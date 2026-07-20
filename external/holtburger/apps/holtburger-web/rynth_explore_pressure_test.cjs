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
  return {
    _pose: pose,
    s: hasSession ? {} : null,
    TryGetPlayerPose() { return this._pose; },
    MoveToPosition(lb, x, y, z, run) { moves.push({ lb, x, y, z, run }); },
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
function mkBot({ enabled = true, running = false, inflight = null, busy = false, lastMission = null } = {}) {
  const notes = [];
  const gotoCalls = [];
  return {
    ai: {
      director: { enabled, _running: running, _inflight: inflight, _lastCheckAt: null },
      journal: { add: (kind, text) => notes.push({ kind, text: String(text) }) },
    },
    globalRouter: { busy },
    lastMission,
    goto: (to) => { gotoCalls.push(to); return Promise.resolve({ ok: true }); },
    _notes: notes,
    _gotoCalls: gotoCalls,
  };
}
const IR = {
  isEnvCellId: (id) => ((id >>> 0) & 0xffff) >= 0x100,
  nearestCell: () => null, // not exercised: fixtures always park the pose ON a graph node
};
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

  // ---- <=3 consecutive random hops, then stand down until a check-in ---
  {
    t = 3_000_000;
    const host = mkHost(outdoorPose);
    const bot = mkBot();
    const c = new ExplorePressureController(host, mkRouter("IDLE"), IR, { isOperatorStopLatched: () => false }, { now: clock });
    c.bot = bot;
    for (let i = 0; i < 3; i++) { t += 26_000; c.tick(); await flush(); }
    check("stand-down: 3 consecutive hops fired", host._moves.length === 3);
    t += 26_000;
    c.tick();
    await flush();
    check("stand-down: 4th hop suppressed without director input", host._moves.length === 3);
    // A fresh director check-in (director._lastCheckAt changes) releases it.
    bot.ai.director._lastCheckAt = Date.now();
    t += 26_000;
    c.tick();
    await flush();
    check("stand-down: released by the next director check-in", host._moves.length === 4);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
