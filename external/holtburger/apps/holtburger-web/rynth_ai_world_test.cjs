#!/usr/bin/env node
// rynth_ai_world_test.cjs — unit tests for rynth/ai/tools/world.js (the general
// use_object interaction primitive) via a mock host. No infra.

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function makeJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
}

const NEARBY = {
  0x5001: "Exit to Holtburg",
  0x5002: "Sedor Wystan the Blacksmith",
  0x5003: "Training Chest",
  0x5004: "Sedor's Apprentice",
};
const INVENTORY = [
  { guid: 0x6001, name: "Exit Token", value: 0, stackSize: 1, equipMask: 0, wcid: 100 },
  { guid: 0x6002, name: "Bread", value: 1, stackSize: 4, equipMask: 0, wcid: 259 },
  { guid: 0x6003, name: "Breadfruit", value: 1, stackSize: 1, equipMask: 0, wcid: 260 },
];
function makeHost() {
  const calls = [];
  return {
    calls,
    NearbyGuids: () => Object.keys(NEARBY).map((k) => Number(k)),
    TryGetObjectName: (g) => NEARBY[g] ?? null,
    UseObject: (g) => { calls.push(["use", g]); return true; },
    TakeObject: (g) => { calls.push(["take", g]); return true; },
    GiveObject: (t, i, q) => { calls.push(["give", t, i, q]); return true; },
    PursueObject: (g, r, _h, run) => { calls.push(["pursue", g, r, run]); return true; },
    TryGetPlayerInventory: () => INVENTORY,
  };
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { worldActions } = await import(modUrl("rynth/ai/tools/world.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));

  const defs = worldActions();
  const byType = Object.fromEntries(defs.map((d) => [d.type, d]));
  check("nine defs (use/take/give/goto + open_container/appraise/use_item_on/drop_item/confirm)",
    Object.keys(byType).length === 9 && byType.use_object && byType.take_item && byType.give_item &&
    byType.goto_object && byType.open_container && byType.appraise && byType.use_item_on &&
    byType.drop_item && byType.confirm);

  // use by exact name -> portal
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal });
    check("use_object exact name (portal)", r.ok && host.calls.some((c) => c[0] === "use" && c[1] === 0x5001), JSON.stringify(r));
    check("use_object journaled", journal.entries.some((e) => /use_object Exit to Holtburg/.test(e.text)));
  }
  // use by guid
  {
    const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "0x5002" }, { journal: makeJournal() });
    check("use_object by guid", r.ok && host.calls.some((c) => c[1] === 0x5002), JSON.stringify(r));
  }
  // substring unique
  {
    const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "chest" }, { journal: makeJournal() });
    check("use_object substring unique", r.ok && host.calls.some((c) => c[1] === 0x5003), JSON.stringify(r));
  }
  // ambiguous substring
  {
    const r = await byType.use_object.apply({ host: makeHost() }, { type: "use_object", object: "sedor" }, { journal: makeJournal() });
    check("use_object ambiguous fails", !r.ok && /ambiguous/i.test(r.error), r.error);
  }
  // no match
  {
    const r = await byType.use_object.apply({ host: makeHost() }, { type: "use_object", object: "dragon" }, { journal: makeJournal() });
    check("use_object no match fails", !r.ok && /no nearby object/.test(r.error), r.error);
  }
  // hostless degrade
  {
    const r = await byType.use_object.apply({ host: {} }, { type: "use_object", object: "portal" }, { journal: makeJournal() });
    check("use_object hostless -> ok:false", !r.ok && /unavailable/.test(r.error), r.error);
  }
  // take_item: pickup by name -> TakeObject, not UseObject
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.take_item.apply(bot, { type: "take_item", object: "Training Chest" }, { journal });
    check("take_item sends TakeObject", r.ok && host.calls.some((c) => c[0] === "take" && c[1] === 0x5003), JSON.stringify(r));
    check("take_item never UseObject", !host.calls.some((c) => c[0] === "use"));
    check("take_item journaled", journal.entries.some((e) => /take_item Training Chest/.test(e.text)));
  }
  // take_item: unknown object fails; hostless degrades
  {
    const r = await byType.take_item.apply({ host: makeHost() }, { type: "take_item", object: "dragon" }, { journal: makeJournal() });
    check("take_item no match fails", !r.ok && /no nearby object/.test(r.error), r.error);
    const r2 = await byType.take_item.apply({ host: {} }, { type: "take_item", object: "chest" }, { journal: makeJournal() });
    check("take_item hostless -> ok:false", !r2.ok && /unavailable/.test(r2.error), r2.error);
  }
  // give_item: token to NPC by name + guid target
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.give_item.apply(bot, { type: "give_item", item: "exit token", target: "0x5004" }, { journal });
    check("give_item name item + guid target", r.ok && host.calls.some((c) => c[0] === "give" && c[1] === 0x5004 && c[2] === 0x6001 && c[3] === 1), JSON.stringify(r));
    check("give_item journaled", journal.entries.some((e) => /give_item Exit Token/.test(e.text)));
  }
  // give_item: qty passes through
  {
    const host = makeHost(); const bot = { host };
    const r = await byType.give_item.apply(bot, { type: "give_item", item: "0x6002", target: "Sedor's Apprentice", qty: 4 }, { journal: makeJournal() });
    check("give_item guid item + qty", r.ok && host.calls.some((c) => c[0] === "give" && c[1] === 0x5004 && c[2] === 0x6002 && c[3] === 4), JSON.stringify(r));
  }
  // give_item: ambiguous inventory item fails
  {
    const r = await byType.give_item.apply({ host: makeHost() }, { type: "give_item", item: "brea", target: "0x5004" }, { journal: makeJournal() });
    check("give_item ambiguous item fails", !r.ok && /ambiguous/i.test(r.error), r.error);
  }
  // give_item: unknown target fails
  {
    const r = await byType.give_item.apply({ host: makeHost() }, { type: "give_item", item: "exit token", target: "dragon" }, { journal: makeJournal() });
    check("give_item no target fails", !r.ok && /no nearby object/.test(r.error), r.error);
  }
  // give_item: bad qty rejected by validate
  {
    const v = byType.give_item.validate({ type: "give_item", item: "exit token", target: "0x5004", qty: 0 });
    check("give_item qty=0 rejected", v.ok === false && /qty/.test(v.error), v.error);
  }
  // give_item: hostless degrade
  {
    const r = await byType.give_item.apply({ host: {} }, { type: "give_item", item: "exit token", target: "0x5004" }, { journal: makeJournal() });
    check("give_item hostless -> ok:false", !r.ok && /unavailable/.test(r.error), r.error);
  }
  // goto_object: walk without using
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.goto_object.apply(bot, { type: "goto_object", object: "0x5001" }, { journal });
    check("goto_object by guid pursues", r.ok && host.calls.some((c) => c[0] === "pursue" && c[1] === 0x5001), JSON.stringify(r));
    check("goto_object never uses", !host.calls.some((c) => c[0] === "use"));
    check("goto_object journaled", journal.entries.some((e) => /goto_object Exit to Holtburg/.test(e.text)));
  }
  // goto_object: track seam fires
  {
    const tracked = [];
    const r = await byType.goto_object.apply({ host: makeHost() }, { type: "goto_object", object: "chest" }, { journal: makeJournal(), track: (g, n) => tracked.push([g, n]) });
    check("goto_object tracks", r.ok && tracked.length === 1 && tracked[0][0] === 0x5003 && /Chest/.test(tracked[0][1]), JSON.stringify(tracked));
  }
  // goto_object: hostless degrade
  {
    const r = await byType.goto_object.apply({ host: {} }, { type: "goto_object", object: "chest" }, { journal: makeJournal() });
    check("goto_object hostless -> ok:false", !r.ok && /unavailable/.test(r.error), r.error);
  }
  // extensions wiring
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false } });
    check("default-on: use_object registered", !!ext.extActions.use_object);
    check("default-on: give_item registered", !!ext.extActions.give_item);
    check("prompt advertises use_object", ext.directorDeps.systemPrompt.includes("use_object"));
    check("prompt advertises give_item", ext.directorDeps.systemPrompt.includes("give_item"));
    check("validate routes use_object", ext.directorDeps.validate({ type: "use_object", object: "portal" }).ok === true);
    check("validate routes give_item", ext.directorDeps.validate({ type: "give_item", item: "token", target: "npc" }).ok === true);
  }
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { world: false, knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false } });
    check("world:false -> not registered", !ext.extActions.use_object && !ext.extActions.give_item);
  }
  // pursue-then-use: use_object walks into range first (ACE answers a far Use
  // with UseDone(OutOfRange) and no emote). Arrival = the player's own pose
  // settling — pursuitStatus is read-clear and the kernel steals the latch.
  {
    const host = makeHost();
    const calls = host.calls;
    let x = 0;
    host.TryGetPlayerPose = () => ({ objCellId: 0x860201ad, x: (x = Math.min(x + 5, 20)), y: 0, z: 0 }); // walks, then stands still at 20
    const r = await byType.use_object.apply({ host }, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    const pi = calls.findIndex((c) => c[0] === "pursue");
    const ui = calls.findIndex((c) => c[0] === "use");
    check("use_object pursues before using", r.ok && pi !== -1 && ui !== -1 && pi < ui, JSON.stringify(calls));
    check("use_object reports settled walk", r.result?.walk === "settled", JSON.stringify(r));
  }
  // pursue-then-use: a bot that never moves (already adjacent or pursue
  // rejected) still sends the Use, tagged no-walk.
  {
    const host = makeHost();
    host.TryGetPlayerPose = () => ({ objCellId: 0x860201ad, x: 1, y: 1, z: 0 });
    const r = await byType.use_object.apply({ host }, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("use_object sends despite no walk", r.ok && host.calls.some((c) => c[0] === "use") && r.result?.walk === "no-walk", JSON.stringify(r));
  }
  // pursue-then-use: pose unavailable degrades to a blind grace wait + Use.
  {
    const host = makeHost();
    const r = await byType.use_object.apply({ host }, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("use_object blind host still uses", r.ok && host.calls.some((c) => c[0] === "use") && r.result?.walk === "blind", JSON.stringify(r));
  }
  // embedded guid in a name string resolves (the "Door 0x7860202d" habit)
  {
    const host = makeHost();
    const r = await byType.use_object.apply({ host }, { type: "use_object", object: "Door 0x5003" }, { journal: makeJournal() });
    check("embedded guid in ref resolves", r.ok && host.calls.some((c) => c[0] === "use" && c[1] === 0x5003), JSON.stringify(r));
  }
  // give_item pursues the target too (token hand-back has the same range gate).
  {
    const host = makeHost();
    host.GetPursuitStatus = () => 2;
    const r = await byType.give_item.apply({ host }, { type: "give_item", item: "token", target: "Blacksmith" }, { journal: makeJournal() });
    const pi = host.calls.findIndex((c) => c[0] === "pursue");
    const gi = host.calls.findIndex((c) => c[0] === "give");
    check("give_item pursues before giving", r.ok && pi !== -1 && gi !== -1 && pi < gi, JSON.stringify(host.calls));
  }

  // ── indoor door-waypoint routing (handoff-4 §0.4 wiring) ──────────────
  // Two-cell dungeon: player in 0x860201A0, target object in 0x860201B0.
  // World-frame graph pos per indoor_router contract (lb 0x86,0x02 origin =
  // 25728, 384). bot.indoorGraph injection wins over the wasm builder.
  const LBX = 0x86 * 192, LBY = 0x02 * 192;
  const twoCellGraph = new Map([
    [0x860201a0, { pos: { x: LBX + 50, y: LBY + 50, z: 0 }, neighbors: [0x860201b0] }],
    [0x860201b0, { pos: { x: LBX + 60, y: LBY + 50, z: 0 }, neighbors: [0x860201a0] }],
  ]);
  function makeRouterBot(host, { routerState = "DONE" } = {}) {
    const router = {
      state: "IDLE",
      followed: null,
      walked: 0,
      follow(legs) { this.followed = legs; this.state = routerState; this.walked = routerState === "DONE" ? legs.length : 0; },
      cancel() { this.state = "IDLE"; },
      get done() { return this.state === "DONE" || this.state === "FAILED"; },
      get status() { return { state: this.state, leg: 0, legs: this.followed?.length ?? 0, walked: this.walked }; },
    };
    const kernel = { running: true, stops: 0, starts: 0, stop() { this.stops++; this.running = false; }, start() { this.starts++; this.running = true; } };
    return { host, router, kernel, indoorGraph: twoCellGraph };
  }
  function makeIndoorHost() {
    const host = makeHost();
    host.TryGetPlayerPose = () => ({ objCellId: 0x860201a0, x: 50, y: 50, z: 0 });
    host.TryGetObjectPosition = (g) => (g === 0x5001 ? { objCellId: 0x860201b0, x: 60, y: 50, z: 0 } : null);
    return host;
  }
  // cross-room use_object: router walks door-waypoint legs, then pursues+uses.
  {
    const host = makeIndoorHost();
    const bot = makeRouterBot(host);
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    const legs = bot.router.followed;
    check("cross-room use routes legs", r.ok && Array.isArray(legs) && legs.length === 2, JSON.stringify(legs));
    check("route ends at the object's own position",
      legs && legs[legs.length - 1].lb === 0x860201b0 && legs[legs.length - 1].x === 60 && legs[legs.length - 1].y === 50,
      JSON.stringify(legs));
    check("first leg is the doorway midpoint", legs && legs[0].x === 55 && legs[0].y === 50, JSON.stringify(legs));
    check("walk tag carries routed()", String(r.result?.walk).startsWith("routed(2)+"), JSON.stringify(r.result));
    check("kernel paused and restored", bot.kernel.stops === 1 && bot.kernel.starts === 1 && bot.kernel.running === true);
    check("still pursues then uses", host.calls.findIndex((c) => c[0] === "pursue") < host.calls.findIndex((c) => c[0] === "use"), JSON.stringify(host.calls));
  }
  // same-cell target: routing must NOT engage (straight pursuit is proven).
  {
    const host = makeIndoorHost();
    host.TryGetObjectPosition = () => ({ objCellId: 0x860201a0, x: 52, y: 50, z: 0 });
    const bot = makeRouterBot(host);
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("same-cell use skips routing", r.ok && bot.router.followed === null && !String(r.result?.walk).includes("routed"), JSON.stringify(r.result));
  }
  // router FAILED (wall wedge etc): tagged route-failed, Use still sent.
  {
    const host = makeIndoorHost();
    const bot = makeRouterBot(host, { routerState: "FAILED" });
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("failed route degrades to use", r.ok && host.calls.some((c) => c[0] === "use") && String(r.result?.walk).startsWith("route-failed("), JSON.stringify(r.result));
    check("failed route still restores kernel", bot.kernel.running === true);
  }
  // goto_object cross-room: same seam, result carries the route tag.
  {
    const host = makeIndoorHost();
    const bot = makeRouterBot(host);
    const r = await byType.goto_object.apply(bot, { type: "goto_object", object: "0x5001" }, { journal: makeJournal() });
    check("goto_object routes cross-room", r.ok && bot.router.followed?.length === 2 && r.result?.walk === "routed(2)", JSON.stringify(r.result));
  }
  // give_item cross-room: approach routes before the give.
  {
    const host = makeIndoorHost();
    host.TryGetObjectPosition = (g) => (g === 0x5002 ? { objCellId: 0x860201b0, x: 60, y: 50, z: 0 } : null);
    const bot = makeRouterBot(host);
    const r = await byType.give_item.apply(bot, { type: "give_item", item: "token", target: "Blacksmith" }, { journal: makeJournal() });
    check("give_item routes cross-room", r.ok && bot.router.followed?.length === 2 && String(r.result?.walk).startsWith("routed(2)+"), JSON.stringify(r.result));
  }
  // cross-LANDBLOCK target (soak-7 §4.3): indoorLegsTo used to bail on the
  // seam; with the stitched graph (injected here) the route walks through.
  // Player in lb 0x8602, target in lb 0x8702 one block east — seam portal
  // records reference full 32-bit ids, world-frame x continues across.
  {
    const LBX2 = 0x87 * 192;
    const crossLbGraph = new Map([
      [0x860201a0, { pos: { x: LBX + 180, y: LBY + 50, z: 0 }, neighbors: [0x860201b0] }],
      [0x860201b0, { pos: { x: LBX + 190, y: LBY + 50, z: 0 }, neighbors: [0x860201a0, 0x87020100] }],
      [0x87020100, { pos: { x: LBX2 + 10, y: LBY + 50, z: 0 }, neighbors: [0x860201b0] }],
    ]);
    const host = makeIndoorHost();
    host.TryGetPlayerPose = () => ({ objCellId: 0x860201a0, x: 180, y: 50, z: 0 });
    host.TryGetObjectPosition = (g) => (g === 0x5001 ? { objCellId: 0x87020100, x: 12, y: 50, z: 0 } : null);
    const bot = makeRouterBot(host);
    bot.indoorGraph = crossLbGraph;
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    const legs = bot.router.followed;
    check("cross-LB use routes stitched legs", r.ok && Array.isArray(legs) && legs.length === 4, JSON.stringify(legs));
    check(
      "cross-LB route ends at target pos in its OWN landblock frame",
      legs && legs[legs.length - 1].lb === 0x87020100 && legs[legs.length - 1].x === 12 && legs[legs.length - 1].y === 50,
      JSON.stringify(legs)
    );
    check(
      "cross-LB legs carry per-cell landblock-local coords",
      legs && legs.every((l) => l.x >= 0 && l.x < 192 && l.y >= 0 && l.y < 192),
      JSON.stringify(legs)
    );
    check("cross-LB walk tag routed", String(r.result?.walk).startsWith("routed(4)+"), JSON.stringify(r.result));
  }
  // pose cell WINS over nearest-centre (v6.3.1 route-failed(0/N) regression):
  // the body stands in cell A hard against the B-shared wall — nearer B's
  // CENTRE than A's. nearestCell-first resolved from=B(=to) -> no route ->
  // out-of-range Use. Id-first must route the 2 legs from A.
  {
    const host = makeIndoorHost();
    host.TryGetPlayerPose = () => ({ objCellId: 0x860201a0, x: 59, y: 50, z: 0 });
    const bot = makeRouterBot(host);
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("pose cell beats nearest-centre for the from-cell",
      r.ok && bot.router.followed?.length === 2 && String(r.result?.walk).startsWith("routed(2)+"),
      JSON.stringify(r.result));
  }
  // no router on the bot: unchanged straight-pursuit behavior.
  {
    const host = makeIndoorHost();
    const r = await byType.use_object.apply({ host, indoorGraph: twoCellGraph }, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("no router degrades to straight pursuit", r.ok && host.calls.some((c) => c[0] === "pursue") && !String(r.result?.walk).includes("routed"), JSON.stringify(r.result));
  }
  // goto owns the router: routing yields, straight pursuit fires.
  {
    const host = makeIndoorHost();
    const bot = makeRouterBot(host);
    bot.globalRouter = { busy: true };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("goto-active yields to straight pursuit", r.ok && bot.router.followed === null && !String(r.result?.walk).includes("routed"), JSON.stringify(r.result));
  }

  // ── new verbs (2026-07-18 verb-audit gaps) ────────────────────────────
  // open_container -> contents journaled + take_item resolves FROM them.
  // Shared state rides worldActions() — build one fresh def set per case.
  {
    const w = worldActions();
    const wb = Object.fromEntries(w.map((d) => [d.type, d]));
    const journal = makeJournal();
    const host = makeHost();
    host.GetContainerContents = (g) => (g === 0x5003 ? [0x7001, 0x7002] : []);
    const names = { ...NEARBY, 0x7001: "Acid Key", 0x7002: "Tattered Note" };
    host.TryGetObjectName = (g) => names[g] ?? null;
    const bot = { host };
    const r = await wb.open_container.apply(bot, { type: "open_container", object: "Training Chest" }, { journal });
    check("open_container uses + reads contents", r.ok && r.result.items === 2 && host.calls.some((c) => c[0] === "use" && c[1] === 0x5003), JSON.stringify(r));
    check("open_container journals contents", journal.entries.some((e) => /Acid Key 0x7001/.test(e.text) && /Tattered Note/.test(e.text)), JSON.stringify(journal.entries));
    // now take a SPECIFIC contained item by name — not in NearbyGuids.
    const r2 = await wb.take_item.apply(bot, { type: "take_item", object: "acid key" }, { journal });
    check("take_item resolves container contents", r2.ok && host.calls.some((c) => c[0] === "take" && c[1] === 0x7001), JSON.stringify(r2));
    check("take_item reports container origin", r2.result?.from === "Training Chest", JSON.stringify(r2.result));
    // and by guid too
    const r3 = await wb.take_item.apply(bot, { type: "take_item", object: "0x7002" }, { journal });
    check("take_item container guid resolves", r3.ok && host.calls.some((c) => c[0] === "take" && c[1] === 0x7002), JSON.stringify(r3));
  }
  // open_container: unacked open (no ViewContents at all) degrades to ok
  // with the not-acknowledged note; an ACKED open with zero items reports
  // a confirmed-empty container (2026-07-18 disambiguation).
  {
    const w = worldActions();
    const wb = Object.fromEntries(w.map((d) => [d.type, d]));
    const journal = makeJournal();
    const host = makeHost();
    host.GetContainerContents = () => [];
    const t0 = Date.now();
    const r = await wb.open_container.apply({ host }, { type: "open_container", object: "Training Chest" }, { journal });
    check("open_container empty still ok", r.ok && r.result.items === 0, JSON.stringify(r));
    check("open_container unacked journals the miss", journal.entries.some((e) => /open NOT acknowledged/.test(e.text)));
    check("open_container empty polls out (~5s)", Date.now() - t0 >= 4500);
  }
  {
    const w = worldActions();
    const wb = Object.fromEntries(w.map((d) => [d.type, d]));
    const journal = makeJournal();
    const host = makeHost();
    host.GetContainerContents = () => [];
    host.GetGroundContainerId = () => 0x5003; // ViewContents acked the open (Training Chest)
    const r = await wb.open_container.apply({ host }, { type: "open_container", object: "Training Chest" }, { journal });
    check("open_container acked-empty still ok", r.ok && r.result.items === 0, JSON.stringify(r));
    check("open_container acked-empty journals EMPTY", journal.entries.some((e) => /container is EMPTY/.test(e.text)));
  }
  // appraise: fresh identify -> journaled summary from the snapshot JSON.
  {
    const journal = makeJournal();
    const host = makeHost();
    host.RequestId = (g) => { host.calls.push(["id", g]); return true; };
    host.HasAppraisalData = () => true;
    host.GetLastIdTime = () => 0;
    host.TryGetObjectAppraisal = (g) =>
      g === 0x5003 ? { identifySuccess: true, properties: { strings: { LongDesc: "A sturdy training chest." }, ints: { Value: 25 } } } : null;
    const r = await byType.appraise.apply({ host }, { type: "appraise", object: "Training Chest" }, { journal });
    check("appraise sends RequestId + ok", r.ok && r.result.fresh === true && host.calls.some((c) => c[0] === "id" && c[1] === 0x5003), JSON.stringify(r));
    check("appraise journals the summary", journal.entries.some((e) => /LongDesc: A sturdy training chest\./.test(e.text) && /Value=25/.test(e.text)), JSON.stringify(journal.entries));
  }
  // appraise: inventory-item fallback (not in nearby).
  {
    const host = makeHost();
    host.RequestId = (g) => { host.calls.push(["id", g]); return true; };
    host.HasAppraisalData = () => true;
    host.TryGetObjectAppraisal = () => ({ properties: { ints: { Value: 1 } } });
    const r = await byType.appraise.apply({ host }, { type: "appraise", object: "exit token" }, { journal: makeJournal() });
    check("appraise falls back to inventory items", r.ok && host.calls.some((c) => c[0] === "id" && c[1] === 0x6001), JSON.stringify(r));
  }
  // appraise: no data arriving -> ok:false with guidance.
  {
    const host = makeHost();
    host.RequestId = () => true;
    host.HasAppraisalData = () => false;
    host.TryGetObjectAppraisal = () => null;
    const r = await byType.appraise.apply({ host }, { type: "appraise", object: "Training Chest" }, { journal: makeJournal() });
    check("appraise no-data fails informatively", !r.ok && /no appraisal data/.test(r.error), JSON.stringify(r));
  }
  // use_item_on: inventory item onto a nearby target (key -> chest).
  {
    const journal = makeJournal();
    const host = makeHost();
    host.UseItemOnTarget = (i, t) => { host.calls.push(["useOn", i, t]); return true; };
    const r = await byType.use_item_on.apply({ host }, { type: "use_item_on", item: "exit token", target: "Training Chest" }, { journal });
    check("use_item_on sends UseWithTarget", r.ok && host.calls.some((c) => c[0] === "useOn" && c[1] === 0x6001 && c[2] === 0x5003), JSON.stringify(r));
    check("use_item_on journaled", journal.entries.some((e) => /use_item_on Exit Token -> Training Chest/.test(e.text)));
    const r2 = await byType.use_item_on.apply({ host: {} }, { type: "use_item_on", item: "x", target: "y" }, { journal: makeJournal() });
    check("use_item_on hostless -> ok:false", !r2.ok && /unavailable/.test(r2.error));
  }
  // drop_item: pack item -> DropItem.
  {
    const journal = makeJournal();
    const host = makeHost();
    host.DropItem = (g) => { host.calls.push(["drop", g]); return true; };
    const r = await byType.drop_item.apply({ host }, { type: "drop_item", item: "brea" }, { journal });
    check("drop_item ambiguous ref fails", !r.ok && /ambiguous/i.test(r.error), JSON.stringify(r));
    const r2 = await byType.drop_item.apply({ host }, { type: "drop_item", item: "0x6001" }, { journal });
    check("drop_item sends DropItem", r2.ok && host.calls.some((c) => c[0] === "drop" && c[1] === 0x6001), JSON.stringify(r2));
    check("drop_item journaled", journal.entries.some((e) => /drop_item Exit Token/.test(e.text)));
  }
  // confirm: answers the pending dialog verbatim; fails clean when none.
  {
    const journal = makeJournal();
    const host = makeHost();
    host.TryGetPendingConfirmations = () => [{ confirmType: 1, context: 42, text: "Aria would like you to swear allegiance." }];
    host.SendConfirmationResponse = (t, c, ac) => { host.calls.push(["confirm", t, c, ac]); return true; };
    const r = await byType.confirm.apply({ host }, { type: "confirm", accept: true }, { journal });
    check("confirm answers type/context verbatim", r.ok && host.calls.some((c) => c[0] === "confirm" && c[1] === 1 && c[2] === 42 && c[3] === true), JSON.stringify(r));
    check("confirm journaled", journal.entries.some((e) => /confirm ACCEPT/.test(e.text)));
    host.TryGetPendingConfirmations = () => [];
    const r2 = await byType.confirm.apply({ host }, { type: "confirm", accept: false }, { journal: makeJournal() });
    check("confirm none-pending fails", !r2.ok && /no confirmation dialog/.test(r2.error), JSON.stringify(r2));
    const v = byType.confirm.validate({ type: "confirm", accept: "yes" });
    check("confirm validates accept boolean", v.ok === false && /boolean/.test(v.error));
  }
  // ── closed-door mid-route retry (handoff-6 §3.3) ──────────────────────
  // First follow FAILS; a closed (non-ethereal) door sits by the player;
  // walkRoute must open it and re-follow the remaining legs once.
  {
    const host = makeIndoorHost();
    host.TryGetObjectDescFlags = (g) => (g === 0x5004 ? 0x1000 : 0); // 0x5004 is a Door
    host.TryGetObjectState = () => 0; // NOT ethereal -> closed
    const doorPos = { objCellId: 0x860201a0, x: 52, y: 50, z: 0 };
    const basePos = host.TryGetObjectPosition;
    host.TryGetObjectPosition = (g) => (g === 0x5004 ? doorPos : basePos(g));
    let follows = 0;
    const bot = makeRouterBot(host);
    const origFollow = bot.router.follow.bind(bot.router);
    bot.router.follow = function (legs) {
      follows++;
      this.followed = legs;
      this.state = follows === 1 ? "FAILED" : "DONE";
      this.walked = follows === 1 ? 0 : legs.length;
    };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("door-retry re-follows after opening", r.ok && follows === 2, JSON.stringify({ follows, walk: r.result?.walk }));
    check("door-retry opened the closed door", host.calls.some((c) => c[0] === "use" && c[1] === 0x5004), JSON.stringify(host.calls));
    check("door-retry walk tag carries the splice", /route-failed\(0\/2\)\+door\(Sedor's Apprentice\)\+routed\(2\)/.test(String(r.result?.walk)), JSON.stringify(r.result));
  }
  // door-retry does NOT touch an OPEN (ethereal) door.
  {
    const host = makeIndoorHost();
    host.TryGetObjectDescFlags = (g) => (g === 0x5004 ? 0x1000 : 0);
    host.TryGetObjectState = () => 0x4; // ethereal -> already open
    const basePos = host.TryGetObjectPosition;
    host.TryGetObjectPosition = (g) => (g === 0x5004 ? { objCellId: 0x860201a0, x: 52, y: 50, z: 0 } : basePos(g));
    const bot = makeRouterBot(host, { routerState: "FAILED" });
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal: makeJournal() });
    check("open door not re-used on failed route", r.ok && !host.calls.some((c) => c[0] === "use" && c[1] === 0x5004), JSON.stringify(host.calls));
    check("open-door case keeps plain failed tag", String(r.result?.walk).startsWith("route-failed(0/2)+"), JSON.stringify(r.result));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
