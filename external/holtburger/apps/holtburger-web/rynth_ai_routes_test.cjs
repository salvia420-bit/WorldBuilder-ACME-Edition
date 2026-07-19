#!/usr/bin/env node
// rynth_ai_routes_test.cjs — unit tests for rynth/ai/tools/routes.js
// (follow_route / list_routes / name_route + the mission line, SPEC-navatlas
// §3-W3.1/3.3) and rynth/ai/tools/metrics.js (§3-W3.5). No infra: the atlas
// and bot are injected mocks, so this passes independently of the W2 modules.
//
// Run: node rynth_ai_routes_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;

function makeJournal() {
  const entries = [];
  return {
    entries,
    add(kind, text) { entries.push({ kind, text: String(text) }); },
    kinds(kind) { return entries.filter((e) => e.kind === kind); },
  };
}

// Duck-typed atlas per the W2 API design (agent-B message 2026-07-18).
function makeAtlas(routes = []) {
  const byName = new Map(routes.map((r) => [r.name, r]));
  const calls = { recordResult: [], nameRoute: [], saveRoute: [] };
  return {
    calls,
    getRoute: (n) => byName.get(n) ?? null,
    listRoutes: () => [...byName.values()],
    summaries: () =>
      [...byName.values()].map((r) => ({
        name: r.name,
        from: { ns: 42.1, ew: 33.6 },
        to: { ns: 33.3, ew: 56.6 },
        legs: r.legs?.length,
        estUnits: r.estUnits,
        successCount: r.successCount ?? 0,
        lastResult: r.lastResult ?? null,
        suspect: r.suspect === true,
        validated: r.validated ?? null,
      })),
    saveRoute: (r) => { calls.saveRoute.push(r); byName.set(r.name ?? "auto-1", { ...r, name: r.name ?? "auto-1" }); return byName.get(r.name ?? "auto-1"); },
    nameRoute: (from, to) => {
      calls.nameRoute.push([from, to]);
      const r = byName.get(from);
      if (!r) return null;
      byName.delete(from);
      r.name = to;
      byName.set(to, r);
      return r;
    },
    recordResult: (n, res) => { calls.recordResult.push([n, res]); return byName.get(n) ?? null; },
    estimateMs: (r, { runRate = 1 } = {}) => ((r.estUnits ?? 0) / (runRate * 4)) * 1000,
  };
}

const ROUTE = {
  id: "r1", name: "holtburg-to-arwic",
  legs: [{ lb: 0xa9b40019, x: 84, y: 12, z: 50 }, { lb: 0xa9b40019, x: 120, y: 40, z: 50 }],
  estUnits: 800, successCount: 3, suspect: false,
};

function makeBot({ followResult = { ok: true, state: "DONE", legsWalked: 2 }, runRate = 2 } = {}) {
  const calls = { followRoute: [] };
  return {
    calls,
    _metrics: { distanceM: 0, lbs: new Set(), deaths: 0, routesRecorded: 0, routesReused: 0 },
    host: { s: { playerRunRate: () => runRate } },
    mission: null,
    lastMission: null,
    router: { status: { state: "IDLE", leg: 0, legs: 0, walked: 0 } },
    globalRouter: {},
    followRoute: async (legs, opts) => { calls.followRoute.push([legs, opts]); return followResult; },
  };
}

(async () => {
  const { registerRoutes, renderMissionLine, liveRunRate, getAtlas } = await import(modUrl("rynth/ai/tools/routes.js"));

  // ---- registration + catalog shape
  {
    const ext = {};
    registerRoutes(ext, { atlas: makeAtlas() });
    check("register: all three actions", ["follow_route", "list_routes", "name_route"].every((t) => ext[t]?.type === t));
    check("register: defs carry params+desc+validate+apply", Object.values(ext).every(
      (d) => d.params && d.desc && typeof d.validate === "function" && typeof d.apply === "function"));
    let threw = false;
    try { registerRoutes(ext, { atlas: makeAtlas() }); } catch { threw = true; }
    check("register: double registration throws (frozen map)", threw);
  }

  // ---- validation
  {
    const ext = {};
    registerRoutes(ext, { atlas: makeAtlas() });
    check("validate: follow_route needs name", ext.follow_route.validate({ type: "follow_route" }).ok === false);
    check("validate: follow_route ok", ext.follow_route.validate({ type: "follow_route", name: "x" }).ok === true);
    check("validate: name_route needs both", ext.name_route.validate({ type: "name_route", route: "a" }).ok === false);
    check("validate: name_route length cap", ext.name_route.validate({ type: "name_route", route: "a", name: "x".repeat(80) }).ok === false);
    check("validate: list_routes ok", ext.list_routes.validate({ type: "list_routes" }).ok === true);
  }

  // ---- follow_route happy path
  {
    const ext = {};
    const atlas = makeAtlas([ROUTE]);
    registerRoutes(ext, { atlas });
    const bot = makeBot();
    const journal = makeJournal();
    const r = await ext.follow_route.apply(bot, { type: "follow_route", name: "holtburg-to-arwic" }, { journal });
    check("follow: ok result with est+actual", r.ok === true && r.result.state === "DONE" && Number.isFinite(r.result.estMs) && Number.isFinite(r.result.actualMs), JSON.stringify(r));
    check("follow: walked the atlas legs via bot.followRoute", bot.calls.followRoute.length === 1 && bot.calls.followRoute[0][0] === ROUTE.legs && bot.calls.followRoute[0][1].label === "holtburg-to-arwic");
    check("follow: est uses live runRate (800u / 8 m/s = 100s)", Math.round(r.result.estMs) === 100_000, String(r.result.estMs));
    check("follow: recordResult called with ok+actualMs", atlas.calls.recordResult.length === 1 && atlas.calls.recordResult[0][0] === "holtburg-to-arwic" && atlas.calls.recordResult[0][1].ok === true);
    check("follow: journaled est vs actual", journal.kinds("note").some((n) => /ARRIVED/.test(n.text) && /est 100s/.test(n.text)), JSON.stringify(journal.entries));
    check("follow: reuse counter bumped", bot._metrics.routesReused === 1);
  }

  // ---- follow_route failure paths
  {
    const ext = {};
    const atlas = makeAtlas([ROUTE]);
    registerRoutes(ext, { atlas });
    const r1 = await ext.follow_route.apply(makeBot(), { type: "follow_route", name: "nope" }, {});
    check("follow: unknown route -> actionable error", r1.ok === false && /list_routes/.test(r1.error));
    const botFail = makeBot({ followResult: { ok: false, state: "FAILED", leg: 1 } });
    const r2 = await ext.follow_route.apply(botFail, { type: "follow_route", name: "holtburg-to-arwic" }, {});
    check("follow: failed walk -> ok:false with state", r2.ok === false && /FAILED/.test(r2.error));
    check("follow: failed walk still records result", atlas.calls.recordResult.some(([, res]) => res.ok === false));
    check("follow: failed walk does NOT bump reuse", botFail._metrics.routesReused === 0);
    const extNoAtlas = {};
    registerRoutes(extNoAtlas, { base: null });
    const r3 = await extNoAtlas.follow_route.apply(makeBot(), { type: "follow_route", name: "x" }, {});
    check("follow: no atlas -> degrades to ok:false", r3.ok === false && /atlas unavailable/.test(r3.error));
  }

  // ---- list_routes / name_route
  {
    const ext = {};
    const atlas = makeAtlas([ROUTE, { ...ROUTE, id: "r2", name: "auto-20260718-1", suspect: true }]);
    registerRoutes(ext, { atlas });
    const r = await ext.list_routes.apply(makeBot(), { type: "list_routes" }, {});
    check("list: rows with name/legs/quality", r.ok === true && r.result.count === 2 && r.result.routes.some((l) => /SUSPECT/.test(l)), JSON.stringify(r));
    const rn = await ext.name_route.apply(makeBot(), { type: "name_route", route: "auto-20260718-1", name: "arwic-alt" }, {});
    check("name: renames via atlas", rn.ok === true && rn.result.name === "arwic-alt" && atlas.getRoute("arwic-alt") != null);
    const rn2 = await ext.name_route.apply(makeBot(), { type: "name_route", route: "ghost", name: "x" }, {});
    check("name: unknown route -> error", rn2.ok === false && /list_routes/.test(rn2.error));
  }

  // ---- liveRunRate
  {
    check("runRate: live value", liveRunRate(makeBot({ runRate: 2.5 })) === 2.5);
    check("runRate: degrades to 1", liveRunRate({}) === 1 && liveRunRate(null) === 1);
    check("runRate: non-finite degrades to 1", liveRunRate(makeBot({ runRate: NaN })) === 1);
  }

  // ---- mission line
  {
    check("mission: idle + no recent -> empty", renderMissionLine(makeBot()) === "");
    const bot = makeBot();
    bot.mission = { kind: "goto", label: "33.3N 56.6E", startedAt: Date.now() - 52_000, interrupts: 1 };
    bot.router.status = { state: "WALK", leg: 2, legs: 7, walked: 300 };
    bot.globalRouter.lastPlan = { estUnits: 700, coverage: "detour", portalsUsed: 0, legCount: 7, plannedAt: Date.now() };
    const line = renderMissionLine(bot);
    // remaining 400u / (2*4 m/s) = 50s
    check("mission: live line has leg/ETA/coverage/interrupts",
      /^mission: goto 33\.3N 56\.6E \| leg 3\/7 \| ETA 50s \| coverage detour \| elapsed 5[12]s \| interrupts: 1$/.test(line), line);
    bot.mission = null;
    bot.lastMission = { kind: "goto", label: "33.3N 56.6E", startedAt: Date.now() - 100_000, endedAt: Date.now() - 4_000, result: { ok: true, state: "DONE", coverage: "detour" } };
    const last = renderMissionLine(bot);
    check("mission: recent completion echoed", /^mission: \(last\) goto 33\.3N 56\.6E -> ARRIVED in 96s$/.test(last), last);
    bot.lastMission.endedAt = Date.now() - 11 * 60_000;
    check("mission: stale completion suppressed", renderMissionLine(bot) === "");
    check("mission: hostile bot -> empty, never throws", renderMissionLine({ get mission() { throw new Error("x"); } }) === "");
  }

  // ---- getAtlas caching + degrade
  {
    const injected = makeAtlas();
    check("atlas: injected wins", (await getAtlas("ignored", injected)) === injected);
    check("atlas: no base -> null", (await getAtlas(null)) === null);
    const missing = await getAtlas(modUrl("rynth/definitely-missing-dir"));
    check("atlas: broken import -> null (cached, no throw)", missing === null);
  }

  // ---- metrics (tools/metrics.js)
  {
    const { createAiMetrics } = await import(modUrl("rynth/ai/tools/metrics.js"));
    let pose = { objCellId: 0xa9b40019, x: 10, y: 10, z: 50 };
    const ticks = [];
    const events = [];
    const bot = {
      host: {
        TryGetPlayerPose: () => pose,
        onTick: (fn) => ticks.push(fn),
        onEvent: (fn) => events.push(fn),
        GetPlayerId: () => 0x50000001,
      },
      kernel: { status: { kills: 5 } },
      ai: { director: { status: { calls: 3 } }, client: { spend: { promptTokens: 1000, completionTokens: 200 } } },
    };
    const journal = makeJournal();
    const m = createAiMetrics(bot, { journal, sampleMs: 0 });
    check("metrics: live counters exposed on bot", bot._metrics === m.live);
    ticks.forEach((f) => f()); // baseline sample
    await new Promise((r) => setTimeout(r, 5));
    pose = { objCellId: 0xa9b40019, x: 30, y: 10, z: 50 }; // +20m walk
    ticks.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 5));
    pose = { objCellId: 0xa8b40019, x: 30, y: 10, z: 50 }; // 192m jump = portal, not walking
    ticks.forEach((f) => f());
    check("metrics: walking distance accumulated", Math.round(m.live.distanceM) === 20, String(m.live.distanceM));
    check("metrics: teleport jump excluded, landblocks counted", m.live.lbs.size === 2);
    events.forEach((f) => f({ kind: 29, u32: 0x50000001 })); // own death
    events.forEach((f) => f({ kind: 29, u32: 0x50000099 })); // someone else's
    check("metrics: own death counted, others ignored", m.live.deaths === 1);
    bot.kernel.status.kills = 12;
    bot.ai.director.status.calls = 9;
    m.live.routesRecorded = 2;
    m.live.routesReused = 1;
    m.flush();
    const line = journal.kinds("note").find((n) => /^metrics /.test(n.text));
    check("metrics: hourly line has the numbers",
      line && /moved 20m/.test(line.text) && /landblocks 2/.test(line.text) && /kills 7/.test(line.text) &&
      /deaths 1/.test(line.text) && /routes recorded 2 reused 1/.test(line.text) && /llm calls 6/.test(line.text),
      line?.text);
    m.flush();
    const line2 = journal.kinds("note").filter((n) => /^metrics /.test(n.text))[1];
    check("metrics: window resets after flush", line2 && /moved 0m/.test(line2.text) && /kills 0/.test(line2.text), line2?.text);
    m.stop();
  }

  // ---- auto-record composition (extensions.js × REAL route_recorder + atlas)
  {
    const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));
    const rynthBase = pathToFileURL(path.join(__dirname, "rynth")).href;
    let pose = { objCellId: 0xa9b40019, x: 10, y: 10, z: 50 };
    const ticks = [];
    const bot = {
      host: {
        TryGetPlayerPose: () => pose,
        onTick: (fn) => ticks.push(fn),
        onEvent: () => {},
        s: { player_run_rate: () => 2 },
      },
      _metrics: { routesRecorded: 0, routesReused: 0 },
      mission: null,
      lastMission: null,
      router: { status: { state: "IDLE", leg: 0, legs: 0, walked: 0 } },
    };
    const journal = makeJournal();
    const ext = composeAiExtensions(bot, {
      base: rynthBase, journal,
      config: { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false, world: false, memory: false, chat: false },
    });
    check("autorec: travel hooks installed", typeof bot._onTravelStart === "function" && typeof bot._onTravelDone === "function");
    bot._onTravelStart({ kind: "goto", label: "41.6N 33.6E", to: { ns: 41.6, ew: 33.6 } });
    await new Promise((r) => setTimeout(r, 150)); // lazy recorder import settles
    // walk 3 breadcrumbs 10m apart; recorder samples via the tick tap (500ms throttle)
    for (const x of [20, 30, 40]) {
      pose = { objCellId: 0xa9b40019, x, y: 10, z: 50 };
      ticks.forEach((f) => f());
      await new Promise((r) => setTimeout(r, 550));
      ticks.forEach((f) => f());
    }
    bot._onTravelDone({ kind: "goto", label: "41.6N 33.6E", result: { ok: true, state: "DONE" }, mission: null });
    await new Promise((r) => setTimeout(r, 250)); // async finish/save settles
    const at = await ext.routes.getAtlas();
    const routes = at ? at.listRoutes() : [];
    check("autorec: successful goto saved to the atlas", routes.length === 1 && Array.isArray(routes[0].legs) && routes[0].legs.length >= 2,
      JSON.stringify(routes.map((r) => ({ n: r.name, legs: r.legs?.length }))));
    check("autorec: metrics counter bumped", bot._metrics.routesRecorded === 1);
    check("autorec: journaled with name_route hint", journal.kinds("note").some((n) => /route recorded/.test(n.text) && /name_route/.test(n.text)),
      JSON.stringify(journal.entries.slice(-3)));
    // A FAILED goto must not be saved (routes-are-experience discipline).
    bot._onTravelStart({ kind: "goto", label: "bad", to: { ns: 41, ew: 33 } });
    await new Promise((r) => setTimeout(r, 150));
    pose = { objCellId: 0xa9b40019, x: 60, y: 10, z: 50 };
    ticks.forEach((f) => f());
    bot._onTravelDone({ kind: "goto", label: "bad", result: { ok: false, state: "FAILED" }, mission: null });
    await new Promise((r) => setTimeout(r, 250));
    check("autorec: failed goto NOT saved", at.listRoutes().length === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
