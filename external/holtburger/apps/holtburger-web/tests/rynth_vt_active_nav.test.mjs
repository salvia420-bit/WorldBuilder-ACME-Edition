// tests/rynth_vt_active_nav.test.mjs — W1-6 NAV: the ActiveNav runtime and
// its waypoint executors (rynth/vt/nav/active_nav.js, executors.js) against a
// fake host + a tiny world simulation + the REAL rynth/router.js.
//
// Covers PLAN §2.8 R5-R11, R17-R20, §2.1 O8/O17 and the §3.8 executor rules:
// per-leg arriveM + distance-scaled timeouts, foreign-router re-issue, Pause
// (no WALK, movement claim), Chat, Recall (no walk, re-cast every 4 s, 60 s
// FAILED + paused), Portal/NPC (teleport and NPC-settle), OpenVendor (only a
// vendorOpen signal newer than the use completes it — never the cached vendor
// state), NPC Talk, Checkpoint, Jump (leg meta + full buildTune tune), Follow
// hysteresis, portal-space hold, Once keeps nav enabled, external-teleport
// re-sync, onLeave keeps the index, the stuck ladder, loadEmbedded(""), a
// second ActiveNav on the same state, the generation guard, boost/D39 wants,
// `/rs jump` gating, the router's per-leg arriveM, the guide's
// death/runback example (a Once "runback" and a Circular "fighting" route),
// FollowAroundCorners (the leader's path walked corner by corner, watchLeader)
// and NavFarStopDistance (the route holds off course, resumes by itself).
//
// The real router reads Date.now(): the test drives a fake clock by
// replacing Date.now for this process only.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_active_nav.test.mjs

import assert from "node:assert/strict";

const clock = { t: 1_800_000_000_000 };
const realNow = Date.now;
Date.now = () => clock.t;
const now = () => clock.t;

const { RynthRouter } = await import("../rynth/router.js");
const goto = await import("../rynth/goto_compose.js");
const { worldXY, worldToOutdoorCell } = await import("../rynth/nav_frame.js");
const { degToWorld, legToNavPoint } = await import("../rynth/nav_file.js");
const { ActiveNav } = await import("../rynth/vt/nav/active_nav.js");
const { ROUTE, POINT } = await import("../rynth/vt/nav/route_model.js");
const { legTimeoutMs, NAV_TUNING } = await import("../rynth/vt/nav/executors.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}
const flush = () => new Promise((r) => setImmediate(r));

// ── fakes ──────────────────────────────────────────────────────────────────
const BASE_EW = 33.6;
const BASE_NS = 42.0;
const M = 1 / 240; // one metre in /loc degrees
const at = (dxM, dyM = 0) => ({ ew: BASE_EW + dxM * M, ns: BASE_NS + dyM * M });
const P = (dxM, dyM = 0, extra = {}) => ({ type: POINT.Point, ...at(dxM, dyM), z: 0, ...extra });
const W = (dxM, dyM = 0) => degToWorld(at(dxM, dyM).ew, at(dxM, dyM).ns);

function makeWorld({ x = 0, y = 0, speed = 4 } = {}) {
  const w = {
    calls: [],
    chat: [],
    portal: false,
    frozen: false,
    mode: 8,
    busy: 0,
    known: [1635, 48],
    heading: 90,
    inventory: [{ guid: 1, equipMask: 0x01000000 }],
    objects: new Map(),
    target: null,
    speed,
    castToken: null,
    itemToken: null,
    vendorState: null,
    onUse: null,
    onCast: null,
    pose: null,
  };
  w.setPoseWorld = (wx, wy, z = 0) => {
    const c = worldToOutdoorCell(wx, wy, z);
    w.pose = { objCellId: c.lb, x: c.x, y: c.y, z, heading: (w.heading * Math.PI) / 180 };
  };
  w.setPoseRel = (dx, dy = 0, z = 0) => {
    const p = W(dx, dy);
    w.setPoseWorld(p.wx, p.wy, z);
  };
  w.poseW = () => {
    const [wx, wy] = worldXY(w.pose.objCellId, w.pose.x, w.pose.y);
    return { wx, wy };
  };
  w.setPoseRel(x, y);
  w.addObject = (guid, name, dx, dy, flags = 0) => {
    const p = W(dx, dy);
    const c = worldToOutdoorCell(p.wx, p.wy, 0);
    w.objects.set(guid >>> 0, { name, pos: { objCellId: c.lb, x: c.x, y: c.y, z: 0 }, flags });
  };
  w.step = (dtMs) => {
    if (!w.target || w.frozen || !w.pose) return;
    const cur = w.poseW();
    const dx = w.target.wx - cur.wx;
    const dy = w.target.wy - cur.wy;
    const d = Math.hypot(dx, dy);
    const s = (w.speed * dtMs) / 1000;
    if (d <= s) {
      w.setPoseWorld(w.target.wx, w.target.wy, w.pose.z);
      w.target = null;
    } else {
      w.setPoseWorld(cur.wx + (dx / d) * s, cur.wy + (dy / d) * s, w.pose.z);
    }
  };
  w.host = {
    TryGetPlayerPose: () => (w.pose ? { ...w.pose } : null),
    MoveToPosition: (lb, x, y, z) => {
      w.calls.push(["MoveToPosition", lb >>> 0, x, y, z]);
      const [wx, wy] = worldXY(lb >>> 0, x, y);
      w.target = { wx, wy };
      return true;
    },
    StopCompletely: () => {
      w.calls.push(["StopCompletely"]);
      w.target = null;
      return true;
    },
    GetPursuitStatus: () => ({ now: 0, last: 0 }),
    IsPortalSpaceActive: () => w.portal,
    UseObject: (g) => {
      w.calls.push(["UseObject", g >>> 0]);
      if (w.onUse) w.onUse(g >>> 0);
      return true;
    },
    CastUntargetedSafe: (id) => {
      w.calls.push(["CastUntargetedSafe", id]);
      if (w.onCast) w.onCast(id);
      return true;
    },
    tryClaimCast: (o) => {
      if (w.castToken && w.castToken !== o) return false;
      w.castToken = o;
      return true;
    },
    releaseCast: (o) => {
      if (w.castToken === o) w.castToken = null;
    },
    tryClaimItemAction: (o) => {
      if (w.itemToken && w.itemToken !== o) return false;
      w.itemToken = o;
      return true;
    },
    releaseItemAction: (o) => {
      if (w.itemToken === o) w.itemToken = null;
    },
    GetCurrentCombatMode: () => w.mode,
    ChangeCombatMode: (m) => {
      w.calls.push(["ChangeCombatMode", m]);
      w.mode = m;
      return true;
    },
    GetBusyState: () => w.busy,
    TryGetKnownSpells: () => w.known.slice(),
    TryGetPlayerInventory: () => w.inventory,
    NearbyGuids: () => [...w.objects.keys()],
    TryGetObjectName: (g) => w.objects.get(g >>> 0)?.name ?? null,
    TryGetObjectPosition: (g) => {
      const o = w.objects.get(g >>> 0);
      return o ? { ...o.pos } : null;
    },
    TryGetObjectDescFlags: (g) => (w.objects.has(g >>> 0) ? w.objects.get(g >>> 0).flags : null),
    TryGetVendorState: (g) => w.vendorState,
    PursueObject: (g) => {
      w.calls.push(["PursueObject", g >>> 0]);
      return true;
    },
    WriteToChatWindow: (t) => {
      w.chat.push(String(t));
      return true;
    },
    TryGetPlayerCompassHeadingDeg: () => w.heading,
  };
  return w;
}

function fakeOptions(init = {}) {
  const v = { EnableNavigation: true, FollowNavMin: 3, PostPortalDelaySec: 4, BoostNavPriority: false, BoostNavStrict: false, ...init };
  const refs = {};
  return {
    v,
    refs,
    getValue: (k) => v[k],
    set: (k, val) => {
      v[k] = val;
      return { ok: true };
    },
    setRef: (k, val) => {
      refs[k] = val;
      return { ok: true };
    },
  };
}

function fakeBot() {
  const claims = new Set();
  const bot = {
    claims,
    extraClaim: false,
    kernel: { running: true, operatorHeld: false },
    claimMovement: (tag) => {
      const t = { tag };
      claims.add(t);
      return () => claims.delete(t);
    },
    movementClaimed: () => claims.size > 0 || bot.extraClaim,
    tags: () => [...claims].map((c) => c.tag),
  };
  return bot;
}

function fakeSignals() {
  const subs = new Map();
  return {
    subscribe: (type, fn) => {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return () => subs.get(type).delete(fn);
    },
    emit: (type, sig) => {
      for (const fn of subs.get(type) || []) fn({ type, ...sig });
    },
    count: () => [...subs.values()].reduce((a, s) => a + s.size, 0),
  };
}

function fakeStore() {
  const m = new Map();
  return {
    list: () => [...m.values()].map((r) => ({ name: r.name, savedAt: 1, bytes: 1 })),
    get: (n) => (m.has(String(n).toLowerCase()) ? JSON.parse(JSON.stringify(m.get(String(n).toLowerCase()).value)) : null),
    put: (n, v) => {
      m.set(String(n).toLowerCase(), { name: n, value: JSON.parse(JSON.stringify(v)) });
      return { ok: true };
    },
    remove: (n) => ({ ok: m.delete(String(n).toLowerCase()) }),
  };
}

function makeProfiles(store = fakeStore()) {
  // The package's own NavProfiles over a fake NamedStore.
  return import("../rynth/vt/nav/nav_profiles.js").then((m) => new m.NavProfiles({ store, now }));
}

async function makeEnv({ world = makeWorld(), options = fakeOptions(), bot = fakeBot(), gotoCompose = goto, runChat = null, onNpcTell = null, state = null, profiles = null } = {}) {
  const router = new RynthRouter(world.host, { log: () => {} });
  const follows = [];
  const origFollow = router.follow.bind(router);
  router.follow = (legs) => {
    follows.push(legs);
    return origFollow(legs);
  };
  const signals = fakeSignals();
  const logs = [];
  const st = state || {};
  const nav = new ActiveNav({
    host: world.host,
    router,
    bot,
    options,
    profiles: profiles || (await makeProfiles()),
    state: st,
    subscribe: signals.subscribe,
    runChat,
    gotoCompose,
    onNpcTell,
    log: (m) => logs.push(m),
    now,
  });
  const env = { world, router, follows, signals, nav, options, bot, logs, state: st, selected: false };
  // A minimal kernel stand-in: the Navigate slot gets the tick while it wants it.
  env.tick = async (dtMs = 100, ctx = {}) => {
    clock.t += dtMs;
    world.step(dtMs);
    router.tick();
    const wants = nav.slot.enabled() && nav.slot.wants(ctx);
    if (wants) {
      env.selected = true;
      nav.slot.tick(ctx);
    } else if (env.selected) {
      env.selected = false;
      nav.slot.onLeave("Idle");
    }
    await flush();
  };
  env.run = async (ms, dtMs = 100, ctx = {}) => {
    const end = clock.t + ms;
    while (clock.t < end) await env.tick(dtMs, ctx);
  };
  env.until = async (pred, maxMs = 60_000, dtMs = 100) => {
    const end = clock.t + maxMs;
    while (clock.t < end) {
      await env.tick(dtMs);
      if (pred()) return true;
    }
    return false;
  };
  return env;
}

const count = (w, name) => w.calls.filter((c) => c[0] === name).length;

console.log("rynth_vt_active_nav");

// ── defaults / slot shape ──────────────────────────────────────────────────
await check("Z2: at schema defaults (EnableNavigation false, no route) both slots are disabled", async () => {
  const env = await makeEnv({ options: fakeOptions({ EnableNavigation: false }) });
  assert.equal(env.nav.slot.enabled(), false);
  assert.equal(env.nav.jumpSlot.enabled(), false);
  assert.equal(env.nav.slot.name, "Navigate");
  assert.equal(env.nav.jumpSlot.name, "JumpNow");
  assert.equal(env.nav.jumpSlot.rank, "afterUnwedge");
  assert.equal(env.nav.slot.rank(), "beforeIdle");
  env.nav.load({ routeType: ROUTE.Circular, points: [P(10)] });
  assert.equal(env.nav.slot.enabled(), false, "a route alone does not enable navigation");
  assert.equal(env.signals.count(), 6, "one subscription per signal type");
});

// ── Point legs ─────────────────────────────────────────────────────────────
await check("Point legs carry arriveM = max(1.5, FollowNavMin) and a distance-scaled timeoutMs (O8)", async () => {
  const env = await makeEnv({ options: fakeOptions({ FollowNavMin: 1.0 }) });
  env.nav.load({ routeType: ROUTE.Once, points: [P(40)] });
  await env.tick();
  assert.equal(env.follows.length, 1);
  const leg = env.follows[0][0];
  assert.equal(leg.arriveM, 1.5);
  assert.ok(Math.abs(leg.timeoutMs - 35_000) < 50, `timeoutMs ${leg.timeoutMs}`);
  assert.equal(legTimeoutMs(1), 15_000, "floor");
  assert.equal(legTimeoutMs(10_000), 120_000, "cap");
  env.options.v.FollowNavMin = 4;
  env.nav.load({ routeType: ROUTE.Once, points: [P(-40)] });
  await env.tick();
  assert.equal(env.follows.at(-1)[0].arriveM, 4);
  assert.equal(env.nav.ownsRouterWalk(), true);
});
await check("a foreign router.follow is detected by element identity and our leg is re-issued", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(40)] });
  await env.tick();
  const ours = env.follows[0][0];
  env.router.follow([{ lb: ours.lb, x: ours.x, y: ours.y + 1, z: 0 }]); // another caller
  assert.equal(env.nav.ownsRouterWalk(), false);
  await env.tick();
  assert.equal(env.follows.length, 3);
  assert.equal(env.nav.ownsRouterWalk(), true);
  assert.equal(env.router.route[0].arriveM, 3);
});
await check("ownsRouterWalk() is false once the router is DONE or IDLE (critic C11)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Circular, points: [P(8), P(30)] });
  await env.tick();
  assert.equal(env.nav.ownsRouterWalk(), true);
  env.router.cancel();
  assert.equal(env.router.route[0], env.follows[0][0], "the router keeps route after cancel");
  assert.equal(env.nav.ownsRouterWalk(), false, "IDLE");
  const env2 = await makeEnv();
  env2.nav.load({ routeType: ROUTE.Once, points: [P(5)] });
  env2.nav.setEnabled(true);
  await env2.tick();
  await env2.run(3000);
  assert.equal(env2.router.status.state, "DONE");
  assert.equal(env2.nav.ownsRouterWalk(), false, "DONE");
});
await check("Router: a per-leg arriveM is honoured; absent ⇒ the router-wide 3.0 m", async () => {
  const w = makeWorld();
  const router = new RynthRouter(w.host, { log: () => {} });
  const c = worldToOutdoorCell(W(2).wx, W(2).wy, 0);
  router.follow([{ lb: c.lb, x: c.x, y: c.y, z: 0, arriveM: 1.0 }]);
  w.frozen = true;
  clock.t += 100;
  router.tick();
  assert.equal(router.status.state, "WALK", "2 m away, arriveM 1.0");
  w.setPoseRel(0.5);
  clock.t += 100;
  router.tick();
  assert.equal(router.status.state, "WALK", "1.5 m away");
  w.setPoseRel(1.05);
  clock.t += 100;
  router.tick();
  assert.equal(router.status.state, "DONE", "0.95 m away");
  w.setPoseRel(0);
  router.follow([{ lb: c.lb, x: c.x, y: c.y, z: 0 }]);
  clock.t += 100;
  router.tick();
  assert.equal(router.status.state, "DONE", "2 m with no per-leg radius → default 3.0");
});

// ── Pause / Chat ───────────────────────────────────────────────────────────
await check("Pause never enters router WALK and holds a movement claim for the dwell (R10)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Pause, ew: 0, ns: 0, z: -1000 / 240, pauseMs: 2000 }, P(20)] });
  let walked = false;
  for (let i = 0; i < 15; i++) {
    await env.tick();
    if (env.router.status.state === "WALK") walked = true;
    assert.deepEqual(env.bot.tags(), ["vt-nav"]);
  }
  assert.equal(walked, false);
  assert.equal(env.follows.length, 0);
  await env.run(800);
  assert.equal(env.nav.route().activeIndex, 1, "advanced after the dwell");
  assert.equal(env.bot.tags().length, 0, "claim released");
  assert.equal(env.state.lastResult, "DONE:3");
});
await check("Pause cancels our own walking leg first", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(40), { type: POINT.Pause, ew: 0, ns: 0, z: 0, pauseMs: 500 }] });
  await env.tick();
  assert.equal(env.router.status.state, "WALK");
  env.nav.setActive(1);
  await env.tick();
  assert.notEqual(env.router.status.state, "WALK");
});
await check("Chat calls runChat once (trimmed) and advances on the next tick (R11)", async () => {
  const lines = [];
  const env = await makeEnv({ runChat: (l) => lines.push(l) });
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "  /rs echo hi  " }, P(30)] });
  await env.tick();
  assert.deepEqual(lines, ["/rs echo hi"]);
  assert.equal(env.nav.route().activeIndex, 0);
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
  await env.run(500);
  assert.equal(lines.length, 1);
});
await check("consecutive Chat points are paced >= 250 ms apart", async () => {
  const stamps = [];
  const env = await makeEnv({ runChat: () => stamps.push(clock.t) });
  const c = (t) => ({ type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: t });
  env.nav.load({ routeType: ROUTE.Once, points: [c("/a"), c("/b"), c("/c")] });
  await env.run(1500);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 250 && stamps[2] - stamps[1] >= 250, JSON.stringify(stamps.map((s) => s - stamps[0])));
});
await check("a Chat point whose runChat loads another route leaves it at ITS start index (generation guard)", async () => {
  const profiles = await makeProfiles();
  profiles.put("other", { routeType: ROUTE.Circular, points: [P(200), P(150), P(1), P(100)] });
  let env;
  env = await makeEnv({ profiles, runChat: (l) => (l === "/rs nav load other" ? env.nav.loadByName("other") : null) });
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "/rs nav load other" }, P(50)] });
  const g0 = env.nav.generation;
  await env.tick();
  assert.equal(env.nav.route().name, "other");
  assert.ok(env.nav.generation > g0);
  assert.equal(env.nav.route().activeIndex, 2, "nearest Point of the new route");
  await env.tick();
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 3, "index 2 is under us → done → 3");
  assert.equal(env.options.refs.navProfile, "other");
});

await check("generation guard: a step that finishes in the same tick it reloads the route does not advance the new one", async () => {
  // NpcTalk returns "done" in the very step whose onNpcTell callback (INT-2:
  // a meta reacting synchronously) loads another route.
  const profiles = await makeProfiles();
  profiles.put("next", { routeType: ROUTE.Circular, points: [P(300), P(1), P(150)] });
  let env;
  env = await makeEnv({ profiles, onNpcTell: () => env.nav.loadByName("next") });
  env.world.addObject(0x7a0000aa, "Guide", 2, 0, 0);
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.NpcTalk, ...at(1), z: 0, name: "Guide", objectClass: 37, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 }, P(50)] });
  await env.tick();
  assert.equal(count(env.world, "UseObject"), 1);
  env.signals.emit("tell", { name: "Guide", text: "go", isSelf: false });
  env.nav.slot.tick({});
  assert.equal(env.nav.route().name, "next");
  assert.equal(env.nav.route().activeIndex, 1, "the new route's start index, not start+1");
  assert.equal(env.state.lastResult, null, "the old executor's result is not recorded on the new route");
});

// ── Recall ─────────────────────────────────────────────────────────────────
await check("Recall fires on activation (no walk) via CastUntargetedSafe, re-casts every 4 s, FAILED + paused at 60 s (R9)", async () => {
  const env = await makeEnv();
  env.world.mode = 1;
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ...at(500), z: 0, spellId: 1635 }, P(20)] });
  await env.tick();
  assert.deepEqual(env.world.calls.filter((c) => c[0] === "ChangeCombatMode"), [["ChangeCombatMode", 8]]);
  await env.run(59_000);
  const casts = env.world.calls.filter((c) => c[0] === "CastUntargetedSafe");
  assert.ok(casts.length >= 14 && casts.length <= 16, `casts ${casts.length}`);
  assert.ok(casts.every((c) => c[1] === 1635));
  assert.equal(count(env.world, "MoveToPosition"), 0, "never walks to the cast site");
  assert.equal(env.nav.paused, null);
  assert.equal(env.nav.slot.pinned(), true, "pinned while casting");
  await env.run(1200);
  assert.ok(env.nav.paused, "paused after 60 s");
  assert.match(env.state.lastResult, /^FAILED:2:no teleport/);
  assert.equal(env.nav.slot.enabled(), false);
  assert.equal(env.world.castToken, null, "cast token released");
  assert.ok(env.world.chat.some((l) => /failed/.test(l)), "chat alert");
  assert.equal(env.nav.route().activeIndex, 0, "index kept");
});
await check("Recall: teleport → settle PostPortalDelaySec → advance", async () => {
  const env = await makeEnv();
  env.world.onCast = () => {
    env.world.onCast = null;
    env.world.setPoseRel(3000, 3000);
  };
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }, P(3010, 3000)] });
  await env.tick();
  assert.equal(count(env.world, "CastUntargetedSafe"), 1);
  await env.run(3000);
  assert.equal(env.nav.route().activeIndex, 0, "settling");
  await env.run(1500);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(count(env.world, "CastUntargetedSafe"), 1, "no re-cast after the teleport");
  assert.equal(env.state.lastResult, "DONE:1".replace("1", "2"));
});
await check("Recall refuses an unknown spell and a missing caster without casting", async () => {
  const env = await makeEnv();
  env.world.known = [48];
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }] });
  await env.tick();
  assert.match(env.state.lastResult, /FAILED:2:not in the spellbook/);
  const env2 = await makeEnv();
  env2.world.inventory = [{ guid: 1, equipMask: 0x2 }];
  env2.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }] });
  await env2.tick();
  assert.match(env2.state.lastResult, /FAILED:2:no caster/);
  assert.equal(count(env.world, "CastUntargetedSafe") + count(env2.world, "CastUntargetedSafe"), 0);
});

// ── Portal / NPC / vendor / talk ───────────────────────────────────────────
await check("Portal/NPC: walk within 3 m, UseObject, teleport → settle → advance (R7)", async () => {
  const env = await makeEnv();
  env.world.addObject(0x7a000001, "Portal to Holtburg", 20, 0, 0x40000);
  env.world.onUse = () => {
    env.world.onUse = null;
    env.world.setPoseRel(5000, 0);
  };
  const ptl = { type: POINT.PortalNPC, ...at(18), z: 0, name: "Portal to Holtburg", objectClass: 14, isTie: false, exitEW: at(20).ew, exitNS: at(20).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [ptl, P(5010)] });
  await env.tick();
  assert.equal(env.follows.length, 1, "approach leg");
  assert.equal(env.follows[0][0].arriveM, NAV_TUNING.approachArriveM);
  const ok = await env.until(() => count(env.world, "UseObject") > 0, 20_000);
  assert.ok(ok, "used");
  assert.equal(env.world.calls.find((c) => c[0] === "UseObject")[1], 0x7a000001);
  assert.equal(env.nav.slot.pinned(), true);
  await env.run(5000);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.state.lastResult, "DONE:6");
  assert.equal(env.world.itemToken, null, "item token released");
});
await check("Portal/NPC: an NPC (objectClass 37) without a teleport is done ~3 s after the use settles", async () => {
  const env = await makeEnv();
  env.world.addObject(0x7a000002, "Town Crier", 2, 0, 0);
  const npc = { type: POINT.PortalNPC, ...at(1), z: 0, name: "Town Crier", objectClass: 37, isTie: false, exitEW: at(2).ew, exitNS: at(2).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [npc, P(40)] });
  await env.tick();
  assert.equal(count(env.world, "UseObject"), 1);
  await env.run(3500);
  assert.equal(env.nav.route().activeIndex, 0);
  await env.run(800);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(count(env.world, "UseObject"), 1, "no re-use while settling");
});
await check("Portal/NPC: a non-NPC with no teleport FAILS after 20 s (re-using every 4 s)", async () => {
  const env = await makeEnv();
  env.world.addObject(0x7a000003, "Broken Portal", 2, 0, 0x40000);
  const ptl = { type: POINT.PortalNPC, ...at(1), z: 0, name: "Broken Portal", objectClass: 14, isTie: false, exitEW: at(2).ew, exitNS: at(2).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [ptl] });
  await env.run(21_000);
  assert.match(env.state.lastResult, /^FAILED:6:no teleport/);
  const uses = count(env.world, "UseObject");
  assert.ok(uses >= 5 && uses <= 6, `uses ${uses}`);
});
await check("OpenVendor: a cached TryGetVendorState never completes it; only a vendorOpen signal after the use does (critic B2)", async () => {
  const env = await makeEnv();
  const VG = 0x90000001;
  env.world.addObject(VG, "Thomas the Merchant", 2, 0, 0x200);
  env.world.vendorState = { vendorGuid: VG, items: [] }; // cached from an earlier visit
  env.signals.emit("vendorOpen", { guid: VG, name: "Thomas the Merchant" }); // stale (before the use)
  await env.tick(); // signal recorded at the previous time; use issued now
  env.nav.load({ routeType: ROUTE.Circular, points: [{ type: POINT.OpenVendor, ...at(1), z: 0, vendorId: VG, name: "Thomas the Merchant" }, P(60)] });
  assert.equal(env.nav.route().activeIndex, 1, "a Circular route starts at its nearest Point");
  env.nav.setActive(0);
  await env.tick();
  assert.equal(count(env.world, "UseObject"), 1);
  await env.run(2500);
  assert.equal(env.nav.route().activeIndex, 0, "still waiting");
  await env.run(1000);
  assert.equal(count(env.world, "UseObject"), 2, "retried after 3 s");
  env.signals.emit("vendorOpen", { guid: 0x90000002, name: "Other Vendor" });
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 0, "another vendor does not count");
  env.signals.emit("vendorOpen", { guid: VG, name: "Thomas the Merchant" });
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.state.lastResult, "DONE:5");
});
await check("OpenVendor: by name when the recorded guid is gone; 20 s without a window ⇒ FAILED", async () => {
  const env = await makeEnv();
  env.world.addObject(0x90000009, "Thomas the Merchant", 2, 0, 0x200);
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.OpenVendor, ...at(1), z: 0, vendorId: 0x90000001, name: "Thomas the Merchant" }] });
  await env.tick();
  assert.equal(env.world.calls.find((c) => c[0] === "UseObject")[1], 0x90000009);
  await env.run(20_500);
  assert.match(env.state.lastResult, /^FAILED:5:vendor did not open/);
});
await check("NPC Talk: UseObject every 4 s until a tell from that NPC; text reported (R8)", async () => {
  const tells = [];
  const env = await makeEnv({ onNpcTell: (n, t) => tells.push([n, t]) });
  env.world.addObject(0x7a000010, "Town Crier", 2, 0, 0);
  const tlk = { type: POINT.NpcTalk, ...at(1), z: 0, name: "Town Crier", objectClass: 37, isTie: false, exitEW: at(2).ew, exitNS: at(2).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [tlk, P(40)] });
  await env.run(8_100);
  assert.equal(count(env.world, "UseObject"), 3);
  env.signals.emit("tell", { name: "Someone Else", text: "hi", isSelf: false });
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 0);
  env.signals.emit("tell", { name: "town crier", text: "Welcome to Holtburg!", isSelf: false });
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
  assert.deepEqual(tells, [["town crier", "Welcome to Holtburg!"]]);
});
await check("NPC Talk: 45 s without a tell ⇒ FAILED + paused", async () => {
  const env = await makeEnv();
  env.world.addObject(0x7a000011, "Mute Guard", 2, 0, 0);
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.NpcTalk, ...at(1), z: 0, name: "Mute Guard", objectClass: 37, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 }] });
  await env.run(45_500);
  assert.match(env.state.lastResult, /^FAILED:7:no tell/);
  assert.ok(env.nav.paused);
});
await check("Portal (legacy): uses the recorded guid and waits for the teleport", async () => {
  const env = await makeEnv();
  env.world.addObject(0x7b000001, "Gateway", 3, 0, 0x40000);
  env.world.onUse = () => {
    env.world.portal = true;
  };
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.PortalLegacy, ...at(3), z: 0, guid: 0x7b000001 }, P(900)] });
  await env.tick();
  assert.equal(env.world.calls.find((c) => c[0] === "UseObject")[1], 0x7b000001);
  await env.run(6000); // a long tunnel (longer than PostPortalDelaySec)
  assert.equal(env.nav.slot.pinned(), true, "pinned while waiting/settling");
  env.world.setPoseRel(880);
  env.world.portal = false;
  await env.run(3500);
  assert.equal(env.nav.route().activeIndex, 0, "the settle counts from the END of portal space");
  await env.run(1000);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(count(env.world, "UseObject"), 1, "no re-use once the teleport began");
});

// ── Checkpoint / Jump ──────────────────────────────────────────────────────
await check("Checkpoint: stop, then done once the pose is still >= 750 ms (R17)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Checkpoint, ...at(0), z: 0 }, P(40)] });
  await env.tick();
  assert.equal(count(env.world, "StopCompletely") >= 1, true);
  await env.run(500);
  assert.equal(env.nav.route().activeIndex, 0);
  await env.run(600);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.state.lastResult, "DONE:8");
});
await check("Checkpoint: a pose that keeps moving ⇒ done with a warning after 10 s", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Checkpoint, ...at(0), z: 0 }] });
  let dx = 0;
  for (let i = 0; i < 99; i++) {
    dx += 0.5;
    env.world.setPoseRel(dx);
    await env.tick();
  }
  assert.equal(env.nav.isEmpty(), false);
  for (let i = 0; i < 3; i++) {
    dx += 0.5;
    env.world.setPoseRel(dx);
    await env.tick();
  }
  assert.match(env.state.lastResult, /^WARN:8:/);
  assert.equal(env.nav.isEmpty(), true);
});
await check("Jump: the job gets leg meta navType 'jmp' and the FULL buildTune tune + direction (critic C5, R20)", async () => {
  const calls = [];
  let resolve;
  const gc = {
    buildTune: goto.buildTune,
    findEntityByName: goto.findEntityByName,
    attemptJumpLeg: (ctx, leg, tune) => {
      calls.push({ ctx, leg, tune });
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const env = await makeEnv({ gotoCompose: gc });
  env.nav.load({
    routeType: ROUTE.Once,
    points: [
      { type: POINT.Jump, ...at(0), z: 0, headingDeg: 270.5, holdShift: true, delayMs: 750, ext: { direction: "strafeleft" } },
      { type: POINT.Jump, ...at(0), z: 0, headingDeg: 10, holdShift: false, delayMs: 300 },
    ],
  });
  await env.tick();
  assert.equal(calls.length, 1);
  const { ctx, leg, tune } = calls[0];
  assert.equal(ctx.host, env.world.host);
  assert.deepEqual(leg.meta, { navType: "jmp", headingDeg: 270.5, holdShift: true, delayMs: 750 });
  const real = goto.buildTune({});
  for (const k of Object.keys(real)) assert.ok(tune[k] !== undefined && tune[k] === real[k], `tune.${k}`);
  for (const [k, v] of Object.entries(tune)) assert.notEqual(v, undefined, `tune.${k} undefined`);
  assert.equal(tune.direction, "strafeleft");
  assert.equal(env.nav.slot.pinned(), true, "pinned while the job runs");
  await env.run(1000);
  assert.equal(env.nav.route().activeIndex, 0);
  resolve({ ok: true });
  await env.tick(); // the job settles after this tick's step (microtask)
  await env.tick(); // settled → done → advance
  assert.equal(env.nav.route().activeIndex, 1);
  await env.tick(); // the next Jump point starts its job
  assert.equal(calls.length, 2);
  assert.equal(calls[1].tune.direction, "forward", "default direction for corpus jmp points");
  assert.equal(count(env.world, "MoveToPosition"), 0, "a jump point is never walked");
});
await check("Jump: a failed job FAILS the waypoint", async () => {
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: async () => ({ ok: false, error: "jump-unavailable: canJumpNow() false" }) };
  const env = await makeEnv({ gotoCompose: gc });
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Jump, ...at(0), z: 0, headingDeg: 0, holdShift: false, delayMs: 100 }] });
  await env.tick();
  await env.tick();
  assert.match(env.state.lastResult, /^FAILED:9:jump-unavailable/);
});

// ── Follow ─────────────────────────────────────────────────────────────────
await check("Follow: PursueObject beyond 8 m, stop inside 5 m, hysteresis between (R3, Q21)", async () => {
  // FollowAroundCorners off: straight at the leader (the trail walk is below).
  const env = await makeEnv({ options: fakeOptions({ FollowAroundCorners: false }) });
  const G = 0x50000077;
  env.world.addObject(G, "Leader Bob", 10, 0, 0x8);
  env.nav.load({ routeType: ROUTE.Follow, points: [], followTarget: { guid: G, name: "Leader Bob" } });
  env.world.frozen = true;
  await env.tick();
  assert.deepEqual(env.world.calls.filter((c) => c[0] === "PursueObject"), [["PursueObject", G]]);
  assert.deepEqual(env.bot.tags(), ["vt-nav-follow"]);
  env.world.addObject(G, "Leader Bob", 6, 0, 0x8);
  await env.run(1100);
  assert.ok(count(env.world, "MoveToPosition") >= 1, "position fallback every 1 s");
  assert.equal(count(env.world, "StopCompletely"), 0);
  env.world.addObject(G, "Leader Bob", 4, 0, 0x8);
  await env.tick();
  assert.equal(count(env.world, "StopCompletely"), 1);
  assert.equal(env.bot.tags().length, 0);
  env.world.addObject(G, "Leader Bob", 7, 0, 0x8);
  await env.run(500);
  assert.equal(count(env.world, "PursueObject"), 1, "no restart inside 8 m");
  env.world.addObject(G, "Leader Bob", 9, 0, 0x8);
  await env.tick();
  assert.equal(count(env.world, "PursueObject"), 2);
  env.world.objects.delete(G);
  await env.tick();
  assert.equal(env.nav.status().exec, "follow target out of range");
  assert.equal(count(env.world, "StopCompletely"), 2);
});

// ── FollowAroundCorners (follow_trail.js) ──────────────────────────────────
const LEADER = 0x50000077;
/** The leader: runs `path` ([[dx, dy], …] metres from BASE) at `speed` m/s. */
function leaderOn(world, path, speed = 6) {
  const L = { i: 1, x: path[0][0], y: path[0][1] };
  const put = () => world.addObject(LEADER, "Leader Bob", L.x, L.y, 0x8);
  put();
  L.step = (dtMs) => {
    let s = (speed * dtMs) / 1000;
    while (s > 0 && L.i < path.length) {
      const [tx, ty] = path[L.i];
      const d = Math.hypot(tx - L.x, ty - L.y);
      if (d <= s) {
        L.x = tx;
        L.y = ty;
        s -= d;
        L.i++;
      } else {
        L.x += ((tx - L.x) / d) * s;
        L.y += ((ty - L.y) / d) * s;
        s = 0;
      }
    }
    put();
  };
  return L;
}
const followLeader = (env) => env.nav.load({ routeType: ROUTE.Follow, points: [], followTarget: { guid: LEADER, name: "Leader Bob" } });
/** Metres from a leg / a MoveToPosition call ({lb,x,y} | [_, lb, x, y]) to BASE + (dx, dy). */
function offBy(at, dx, dy) {
  const [wx, wy] = Array.isArray(at) ? worldXY(at[1], at[2], at[3]) : worldXY(at.lb, at.x, at.y);
  const c = W(dx, dy);
  return Math.hypot(wx - c.wx, wy - c.wy);
}
const poseOff = (world, dx, dy) => {
  const p = world.poseW();
  const c = W(dx, dy);
  return Math.hypot(p.wx - c.wx, p.wy - c.wy);
};

await check("FollowAroundCorners (the default): the leader turns a corner → the follower runs to it first (router legs), then along their path, then straight at them; off: no leg, straight at them across the corner", async () => {
  async function run(opts, path = [[10, 0], [30, 0], [30, 30]]) {
    const env = await makeEnv({ options: fakeOptions(opts) });
    const L = leaderOn(env.world, path);
    followLeader(env);
    let near = Infinity;
    for (let i = 0; i < 220; i++) {
      L.step(100);
      await env.tick();
      near = Math.min(near, poseOff(env.world, 30, 0));
    }
    return { env, near };
  }
  const on = await run({}); // FollowAroundCorners absent: the schema default (on)
  assert.ok(on.env.follows.length >= 5, `router legs along their path (${on.env.follows.length})`);
  assert.ok(on.env.follows.every((legs) => legs.length === 1 && legs[0].followTrail === true && legs[0].arriveM === 1));
  assert.ok(offBy(on.env.follows[0][0], 30, 0) <= 2, "the first leg goes to the corner they turned");
  assert.ok(on.near <= 2.5, `through the corner (closest ${on.near.toFixed(2)} m)`);
  assert.ok(poseOff(on.env.world, 30, 30) < 5.5, "and up to them at the end");
  assert.match(on.env.nav.status().exec, /holding/);
  assert.equal(on.env.state.follow.moving, false);
  assert.deepEqual(on.env.bot.tags(), [], "the claim is released");
  // Their last corner passed while still > 5 m from them: straight at them (the pursuit) again.
  const short = await run({}, [[10, 0], [30, 0], [30, 12]]);
  assert.equal(count(short.env.world, "PursueObject"), 2, "the start, and after their last corner");
  assert.equal(short.env.state.follow.mode ?? null, null);
  assert.match(short.env.nav.status().exec, /holding/);
  const off = await run({ FollowAroundCorners: false });
  assert.equal(off.env.follows.length, 0, "no router leg: PursueObject / MoveToPosition at them");
  assert.ok(off.near > 4, `the corner is cut (closest ${off.near.toFixed(2)} m)`);
});

await check("FollowAroundCorners: a yield cancels the corner leg and keeps the trail (the same corner after); off mid-corner: the leg is cancelled, straight at them at once; out of sight: stop and their path is dropped; beside them (< 5 m): stop", async () => {
  const env = await makeEnv();
  const L = leaderOn(env.world, [[10, 0], [30, 0], [30, 30]]);
  followLeader(env);
  for (let i = 0; i < 60 && !env.follows.length; i++) {
    L.step(100);
    await env.tick();
  }
  assert.equal(env.follows.length, 1, "the corner leg");
  assert.equal(env.router.status.state, "WALK");
  assert.deepEqual(env.bot.tags(), ["vt-nav-follow"]);
  assert.match(env.nav.status().exec, /^following Leader Bob: [\d.]+ m, on their path \(\d+ corners? ahead\)$/);
  const corner = env.follows[0][0].trailPoint;
  env.nav.slot.onLeave("Combat");
  assert.equal(env.router.status.state, "IDLE", "a yield cancels the corner leg");
  assert.deepEqual(env.bot.tags(), [], "and releases the claim");
  await env.tick();
  assert.equal(env.follows.length, 2, "re-issued when the slot is back");
  assert.equal(env.follows[1][0].trailPoint, corner, "to the same corner: the trail was kept");
  env.options.v.FollowAroundCorners = false;
  await env.tick();
  assert.equal(env.router.status.state, "IDLE", "off mid-corner: the corner leg is cancelled");
  assert.ok(offBy(env.world.calls.filter((c) => c[0] === "MoveToPosition").at(-1), L.x, L.y) < 1, "straight at them at once");
  assert.equal(env.state.follow.mode, null);
  env.options.v.FollowAroundCorners = true;
  env.world.objects.delete(LEADER);
  await env.tick();
  assert.equal(env.nav.status().exec, "follow target out of range");
  assert.equal(env.state.follow.moving, false);
  // Back in sight further on: their old corner is gone — straight at them.
  const n = env.follows.length;
  const p = count(env.world, "PursueObject");
  env.world.addObject(LEADER, "Leader Bob", 40, 30, 0x8);
  await env.tick();
  assert.equal(env.follows.length, n, "no leg to the corner seen before they left sight");
  assert.equal(count(env.world, "PursueObject"), p + 1);
  // Beside them: stop.
  const me = env.world.poseW();
  env.world.addObject(LEADER, "Leader Bob", me.wx - W(0, 0).wx + 3, me.wy - W(0, 0).wy, 0x8);
  await env.tick();
  assert.equal(env.state.follow.moving, false);
  assert.match(env.nav.status().exec, /holding/);
});

await check("FollowAroundCorners: watchLeader (the layer's pre-tick) keeps recording their path while a fight holds the tick — after it the follower runs that path from the corner (unwatched: to where they were, then straight)", async () => {
  async function run(watch) {
    const env = await makeEnv();
    env.world.frozen = true;
    const L = leaderOn(env.world, [[12, 0], [30, 0], [30, 20]]);
    followLeader(env);
    await env.tick(); // 12 m: running at them
    assert.equal(count(env.world, "PursueObject"), 1);
    env.nav.slot.onLeave("Combat"); // a fight holds the tick for 7 s
    for (let i = 0; i < 70; i++) {
      clock.t += 100;
      L.step(100);
      if (watch) env.nav.watchLeader(clock.t);
    }
    await env.tick();
    return env.follows.length ? env.follows[0][0] : null;
  }
  const leg = await run(true);
  assert.ok(leg && leg.followTrail === true, "a corner leg after the fight");
  assert.ok(offBy(leg, 30, 0) <= 2, `to the corner they turned meanwhile (${offBy(leg, 30, 0).toFixed(2)} m off)`);
  const blind = await run(false);
  assert.ok(blind && offBy(blind, 12, 0) <= 1, "unwatched: to where they were when the fight began");
  // watchLeader is inert unless a Follow route runs, and never throws.
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(10)] });
  env.nav.watchLeader();
  env.nav.watchLeader(NaN);
  assert.equal(env.world.calls.length, 0);
});

const farAlerts = (w) => w.chat.filter((l) => /far-stop range/.test(l));
/** `laps` laps around a follower at the origin, `r` metres out (8 corners a lap). */
function lapsAround(r, laps, from = 0) {
  const out = [];
  for (let lap = 0; lap < laps; lap++) for (let k = 0; k < 8; k++) out.push([r * Math.cos(from + (k * Math.PI) / 4), r * Math.sin(from + (k * Math.PI) / 4)]);
  return out;
}
/** Their wander inside the 5-8 m hold band: laps around us (24 corners), and
 *  laps that begin with the corner nearest us (which a join alone would keep
 *  the whole wander after). [points, their radius] */
const WANDERS = [
  [[...lapsAround(6.5, 3), [6.5, 0]], 6.5],
  [[[5.2, 0], [5.2, 3], ...lapsAround(7.5, 2, Math.PI / 6), [7.5, 0]], 7.5],
];
/** Then away north, and east at a corner at (6.5, 12). */
const LEAVE = [[6.5, 3], [6.5, 6], [6.5, 9], [6.5, 12], [9, 12], [12, 12], [15, 12], [18, 12]];
/** Legs to a point of their laps (`r` metres from the origin). */
const wanderLegs = (env, r) =>
  env.follows.filter((legs) => {
    const [wx, wy] = worldXY(legs[0].lb, legs[0].x, legs[0].y);
    const o = W(0, 0);
    return Math.abs(Math.hypot(wx - o.wx, wy - o.wy) - r) < 0.3;
  }).length;

await check("FollowAroundCorners (review): their wander while we hold 5-8 m away is not walked later — only their last steps are kept, and the walk joins their path where it passes nearest us; their corner is still walked", async () => {
  for (const [wander, r] of WANDERS) {
    const env = await makeEnv();
    const put = (x, y) => env.world.addObject(LEADER, "Leader Bob", x, y, 0x8);
    put(...wander[0]);
    followLeader(env);
    for (const p of wander) {
      put(...p);
      for (let i = 0; i < 3; i++) await env.tick();
    }
    assert.equal(env.follows.length, 0, "holding: no leg");
    assert.equal(env.state.follow.moving, false);
    for (const p of LEAVE) {
      put(...p);
      for (let i = 0; i < 3; i++) await env.tick();
    }
    await env.run(12_000);
    assert.ok(wanderLegs(env, r) <= 2, `at most their last steps there (${wanderLegs(env, r)} legs for their ${wander.length} corners)`);
    assert.ok(env.follows.some((legs) => offBy(legs[0], 6.5, 12) < 1.5), "their corner is walked");
    assert.ok(poseOff(env.world, 18, 12) < 5.5, "and up to them");
  }
});

await check("FollowAroundCorners (review): their wander near us during a fight (watchLeader) is not walked after it; a far-stop hold forgets their path out there (back in range: straight at them)", async () => {
  for (const [wander, r] of WANDERS) {
    const env = await makeEnv();
    env.world.frozen = true;
    const put = (x, y) => env.world.addObject(LEADER, "Leader Bob", x, y, 0x8);
    put(12, 0);
    followLeader(env);
    await env.tick(); // 12 m: running at them
    env.nav.slot.onLeave("Combat"); // a fight holds the tick; the pre-tick still watches them
    const watch = (p) => {
      put(...p);
      for (let i = 0; i < 3; i++) {
        clock.t += 100;
        env.nav.watchLeader(clock.t);
      }
    };
    for (const p of wander) watch(p);
    for (const p of LEAVE) watch(p);
    env.world.frozen = false;
    await env.run(12_000);
    assert.ok(wanderLegs(env, r) <= 2, `at most their last steps near us (${wanderLegs(env, r)} legs for their ${wander.length} corners)`);
    assert.ok(env.follows.some((legs) => offBy(legs[0], 6.5, 12) < 1.5), "their corner is walked");
  }
  // Far-stop: they turn a corner within range at (30, 0), run off past it and
  // around more corners, then come back within it further from us than that
  // corner — which a kept trail would join first.
  const far = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 40 }) });
  far.world.frozen = true;
  const fput = (x, y) => far.world.addObject(LEADER, "Leader Bob", x, y, 0x8);
  fput(10, 0);
  followLeader(far);
  await far.tick();
  const trip = [[20, 0], [30, 0], [30, 10], [30, 20], [30, 30], [20, 40], [10, 45], [0, 50]];
  for (let i = 0; i < 10; i++) trip.push([0, 50]); // they linger out there
  trip.push([0, 45], [0, 39]);
  let legsAtHold = -1;
  for (const p of trip) {
    fput(...p);
    for (let i = 0; i < 3; i++) {
      clock.t += 100;
      far.nav.watchLeader(clock.t);
      await far.tick();
    }
    if (legsAtHold < 0 && /^leader too far/.test(far.nav.status().blockedBy || "")) legsAtHold = far.follows.length;
  }
  assert.ok(legsAtHold >= 0, "held while they were out of range");
  assert.equal(far.nav.status().blockedBy, null, "back within range");
  assert.equal(far.follows.length, legsAtHold, "no leg to their (30, 0) corner or their trip out there");
  assert.ok(count(far.world, "PursueObject") >= 2, "straight at them");
});

await check("FollowAroundCorners (review): a new follow target forgets the old leader — the far-stop never judges the previous leader's distance (setFollowTarget, load)", async () => {
  for (const how of ["setFollowTarget", "load"]) {
    const env = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }) });
    env.world.frozen = true;
    env.world.addObject(LEADER, "Leader Bob", 20, 0, 0x8);
    followLeader(env);
    await env.tick(); // Bob seen: 20 m, followed
    env.world.addObject(LEADER, "Leader Bob", 90, 0, 0x8); // Bob now far away
    const ALICE = 0x50000088; // not in sight yet
    if (how === "setFollowTarget") env.nav.setFollowTarget({ guid: ALICE, name: "Alice" });
    else env.nav.load({ routeType: ROUTE.Follow, points: [], followTarget: { guid: ALICE, name: "Alice" } });
    await env.run(500);
    assert.equal(farAlerts(env.world).length, 0, `${how}: no far-stop alert about Bob`);
    assert.equal(env.nav.status().exec, "follow target out of range", how);
    assert.equal(env.nav.status().blockedBy, null, how);
  }
});

// ── NavFarStopDistance (VTank NavFarStopRange) ─────────────────────────────
await check("NavFarStopDistance: a waypoint beyond it holds the route — no leg, the slot declines the tick, blockedBy says why, ONE chat alert — and back within range it walks on by itself; EnableNavigation is never touched", async () => {
  const env = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }) });
  env.world.frozen = true;
  env.nav.load({ routeType: ROUTE.Once, points: [P(100), P(140)] });
  await env.run(2000);
  assert.equal(env.follows.length, 0, "no leg");
  assert.equal(env.nav.slot.wants({}), false);
  assert.equal(env.nav.status().blockedBy, "far off course: 100 m > 50 m");
  assert.equal(farAlerts(env.world).length, 1, "one alert for the hold");
  assert.equal(farAlerts(env.world)[0], "[RynthSuite] nav: waypoint 1/2 is 100 m away, past the nav far-stop range (50 m) — holding the route until you are back within range");
  assert.equal(env.options.v.EnableNavigation, true);
  assert.equal(env.nav.status().enabled, true);
  assert.equal(env.nav.paused, null, "held, not paused");
  env.nav.slot.tick({}); // a tick that came without wants(): still no leg
  assert.equal(env.follows.length, 0);
  assert.equal(farAlerts(env.world).length, 1);
  env.world.setPoseRel(60); // back within range (moved by hand)
  await env.tick();
  assert.equal(env.follows.length, 1, "walking again");
  assert.equal(env.nav.status().blockedBy, null);
  assert.ok(env.logs.some((l) => /back within the nav far-stop range/.test(l)));
  // Off course again at once: the same waypoint within 60 s is logged, not re-alerted.
  env.world.setPoseRel(-10);
  await env.tick();
  assert.equal(env.router.status.state, "IDLE", "the slot left: our leg is cancelled");
  assert.match(env.nav.status().blockedBy, /^far off course: 110 m > 50 m$/);
  assert.equal(farAlerts(env.world).length, 1);
  // Another waypoint is another hold.
  env.nav.setActive(1);
  await env.tick();
  assert.equal(farAlerts(env.world).length, 2);
  assert.match(farAlerts(env.world)[1], /waypoint 2\/2 is 150 m away/);
  // 0 = off.
  env.options.v.NavFarStopDistance = 0;
  await env.tick();
  assert.equal(env.nav.status().blockedBy, null);
  assert.equal(env.follows.length, 2);
});

await check("NavFarStopDistance: in-place waypoints (Chat, Pause, Recall…) are never held; Portal/NPC is measured at its portal's recorded position (exitEW/exitNS), not its own stale coordinates", async () => {
  const chats = [];
  const env = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }), runChat: (t) => chats.push(t) });
  env.world.frozen = true;
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Chat, ...at(500), z: 0, chat: "/rs echo hi" }, P(400)] });
  await env.run(500);
  assert.deepEqual(chats, ["/rs echo hi"], "the Chat point ran where we stand");
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.nav.status().blockedBy, "far off course: 400 m > 50 m");
  const exit = at(10);
  const portal = { type: POINT.PortalNPC, ...at(4000), z: 0, name: "Baishi Portal", objectClass: 14, exitEW: exit.ew, exitNS: exit.ns, exitZ: 0 };
  const env2 = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }) });
  env2.world.frozen = true;
  env2.world.addObject(0x7a000099, "Baishi Portal", 10, 0, 0x40000);
  env2.nav.load({ routeType: ROUTE.Once, points: [portal] });
  await env2.tick();
  assert.equal(env2.nav.status().blockedBy, null, "10 m from the portal");
  assert.ok(env2.follows.length === 1 && offBy(env2.follows[0][0], 10, 0) < 0.5, "approaching it");
  const env3 = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }) });
  env3.nav.load({ routeType: ROUTE.Once, points: [{ ...portal, exitEW: 0, exitNS: 0 }] });
  await env3.tick();
  assert.equal(env3.nav.status().blockedBy, "far off course: 4000 m > 50 m", "no recorded portal position: its own");
});

await check("NavFarStopDistance: an external teleport while held re-syncs a Circular route first (died → respawned at the far end of the route), and it walks from there", async () => {
  const env = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 100 }) });
  env.world.frozen = true;
  env.nav.load({ routeType: ROUTE.Circular, points: [P(0), P(500), P(1000)] });
  env.nav.setActive(1);
  await env.run(500);
  assert.equal(env.nav.status().blockedBy, "far off course: 500 m > 100 m");
  assert.equal(env.follows.length, 0);
  env.world.setPoseRel(990);
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 2, "re-synced to the nearest Point");
  assert.equal(env.nav.status().blockedBy, null);
  assert.equal(env.follows.length, 1);
});

await check("NavFarStopDistance on a Follow route: a leader beyond it is not followed (no pursuit), one alert; back within range the follow picks up", async () => {
  const env = await makeEnv({ options: fakeOptions({ NavFarStopDistance: 50 }) });
  env.world.frozen = true;
  env.world.addObject(LEADER, "Leader Bob", 80, 0, 0x8);
  followLeader(env);
  await env.run(1000);
  assert.equal(count(env.world, "PursueObject"), 0);
  assert.equal(env.nav.status().blockedBy, "leader too far: 80 m > 50 m");
  assert.equal(env.nav.status().exec, "following Leader Bob: 80.0 m");
  assert.equal(farAlerts(env.world).length, 1);
  assert.match(farAlerts(env.world)[0], /follow target Leader Bob is 80 m away, past the nav far-stop range \(50 m\) — holding until they are back within range/);
  env.world.addObject(LEADER, "Leader Bob", 30, 0, 0x8);
  await env.tick();
  assert.deepEqual(env.world.calls.filter((c) => c[0] === "PursueObject"), [["PursueObject", LEADER]]);
  assert.equal(env.nav.status().blockedBy, null);
});

// ── holds / ownership ──────────────────────────────────────────────────────
await check("portal space holds every executor (no leg, no use, no cast)", async () => {
  const env = await makeEnv();
  env.world.portal = true;
  env.world.addObject(0x7a000020, "Thomas", 1, 0, 0x200);
  env.nav.load({ routeType: ROUTE.Circular, points: [P(40), { type: POINT.OpenVendor, ...at(1), z: 0, vendorId: 0x7a000020, name: "Thomas" }, { type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }] });
  await env.run(2000);
  assert.equal(env.follows.length, 0);
  assert.equal(env.nav.slot.wants({}), false);
  for (const i of [1, 2]) {
    env.nav.setActive(i);
    env.nav.slot.tick({});
  }
  assert.equal(count(env.world, "UseObject") + count(env.world, "CastUntargetedSafe"), 0);
  env.world.portal = false;
  env.nav.setActive(0);
  await env.tick();
  assert.equal(env.follows.length, 1);
});
await check("slot.onLeave keeps the index and cancels only our leg; re-selection re-issues", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Circular, points: [P(0), P(40), P(80)] });
  await env.tick();
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.router.status.state, "WALK");
  env.nav.slot.onLeave("Combat");
  assert.equal(env.router.status.state, "IDLE");
  assert.equal(env.nav.route().activeIndex, 1);
  assert.match(env.nav.status().blockedBy, /yielded to Combat/);
  const n = env.follows.length;
  await env.tick();
  assert.equal(env.follows.length, n + 1);
  assert.equal(env.router.status.state, "WALK");
  // a foreign walk is never cancelled by our yield
  env.router.follow([{ ...env.follows[0][0], y: env.follows[0][0].y + 5 }]);
  env.nav.yield("Loot");
  assert.equal(env.router.status.state, "WALK");
});
await check("pause('operator cancel') cancels our leg and nothing re-issues until resume() (critic B1)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(60)] });
  await env.tick();
  assert.equal(env.router.status.state, "WALK");
  env.nav.pause("operator cancel");
  assert.equal(env.router.status.state, "IDLE");
  const n = env.follows.length;
  for (let i = 0; i < 10; i++) {
    env.nav.slot.tick({});
    await env.tick();
  }
  assert.equal(env.follows.length, n);
  assert.equal(env.nav.status().paused.reason, "operator cancel");
  assert.equal(env.nav.slot.enabled(), false);
  env.nav.resume();
  await env.tick();
  assert.equal(env.follows.length, n + 1);
});
await check("setEnabled(false) stops our walk at once; load never changes EnableNavigation", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(60)] });
  await env.tick();
  env.nav.setEnabled(false);
  assert.equal(env.options.v.EnableNavigation, false);
  assert.equal(env.router.status.state, "IDLE");
  env.nav.load({ routeType: ROUTE.Once, points: [P(10)] });
  assert.equal(env.options.v.EnableNavigation, false);
  env.nav.enabled = true;
  assert.equal(env.options.v.EnableNavigation, true);
});
await check("Once: the route empties at its end and navigation stays enabled (R4, U7b H4)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [P(0), P(8), P(16)] });
  const ok = await env.until(() => env.nav.isEmpty(), 30_000);
  assert.ok(ok);
  assert.equal(env.options.v.EnableNavigation, true);
  assert.equal(env.nav.status().finished, true);
  assert.equal(env.nav.route().points.length, 0);
  assert.equal(env.nav.slot.enabled(), false);
});
await check("external teleport: Circular/Linear re-sync to the nearest Point; Once holds", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Circular, points: [P(0), P(200), P(400), P(600)] });
  await env.tick();
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
  env.world.setPoseRel(410, 5);
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 2, "≥ 30 m jump between ticks → nearest Point");
  assert.equal(env.follows.at(-1)[0], env.router.route[0], "walking the new waypoint");
  const env2 = await makeEnv();
  env2.nav.load({ routeType: ROUTE.Once, points: [P(0), P(200), P(400), P(600)] });
  await env2.tick();
  await env2.tick();
  env2.world.setPoseRel(410, 5);
  await env2.tick();
  assert.equal(env2.nav.route().activeIndex, 1, "Once holds");
  // walked into a portal: a portalIn signal (no executor expecting it) re-syncs
  // once the tunnel ends, even though the nav ticks around it were not consecutive
  const env3 = await makeEnv();
  env3.nav.load({ routeType: ROUTE.Linear, points: [P(0), P(200), P(400)] });
  await env3.tick();
  await env3.tick();
  assert.equal(env3.nav.route().activeIndex, 1);
  env3.signals.emit("portalIn", { seq: 1 });
  env3.world.portal = true;
  await env3.run(2000);
  assert.equal(env3.nav.route().activeIndex, 1, "held in portal space");
  env3.world.portal = false;
  env3.world.setPoseRel(430);
  await env3.run(4500);
  assert.equal(env3.nav.route().activeIndex, 2);
});

// ── stuck ladder ───────────────────────────────────────────────────────────
async function stuckRun(routeType) {
  const jumps = [];
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: async (c, leg, tune) => (jumps.push({ leg, tune }), { ok: true }) };
  const env = await makeEnv({ gotoCompose: gc });
  env.world.frozen = true;
  env.nav.load({ routeType, points: [P(10), P(-30)] });
  env.nav.setActive(0);
  return { env, jumps };
}
await check("stuck ladder: re-issue ×2 → directional jump → skip (Circular)", async () => {
  const { env, jumps } = await stuckRun(ROUTE.Circular);
  await env.tick();
  assert.equal(env.follows.length, 1);
  await env.run(17_000);
  assert.equal(env.follows.length, 2, "rung 1: re-issue");
  await env.run(17_000);
  assert.equal(env.follows.length, 3, "rung 1: second re-issue");
  await env.run(17_000);
  assert.equal(jumps.length, 1, "rung 2: directional jump");
  assert.equal(jumps[0].leg.meta.delayMs, 500);
  assert.equal(jumps[0].tune.direction, "forward");
  assert.ok(Math.abs(jumps[0].leg.meta.headingDeg - 90) < 1, `heading ${jumps[0].leg.meta.headingDeg} (target due east)`);
  assert.equal(env.follows.length, 4, "re-issued after the jump");
  await env.run(17_000);
  assert.equal(env.state.lastResult, "SKIPPED:0:stuck", "rung 3: skip");
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.nav.paused, null);
});
await check("stuck ladder: Once cannot skip → paused {reason:'stuck'} + chat alert", async () => {
  const { env } = await stuckRun(ROUTE.Once);
  await env.run(70_000);
  assert.equal(env.state.lastResult, "FAILED:0:stuck");
  assert.equal(env.nav.paused.reason, "stuck");
  assert.ok(env.world.chat.some((l) => /navigation paused/.test(l)));
});

// ── loads / state ──────────────────────────────────────────────────────────
await check("loadEmbedded with navText '' clears the active nav; a real text loads it", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Circular, points: [P(10), P(20)] });
  const g = env.nav.generation;
  const r = env.nav.loadEmbedded("runback", { displayName: "runback", routeType: ROUTE.Once, navText: "" });
  assert.equal(r.ok, true);
  assert.equal(env.nav.isEmpty(), true);
  assert.equal(env.nav.route().name, "runback");
  assert.ok(env.nav.generation > g);
  const text = "uTank2 NAV 1.2\r\n4\r\n1\r\n0\r\n" + at(10).ew + "\r\n" + at(10).ns + "\r\n0\r\n0\r\n";
  const r2 = env.nav.loadEmbedded("x", { displayName: "Leg", routeType: ROUTE.Once, navText: text });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(env.nav.route().routeType, ROUTE.Once);
  assert.equal(env.nav.route().points.length, 1);
  assert.equal(env.nav.loadEmbedded("y", { navText: "junk" }).ok, false);
});
await check("loadByName: synchronous, sets the navProfile ref, keeps EnableNavigation; unknown name keeps the route (R15)", async () => {
  const profiles = await makeProfiles();
  profiles.put("Hunt", { routeType: ROUTE.Circular, points: [P(100), P(2), P(50)] });
  const env = await makeEnv({ profiles, options: fakeOptions({ EnableNavigation: false }) });
  env.nav.load({ routeType: ROUTE.Once, points: [P(5)] }, { name: "cur" });
  const r = env.nav.loadByName("hunt");
  assert.equal(r.ok, true);
  assert.equal(env.nav.isEmpty(), false, "non-empty within the same call");
  assert.equal(env.nav.route().name, "Hunt");
  assert.equal(env.nav.route().activeIndex, 1, "nearest Point");
  assert.equal(env.options.refs.navProfile, "Hunt");
  assert.equal(env.options.v.EnableNavigation, false);
  const bad = env.nav.loadByName("missing");
  assert.equal(bad.ok, false);
  assert.equal(env.nav.route().name, "Hunt");
});
await check("save(name) overwrites, clears dirty/reversed and sets the ref; empty route allowed", async () => {
  const profiles = await makeProfiles();
  const env = await makeEnv({ profiles });
  env.nav.load({ routeType: ROUTE.Linear, points: [P(1), P(2), P(3)] });
  env.nav.reverse(true);
  env.nav.add(P(4));
  assert.equal(env.nav.status().dirty, true);
  assert.equal(env.nav.save("Mine").ok, true);
  const st = env.nav.status();
  assert.equal(st.dirty, false);
  assert.equal(st.reversed, false);
  assert.equal(st.name, "Mine");
  assert.deepEqual(profiles.get("mine").points.map((p) => Math.round((p.ew - BASE_EW) * 240)), [3, 2, 1, 4], "on-screen order (Q4)");
  env.nav.clear();
  assert.equal(env.nav.save("Mine").ok, true);
  assert.equal(profiles.get("Mine").points.length, 0);
  assert.equal(env.nav.save("").ok, false);
});
await check("a second ActiveNav on the same state resumes at the same index and Pause remaining time", async () => {
  const state = {};
  const world = makeWorld();
  const env1 = await makeEnv({ state, world });
  env1.nav.load({ routeType: ROUTE.Once, points: [P(0), { type: POINT.Pause, ew: 0, ns: 0, z: 0, pauseMs: 5000 }, P(20)] });
  await env1.tick();
  await env1.tick();
  assert.equal(env1.nav.route().activeIndex, 1);
  await env1.run(2000);
  env1.nav.dispose();
  const env2 = await makeEnv({ state, world });
  assert.equal(env2.nav.route().activeIndex, 1);
  await env2.run(2500);
  assert.equal(env2.nav.route().activeIndex, 1, "still pausing (≈0.5 s left)");
  await env2.run(800);
  assert.equal(env2.nav.route().activeIndex, 2, "the dwell was not restarted");
  assert.equal(env1.signals.count(), 0, "dispose unsubscribed");
});
await check("addHere: Point at the pose (Z = pose.z/240); Jump defaults; Pause/Chat need fields; Follow Add sets the target (R5, R19)", async () => {
  const env = await makeEnv();
  env.world.setPoseRel(12, 3, 48);
  env.world.heading = 123;
  const r = env.nav.addHere(POINT.Point);
  assert.equal(r.ok, true);
  const p = env.nav.route().points[r.index];
  const pose = env.world.pose;
  const e = legToNavPoint(pose.objCellId, pose.x, pose.y, pose.z);
  assert.equal(p.ew, e.ew);
  assert.equal(p.ns, e.ns);
  assert.equal(p.z, 48 / 240);
  const j = env.nav.addHere(POINT.Jump, { direction: "straferight", delayMs: 400 });
  const jp = env.nav.route().points[j.index];
  assert.equal(jp.headingDeg, 123);
  assert.equal(jp.holdShift, false);
  assert.deepEqual(jp.ext, { direction: "straferight" });
  assert.equal(env.nav.addHere(POINT.Pause, {}).ok, false);
  const pz = env.nav.addHere(POINT.Pause, { seconds: 2 });
  assert.equal(env.nav.route().points[pz.index].pauseMs, 2000);
  assert.equal(env.nav.addHere(POINT.Chat, { text: " " }).ok, false);
  const above = env.nav.addHere(POINT.Checkpoint, {}, { mode: "above", selected: 0 });
  assert.equal(above.index, 0);
  env.world.addObject(0x7a000099, "Portal to Somewhere", 13, 3, 0x40000);
  const pp = env.nav.addHere(POINT.Point, { targetGuid: 0x7a000099 });
  const pt = env.nav.route().points[pp.index];
  assert.equal(pt.type, POINT.PortalNPC, "a selected portal becomes Portal/NPC");
  assert.equal(pt.objectClass, 14);
  assert.equal(pt.name, "Portal to Somewhere");
  env.nav.setType(ROUTE.Follow);
  env.world.addObject(0x50000002, "Alice", 5, 0, 0x8);
  const f = env.nav.addHere(POINT.Point, { targetGuid: 0x50000002 });
  assert.equal(f.ok, true);
  assert.deepEqual(env.nav.route().followTarget, { guid: 0x50000002, name: "Alice" });
  assert.equal(env.nav.addHere(POINT.Point, {}).ok, false);
});
await check("indoors (same landblock EnvCell) the leg uses the pose's cell and arrival needs |Δz| < 3 m", async () => {
  const env = await makeEnv();
  const cell = (env.world.pose.objCellId & 0xffff0000) | 0x0105;
  env.world.pose = { ...env.world.pose, objCellId: cell >>> 0, z: 12 };
  const pt = { type: POINT.Point, ...legToNavPoint(cell, env.world.pose.x + 1, env.world.pose.y, 0), flag: "0" };
  pt.z = pt.navZ;
  delete pt.navZ;
  env.world.frozen = true;
  env.nav.load({ routeType: ROUTE.Once, points: [pt, P(30)] });
  await env.tick();
  assert.equal(env.follows[0][0].lb, cell >>> 0, "issued in the pose's EnvCell");
  await env.run(500);
  assert.equal(env.nav.route().activeIndex, 0, "1 m away in x/y but 12 m above: not arrived");
  assert.equal(env.follows.length, 1, "no per-tick re-issue storm");
  await env.run(3000);
  assert.equal(env.follows.length, 2, "re-issued once after 3 s (a stuck-ladder rung)");
  env.world.pose = { ...env.world.pose, z: 1 };
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1);
});

// ── boost / jump gating ────────────────────────────────────────────────────
await check("Boost Nav: gentle yields when attacked; strict does not; both yield to buffing (O17, D39)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Circular, points: [P(10), P(20)] });
  const s = env.nav.slot;
  assert.equal(s.rank(), "beforeIdle");
  assert.equal(s.wants({ buffNeeded: true }), true, "unboosted: the kernel ladder already ranks buffing first");
  assert.equal(s.wants({ lootPinned: true }), true, "unboosted: the ladder already ranks an in-flight loot first");
  env.options.v.BoostNavPriority = true;
  assert.equal(s.rank(), "beforeCombat");
  assert.equal(s.wants({}), true);
  assert.equal(s.wants({ underAttack: true, threat: true }), false, "gentle: a fight-back declines");
  assert.equal(s.wants({ underAttack: true, corpse: true }), false, "gentle: the after-kill corpse is looted first");
  assert.equal(s.wants({ underAttack: true }), true, "gentle: attacked with nothing to fight keeps walking (logic-2)");
  assert.equal(s.wants({ threat: true }), true, "gentle: boost outranks attacking when not attacked");
  assert.equal(s.wants({ corpse: true }), true, "gentle: boost outranks a corpse not yet started");
  assert.equal(s.wants({ buffNeeded: true }), false);
  assert.equal(s.wants({ buffPinned: true }), false);
  assert.equal(s.wants({ lootPinned: true }), false, "gentle: a loot in flight finishes first (regress-1)");
  env.options.v.BoostNavStrict = true;
  assert.equal(s.rank(), "beforeCombatPinned");
  assert.equal(s.wants({ underAttack: true }), true);
  assert.equal(s.wants({ underAttack: true, threat: true }), true);
  assert.equal(s.wants({ buffNeeded: true }), false);
  assert.equal(s.wants({ buffPinned: true }), false);
  assert.equal(s.wants({ lootPinned: true }), false, "strict: a loot in flight finishes first (regress-1)");
  assert.equal(s.wants({ inCombat: true, threat: true }), true);
});
// The REAL kernel + loot loop + unwedge reflex around a gentle-boosted
// ActiveNav (review regress-1 / logic-2): the aux ladder, the loot
// transaction and the "commanded movement" reads all interact.
async function makeKernelRig({ corpse = true, route = "pause" } = {}) {
  const { RynthBotKernel } = await import("../rynth/kernel.js");
  const { RynthLootLoop } = await import("../rynth/loot_loop.js");
  const { UnwedgeReflex } = await import("../rynth/unwedge.js");
  const world = makeWorld();
  Object.assign(world.host, {
    IsPlayerReady: () => true,
    onTick() {},
    onEvent() {},
    StopStick() {},
    GetCastBusyState: () => 0,
    GetGroundContainerId: () => 0, // the corpse never opens: OPEN runs to its own retry limit
    GetContainerContents: () => [],
    CloseContainer: () => true,
    TryGetObjectWcid: (g) => world.objects.get(g >>> 0)?.wcid ?? null,
  });
  const logs = [];
  const router = new RynthRouter(world.host, { log: () => {} });
  const options = fakeOptions({ BoostNavPriority: true });
  const loot = new RynthLootLoop(world.host, { log: (m) => logs.push(`[loot] ${m}`) });
  const bot = fakeBot();
  bot.router = router;
  bot.loot = loot;
  bot.kernel = null;
  // bot.js movementClaimed, the parts reachable here.
  bot.movementClaimed = () => {
    const rs = router.status && router.status.state;
    return rs === "WALK" || rs === "PORTAL" || loot.state === "APPROACH" || bot.claims.size > 0;
  };
  const nav = new ActiveNav({ host: world.host, router, bot, options, profiles: await makeProfiles(), state: {}, subscribe: () => () => {}, gotoCompose: goto, log: (m) => logs.push(`[nav] ${m}`), now });
  const rig = { world, router, loot, nav, logs, underAttack: true, actions: [] };
  const combat = { locked: 0, enabled: true, _scanTargets: () => [], canEngage: () => true, disengage() {}, tick() {}, underAttack: () => rig.underAttack };
  const buff = { enabled: true, pending: null, status: { ready: true, active: 1, desired: 1, pending: 0, blocked: false }, heartbeat() {}, tick() {} };
  const aux = { slots: [nav.slot], idleHooks: [], policy: { boostLoot: () => false }, status: () => ({}) };
  const unwedge = new UnwedgeReflex(world.host, { log: (m) => logs.push(`[unwedge] ${m}`), livelockRecall: false, adminTeleFallback: false, now });
  const k = new RynthBotKernel(world.host, { combat, buff, loot, vitals: null, unwedge, aux }, { log: (m) => logs.push(`[kernel] ${m}`) });
  bot.kernel = k;
  unwedge.bot = bot;
  k._running = true;
  rig.kernel = k;
  rig.unwedge = unwedge;
  if (route === "pause") nav.load({ routeType: ROUTE.Circular, points: [P(0, 0), { type: POINT.Pause, ew: 0, ns: 0, z: 0, pauseMs: 30_000 }, P(0, 1)] });
  else nav.load({ routeType: ROUTE.Circular, points: [P(0, 40), P(0, -40)] });
  if (corpse) {
    world.addObject(0xc0, "Corpse of Drudge", 15, 0);
    world.objects.get(0xc0).wcid = 21;
  }
  rig.tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.t += 100;
      world.step(100);
      router.tick();
      unwedge.tick();
      k.tick();
      rig.actions.push([k.action, loot.state]);
      await flush();
    }
  };
  return rig;
}
await check("gentle Boost Nav: a loot already in flight finishes before Navigate takes the tick; no false unwedge recovery during a VT Pause (regress-1)", async () => {
  const rig = await makeKernelRig({ corpse: true, route: "pause" });
  await rig.tick(21); // 2 s of corpse walk while the attacker grace runs
  assert.equal(rig.kernel.action, "Loot");
  assert.equal(rig.loot.state, "APPROACH");
  rig.underAttack = false; // the grace ends mid-approach
  await rig.tick(600); // 60 s
  const navWhileLooting = rig.actions.filter(([a, l]) => a === "Navigate" && l !== "SCAN");
  assert.equal(navWhileLooting.length, 0, `Navigate ran with loot.state ${navWhileLooting[0] && navWhileLooting[0][1]}`);
  assert.equal(rig.loot.state, "SCAN", "the loot transaction ended by its own limits");
  assert.equal(rig.kernel.action, "Navigate", "then the boosted route resumes");
  const wedged = rig.logs.filter((l) => /WEDGED/.test(l));
  assert.deepEqual(wedged, [], "no unwedge recovery during the Pause dwell");
  assert.equal(rig.unwedge.state, "MONITOR");
});
await check("gentle Boost Nav: attacked with nothing to fight keeps walking instead of idling (logic-2)", async () => {
  const rig = await makeKernelRig({ corpse: false, route: "walk" });
  await rig.tick(20);
  assert.equal(rig.kernel.action, "Navigate", "not Idle");
  assert.equal(rig.router.status.state, "WALK");
  assert.ok(rig.world.calls.some((c) => c[0] === "MoveToPosition"), "a router leg is issued");
});
await check("meta-visible nav state (R22/R9): onReversed on reverse and on a load that changes the flag; onResult with DONE/FAILED (review guide-3)", async () => {
  const seenRev = [];
  const seenRes = [];
  const world = makeWorld();
  const router = new RynthRouter(world.host, { log: () => {} });
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: async () => ({ ok: false, error: "jump-unavailable: canJumpNow() false" }) };
  const nav = new ActiveNav({
    host: world.host,
    router,
    bot: fakeBot(),
    options: fakeOptions(),
    profiles: await makeProfiles(),
    state: {},
    subscribe: () => () => {},
    gotoCompose: gc,
    onReversed: (v) => seenRev.push(v),
    onResult: (t) => seenRes.push(t),
    log: () => {},
    now,
  });
  nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Jump, ...at(0), z: 0, headingDeg: 0, holdShift: false, delayMs: 100 }] });
  assert.deepEqual(seenRev, [], "a load that keeps reversed=false says nothing");
  assert.equal(nav.reverse(true), true);
  assert.equal(nav.reverse(false), false);
  nav.reverse(true);
  assert.deepEqual(seenRev, [true, false, true]);
  nav.load({ routeType: ROUTE.Circular, points: [P(10), P(20)] });
  assert.deepEqual(seenRev, [true, false, true, false], "a load resets the flag and says so");
  nav.reverse(true);
  assert.equal(nav.save("revsaved").ok, true);
  assert.equal(nav.status().reversed, false, "save stores the on-screen order and clears the flag (Q4)");
  assert.deepEqual(seenRev, [true, false, true, false, true, false], "a save that clears the flag says so");
  assert.equal(nav.save("revsaved2").ok, true);
  assert.deepEqual(seenRev, [true, false, true, false, true, false], "a save of an unreversed route says nothing");
  nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Jump, ...at(0), z: 0, headingDeg: 0, holdShift: false, delayMs: 100 }] });
  for (let i = 0; i < 5; i++) {
    clock.t += 100;
    nav.slot.tick({});
    await flush();
  }
  assert.ok(seenRes.some((t) => /^FAILED:9:/.test(t)), JSON.stringify(seenRes));
  assert.equal(nav.status().lastResult, seenRes.at(-1));
  assert.ok(nav.paused, "FAILED pauses navigation");
  const throwing = new ActiveNav({ host: world.host, router, bot: fakeBot(), options: fakeOptions(), state: {}, onReversed: () => { throw new Error("boom"); }, log: () => {}, now });
  assert.equal(throwing.reverse(true), true, "a throwing callback is isolated");
});

await check("requestJump: refused while held, in portal space, or (kernel stopped) while another mover owns the body (critic B10)", async () => {
  const calls = [];
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: async (c, leg, tune) => (calls.push({ leg, tune }), { ok: true }) };
  const env = await makeEnv({ gotoCompose: gc });
  env.bot.kernel.operatorHeld = true;
  assert.equal(env.nav.requestJump({ headingDeg: 90, shift: true, ms: 500 }).ok, false);
  env.bot.kernel.operatorHeld = false;
  env.world.portal = true;
  assert.equal(env.nav.requestJump({ headingDeg: 90 }).ok, false);
  env.world.portal = false;
  env.bot.kernel.running = false;
  env.bot.extraClaim = true;
  const r = env.nav.requestJump({ headingDeg: 90, shift: true, ms: 500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /mover/);
  assert.equal(calls.length, 0);
  assert.equal(env.nav.requestJump({ headingDeg: 360 }).ok, false, "heading range");
  assert.equal(env.nav.requestJump({ headingDeg: 10, ms: 1500 }).ok, false, "charge range");
  assert.equal(env.nav.requestJump({ headingDeg: 10, direction: "up" }).ok, false, "direction");
});
await check("requestJump: kernel stopped + body free → runs at once under claimMovement('rs-jump')", async () => {
  const calls = [];
  let resolve;
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: (c, leg, tune) => (calls.push({ leg, tune }), new Promise((r) => (resolve = r))) };
  const env = await makeEnv({ gotoCompose: gc });
  env.bot.kernel.running = false;
  const r = env.nav.requestJump({ headingDeg: 45, shift: false, ms: 250 });
  assert.equal(r.ok, true);
  assert.equal(r.queued, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].leg.meta, { navType: "jmp", headingDeg: 45, holdShift: false, delayMs: 250 });
  assert.equal(calls[0].tune.direction, "none", "VTank /rs jump = in place");
  assert.deepEqual(env.bot.tags(), ["rs-jump"]);
  assert.equal(env.nav.requestJump({ headingDeg: 1 }).ok, false, "one jump at a time");
  resolve({ ok: true });
  await flush();
  await flush();
  assert.equal(env.bot.tags().length, 0, "claim released");
  assert.equal(env.state.lastJump.ok, true);
});
await check("requestJump: kernel running → queued for the JumpNow slot (pinned) which fires it", async () => {
  const calls = [];
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: async (c, leg, tune) => (calls.push({ leg, tune }), { ok: true }) };
  const env = await makeEnv({ gotoCompose: gc });
  env.world.heading = 200;
  const r = env.nav.requestJump({ shift: true, ms: 800, direction: "forward" });
  assert.equal(r.queued, true);
  assert.equal(calls.length, 0);
  assert.equal(env.nav.jumpSlot.enabled(), true);
  assert.equal(env.nav.jumpSlot.pinned(), true);
  env.nav.jumpSlot.tick({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].leg.meta.headingDeg, 200, "no heading → current compass heading");
  assert.equal(calls[0].tune.direction, "forward");
  await flush();
  await flush();
  assert.equal(env.nav.jumpSlot.enabled(), false);
  env.nav.requestJump({ headingDeg: 5 });
  env.nav.jumpSlot.onLeave("Vitals");
  assert.equal(env.nav.jumpSlot.enabled(), false, "a queued jump is dropped when the kernel moves on");
});

// ── acceptance: the guide's death / runback example (G:294-319) ────────────
await check("ACCEPTANCE: guide death example — Once 'runback' runs to empty, then Circular 'fighting' laps", async () => {
  const profiles = await makeProfiles();
  profiles.put("runback", { routeType: ROUTE.Once, points: [P(0), P(25), P(50), P(75, 10)] });
  profiles.put("fighting", { routeType: ROUTE.Circular, points: [P(80, 10), P(100, 10), P(100, 30), P(80, 30)] });
  const lines = [];
  let env;
  // the meta's Chat actions, applied synchronously (what CMD does for these lines)
  const runChat = (l) => {
    lines.push(l);
    const m = /^\/vt nav load (\S+)$/.exec(l);
    if (m) env.nav.loadByName(m[1]);
    if (l === "/vt opt set enablenav true") env.nav.setEnabled(true);
  };
  env = await makeEnv({ profiles, runChat, options: fakeOptions({ EnableNavigation: false }) });
  // dead state: "/vt nav load runback", "/vt opt set enablenav true"
  runChat("/vt nav load runback");
  runChat("/vt opt set enablenav true");
  assert.equal(env.nav.route().name, "runback");
  const seen = [];
  const done = await env.until(() => {
    if (env.nav.isEmpty()) return true;
    const i = env.nav.route().activeIndex;
    if (seen.at(-1) !== i) seen.push(i);
    return false;
  }, 60_000);
  assert.ok(done, "runback reached NavEmpty");
  assert.deepEqual(seen, [1, 2, 3], "walked every runback waypoint in order");
  assert.equal(env.nav.status().enabled, true, "nav stays enabled after a Once route");
  assert.equal(env.nav.status().finished, true);
  const p = env.world.poseW();
  const end = W(75, 10);
  assert.ok(Math.hypot(p.wx - end.wx, p.wy - end.wy) <= 3, "stood at the end of the runback");
  // back state (NavEmpty fired): "/vt nav load fighting"
  runChat("/vt nav load fighting");
  assert.equal(env.nav.isEmpty(), false);
  assert.equal(env.nav.route().name, "fighting");
  assert.equal(env.nav.route().activeIndex, 0, "nearest Point of 'fighting'");
  const laps = [];
  let last = env.nav.route().activeIndex;
  const endT = clock.t + 60_000;
  while (clock.t < endT) {
    await env.tick();
    const i = env.nav.route().activeIndex;
    if (i !== last) {
      laps.push(i);
      last = i;
    }
  }
  const wraps = laps.filter((i, k) => i === 0 && (k === 0 ? false : laps[k - 1] === 3)).length;
  assert.ok(wraps >= 2, `Circular wrapped ${wraps} time(s): ${laps.join(",")}`);
  assert.equal(env.nav.isEmpty(), false, "a Circular route never empties");
  assert.equal(env.nav.paused, null);
  assert.deepEqual(lines.slice(0, 3), ["/vt nav load runback", "/vt opt set enablenav true", "/vt nav load fighting"]);
});

// ── verifier additions (W1-6 review) ───────────────────────────────────────
await check("time outside the slot (combat) never consumes a waypoint's budget: Recall before its cast, OpenVendor after its use", async () => {
  const env = await makeEnv();
  env.world.busy = 1; // the recall waits on the busy gate: not cast, not pinned
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }, P(20)] });
  await env.tick();
  assert.equal(count(env.world, "CastUntargetedSafe"), 0);
  assert.equal(env.nav.slot.pinned(), false);
  env.nav.slot.onLeave("Combat");
  clock.t += 70_000; // a 70 s fight
  env.world.busy = 0;
  env.nav.slot.tick({});
  assert.equal(env.state.lastResult, null, "not FAILED for time it was not running");
  assert.equal(env.nav.paused, null);
  assert.equal(count(env.world, "CastUntargetedSafe"), 1, "casts on resume");
  // OpenVendor: used, then a 30 s fight before the window opens
  const env2 = await makeEnv();
  const VG = 0x90000011;
  env2.world.addObject(VG, "Thomas the Merchant", 2, 0, 0x200);
  env2.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.OpenVendor, ...at(1), z: 0, vendorId: VG, name: "Thomas the Merchant" }, P(40)] });
  await env2.tick();
  assert.equal(count(env2.world, "UseObject"), 1);
  env2.nav.slot.onLeave("Combat");
  clock.t += 30_000;
  env2.nav.slot.tick({});
  assert.equal(env2.state.lastResult, null, "the 20 s vendor wait did not expire during the fight");
  assert.equal(count(env2.world, "UseObject"), 2, "re-uses the vendor on resume");
  env2.signals.emit("vendorOpen", { guid: VG, name: "Thomas the Merchant" });
  env2.nav.slot.tick({});
  assert.equal(env2.state.lastResult, "DONE:5");
  // the budget still runs while the slot is selected (20 s active ⇒ FAILED)
  const env3 = await makeEnv();
  env3.world.addObject(VG, "Thomas the Merchant", 2, 0, 0x200);
  env3.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.OpenVendor, ...at(1), z: 0, vendorId: VG, name: "Thomas the Merchant" }] });
  await env3.run(10_000);
  env3.nav.slot.onLeave("Vitals");
  clock.t += 5_000;
  await env3.run(10_500);
  assert.match(env3.state.lastResult, /^FAILED:5:vendor did not open/, "10 s + 10.5 s active");
});
await check("without a portal-space presentation (nullRender) the settle waits for the transit to end (portalOut), not the PlayerTeleport", async () => {
  const env = await makeEnv(); // world.portal stays false: no presentation
  const G = 0x7a000031;
  env.world.addObject(G, "Portal to Holtburg", 2, 0, 0x40000);
  env.world.onUse = () => {
    env.world.onUse = null;
    env.signals.emit("portalIn", { seq: 7 }); // kind 33: the transit starts, the pose has not moved
  };
  const ptl = { type: POINT.PortalNPC, ...at(1), z: 0, name: "Portal to Holtburg", objectClass: 14, isTie: false, exitEW: at(2).ew, exitNS: at(2).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [ptl, P(5010)] });
  await env.tick();
  assert.equal(count(env.world, "UseObject"), 1);
  await env.run(6_000); // longer than PostPortalDelaySec: the far side has not landed yet
  assert.equal(env.nav.route().activeIndex, 0, "still in transit");
  env.world.objects.delete(G);
  env.world.setPoseRel(5000, 0);
  env.signals.emit("teleportArrived", { cell: env.world.pose.objCellId });
  env.signals.emit("portalOut", {}); // host_signals: kind 66 with no presentation
  await env.run(3_500);
  assert.equal(env.nav.route().activeIndex, 0, "settling PostPortalDelaySec from the arrival");
  await env.run(1_000);
  assert.equal(env.nav.route().activeIndex, 1);
  assert.equal(env.state.lastResult, "DONE:6");
});
await check("Portal/NPC: walking into the portal on the approach completes the waypoint (ACE Portal.OnCollideObject), even on a Once route", async () => {
  const env = await makeEnv();
  const G = 0x7a000032;
  env.world.addObject(G, "Portal to Holtburg", 20, 0, 0x40000);
  const ptl = { type: POINT.PortalNPC, ...at(18), z: 0, name: "Portal to Holtburg", objectClass: 14, isTie: false, exitEW: at(20).ew, exitNS: at(20).ns, exitZ: 0 };
  env.nav.load({ routeType: ROUTE.Once, points: [ptl, P(5010)] });
  let hopped = false;
  const end = clock.t + 30_000;
  while (clock.t < end && env.nav.route().activeIndex === 0) {
    await env.tick();
    const p = env.world.poseW();
    const portal = W(20);
    if (!hopped && Math.hypot(p.wx - portal.wx, p.wy - portal.wy) < 3.6) { // a large portal: touched before the 3 m use range
      hopped = true;
      env.world.portal = true; // the presentation runs this time
      env.signals.emit("portalIn", { seq: 9 });
      env.world.objects.delete(G);
      env.world.setPoseRel(5000, 0);
      await env.run(2_000);
      env.world.portal = false;
      env.signals.emit("portalOut", {});
    }
  }
  assert.ok(hopped, "walked into the portal");
  assert.equal(count(env.world, "UseObject"), 0, "never needed a use");
  assert.equal(env.nav.route().activeIndex, 1, "advanced to the far-side waypoint");
  assert.equal(env.state.lastResult, "DONE:6");
  assert.ok(!env.logs.some((l) => /external teleport/.test(l)), "not treated as an external teleport");
});
await check("slot.pinned() is false once navigation is disabled mid-recall (no kernel pin on a slot that will not tick)", async () => {
  const env = await makeEnv();
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Recall, ew: 0, ns: 0, z: 0, spellId: 1635 }] });
  await env.tick();
  assert.equal(env.nav.slot.pinned(), true, "casting");
  env.nav.setEnabled(false);
  assert.equal(env.nav.slot.enabled(), false);
  assert.equal(env.nav.slot.pinned(), false);
  assert.equal(env.nav.slot.wants({}), false);
});
await check("a jump job still in the air when its executor is reset (pause/resume, setActive) is waited for: no second attemptJumpLeg, no /rs jump until it lands (review runtime-2)", async () => {
  const resolvers = [];
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: () => new Promise((r) => resolvers.push(r)) };
  const env = await makeEnv({ gotoCompose: gc });
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Jump, ...at(0), z: 0, headingDeg: 0, holdShift: false, delayMs: 300 }, P(30)] });
  await env.tick();
  assert.equal(resolvers.length, 1, "job 1 started");
  env.nav.pause("test");
  env.nav.resume();
  await env.run(2000);
  assert.equal(resolvers.length, 1, "no second attemptJumpLeg while job 1 is in the air");
  assert.equal(env.nav.slot.pinned(), true, "the slot stays pinned meanwhile");
  assert.equal(env.nav.status().blockedBy, "a previous jump is still landing");
  const r = env.nav.requestJump({ headingDeg: 90 });
  assert.equal(r.ok, false, "/rs jump refused");
  assert.match(r.error, /jump is already in progress/);
  env.nav.setActive(0);
  await env.run(500);
  assert.equal(resolvers.length, 1, "setActive does not start a second job either");
  assert.equal(count(env.world, "MoveToPosition"), 0, "nor a router leg");
  resolvers[0]({ ok: true });
  await flush();
  await env.tick();
  assert.equal(resolvers.length, 2, "then the waypoint is retried fresh (resume semantics)");
  assert.equal(env.nav.status().blockedBy, null);
  resolvers[1]({ ok: true });
  await flush();
  await env.tick();
  assert.equal(env.nav.route().activeIndex, 1, "the jump waypoint completes");
  // The Point stuck-rung jump is kept the same way.
  const res2 = [];
  const gc2 = { buildTune: goto.buildTune, attemptJumpLeg: () => new Promise((r2) => res2.push(r2)) };
  const env2 = await makeEnv({ gotoCompose: gc2 });
  env2.world.frozen = true;
  env2.nav.load({ routeType: ROUTE.Once, points: [P(40)] });
  assert.ok(await env2.until(() => res2.length === 1, 120_000), "the stuck ladder reaches its jump");
  const legs = count(env2.world, "MoveToPosition");
  env2.nav.pause("test");
  env2.nav.resume();
  await env2.run(1500);
  assert.equal(count(env2.world, "MoveToPosition"), legs, "no new router leg while the stuck jump is in the air");
  assert.equal(env2.nav.requestJump({ headingDeg: 10 }).ok, false);
  res2[0]({ ok: false, error: "jump-unavailable" });
  await flush();
  await env2.tick();
  assert.ok(count(env2.world, "MoveToPosition") > legs, "a fresh leg once it has landed");
});

await check("requestJump is refused while a nav Jump waypoint is in the air (no concurrent attemptJumpLeg)", async () => {
  let jobs = 0;
  const gc = { buildTune: goto.buildTune, attemptJumpLeg: () => (jobs++, new Promise(() => {})) };
  const env = await makeEnv({ gotoCompose: gc });
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.Jump, ...at(0), z: 0, headingDeg: 0, holdShift: false, delayMs: 300 }] });
  await env.tick();
  assert.equal(jobs, 1);
  const r = env.nav.requestJump({ headingDeg: 90, ms: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /nav jump/);
  env.nav.jumpSlot.tick({});
  assert.equal(jobs, 1);
});
await check("an action waypoint far away: the walk to it does not consume its 60 s find budget", async () => {
  const VG = 0x90000021;
  const env = await makeEnv({ world: makeWorld({ speed: 2 }) }); // 200 m at 2 m/s = 100 s (leg watchdog 120 s)
  env.nav.load({ routeType: ROUTE.Once, points: [{ type: POINT.OpenVendor, ...at(200), z: 0, vendorId: VG, name: "Far Vendor" }] });
  let seen = false;
  const end = clock.t + 150_000;
  while (clock.t < end && count(env.world, "UseObject") === 0) {
    await env.tick(200);
    const p = env.world.poseW();
    const v = W(201);
    if (!seen && Math.hypot(p.wx - v.wx, p.wy - v.wy) < 20) {
      seen = true; // comes into view (NearbyGuids) only when close
      env.world.addObject(VG, "Far Vendor", 201, 0, 0x200);
    }
  }
  assert.ok(seen, "walked to the waypoint");
  assert.equal(env.state.lastResult, null, `not FAILED on the way (${env.state.lastResult})`);
  assert.equal(count(env.world, "UseObject"), 1);
  env.signals.emit("vendorOpen", { guid: VG, name: "Far Vendor" });
  await env.tick();
  assert.equal(env.state.lastResult, "DONE:5");
});
await check("C9: add/addHere/requestJump never throw on a null options argument", async () => {
  const env = await makeEnv();
  assert.equal(env.nav.add(P(1), null), 0);
  assert.equal(env.nav.addHere(POINT.Point, {}, null).ok, true);
  assert.equal(typeof env.nav.requestJump(null).ok, "boolean");
});

Date.now = realNow;

// ── goto_compose edits owned by NAV (real clock; the primitives await real timers) ──
const FAST = { ...goto.buildTune({ pollMs: 2 }), jumpTurnTimeoutMs: 20, jumpApproachMinMs: 1, jumpApproachMaxMs: 3, jumpAirborneTimeoutMs: 6, jumpLandingPollMs: 1, jumpLandingSettlePadMs: 1 };
function jumpHost() {
  const h = { moves: [], jumps: [] };
  Object.assign(h, {
    TryGetPlayerPose: () => ({ objCellId: 0x05050001, x: 1, y: 1, z: 0 }), // no heading → no turn
    CanJumpNow: () => true,
    SetMovementInput: (f, s, t, run) => h.moves.push([f, s, t, run]),
    Jump: (p) => h.jumps.push(p),
  });
  return h;
}
await check("goto_compose: the five primitives are exported (named + default export)", () => {
  for (const k of ["findEntityByName", "attemptMetaPortalTouch", "attemptJumpLeg", "attemptDoorOpen", "buildTune"]) {
    assert.equal(typeof goto[k], "function", `named ${k}`);
    assert.equal(goto.default[k], goto[k], `default.${k}`);
  }
  assert.equal(goto.default.attemptRecallCast, goto.attemptRecallCast);
});
await check("goto_compose: attemptJumpLeg honours tune.direction (forward default = today; none = in place)", async () => {
  const leg = { meta: { navType: "jmp", headingDeg: 0, holdShift: false, delayMs: 200 } };
  const want = { forward: [1, 0], back: [-1, 0], strafeleft: [0, -1], straferight: [0, 1] };
  for (const [dir, [f, s]] of Object.entries(want)) {
    const h = jumpHost();
    const r = await goto.attemptJumpLeg({ host: h }, leg, { ...FAST, direction: dir });
    assert.equal(r.ok, true, dir);
    assert.equal(r.direction, dir);
    assert.deepEqual(h.moves[0], [f, s, 0, true], dir);
    assert.deepEqual(h.moves.at(-1), [0, 0, 0, false], `${dir} released`);
    assert.equal(h.jumps.length, 1);
  }
  const none = jumpHost();
  const rn = await goto.attemptJumpLeg({ host: none }, leg, { ...FAST, direction: "none" });
  assert.equal(rn.ok, true);
  assert.deepEqual(none.moves, [], "no movement input for an in-place hop");
  assert.equal(none.jumps.length, 1);
  const dflt = jumpHost();
  await goto.attemptJumpLeg({ host: dflt }, leg, FAST);
  assert.deepEqual(dflt.moves[0], [1, 0, 0, true], "no direction = forward (replayRoute unchanged)");
  const odd = jumpHost();
  await goto.attemptJumpLeg({ host: odd }, leg, { ...FAST, direction: "sideways" });
  assert.deepEqual(odd.moves[0], [1, 0, 0, true], "unknown = forward");
});
await check("goto_compose: attemptRecallCast casts through CastUntargetedSafe when spell records exist, legacy CastSpell(0) on a stale pkg", async () => {
  async function run(extra) {
    const calls = [];
    let pose = { objCellId: 0x05050001, x: 1, y: 1, z: 0 };
    const host = {
      s: { playerKnownSpells: () => [1635] },
      TryGetPlayerPose: () => pose,
      CastSpell: (t, id) => (calls.push(["CastSpell", t, id]), (pose = { objCellId: 0x40400001, x: 5, y: 5, z: 0 }), true),
      CastUntargetedSafe: (id) => (calls.push(["CastUntargetedSafe", id]), (pose = { objCellId: 0x40400001, x: 5, y: 5, z: 0 }), true),
      ...extra,
    };
    const r = await goto.attemptRecallCast({ host }, { meta: { spellId: 1635, spellName: "Lifestone Recall" } }, { ...FAST, recallTeleportMs: 200, castTokenWaitMs: 5 });
    return { ok: r.ok, calls };
  }
  let r = await run({ has: (c) => c === "GetSpellRecord" });
  assert.deepEqual(r, { ok: true, calls: [["CastUntargetedSafe", 1635]] });
  r = await run({ has: () => false });
  assert.deepEqual(r, { ok: true, calls: [["CastSpell", 0, 1635]] }, "stale pkg keeps today's pass-through");
  r = await run({ CastUntargetedSafe: undefined });
  assert.deepEqual(r, { ok: true, calls: [["CastSpell", 0, 1635]] }, "old host shape (rynth_goto_compose_test fakes)");
});

console.log(fail === 0 ? `rynth_vt_active_nav: all ${pass} checks passed` : `rynth_vt_active_nav: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
