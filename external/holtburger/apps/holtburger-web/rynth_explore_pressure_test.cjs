#!/usr/bin/env node
// rynth_explore_pressure_test.cjs — unit tests for rynth/bot.js's
// ExplorePressureController (task #15, ?explorePressure=1). No infra, no
// network, no wasm: host/router/bot/indoor_router/operator_stop are all
// mocked; the clock is injected (opts.now) so idle-window gating is
// deterministic without real sleeps.
//
// Run: node rynth_explore_pressure_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ---- mock fixtures --------------------------------------------------------
function mkHost(pose, { hasSession = true, nearby = [], descFlags = {}, objPos = {}, objName = {} } = {}) {
  const moves = [];
  const chatCalls = [];
  return {
    _pose: pose,
    s: hasSession ? {} : null,
    TryGetPlayerPose() { return this._pose; },
    MoveToPosition(lb, x, y, z, run) { moves.push({ lb, x, y, z, run }); },
    // Spy only — the operator has explicitly ruled out @telepoi/any chat-
    // parser teleport shortcut for the hard-loop rung (2026-07-21); every
    // escalation test asserts this stays at 0 calls.
    InvokeChatParser(text) { chatCalls.push(text); },
    _chatCalls: chatCalls,
    NearbyGuids: () => nearby,
    TryGetObjectDescFlags: (g) => (g in descFlags ? descFlags[g] : 0),
    TryGetObjectPosition: (g) => objPos[g] ?? null,
    TryGetObjectName: (g) => objName[g] ?? null,
    _moves: moves,
  };
}
function mkRouter(state = "IDLE") {
  return { status: { state } };
}
function mkBot({
  enabled = true, running = false, inflight = null, busy = false, lastMission = null,
  extensions = undefined, travel = undefined,
} = {}) {
  const notes = [];
  const gotoCalls = [];
  const travelCalls = [];
  const bot = {
    ai: {
      director: { enabled, _running: running, _inflight: inflight, _lastCheckAt: null },
      journal: { add: (kind, text) => notes.push({ kind, text: String(text) }) },
      extensions,
    },
    globalRouter: { busy },
    lastMission,
    goto: (to) => { gotoCalls.push(to); return Promise.resolve({ ok: true }); },
    // Always present (spy) so WS-C's escalate-out rung (bot.travel, NOT
    // bot.goto) can be asserted on without every test having to opt in;
    // harmless to tests that never reach that rung.
    travel: (route) => {
      travelCalls.push(route);
      return typeof travel === "function" ? travel(route) : { ok: true };
    },
    _notes: notes,
    _gotoCalls: gotoCalls,
    _travelCalls: travelCalls,
  };
  return bot;
}
// Minimal ExploreMemory double (frozen-contract shape, DESIGN-surveyor-
// frontier WS-A): every method overridable per test; default = "nothing
// found" so a test only needs to specify what it's exercising.
function mkExploreMemory({
  frontier = () => null,
  loopVerdict = () => ({ looping: false, severity: 0, reason: "", correction: "" }),
  variation = () => 0,
  townFrontier = () => null,
} = {}) {
  const observeCalls = [];
  return {
    observe: (pose) => { observeCalls.push(pose); },
    frontier,
    loopVerdict,
    variation,
    townFrontier,
    _observeCalls: observeCalls,
  };
}
const IR = {
  isEnvCellId: (id) => ((id >>> 0) & 0xffff) >= 0x100,
  nearestCell: () => null, // not exercised: fixtures always park the pose ON a graph node
};
// Test-side copy of bot.js's private worldX/worldY/_worldToLandCell — used
// ONLY to compute EXPECTED values independently of the controller under
// test (same convention the pre-existing indoor-sweep test uses for its
// toLegs fixture).
const worldXOf = (cellId, x) => ((cellId >>> 24) & 0xff) * 192 + x;
const worldYOf = (cellId, y) => ((cellId >>> 16) & 0xff) * 192 + y;
function expectedLandCell(tx, ty, z) {
  const lbX = Math.max(0, Math.min(255, Math.floor(tx / 192)));
  const lbY = Math.max(0, Math.min(255, Math.floor(ty / 192)));
  const lx = tx - lbX * 192, ly = ty - lbY * 192;
  const cellIdx = 1 + Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24));
  const lb = (((lbX << 24) | (lbY << 16) | cellIdx) >>> 0);
  return { lb, x: lx, y: ly, z };
}
// tick() fires the step fire-and-forget (`void this._step(now)...`); even a
// synchronously-complete step only clears the _stepBusy re-entrancy guard in
// a queued .finally() microtask. A real host.onTick driver always yields the
// event loop between ticks (macrotask timer), so this never matters live —
// but a synchronous test loop calling tick() back-to-back must flush that
// microtask itself, or every call after the first is skipped as "still busy".
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "bot.js")).href);
  const { ExplorePressureController } = mod;
  check("exports: ExplorePressureController", typeof ExplorePressureController === "function");

  const outdoorPose = { objCellId: 0x0001000e, x: 96, y: 96, z: 0 };
  let t = 1_000_000;
  const clock = () => t;

  // ---- gate matrix: each condition independently blocks a step ----------
  {
    const cases = [
      ["director missing", { ai: {} }],
      ["director disabled (manual bot)", mkBot({ enabled: false })],
      ["check-in in flight (_running)", mkBot({ running: true })],
      ["check-in in flight (_inflight)", mkBot({ inflight: Promise.resolve() })],
      ["active route (globalRouter.busy)", mkBot({ busy: true })],
    ];
    for (const [name, bot] of cases) {
      const host = mkHost(outdoorPose);
      const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
      c.bot = bot;
      c._lastMoveAt = t - 30_000;
      c._lastStepAt = t - 30_000;
      check(`gate blocks: ${name}`, c._gatesOpen(t) === false);
    }
    // router mid-route
    {
      const host = mkHost(outdoorPose);
      const c = new ExplorePressureController(host, mkRouter("WALK"), IR, { isOperatorStopLatched: () => false }, { now: clock });
      c.bot = mkBot();
      c._lastMoveAt = t - 30_000;
      c._lastStepAt = t - 30_000;
      check("gate blocks: router mid-route (state=WALK)", c._gatesOpen(t) === false);
    }
    // operator-stop latch
    {
      const host = mkHost(outdoorPose);
      const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => true }, { now: clock });
      c.bot = mkBot();
      c._lastMoveAt = t - 30_000;
      c._lastStepAt = t - 30_000;
      check("gate blocks: operator-stop latch", c._gatesOpen(t) === false);
    }
    // idle windows not yet satisfied
    {
      const host = mkHost(outdoorPose);
      const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
      c.bot = mkBot();
      c._lastMoveAt = t - 5_000; // < 25s since movement
      c._lastStepAt = 0;
      check("gate blocks: <25s since last movement", c._gatesOpen(t) === false);
      c._lastMoveAt = t - 30_000;
      c._lastStepAt = t - 5_000; // < 25s since last step
      check("gate blocks: <25s since last pressure step", c._gatesOpen(t) === false);
    }
    // all clear
    {
      const host = mkHost(outdoorPose);
      const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
      c.bot = mkBot();
      c._lastMoveAt = t - 30_000;
      c._lastStepAt = t - 30_000;
      check("gate opens: all conditions satisfied", c._gatesOpen(t) === true);
    }
  }

  // ---- tick(): end-to-end fire-only-when-idle + <=1 step/20s -----------
  {
    t = 2_000_000;
    const host = mkHost(outdoorPose);
    const router = mkRouter("IDLE");
    const bot = mkBot();
    const c = new ExplorePressureController(host, router, IR, { isOperatorStopLatched: () => false }, { now: clock, log: () => {} });
    c.bot = bot;

    c.tick(); // freshly constructed -> 0s idle -> no step
    check("tick: no step immediately after construction (idle window not met)", host._moves.length === 0);

    t += 26_000; // >= 25s idle
    c.tick();
    check("tick: fires exactly one MoveToPosition once idle >= 25s", host._moves.length === 1);
    check("tick: journals a compact [pressure] note", bot._notes.length === 1 && bot._notes[0].kind === "note" && bot._notes[0].text.startsWith("[pressure]"));

    c.tick(); // same instant -> re-fire suppressed
    check("tick: does not re-fire inside the 20-25s cooldown", host._moves.length === 1);

    t += 100; // still well inside the cooldown
    c.tick();
    check("tick: still suppressed a moment later", host._moves.length === 1);
  }

  // ---- <=6 consecutive random hops, then stand down until a check-in ---
  // (cap tuned 3->6 on 2026-07-20 — stream felt statue-y at 3)
  {
    t = 3_000_000;
    const host = mkHost(outdoorPose);
    const bot = mkBot();
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    for (let i = 0; i < 6; i++) { t += 26_000; c.tick(); await flush(); }
    check("stand-down: 6 consecutive hops fired", host._moves.length === 6);
    t += 26_000;
    c.tick();
    await flush();
    check("stand-down: 7th hop suppressed without director input", host._moves.length === 6);
    // A fresh director check-in (director._lastCheckAt changes) releases it.
    bot.ai.director._lastCheckAt = Date.now();
    t += 26_000;
    c.tick();
    await flush();
    check("stand-down: released by the next director check-in", host._moves.length === 7);
  }

  // ---- priority 1: re-issue the last unreached director goto -----------
  {
    t = 4_000_000;
    const host = mkHost(outdoorPose);
    const bot = mkBot({ lastMission: { kind: "goto", to: { lb: 1, x: 2, y: 3, z: 4 }, label: "camp", result: { ok: false } } });
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    check("priority-1: re-issues bot.goto with the unreached target", bot._gotoCalls.length === 1 && bot._gotoCalls[0].lb === 1);
    check("priority-1: does not also take a random/sweep hop", host._moves.length === 0);
    check("priority-1: does not count toward the consecutive-hop cap", c._consecutiveHops === 0);
    // Once the mission reads as reached, priority 1 stops firing.
    bot.lastMission.result = { ok: true };
    t += 26_000;
    c.tick();
    await flush();
    check("priority-1: stands aside once the mission is marked reached", bot._gotoCalls.length === 1 && host._moves.length === 1);
  }

  // ---- outdoor hop: prefers an unvisited door over a random hop --------
  {
    t = 5_000_000;
    const DOOR_GUID = 0xdead;
    const host = mkHost(outdoorPose, {
      nearby: [DOOR_GUID],
      descFlags: { [DOOR_GUID]: 0x1000 }, // ODF_DOOR
      objPos: { [DOOR_GUID]: { objCellId: outdoorPose.objCellId, x: 110, y: 96, z: 0 } },
      objName: { [DOOR_GUID]: "Stockade Door" },
    });
    const bot = mkBot();
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    check("outdoor hop: walks toward the nearby door, not a random bearing", host._moves.length === 1 && host._moves[0].x > outdoorPose.x);
    check("outdoor hop: journal names the door", bot._notes[0].text.includes("Stockade Door"));
    check("outdoor hop: door guid marked visited", c._visitedDoors.has(DOOR_GUID));
    // Second hop: the only door is now visited -> falls back to a random hop.
    t += 26_000;
    c.tick();
    await flush();
    check("outdoor hop: a visited door is not targeted twice", host._moves.length === 2 && bot._notes[1].text.includes("random hop"));
  }

  // ---- indoor sweep hop: walks an unvisited graph neighbor --------------
  {
    t = 6_000_000;
    const LB = 0x01a90000;
    const A = LB | 0x100, B = LB | 0x101;
    const graph = new Map([
      [A, { pos: { x: 200, y: 32450, z: 0 }, neighbors: [B] }],
      [B, { pos: { x: 210, y: 32450, z: 0 }, neighbors: [A] }],
    ]);
    const pose = { objCellId: A, x: 8, y: 2, z: 0 }; // local coords irrelevant: cur resolves via nodes.has(cellId)
    const host = mkHost(pose);
    const bot = mkBot();
    let fetchCalls = 0;
    const ir = {
      isEnvCellId: IR.isEnvCellId,
      nearestCell: IR.nearestCell,
      buildGraphFromWasm: async () => { fetchCalls++; return graph; },
      toLegs: (g, path) => path.map((id) => {
        const n = g.get(id);
        return { lb: id, x: n.pos.x - ((id >>> 24) & 0xff) * 192, y: n.pos.y - ((id >>> 16) & 0xff) * 192, z: n.pos.z };
      }),
    };
    const c = new ExplorePressureController(host, mkRouter("IDLE"), ir, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    c._lastMoveAt = t - 30_000;
    c._lastStepAt = t - 30_000;
    await c._step(t);
    check("indoor sweep: builds the graph once via buildGraphFromWasm", fetchCalls === 1);
    check("indoor sweep: walks the unvisited neighbor B", host._moves.length === 1 && host._moves[0].lb === B);
    check("indoor sweep: marks the current cell visited", c._visitedCells.get(LB >>> 16).has(A));

    // Cache hit: a second step in the same landblock does not rebuild.
    c._lastMoveAt = t - 30_000;
    c._lastStepAt = t - 30_000;
    host._pose = { objCellId: B, x: 18, y: 2, z: 0 };
    await c._step(t + 26_000);
    check("indoor sweep: same-landblock cache prevents a rebuild", fetchCalls === 1);

    // Abort-mid-await: something claims the route while the graph builds.
    const ir2 = {
      isEnvCellId: IR.isEnvCellId,
      nearestCell: IR.nearestCell,
      buildGraphFromWasm: async () => { bot2.globalRouter.busy = true; return graph; },
      toLegs: ir.toLegs,
    };
    const host2 = mkHost({ objCellId: A, x: 8, y: 2, z: 0 });
    const bot2 = mkBot();
    const c2 = new ExplorePressureController(host2, mkRouter("IDLE"), ir2, { isOperatorStopLatched: () => false }, { now: clock });
    c2.bot = bot2;
    c2._lastMoveAt = t - 30_000;
    c2._lastStepAt = t - 30_000;
    await c2._step(t + 52_000);
    check("indoor sweep: aborts instantly if a route claims busy mid-await", host2._moves.length === 0);
  }

  // ═══ WS-C: frontier-directed escalation ladder (DESIGN-surveyor-frontier-2026-07-21) ═══

  // ---- step 2 (outdoor): frontier hop chosen over the legacy door/random hop ----
  {
    t = 7_000_000;
    const DOOR_GUID = 0xbeef;
    const host = mkHost(outdoorPose, {
      nearby: [DOOR_GUID],
      descFlags: { [DOOR_GUID]: 0x1000 },
      objPos: { [DOOR_GUID]: { objCellId: outdoorPose.objCellId, x: 110, y: 96, z: 0 } },
      objName: { [DOOR_GUID]: "Decoy Door" },
    });
    const curLb = outdoorPose.objCellId >>> 16;
    const wx = worldXOf(outdoorPose.objCellId, outdoorPose.x), wy = worldYOf(outdoorPose.objCellId, outdoorPose.y);
    const frontierWorld = { worldX: wx + 30, worldY: wy + 20, dist: 36.1, bearingDeg: 56, lb: curLb };
    const em = mkExploreMemory({ frontier: () => frontierWorld });
    const bot = mkBot({ extensions: { exploreMemory: em } });
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    const expected = expectedLandCell(frontierWorld.worldX, frontierWorld.worldY, outdoorPose.z);
    check("frontier hop: observe() fed with the raw pose", em._observeCalls.length === 1 && em._observeCalls[0] === outdoorPose);
    check("frontier hop: MoveToPosition targets the frontier's LandCell, not the door", host._moves.length === 1 &&
      host._moves[0].lb === expected.lb && host._moves[0].x === expected.x && host._moves[0].y === expected.y);
    check("frontier hop: journal says \"frontier hop\", not door/random", bot._notes[0].text.includes("frontier hop") &&
      !bot._notes[0].text.includes("door") && !bot._notes[0].text.includes("random hop"));
    check("frontier hop: never touches InvokeChatParser", host._chatCalls.length === 0);
  }

  // ---- step 2 (indoor): frontier hop steers toward the frontier cell, not the nearest neighbor ----
  {
    t = 8_000_000;
    const LB = 0x01a90000;
    const A = LB | 0x100, B = LB | 0x101, C = LB | 0x102; // A=here, B=nearest neighbor, C=the frontier tile
    const graph = new Map([
      [A, { pos: { x: 200, y: 32450, z: 0 }, neighbors: [B] }],
      [B, { pos: { x: 210, y: 32450, z: 0 }, neighbors: [A] }],
      [C, { pos: { x: 400, y: 32450, z: 0 }, neighbors: [] }], // deliberately NOT graph-adjacent to A
    ]);
    const pose = { objCellId: A, x: 8, y: 2, z: 0 };
    const host = mkHost(pose);
    const em = mkExploreMemory({ frontier: () => ({ worldX: 400, worldY: 32450, dist: 200, bearingDeg: 90, lb: LB >>> 16 }) });
    const bot = mkBot({ extensions: { exploreMemory: em } });
    const ir = {
      isEnvCellId: IR.isEnvCellId,
      nearestCell: (nodes, wx) => (wx > 300 ? C : B), // frontier's worldX (400) resolves to C
      buildGraphFromWasm: async () => graph,
      toLegs: (g, path) => path.map((id) => {
        const n = g.get(id);
        return { lb: id, x: n.pos.x - ((id >>> 24) & 0xff) * 192, y: n.pos.y - ((id >>> 16) & 0xff) * 192, z: n.pos.z };
      }),
    };
    const c = new ExplorePressureController(host, mkRouter("IDLE"), ir, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    c._lastMoveAt = t - 30_000;
    c._lastStepAt = t - 30_000;
    await c._step(t);
    check("indoor frontier hop: walks the frontier cell C, not the nearest neighbor B", host._moves.length === 1 && host._moves[0].lb === C);
    check("indoor frontier hop: journal names the frontier cell", bot._notes[0].text.includes("frontier hop") && bot._notes[0].text.includes(C.toString(16)));
  }

  // ---- step 3: escalate out via dungeonNav.exitRoute + bot.travel (NOT bot.goto) ----
  {
    t = 9_000_000;
    const LB = 0x01aa0000;
    const A = LB | 0x150;
    const graph = new Map([[A, { pos: { x: 0, y: 0, z: 0 }, neighbors: [] }]]);
    const pose = { objCellId: A, x: 0, y: 0, z: 0 };
    const host = mkHost(pose);
    const exitLegs = [{ lb: 0xaaaa0001, x: 1, y: 2, z: 3 }];
    const dungeonNav = { exitRoute: async () => ({ ok: true, legs: exitLegs, exitCell: A, outdoorId: 0x00010001, reason: "1 cell(s) to exit" }) };
    // severity>=2 alone (no local frontier needed) is enough to trigger escalation (WS-C step-3 gate).
    const em = mkExploreMemory({ frontier: () => null, loopVerdict: () => ({ looping: true, severity: 2, reason: "oscillating", correction: "leave" }) });
    const bot = mkBot({ extensions: { exploreMemory: em, dungeonNav } });
    const ir = { isEnvCellId: IR.isEnvCellId, nearestCell: () => null, buildGraphFromWasm: async () => graph, toLegs: () => [] };
    const c = new ExplorePressureController(host, mkRouter("IDLE"), ir, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    c._lastMoveAt = t - 30_000;
    c._lastStepAt = t - 30_000;
    await c._step(t);
    check("escalate-out: calls bot.travel with exitRoute's legs", bot._travelCalls.length === 1 && bot._travelCalls[0] === exitLegs);
    check("escalate-out: does NOT go through host.MoveToPosition or bot.goto", host._moves.length === 0 && bot._gotoCalls.length === 0);
    check("escalate-out: journals ESCALATE + exiting the building", bot._notes[0].text.includes("ESCALATE") && bot._notes[0].text.includes("exiting the building"));
  }

  // ---- step 3 fallback: dungeonNav unavailable -> local findExitPath + direct MoveToPosition ----
  {
    t = 9_500_000;
    const LB = 0x01ab0000;
    const A = LB | 0x150;
    const graph = new Map([[A, { pos: { x: 50, y: 60, z: 0 }, neighbors: [] }]]);
    const pose = { objCellId: A, x: 0, y: 0, z: 0 };
    const host = mkHost(pose);
    const em = mkExploreMemory({ frontier: () => null, variation: () => 6 }); // frontier exhausted AND variation>=5
    const bot = mkBot({ extensions: { exploreMemory: em } }); // no dungeonNav
    const ir = {
      isEnvCellId: IR.isEnvCellId,
      nearestCell: () => null,
      buildGraphFromWasm: async () => graph,
      findExitPath: (g, cur) => ({ path: [cur], exitCell: cur, outdoorId: 0x00010001 }),
      toLegs: (g, path) => path.map((id) => { const n = g.get(id); return { lb: id, x: n.pos.x, y: n.pos.y, z: n.pos.z }; }),
    };
    const c = new ExplorePressureController(host, mkRouter("IDLE"), ir, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    c._lastMoveAt = t - 30_000;
    c._lastStepAt = t - 30_000;
    await c._step(t);
    check("escalate-out fallback: MoveToPosition toward the exit cell (no dungeonNav)", host._moves.length === 1 && host._moves[0].lb === A);
    check("escalate-out fallback: journals ESCALATE + building exit", bot._notes[0].text.includes("ESCALATE") && bot._notes[0].text.includes("building exit"));
    check("escalate-out fallback: never calls bot.travel", bot._travelCalls.length === 0);
  }

  // ---- step 4: landblock hop (frontier tile sits in a DIFFERENT landblock) ----
  {
    t = 10_000_000;
    const host = mkHost(outdoorPose);
    const curLb = outdoorPose.objCellId >>> 16;
    const wx = worldXOf(outdoorPose.objCellId, outdoorPose.x), wy = worldYOf(outdoorPose.objCellId, outdoorPose.y);
    // Far enough to guarantee a different landblock (>192m away).
    const frontierWorld = { worldX: wx, worldY: wy + 500, dist: 500, bearingDeg: 0, lb: curLb + 2 };
    const em = mkExploreMemory({ frontier: () => frontierWorld });
    const bot = mkBot({ extensions: { exploreMemory: em } });
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    const expected = expectedLandCell(frontierWorld.worldX, frontierWorld.worldY, outdoorPose.z);
    check("landblock hop: crosses into the frontier's landblock", (expected.lb >>> 16) !== curLb);
    check("landblock hop: MoveToPosition targets the cross-lb LandCell", host._moves.length === 1 && host._moves[0].lb === expected.lb);
    check("landblock hop: journal says \"landblock hop\"", bot._notes[0].text.includes("landblock hop"));
  }

  // ---- step 5: hard-loop last resort — directed ON-FOOT walk toward the nearest unvisited town ----
  {
    t = 11_000_000;
    const host = mkHost(outdoorPose);
    const town = { name: "Zaikhal", ns: 60, ew: 40, dist: 12.3 };
    const townsList = ["placeholder-towns-array"]; // opaque — only identity matters here
    let townFrontierArgs = null;
    const em = mkExploreMemory({
      frontier: () => null, // no local frontier left
      loopVerdict: () => ({ looping: true, severity: 3, reason: "wedged", correction: "walk toward Zaikhal" }),
      townFrontier: (towns, pose) => { townFrontierArgs = { towns, pose }; return town; },
    });
    const bot = mkBot({ extensions: { exploreMemory: em } });
    // opts.towns is how createGrindBot wires tools/towns.js's TOWNS through
    // (constructor signature is unchanged; towns rides in the opts bag).
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock, towns: townsList });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    check("town hop: townFrontier receives the ctor's opts.towns list", townFrontierArgs && townFrontierArgs.towns === townsList);
    check("town hop: townFrontier receives the raw pose", townFrontierArgs && townFrontierArgs.pose === outdoorPose);
    check("town hop: exactly one MoveToPosition (long on-foot walk)", host._moves.length === 1);
    check("town hop: journal names the town + ESCALATE + hard loop + on foot", bot._notes[0].text.includes("Zaikhal") &&
      bot._notes[0].text.includes("ESCALATE") && bot._notes[0].text.includes("hard loop") && bot._notes[0].text.toLowerCase().includes("on foot"));
    check("town hop: NEVER calls InvokeChatParser (no @telepoi / teleport shortcut)", host._chatCalls.length === 0);
    check("town hop: journal never mentions telepoi", !bot._notes[0].text.toLowerCase().includes("telepoi"));
  }

  // ---- step ordering: severity 3 does NOT override an available local frontier ----
  {
    t = 12_000_000;
    const host = mkHost(outdoorPose);
    const curLb = outdoorPose.objCellId >>> 16;
    const wx = worldXOf(outdoorPose.objCellId, outdoorPose.x), wy = worldYOf(outdoorPose.objCellId, outdoorPose.y);
    const frontierWorld = { worldX: wx + 10, worldY: wy + 5, dist: 11.2, bearingDeg: 27, lb: curLb };
    const em = mkExploreMemory({
      frontier: () => frontierWorld,
      loopVerdict: () => ({ looping: true, severity: 3, reason: "wedged", correction: "x" }),
      townFrontier: () => ({ name: "Zaikhal", ns: 60, ew: 40, dist: 12.3 }),
    });
    const bot = mkBot({ extensions: { exploreMemory: em } });
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    check("ordering: an available frontier wins over the severity-3 town hop", bot._notes[0].text.includes("frontier hop") && !bot._notes[0].text.includes("Zaikhal"));
  }

  // ---- graceful fallback: exploreMemory present but every method throws -> legacy hop, never crashes ----
  {
    t = 13_000_000;
    const host = mkHost(outdoorPose);
    const brokenEm = {
      observe: () => { throw new Error("boom-observe"); },
      frontier: () => { throw new Error("boom-frontier"); },
      loopVerdict: () => { throw new Error("boom-verdict"); },
      variation: () => { throw new Error("boom-variation"); },
      townFrontier: () => { throw new Error("boom-town"); },
    };
    const bot = mkBot({ extensions: { exploreMemory: brokenEm } });
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    let threw = false;
    try { c.tick(); await flush(); } catch { threw = true; }
    check("broken exploreMemory: tick never throws", threw === false);
    check("broken exploreMemory: still degrades to a legacy hop", host._moves.length === 1);
    check("broken exploreMemory: never calls InvokeChatParser", host._chatCalls.length === 0);
  }

  // ---- graceful fallback: extensions object present but exploreMemory absent -> legacy behavior ----
  {
    t = 14_000_000;
    const host = mkHost(outdoorPose);
    const bot = mkBot({ extensions: {} }); // extensions wired, exploreMemory not (e.g. WS-A not landed yet)
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    t += 26_000;
    c.tick();
    await flush();
    check("no exploreMemory on extensions: falls back to legacy random/door hop", host._moves.length === 1 && bot._notes[0].text.includes("random hop"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
