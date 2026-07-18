// tools/world.js — the playtester's general "hands" for the world: use/interact
// with ANY nearby object by name or guid (enter a portal, talk to/open an NPC,
// open a door or chest, pull a lever, read a sign). This is a GENERAL primitive,
// not a scripted path: it resolves a nearby object and calls the host's
// UseObject; the LLM decides what to interact with (from its "nearby"
// perception line, observe_ext.js probeNearbyObjects).
//
// Complements economy.open_vendor (the specialized vendor-profile flow) — for
// non-vendor interactions (the "Exit to Holtburg" portal, generic NPCs, doors)
// use_object is the tool. Same additive registration shape as economy.js.
//
// Survival invariant: every apply degrades to { ok:false, error }.

import { parseGuid, resolveItem } from "./economy.js";
import {
  isEnvCellId,
  nearestCell,
  findPath,
  toLegs,
  buildGraphFromWasm,
} from "../../indoor_router.js";

const JOURNAL_CLIP = 800;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const hex = (g) => `0x${(g >>> 0).toString(16).toUpperCase()}`;

function journalNote(ctx, text) {
  try {
    ctx.journal?.add?.("note", clip(String(text), JOURNAL_CLIP));
  } catch {}
}

function makeApply(def, run) {
  return async function apply(bot, a, ctx = {}) {
    const fail = (error) => {
      try { ctx.log && ctx.log(`[ai] action ${def.type}: ${error}`); } catch {}
      return { type: def.type, ok: false, error: String(error) };
    };
    try {
      const v = def.validate(a);
      if (!v.ok) return fail(v.error);
      return await run(bot, a, ctx, fail);
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };
}

const baseValidate = (type) => (a) => {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
  if (a.type !== type) return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
  return { ok: true };
};

// Resolve a nearby object by guid (wins) or case-insensitive name substring.
// -> { guid, name } | { error }
function resolveNearby(h, ref) {
  let g = parseGuid(ref);
  if (!g && typeof ref === "string") {
    // Models habitually write "Door 0x7860202d" (name + guid in one string);
    // a pure substring match on that fails while the guid sits in plain
    // sight. Extract an embedded 0x guid and prefer it. (Recurring live
    // failure, 3 soaks running.)
    const m = ref.match(/0x[0-9a-fA-F]{3,8}\b/);
    if (m) g = parseGuid(m[0]);
  }
  if (g) {
    const name = (typeof h.TryGetObjectName === "function" ? h.TryGetObjectName(g) : null) || "?";
    return { guid: g, name };
  }
  const want = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!want) return { error: "object must be a name or guid" };
  const hits = [];
  for (const gg of h.NearbyGuids?.() ?? []) {
    let name = null;
    try { name = h.TryGetObjectName(gg); } catch {}
    if (name && name.toLowerCase().includes(want)) hits.push({ guid: gg >>> 0, name });
  }
  if (!hits.length) return { error: `no nearby object matching "${ref}" — check your 'nearby' perception list` };
  const exact = hits.filter((x) => x.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `ambiguous "${ref}": ${hits.slice(0, 5).map((x) => `${x.name} ${hex(x.guid)}`).join(", ")}` };
}

// ── indoor door-waypoint legs (handoff-4 §0.4) ──────────────────────────────
// Straight-line pursuit wedges on walls whenever the target stands in another
// dungeon cell (live repro: Jonathan in 0x01B0, unreachable from the hub —
// walk:no-walk at 25m, quest registry empty). The fix is the deferred
// "indoor-router leg wiring": when both endpoints are EnvCells of the SAME
// landblock but DIFFERENT cells, A* the EnvCell portal graph
// (rynth/indoor_router.js) and walk door-waypoint legs via bot.router BEFORE
// the local PursueObject approach. Everything degrades to the old straight
// pursuit: off-graph, outdoors, cross-landblock, no router, goto active, or
// any error -> null/skip, never a throw into the action.

const worldX = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
const worldY = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;

// Per-landblock graph cache — dungeon geometry is static, one wasm build per
// dungeon visit. bot.indoorGraph (the dungeon_nav.js advisory field) wins so
// tests / integrators can inject a synthetic graph.
let _graphCache = null; // { lb, graph }

async function indoorGraphFor(bot, lb) {
  const injected = bot?.indoorGraph;
  if (injected) return injected;
  if (_graphCache && _graphCache.lb === lb) return _graphCache.graph;
  const handle = bot?.host?.s;
  if (!handle) return null;
  let g = null;
  try {
    g = await buildGraphFromWasm(handle, 0, {});
  } catch {
    g = null;
  }
  if (g) _graphCache = { lb, graph: g };
  return g;
}

/**
 * Door-waypoint legs to `guid`, or null when indoor routing does not apply
 * (outdoors, same cell, cross-landblock, unknown position, no graph, no path).
 * Legs are router.js-shaped {lb,x,y,z}: doorway midpoints (the C# anti-corner-
 * cut waypoints — cell centres alone let MoveToManager clip offset door
 * frames) + cell centres, ending at the target's own position in its cell.
 */
async function indoorLegsTo(bot, guid) {
  const h = bot?.host;
  const pose = h?.TryGetPlayerPose?.();
  const tp = h?.TryGetObjectPosition?.(guid);
  if (!pose || !tp) return null;
  const pc = pose.objCellId >>> 0;
  const tc = tp.objCellId >>> 0;
  if (!isEnvCellId(pc) || !isEnvCellId(tc)) return null; // an endpoint is outdoors
  if (pc >>> 16 !== tc >>> 16) return null; // cross-landblock: not this seam's job
  if (pc === tc) return null; // same room: straight pursuit is proven
  const graph = await indoorGraphFor(bot, pc >>> 16);
  if (!graph) return null;
  // Endpoint cells: the snapshot ids are now the PRIMARY source — the wasm
  // pose-cell freeze that forced position-derived cells (v5.9: 0x01AD across
  // 60m) was root-fixed 2026-07-18 (faithful_bridge indoor→indoor re-derive),
  // and NPC entity cells were always server-truth. nearestCell is the
  // FALLBACK only: its nearest-cell-CENTRE heuristic picks the wrong room
  // near shared walls — v6.3.1 live: route-failed(0/N) on every leg computed
  // from the NE rooms while the pose cell was correct the whole time.
  const has = (id) => (graph instanceof Map ? graph.has(id) : id in graph);
  const from =
    (has(pc) ? pc : 0) || nearestCell(graph, worldX(pc, pose.x), worldY(pc, pose.y), pose.z);
  const to =
    (has(tc) ? tc : 0) || nearestCell(graph, worldX(tc, tp.x), worldY(tc, tp.y), tp.z);
  if (!from || !to || from === to) return null;
  const path = findPath(graph, from, to);
  if (!path || path.length < 2) return null;
  const legs = toLegs(graph, path, { midpoints: true }).slice(1); // drop own cell centre
  legs.pop(); // target cell centre -> replaced by the object's actual position
  legs.push({ lb: tc, x: tp.x, y: tp.y, z: tp.z });
  return legs.length ? legs : null;
}

/**
 * Walk `legs` via bot.router (the proven leg executor: per-leg watchdog,
 * re-issue, seam/portal handling), kernel paused like bot.goto() does so the
 * grind loops can't fight the walk. Resolves to a walk-tag fragment:
 * routed(N) | route-failed(w/N) | route-timeout(w/N) | null (router absent or
 * owned by a goto — caller falls through to straight pursuit).
 */
async function walkRoute(bot, legs) {
  const router = bot?.router;
  if (!router || typeof router.follow !== "function") return null;
  if (bot?.globalRouter?.busy) return null; // a goto owns the router
  const kernel = bot?.kernel;
  const wasRunning = kernel?.running === true;
  try {
    if (wasRunning) kernel.stop();
  } catch {}
  try {
    router.follow(legs);
    const deadline = Date.now() + Math.min(90_000, 8_000 + legs.length * 15_000);
    while (Date.now() < deadline && !router.done && router.state !== "IDLE") {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (router.state === "IDLE") return `route-cancelled(${(router.status || {}).walked ?? "?"}/${legs.length})`;
    const st = router.status || {};
    if (!router.done) {
      try {
        router.cancel();
      } catch {}
      return `route-timeout(${st.walked ?? "?"}/${legs.length})`;
    }
    return st.state === "DONE" ? `routed(${legs.length})` : `route-failed(${st.walked ?? "?"}/${legs.length})`;
  } catch {
    return "route-error";
  } finally {
    try {
      if (wasRunning) kernel.start();
    } catch {}
  }
}

/** Cross-room leg walk when applicable; null tag when routing didn't engage. */
async function routeToward(bot, guid) {
  try {
    const legs = await indoorLegsTo(bot, guid);
    if (!legs) return null;
    return await walkRoute(bot, legs);
  } catch {
    return null;
  }
}

/**
 * Walk into use range before acting. The retail contract is that the CLIENT
 * closes the distance before the server's range check — ACE answers a far
 * Use with UseDone(OutOfRange) and fires no emote. Observed live (2026-07-17):
 * Jonathan (academyguardexitholtburg) used repeatedly across three soaks with
 * a bare UseObject send; his quest registry stayed empty — every Use was
 * silently out of range. pursuitStatus low 16: 0 idle / 1 active / 2 arrived /
 * 3 failed (read-clear on >=2). Degrades to "just send" when the mover is
 * unavailable — the server error now reaches the observation either way.
 */
async function approach(bot, guid, ms = 12000) {
  const h = bot?.host;
  // Cross-room targets first walk door-waypoint legs (routeToward above);
  // straight pursuit below then only has to cover the final same-room hop.
  const routeTag = await routeToward(bot, guid);
  const tag = (walk) => (routeTag ? `${routeTag}+${walk}` : walk);
  if (typeof h?.PursueObject !== "function") return tag("no-mover");
  if (!h.PursueObject(guid, 1.0, 0, true)) return tag("no-mover");
  // Do NOT poll GetPursuitStatus here: its arrived/failed latch is READ-CLEAR
  // and the bot kernel's tick loop consumes it first, so this seam always saw
  // idle and fired the Use mid-walk from across the room (observed live twice:
  // Jonathan "used" from 25m+, no emote, walk:idle on every action). The
  // player's own pose can't be stolen — walk until the bot stops moving, then
  // act. "no-walk" = never moved (already adjacent, or pursue rejected):
  // proceed either way; the server verdict lands in the heard section.
  const pose = () => {
    try { const p = h.TryGetPlayerPose?.(); return p ? { x: p.x, y: p.y, cell: p.objCellId >>> 0 } : null; }
    catch { return null; }
  };
  let last = pose();
  if (!last) { await new Promise((r) => setTimeout(r, 1200)); return tag("blind"); }
  const t0 = Date.now();
  let lastMoveT = t0;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 400));
    const cur = pose();
    if (!cur) return tag("blind");
    const moved = cur.cell !== last.cell || Math.hypot(cur.x - last.x, cur.y - last.y) > 0.5;
    if (moved) lastMoveT = Date.now();
    last = cur;
    if (Date.now() - lastMoveT > 1600)
      return tag(Date.now() - t0 <= 2200 ? "no-walk" : "settled");
  }
  return tag("timeout");
}

/** "use_object" — interact with a nearby world object (portal, NPC, door, sign…). */
export function useObjectAction() {
  const def = {
    type: "use_object",
    params: { object: "name (substring) or guid of a nearby object from your 'nearby' perception line" },
    desc: "walk up to and use/interact with a nearby world object: enter a portal, talk to or open an NPC, open a door or chest, pull a lever, read a sign. To pick up a ground [item], use take_item instead — 'using' a plain ground item does nothing. Portals teleport you on use; DOORS only swing open — using a door never moves you through it: after opening, goto_object or use_object your actual target in the room beyond to walk through the doorway. This is how you move between areas and start interactions.",
    validate(a) {
      const b = baseValidate("use_object")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UseObject !== "function" || typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    const walk = await approach(bot, res.guid);
    if (!h.UseObject(res.guid)) return fail("use request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, `use_object ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}, used; confirm result on next check-in`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), walk: walk ?? undefined } };
  });
  return def;
}

/** "take_item" — pick a ground [item] up into the pack (PutItemInContainer). */
export function takeItemAction() {
  const def = {
    type: "take_item",
    params: { object: "name (substring) or guid of a ground [item] from your 'nearby' perception line" },
    desc: "walk up to a ground [item] (armor, weapon, key, quest item) and pick it up into your inventory. This is the ONLY way to take loose world items — use_object does not pick things up. Server validates range/burden; confirm via your inventory line next check-in.",
    validate(a) {
      const b = baseValidate("take_item")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.TakeObject !== "function" || typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    const walk = await approach(bot, res.guid);
    if (!h.TakeObject(res.guid)) return fail("pickup request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, `take_item ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}, pickup sent; confirm via inventory next check-in`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), walk: walk ?? undefined } };
  });
  return def;
}

/** "goto_object" — walk to a nearby object WITHOUT using it (approach/scout). */
export function gotoObjectAction() {
  const def = {
    type: "goto_object",
    params: { object: "name (substring) or guid of a nearby object from your 'nearby' perception line — prefer the guid" },
    desc: "walk over to a nearby object or NPC without interacting: get within reach, scout what is around it, and bring new objects into your perception range. Use this to explore toward the farthest interesting thing you can see.",
    validate(a) {
      const b = baseValidate("goto_object")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.PursueObject !== "function" || typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    // Cross-room targets walk door-waypoint legs first (same seam as
    // use_object's approach); the trailing PursueObject keeps goto_object's
    // fire-and-forget local semantics for the last few metres.
    const routeTag = await routeToward(bot, res.guid);
    if (!h.PursueObject(res.guid, 1.0, 0, true)) return fail("pursue request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, `goto_object ${res.name} (${hex(res.guid)})${routeTag ? ` — indoor route ${routeTag}` : ""} — walking over; check the pos line next check-in to confirm arrival`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), ...(routeTag ? { walk: routeTag } : {}) } };
  });
  return def;
}

/** "give_item" — hand an inventory item to a nearby NPC/player (quest turn-ins). */
export function giveItemAction() {
  const def = {
    type: "give_item",
    params: {
      item: "name (substring) or guid of an item in YOUR inventory",
      target: "name (substring) or guid of a nearby NPC/player from your 'nearby' perception line — prefer the guid",
      qty: "optional int >= 1 (default 1)",
    },
    desc: "give one of your inventory items to a nearby NPC or player: quest turn-ins, handing a token or quest item to an NPC. Fire-and-forget — the server validates; confirm via chat/inventory on your next check-in.",
    validate(a) {
      const b = baseValidate("give_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item))
        return { ok: false, error: "item must be a name or guid" };
      if ((typeof a.target !== "string" || !a.target.trim()) && !parseGuid(a.target))
        return { ok: false, error: "target must be a name or guid" };
      if (a.qty != null && (!Number.isInteger(a.qty) || a.qty < 1))
        return { ok: false, error: "qty must be an int >= 1" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.GiveObject !== "function" || typeof h?.NearbyGuids !== "function" ||
        typeof h?.TryGetPlayerInventory !== "function") return fail("unavailable");
    const tgt = resolveNearby(h, a.target);
    if (tgt.error) return fail(tgt.error);
    const rows = h.TryGetPlayerInventory();
    if (!rows || !rows.length) return fail("inventory not streamed yet — try again next check-in");
    const it = resolveItem(rows, { item: a.item });
    if (it.error) return fail(it.error);
    const itemGuid = (it.row.guid ?? it.row.itemGuid) >>> 0;
    const qty = a.qty ?? 1;
    const walk = await approach(bot, tgt.guid);
    if (!h.GiveObject(tgt.guid, itemGuid, qty)) return fail("give request failed to send");
    ctx.track?.(tgt.guid, tgt.name);
    journalNote(
      ctx,
      `give_item ${it.row.name}${qty > 1 ? ` x${qty}` : ""} -> ${tgt.name} (${hex(tgt.guid)}) — server validates; confirm via chat/inventory next check-in`
    );
    return { type: def.type, ok: true, result: { item: it.row.name, guid: hex(itemGuid), target: tgt.name, targetGuid: hex(tgt.guid), qty, walk: walk ?? undefined } };
  });
  return def;
}

export function worldActions() {
  return [useObjectAction(), takeItemAction(), giveItemAction(), gotoObjectAction()];
}

/** Integrator seam, registerEconomy-shaped. */
export function registerWorld(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerWorld: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = worldActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
