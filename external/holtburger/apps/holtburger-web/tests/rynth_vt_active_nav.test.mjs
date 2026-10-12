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
// `/rs jump` gating, the router's per-leg arriveM, and the guide's
// death/runback example (a Once "runback" and a Circular "fighting" route).
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
  const env = await makeEnv();
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
  env.options.v.BoostNavPriority = true;
  assert.equal(s.rank(), "beforeCombat");
  assert.equal(s.wants({}), true);
  assert.equal(s.wants({ underAttack: true }), false);
  assert.equal(s.wants({ buffNeeded: true }), false);
  assert.equal(s.wants({ buffPinned: true }), false);
  env.options.v.BoostNavStrict = true;
  assert.equal(s.rank(), "beforeCombatPinned");
  assert.equal(s.wants({ underAttack: true }), true);
  assert.equal(s.wants({ buffNeeded: true }), false);
  assert.equal(s.wants({ buffPinned: true }), false);
  assert.equal(s.wants({ inCombat: true, threat: true }), true);
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
