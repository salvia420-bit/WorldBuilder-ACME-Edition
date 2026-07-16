#!/usr/bin/env node
// rynth_ai_dungeon_nav_test.cjs — unit tests for rynth/ai/tools/dungeon_nav.js
// (the dungeon-nav ADVISOR, v2 layer). No infra, no network, no wasm: the
// indoor graph and pose come from mock bots; the live-build path is exercised
// through buildGraphFromWasm's fetchEnvCells injection seam with fake
// placements.
//
// Run: node rynth_ai_dungeon_nav_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ---- fixture dungeon (landblock 0x01a9: wx base 1*192=192, wy base 0xa9*192=32448)
//
//   A ── B ── C ── F ── U(z+4, walkable slope)
//   │              └──> FRONTIER (portal to a cell the graph lacks)
//   D(z-10, vertical DROP off A — unreachable without a jump)
const LB = 0x01a90000;
const A = LB | 0x100, B = LB | 0x101, C = LB | 0x102, F = LB | 0x103, U = LB | 0x104, D = LB | 0x105;
const FRONTIER = LB | 0x1ff;
const mkGraph = () => new Map([
  [A, { pos: { x: 200, y: 32450, z: 0 }, neighbors: [B, D] }],
  [B, { pos: { x: 210, y: 32450, z: 0 }, neighbors: [A, C] }],
  [C, { pos: { x: 220, y: 32450, z: 0 }, neighbors: [B, F] }],
  [F, { pos: { x: 220, y: 32460, z: 0 }, neighbors: [C, U, FRONTIER] }],
  [U, { pos: { x: 220, y: 32470, z: 4 }, neighbors: [F] }],
  [D, { pos: { x: 201, y: 32450, z: -10 }, neighbors: [A] }],
]);
const poseAt = (cell, wx, wy, z) => ({
  objCellId: cell,
  x: wx - ((cell >>> 24) & 0xff) * 192,
  y: wy - ((cell >>> 16) & 0xff) * 192,
  z,
});
const poseA = () => poseAt(A, 200, 32450, 0);
const mkBot = (pose, graph) => ({ host: { TryGetPlayerPose: () => pose }, ...(graph ? { indoorGraph: graph } : {}) });
const lastLb = (r) => r.legs[r.legs.length - 1].lb >>> 0;

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "tools", "dungeon_nav.js")).href);
  const { DungeonNavAdvisor, dungeonSuggestAction, registerDungeonNav, HINT_NAMES, TO_MAX_CHARS } = mod;
  // The frozen v1 module, imported ONLY to prove we never touch it.
  const actionsMod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "actions.js")).href);

  check("exports: class + action + register + consts",
    typeof DungeonNavAdvisor === "function" && typeof dungeonSuggestAction === "function"
    && typeof registerDungeonNav === "function" && typeof HINT_NAMES === "string" && Number.isInteger(TO_MAX_CHARS));

  // ---- describeSurroundings (indoors, graph on the bot)
  {
    const adv = new DungeonNavAdvisor();
    const s = adv.describeSurroundings(mkBot(poseA(), mkGraph()));
    check("describe: sync string", typeof s === "string", typeof s);
    check("describe: current cell", s.includes("01a90100"), s);
    check("describe: adjacent cell with compass dir", /01a90101 E\b/.test(s), s);
    check("describe: drop exit flagged", s.includes("01a90105") && s.includes("DROP"), s);
    check("describe: reachable excludes the drop cell", s.includes("cells=6") && s.includes("reachable=5"), s);
    check("describe: frontier surfaced", /unexplored frontier: 1 /.test(s), s);
    check("describe: compact", s.length < 700 && s.split("\n").length <= 4, `${s.length} chars`);
  }

  // ---- describeSurroundings degradations
  {
    const adv = new DungeonNavAdvisor();
    check("describe: no bot -> no-pose string", adv.describeSurroundings(null).includes("no player pose"));
    check("describe: hostile pose thrower -> no-pose string",
      adv.describeSurroundings({ host: { TryGetPlayerPose() { throw new Error("boom"); } } }).includes("no player pose"));
    const out = adv.describeSurroundings(mkBot(poseAt(0xa9b4002e, 100, 100, 0), mkGraph()));
    check("describe: outdoors -> advises outdoor goto", out.includes("outdoors") && out.includes("goto"), out);
    check("describe: indoors without graph -> unavailable",
      adv.describeSurroundings(mkBot(poseA())).includes("indoor graph unavailable"));
    // Plain-object graph with string keys (indoor_router.js graph contract).
    const objGraph = {};
    for (const [k, v] of mkGraph()) objGraph[k] = v;
    check("describe: plain-object graph accepted",
      adv.describeSurroundings(mkBot(poseA(), objGraph)).includes("cells=6"));
  }

  // ---- suggestRoute: explicit cell targets
  {
    const adv = new DungeonNavAdvisor();
    const bot = mkBot(poseA(), mkGraph());
    const r = await adv.suggestRoute(bot, { toCellId: U });
    check("route: A->U ok with 5 legs", r.ok === true && r.legs.length === 5, JSON.stringify(r));
    check("route: legs are {lb,x,y,z} landblock-local (indoor_router toLegs)",
      r.ok && r.legs[0].lb === A && lastLb(r) === U
      && r.legs[4].x === 28 && r.legs[4].y === 22 && r.legs[4].z === 4,
      JSON.stringify(r.legs));
    const rHex = await adv.suggestRoute(bot, { toCellId: "0x01a90104" });
    check("route: hex-string target", rHex.ok && lastLb(rHex) === U, JSON.stringify(rHex));
    const rLow = await adv.suggestRoute(bot, { toCellId: "0104" });
    check("route: bare low word promoted into current dungeon", rLow.ok && lastLb(rLow) === U, JSON.stringify(rLow));
    const rDrop = await adv.suggestRoute(bot, { toCellId: D });
    check("route: drop-gated cell -> unreachable, not a throw",
      rDrop.ok === false && rDrop.error === "unreachable" && /drop/i.test(rDrop.reason), JSON.stringify(rDrop));
    const rMiss = await adv.suggestRoute(bot, { toCellId: "0x01a90777" });
    check("route: unknown cell -> bad-target", rMiss.ok === false && rMiss.error === "bad-target", JSON.stringify(rMiss));
    const rJunk = await adv.suggestRoute(bot, { toCellId: "zzz" });
    check("route: unparseable target -> bad-target with hint list",
      rJunk.ok === false && rJunk.error === "bad-target" && rJunk.reason.includes(HINT_NAMES), JSON.stringify(rJunk));
  }

  // ---- suggestRoute: hints
  {
    const adv = new DungeonNavAdvisor();
    const bot = mkBot(poseA(), mkGraph());
    const far = await adv.suggestRoute(bot, { toHint: "farthest" });
    check("hint farthest: deepest reachable cell (U, 4 hops)", far.ok && far.to === U && lastLb(far) === U, JSON.stringify(far));
    const unx = await adv.suggestRoute(bot, { toHint: "unexplored" });
    check("hint unexplored: nearest frontier cell (F)", unx.ok && unx.to === F && lastLb(unx) === F, JSON.stringify(unx));
    const up = await adv.suggestRoute(bot, { toHint: "up" });
    check("hint up: highest reachable cell (U)", up.ok && up.to === U, JSON.stringify(up));
    const down = await adv.suggestRoute(bot, { toHint: "down" });
    check("hint down: lowest reachable (tie -> smallest id = A, already there)",
      down.ok && down.to === A && down.legs.length === 1 && /already there/.test(down.reason), JSON.stringify(down));
    const pat = await adv.suggestRoute(bot, { toHint: "patrol" });
    check("hint patrol: closed walk starts+ends at A",
      pat.ok && pat.legs.length > 1 && pat.legs[0].lb === A && lastLb(pat) === A, JSON.stringify(pat));
    const alias = await adv.suggestRoute(bot, { toHint: "DEEPEST" });
    check("hint aliases + case-insensitive", alias.ok && alias.to === U, JSON.stringify(alias));
    const bad = await adv.suggestRoute(bot, { toHint: "sideways" });
    check("hint unknown -> bad-target listing hints",
      bad.ok === false && bad.error === "bad-target" && bad.reason.includes(HINT_NAMES), JSON.stringify(bad));
    // No frontier once the frontier portal is known:
    const full = mkGraph();
    full.set(FRONTIER, { pos: { x: 230, y: 32460, z: 0 }, neighbors: [F] });
    full.get(F).neighbors = [C, U, FRONTIER];
    const nofr = await adv.suggestRoute(mkBot(poseA(), full), { toHint: "unexplored" });
    check("hint unexplored on fully-known graph -> no-frontier", nofr.ok === false && nofr.error === "no-frontier", JSON.stringify(nofr));
  }

  // ---- suggestRoute: degradations (never throws)
  {
    const adv = new DungeonNavAdvisor();
    const r1 = await adv.suggestRoute(null, { toCellId: U });
    check("degrade: no bot -> no-pose", r1.ok === false && r1.error === "no-pose" && typeof r1.reason === "string", JSON.stringify(r1));
    const r2 = await adv.suggestRoute(mkBot(poseAt(0xa9b4002e, 100, 100, 0), mkGraph()), { toCellId: U });
    check("degrade: outdoors -> advises use goto (outdoor)",
      r2.ok === false && r2.error === "outdoors" && r2.reason.includes("use goto (outdoor)"), JSON.stringify(r2));
    const r3 = await adv.suggestRoute(mkBot(poseA()), { toCellId: U });
    check("degrade: indoors, no graph anywhere -> no-graph", r3.ok === false && r3.error === "no-graph", JSON.stringify(r3));
    const r4 = await adv.suggestRoute(mkBot(poseA(), mkGraph()), {});
    check("degrade: no target -> no-target with usage", r4.ok === false && r4.error === "no-target", JSON.stringify(r4));
    const r5 = await adv.suggestRoute({ host: { TryGetPlayerPose() { throw new Error("boom"); } } }, { toHint: "farthest" });
    check("degrade: hostile pose thrower -> ok:false, no throw", r5.ok === false, JSON.stringify(r5));
  }

  // ---- graph sources: constructor graph, async graphSource, wasm seam + cache
  {
    const advStatic = new DungeonNavAdvisor({ graph: mkGraph() });
    const rs = await advStatic.suggestRoute(mkBot(poseA()), { toCellId: U });
    check("source: constructor graph wins without bot.indoorGraph", rs.ok && lastLb(rs) === U, JSON.stringify(rs));

    let sourceCalls = 0;
    const advSrc = new DungeonNavAdvisor({ graphSource: async () => { sourceCalls++; return mkGraph(); } });
    const botNoGraph = mkBot(poseA());
    check("source: async graphSource not usable by sync describe (pre-prime)",
      advSrc.describeSurroundings(botNoGraph).includes("unavailable"));
    const rr = await advSrc.suggestRoute(botNoGraph, { toHint: "farthest" });
    check("source: async graphSource resolves for suggestRoute", rr.ok && rr.to === U, JSON.stringify(rr));
    check("source: async resolution primes the sync cache",
      sourceCalls >= 1 && advSrc.describeSurroundings(botNoGraph).includes("cells=6"));

    // Live path: buildGraphFromWasm via injected fetchEnvCells + host.s handle
    // (fake EnvCellPlacement duck types, indoor_router.js:540-547 fields).
    const g = mkGraph();
    const placements = [...g].map(([id, n]) => ({
      cellId: id, cellOriginX: n.pos.x, cellOriginY: n.pos.y, cellOriginZ: n.pos.z,
      takePortalCellIds: () => n.neighbors.slice(), free() {},
    }));
    const fetched = [];
    const advWasm = new DungeonNavAdvisor({ fetchEnvCells: async (lb) => { fetched.push(lb >>> 0); return placements; } });
    const wasmBot = { host: { TryGetPlayerPose: () => poseA(), s: { getCurrentCellId: () => A } } };
    const rw = await advWasm.suggestRoute(wasmBot, { toHint: "farthest" });
    check("wasm: graph built from placements via host.s", rw.ok && rw.to === U, JSON.stringify(rw));
    check("wasm: fetched the dungeon landblock once", fetched.length === 1 && fetched[0] === (A & 0xffff0000) >>> 0, JSON.stringify(fetched));
    check("wasm: cache serves sync describe after the build",
      advWasm.describeSurroundings(wasmBot).includes("cells=6"));
    await advWasm.suggestRoute(wasmBot, { toHint: "up" });
    check("wasm: same-landblock cache prevents a rebuild", fetched.length === 1, JSON.stringify(fetched));
  }

  // ---- action definition: shape + validate
  {
    const adv = new DungeonNavAdvisor();
    const def = dungeonSuggestAction(adv);
    check("action: type + ACTIONS-entry shape", def.type === "dungeon_suggest"
      && typeof def.desc === "string" && def.params && typeof def.params.to === "string"
      && Object.values(def.params).every((p) => typeof p === "string"));
    check("action: renders like an actions.js catalog row",
      `${def.type} {${Object.entries(def.params).map(([k, d]) => `${k}: ${d}`).join("; ")}} — ${def.desc}`.includes("dungeon_suggest {to:"));
    check("action: advisory (result-only, never a bot mover)", /does NOT move the bot/i.test(def.desc), def.desc);
    check("validate: to optional", def.validate({ type: "dungeon_suggest" }).ok === true);
    check("validate: hint string ok", def.validate({ type: "dungeon_suggest", to: "farthest" }).ok === true);
    check("validate: integer cell id ok", def.validate({ type: "dungeon_suggest", to: U }).ok === true);
    check("validate: empty string rejected", def.validate({ type: "dungeon_suggest", to: "  " }).ok === false);
    check("validate: over-long string rejected", def.validate({ type: "dungeon_suggest", to: "x".repeat(TO_MAX_CHARS + 1) }).ok === false);
    check("validate: negative / non-int number rejected",
      def.validate({ type: "dungeon_suggest", to: -1 }).ok === false && def.validate({ type: "dungeon_suggest", to: 1.5 }).ok === false);
    check("validate: object to rejected", def.validate({ type: "dungeon_suggest", to: {} }).ok === false);
    check("validate: wrong type rejected", def.validate({ type: "goto" }).ok === false && def.validate(null).ok === false);
    check("v1 untouched: actions.js still rejects dungeon_suggest",
      actionsMod.validateAction({ type: "dungeon_suggest" }).ok === false && !("dungeon_suggest" in actionsMod.ACTIONS));
  }

  // ---- action apply: results, journal note, never-throws
  {
    const adv = new DungeonNavAdvisor();
    const def = dungeonSuggestAction(adv);
    const bot = mkBot(poseA(), mkGraph());
    const notes = [];
    const journal = { add: (kind, text) => notes.push({ kind, text: String(text) }) };

    const r0 = await def.apply(bot, { type: "dungeon_suggest" }, { journal });
    check("apply: no to -> surroundings only", r0.ok === true && typeof r0.result.surroundings === "string"
      && r0.result.suggestion === undefined, JSON.stringify(r0));
    const r1 = await def.apply(bot, { type: "dungeon_suggest", to: "farthest" }, { journal });
    check("apply: hint to -> suggestion attached", r1.ok === true && r1.result.suggestion.ok === true
      && r1.result.suggestion.to === U, JSON.stringify(r1.result.suggestion?.reason));
    const r2 = await def.apply(bot, { type: "dungeon_suggest", to: "0x01a90104" }, { journal });
    check("apply: cell-id to -> route suggestion", r2.ok === true && r2.result.suggestion.ok === true, JSON.stringify(r2.result.suggestion));
    check("apply: journal notes carry the advice for the next check-in",
      notes.length === 3 && notes.every((n) => n.kind === "note" && n.text.startsWith("dungeon_suggest:"))
      && notes[1].text.includes("dest lb=0x01a90104") && notes.every((n) => n.text.length <= 500),
      JSON.stringify(notes.map((n) => n.text.length)));
    const rOut = await def.apply(mkBot(poseAt(0xa9b4002e, 100, 100, 0), mkGraph()), { type: "dungeon_suggest", to: "farthest" }, {});
    check("apply: outdoors is advice, not an action failure",
      rOut.ok === true && rOut.result.suggestion.ok === false && rOut.result.suggestion.error === "outdoors", JSON.stringify(rOut));
    const rInv = await def.apply(bot, { type: "dungeon_suggest", to: "" }, {});
    check("apply: invalid action -> ok:false via own validate", rInv.ok === false && typeof rInv.error === "string");
    const rNoAdv = await dungeonSuggestAction(null).apply(bot, { type: "dungeon_suggest" }, {});
    check("apply: no advisor anywhere -> unavailable", rNoAdv.ok === false && rNoAdv.error === "unavailable");
    const hostile = { describeSurroundings() { throw new Error("boom"); }, suggestRoute() { throw new Error("boom"); } };
    const rHostile = await def.apply(bot, { type: "dungeon_suggest", to: "farthest" }, { advisor: hostile });
    check("apply: hostile ctx.advisor -> resolves, never throws",
      rHostile.ok === true && rHostile.result.suggestion.ok === false, JSON.stringify(rHostile));
    const rBadJournal = await def.apply(bot, { type: "dungeon_suggest" }, { journal: { add() { throw new Error("quota"); } } });
    check("apply: journal thrower swallowed", rBadJournal.ok === true);
  }

  // ---- registerDungeonNav
  {
    const adv = new DungeonNavAdvisor({ graph: mkGraph() });
    const map = { ...actionsMod.ACTIONS };
    const def = registerDungeonNav(map, adv);
    check("register: mutates the passed-in copy, returns the def",
      map.dungeon_suggest === def && def.type === "dungeon_suggest" && !("dungeon_suggest" in actionsMod.ACTIONS));
    let threw = null;
    try { registerDungeonNav(null, adv); } catch (e) { threw = e; }
    check("register: loud TypeError on a bad map", threw instanceof TypeError);
    const fake = {};
    registerDungeonNav(fake, adv);
    check("register: works on any mutable map", typeof fake.dungeon_suggest.apply === "function");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
