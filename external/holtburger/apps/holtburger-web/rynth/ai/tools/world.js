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
  findExitPath,
  toLegs,
  buildStitchedGraphFromWasm,
} from "../../indoor_router.js";
import { RUN_SPEED_MS } from "../../atlas.js";
// Indoor-leg frame fix (2026-07-24, Town Network no-walk wedge): every indoor
// leg producer must issue legs in the normalized world frame (the ONE copy,
// nav_frame.js — the goto_compose.js convention). Dungeon EnvCell frames can
// carry cell-local coords OUTSIDE [0,192) (Town Network 0x0007xxxx: y ≈ −70);
// the raw frame is exactly what goto_compose.js documents as feeding
// MoveToPosition "internal cell re-derivation garbage". goto_compose's own
// paths (portal-approach / egress / wedge-repath) already normalize and are
// live-proven in this dungeon; these approach() routes were the ones left raw.
import { normalizeLegWorldFrame } from "../../nav_frame.js";

const JOURNAL_CLIP = 800;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const hex = (g) => `0x${(g >>> 0).toString(16).toUpperCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Per-landblock-set graph cache — dungeon geometry is static, one wasm build
// per landblock combination visited. bot.indoorGraph (the dungeon_nav.js
// advisory field) wins so tests / integrators can inject a synthetic graph.
let _graphCache = null; // { key, graph }

async function indoorGraphFor(bot, lbWords) {
  const injected = bot?.indoorGraph;
  if (injected) return injected;
  const key = [...new Set(lbWords.map((l) => (l >>> 0) & 0xffff0000))]
    .sort((a, b) => a - b)
    .map((l) => l.toString(16))
    .join("+");
  if (_graphCache && _graphCache.key === key) return _graphCache.graph;
  const handle = bot?.host?.s;
  if (!handle) return null;
  let g = null;
  try {
    // Stitched builder even for one landblock — same code path, and the
    // expand option pulls in seam-adjacent blocks the endpoints reference.
    g = await buildStitchedGraphFromWasm(lbWords, {});
  } catch {
    g = null;
  }
  if (g) _graphCache = { key, graph: g };
  return g;
}

/**
 * Door-waypoint legs to `guid`, or null when indoor routing does not apply
 * (outdoors, same cell, unknown position, no graph, no path). Legs are
 * router.js-shaped {lb,x,y,z}: doorway midpoints (the C# anti-corner-
 * cut waypoints — cell centres alone let MoveToManager clip offset door
 * frames) + cell centres, ending at the target's own position in its cell.
 *
 * Cross-landblock endpoints (2026-07-18, soak-7 §4.3): both blocks' EnvCell
 * graphs are stitched into one — portal ids are full 32-bit, so the seam
 * doorway connects once both sides load. Unconnected blocks (no seam portal
 * record) still find no path and degrade to null like before.
 */
async function indoorLegsTo(bot, guid) {
  const h = bot?.host;
  const pose = h?.TryGetPlayerPose?.();
  const tp = h?.TryGetObjectPosition?.(guid);
  if (!pose || !tp) return null;
  const pc = pose.objCellId >>> 0;
  const tc = tp.objCellId >>> 0;
  // Boundary crossings (soak-14): a straight pursuit walks into the shop
  // wall. When exactly one endpoint is indoors, route via the building's
  // exit portal — the same graph machinery as exit_building, walked in the
  // appropriate direction (enter: door-outside point -> exit cell -> ... ->
  // target; leave: own cell -> ... -> exit cell -> door-outside point ->
  // target). Live driver: "open_vendor" on Arwic's Scrivener of War Magic —
  // town vendors stand INSIDE their shops.
  if (!isEnvCellId(pc) && isEnvCellId(tc)) return enterLegsTo(bot, tc, tp);
  if (isEnvCellId(pc) && !isEnvCellId(tc)) return leaveLegsTo(bot, pc, pose, tp);
  if (!isEnvCellId(pc) || !isEnvCellId(tc)) return null; // both outdoors: straight pursuit
  if (pc === tc) return null; // same room: straight pursuit is proven
  const graph = await indoorGraphFor(bot, [pc, tc]);
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
  // World-frame normalize (see the nav_frame import note): identical world
  // points, but the lb/local pair MoveToPosition receives is re-bucketed to
  // the containing landblock — required for dungeons whose EnvCell frames
  // carry out-of-range locals (Town Network).
  return legs.length ? legs.map(normalizeLegWorldFrame) : null;
}

/** One router.follow pass over `legs`. -> { tag, walked, retryable } */
async function followLegs(router, legs) {
  router.follow(legs);
  // The outer poll deadline must strictly EXCEED the router's own per-leg
  // watchdog (rynth/router.js legTimeoutMs, default 30_000) or a short route
  // gets cut off here before the router itself concludes DONE/FAILED — live
  // 2026-07-20: a 1-leg retry's old budget (8_000 + 1*15_000 = 23_000ms) was
  // SHORTER than the router's 30_000ms leg watchdog, and produced exactly
  // that: route-failed(3/4)+door(Door)+route-timeout(0/1) with the router
  // still mid-leg when this loop gave up. Read the router's actual
  // legTimeoutMs (test mocks/live tuning may override it) with a +5s margin
  // per leg for the router's own reissue/settle overhead beyond the raw
  // watchdog.
  const perLeg = Number.isFinite(router.legTimeoutMs) ? router.legTimeoutMs : 30_000;
  const deadline = Date.now() + Math.min(120_000, 12_000 + legs.length * (perLeg + 5_000));
  while (Date.now() < deadline && !router.done && router.state !== "IDLE") {
    await sleep(300);
  }
  const st = router.status || {};
  const walked = Number.isFinite(st.walked) ? st.walked : 0;
  if (router.state === "IDLE")
    return { tag: `route-cancelled(${st.walked ?? "?"}/${legs.length})`, walked, retryable: false };
  if (!router.done) {
    try {
      router.cancel();
    } catch {}
    return { tag: `route-timeout(${st.walked ?? "?"}/${legs.length})`, walked, retryable: true };
  }
  return st.state === "DONE"
    ? { tag: `routed(${legs.length})`, walked: legs.length, retryable: false }
    : { tag: `route-failed(${st.walked ?? "?"}/${legs.length})`, walked, retryable: true };
}

// ── closed-door mid-route retry (handoff-6 §3.3 / handoff-5 §3.3) ───────────
// A door standing CLOSED on a route leg stalls the follow against its leaf —
// the leg times out / fails with the doorway metres away. ACE doors flip
// PhysicsState.Ethereal (0x4) when OPEN (Door.Open — passable) and clear it
// when closed, so "closed door" is detectable client-side. On a retryable
// follow outcome, open the nearest closed door within reach and re-follow the
// REMAINING legs once. One retry only; a still-blocked route surfaces the
// original tag shape for the journal.
const ODF_DOOR = 0x1000; // ObjectDescriptionFlag.Door (observe_ext.js ODF map)
const PHYS_ETHEREAL = 0x4; // PhysicsState.Ethereal — set while a door stands open
const DOOR_RETRY_RANGE_M = 10;

function nearestClosedDoor(bot) {
  const h = bot?.host;
  if (typeof h?.NearbyGuids !== "function" || typeof h?.TryGetObjectDescFlags !== "function") return null;
  const pose = h.TryGetPlayerPose?.();
  if (!pose) return null;
  const px = worldX(pose.objCellId >>> 0, pose.x);
  const py = worldY(pose.objCellId >>> 0, pose.y);
  let best = null;
  for (const g of h.NearbyGuids() ?? []) {
    try {
      const flags = h.TryGetObjectDescFlags(g);
      if (flags == null || !(flags & ODF_DOOR)) continue;
      const st = h.TryGetObjectState?.(g) ?? 0;
      if (st & PHYS_ETHEREAL) continue; // already open — using it would CLOSE it
      const p = h.TryGetObjectPosition?.(g);
      if (!p) continue;
      const d = Math.hypot(
        worldX(p.objCellId >>> 0, p.x) - px,
        worldY(p.objCellId >>> 0, p.y) - py,
        (p.z || 0) - (pose.z || 0)
      );
      if (d <= DOOR_RETRY_RANGE_M && (!best || d < best.d))
        best = { guid: g >>> 0, name: h.TryGetObjectName?.(g) || "Door", d };
    } catch {}
  }
  return best;
}

/**
 * Walk `legs` via bot.router (the proven leg executor: per-leg watchdog,
 * re-issue, seam/portal handling), kernel paused like bot.goto() does so the
 * grind loops can't fight the walk. Resolves to a walk-tag fragment:
 * routed(N) | route-failed(w/N) | route-timeout(w/N) — optionally with a
 * `+door(Name)+<retag>` middle when the closed-door retry engaged — or null
 * (router absent or owned by a goto; caller falls through to straight
 * pursuit).
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
    const first = await followLegs(router, legs);
    if (!first.retryable) return first.tag;
    const door = nearestClosedDoor(bot);
    if (!door || typeof bot?.host?.UseObject !== "function") return first.tag;
    try {
      bot.host.UseObject(door.guid);
    } catch {
      return first.tag;
    }
    await sleep(1500); // door swing + physics flip before re-walking
    const rest = legs.slice(Math.min(Math.max(first.walked, 0), legs.length - 1));
    const second = await followLegs(router, rest);
    return `${first.tag}+door(${door.name})+${second.tag}`;
  } catch {
    return "route-error";
  } finally {
    try {
      if (wasRunning) kernel.start();
    } catch {}
  }
}

/** asMap-lite for the two boundary helpers (graphs here are always Maps). */
const nodeOf = (graph, id) => (graph instanceof Map ? graph.get(id) : graph[id]);

/**
 * "Just outside the door" waypoint for an exit-bearing cell: project ~9
 * units past the exit cell's anchor along the inside->door direction, then
 * bin the point into its outdoor LandCell (gid_to_lcoord inverse — same
 * math as dungeon_nav.exitRoute). insideRef = an inside reference position
 * (previous path cell's anchor, or the target when the path is one cell).
 */
function doorOutsidePoint(exitNode, insideRef) {
  let dx = exitNode.pos.x - insideRef.x;
  let dy = exitNode.pos.y - insideRef.y;
  const len = Math.hypot(dx, dy);
  if (len > 0.01) { dx /= len; dy /= len; } else { dx = 0; dy = 1; }
  const wx = exitNode.pos.x + dx * 9;
  const wy = exitNode.pos.y + dy * 9;
  const lbx = Math.floor(wx / 192), lby = Math.floor(wy / 192);
  const cx = Math.floor((wx - lbx * 192) / 24), cy = Math.floor((wy - lby * 192) / 24);
  return {
    lb: (((lbx & 0xff) << 24) | ((lby & 0xff) << 16) | (cx * 8 + cy + 1)) >>> 0,
    x: wx - lbx * 192,
    y: wy - lby * 192,
    z: exitNode.pos.z,
  };
}

/** OUTDOOR player -> INDOOR target: door-outside point, exit cell, interior path, target. */
async function enterLegsTo(bot, tc, tp) {
  const graph = await indoorGraphFor(bot, [tc]);
  if (!graph) return null;
  const has = (id) => (graph instanceof Map ? graph.has(id) : id in graph);
  const to = (has(tc) ? tc : 0) || nearestCell(graph, worldX(tc, tp.x), worldY(tc, tp.y), tp.z);
  if (!to) return null;
  const exit = findExitPath(graph, to); // path is [to .. exitCell]
  if (!exit) return null;
  const walkOrder = exit.path.slice().reverse(); // exitCell .. to
  const exitNode = nodeOf(graph, exit.exitCell);
  if (!exitNode) return null;
  const insideRef = walkOrder.length > 1 ? nodeOf(graph, walkOrder[1])?.pos : { x: worldX(tc, tp.x), y: worldY(tc, tp.y) };
  if (!insideRef) return null;
  const legs = [doorOutsidePoint(exitNode, insideRef), ...toLegs(graph, walkOrder, { midpoints: true })];
  legs.pop(); // target cell centre -> the object's actual position
  legs.push({ lb: tc, x: tp.x, y: tp.y, z: tp.z });
  return legs.map(normalizeLegWorldFrame); // world-frame normalize (nav_frame note)
}

/** INDOOR player -> OUTDOOR target: interior path to exit cell, door-outside point, target. */
async function leaveLegsTo(bot, pc, pose, tp) {
  const graph = await indoorGraphFor(bot, [pc]);
  if (!graph) return null;
  const has = (id) => (graph instanceof Map ? graph.has(id) : id in graph);
  const from = (has(pc) ? pc : 0) || nearestCell(graph, worldX(pc, pose.x), worldY(pc, pose.y), pose.z);
  if (!from) return null;
  const exit = findExitPath(graph, from); // path is [from .. exitCell]
  if (!exit) return null;
  const exitNode = nodeOf(graph, exit.exitCell);
  if (!exitNode) return null;
  const insideRef =
    exit.path.length > 1
      ? nodeOf(graph, exit.path[exit.path.length - 2])?.pos
      : { x: worldX(pc, pose.x), y: worldY(pc, pose.y) };
  if (!insideRef) return null;
  const legs = toLegs(graph, exit.path, { midpoints: true }).slice(1); // drop own cell centre
  legs.push(doorOutsidePoint(exitNode, insideRef));
  legs.push({ lb: tp.objCellId >>> 0, x: tp.x, y: tp.y, z: tp.z });
  return legs.map(normalizeLegWorldFrame); // world-frame normalize (nav_frame note)
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
export async function approach(bot, guid, ms = 12000) {
  const h = bot?.host;
  // Cross-room targets first walk door-waypoint legs (routeToward above);
  // the mover below then only has to cover the final same-room hop.
  const routeTag = await routeToward(bot, guid);
  const tag = (walk) => (routeTag ? `${routeTag}+${walk}` : walk);
  // Mover choice — UPDATED 2026-07-20 (live-verified, straight-line pursuit
  // walked into a building wall): PursueObject DOES translate the player now
  // (measured 9.7m/6s ≈ walk speed, straight-line, no obstacle avoidance) —
  // the prior 2026-07-18 note below calling it turn-only predates the soak-10
  // pursuit fixes and was stale. MoveToPosition remains the PREFERRED mover
  // regardless: it is the router's own proven walk primitive (stuck-detection
  // here reuses the exact same pose-polling contract walkRoute's watchdog
  // relies on), and it targets a fixed point rather than re-chasing a moving
  // guid every tick. PursueObject is kept as the fallback for hosts that
  // don't expose MoveToPosition.
  // (2026-07-18, live-diagnosed in the Holtburg tavern — STALE, see above):
  // "PursueObject/pursueEntity only reliably TURNS the local player, it never
  // translates it (url-flags.md wasmPursuit DEFUNCT note, 2026-07-06 combat
  // rewrite) — every soak walk:no-walk was this." StickToObject only steps
  // inside an active manual-drive slice, so it too is a no-op from standstill
  // (verified live: sticky latched, pose frozen, 1 s timeout never ticked;
  // this part still holds — StickToObject was never re-verified).
  let mover = null;
  const pos = (() => {
    try { return h?.TryGetObjectPosition?.(guid) ?? null; } catch { return null; }
  })();
  if (pos && typeof h?.MoveToPosition === "function") {
    h.MoveToPosition(pos.objCellId, pos.x, pos.y, pos.z, true);
    mover = "moveTo";
  } else if (typeof h?.PursueObject === "function" && h.PursueObject(guid, 1.0, 0, true)) {
    mover = "pursue"; // last resort: at least turns to face the target
  }
  if (!mover) return tag("no-mover");
  const cancelMove = () => { try { h.StopCompletely?.(); } catch {} };
  // Do NOT poll GetPursuitStatus here: its arrived/failed latch is READ-CLEAR
  // and the bot kernel's tick loop consumes it first, so this seam always saw
  // idle and fired the Use mid-walk from across the room (observed live twice:
  // Jonathan "used" from 25m+, no emote, walk:idle on every action). The
  // player's own pose can't be stolen — walk until the bot stops moving, then
  // act. "no-walk" = never moved (already adjacent, or mover rejected):
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
    // Widened 2026-07-20 from 1600/2200ms (was too eager: a mover that needs
    // a beat to start moving — e.g. the client's own turn-before-walk facing
    // adjustment — read as "no-walk" before it ever got going). Chose
    // widening the window over retrying the mover dispatch: a reissue adds
    // the SAME ~1.4s of extra wait for a stuck case (its own reissued-window
    // still needs to elapse before concluding no-walk) with more code and a
    // second live command to reason about, for no proven benefit — nothing
    // here indicates the first send is being dropped versus simply slow to
    // take effect.
    if (Date.now() - lastMoveT > 3000)
      return tag(Date.now() - t0 <= 4000 ? "no-walk" : "settled");
  }
  cancelMove(); // still mid-walk at deadline — don't fight the next action
  return tag("timeout");
}

/** The final "+"-joined segment of an approach() walk tag — the LAST hop's
 * own mover verdict (no-mover|blind|no-walk|settled|timeout), independent of
 * any routeTag/door-retry prefix ("routed(2)+door(Name)+route-failed(0/1)+
 * no-walk" -> "no-walk"). */
function finalWalkTag(walk) {
  if (typeof walk !== "string" || !walk) return walk;
  const i = walk.lastIndexOf("+");
  return i < 0 ? walk : walk.slice(i + 1);
}

/** World-frame distance (metres) from the player to `guid`'s tracked
 * position, or null when either position is unavailable. */
function distanceToObject(h, guid) {
  try {
    const p = h?.TryGetObjectPosition?.(guid);
    const pose = h?.TryGetPlayerPose?.();
    if (!p || !pose) return null;
    return Math.hypot(
      worldX(p.objCellId >>> 0, p.x) - worldX(pose.objCellId >>> 0, pose.x),
      worldY(p.objCellId >>> 0, p.y) - worldY(pose.objCellId >>> 0, pose.y),
      (p.z || 0) - (pose.z || 0)
    );
  } catch {
    return null;
  }
}

const WALK_FAIL_RANGE_M = 5;

/** Should an interaction after approach() actually fire? "no-walk" and
 * "timeout" are ambiguous BY THEMSELVES: no-walk covers both "already
 * adjacent" (fine, fire) and "mover rejected / never left" (not fine); a
 * timeout can still have closed most of the distance. Recompute the real
 * remaining distance and let THAT decide rather than trusting the tag text
 * alone — "settled" and "blind" always proceed (settled = we walked and
 * stopped, presumably in range; blind = no pose telemetry to doubt it with,
 * same as before this change). Returns { blocked, distanceM }; distanceM is
 * null when it couldn't be computed (blocked is then always false — we
 * cannot prove a failure we cannot measure).
 */
function walkFailedTooFar(h, guid, walk) {
  const tag = finalWalkTag(walk);
  if (tag !== "no-walk" && tag !== "timeout") return { blocked: false, distanceM: null };
  const d = distanceToObject(h, guid);
  if (d == null || d <= WALK_FAIL_RANGE_M) return { blocked: false, distanceM: d };
  return { blocked: true, distanceM: d };
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
    const wf = walkFailedTooFar(h, res.guid, walk);
    if (wf.blocked)
      return fail(`walk failed (${walk}), target ${wf.distanceM.toFixed(0)}m away — not fired`);
    if (!h.UseObject(res.guid)) return fail("use request failed to send");
    ctx.track?.(res.guid, res.name);
    // Interaction-outcome memory (general no-effect tracking, 2026-07-21):
    // snapshots pose/coins/inv/kills NOW; extensions.js resolves it against
    // the NEXT check-in's snapshot, so a use that changes nothing observable
    // twice in a row surfaces a "no-effect" line in the LOCATION block —
    // content-agnostic, no object names/wcids/cells hardcoded anywhere here.
    ctx.interactions?.record?.(bot, res.guid, res.name);
    journalNote(ctx, `use_object ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}, used; confirm result on next check-in`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), walk: walk ?? undefined } };
  });
  return def;
}

/** "take_item" — pick a ground [item] OR an opened-container item into the
 * pack (PutItemInContainer both ways). `state.lastContainer` (set by
 * open_container) extends resolution to container contents — verb-audit gap 3:
 * the primitives existed but the LLM had no way to loot a SPECIFIC item. */
export function takeItemAction(state = {}) {
  const def = {
    type: "take_item",
    params: { object: "name (substring) or guid of a ground [item] from 'nearby', or an item listed by open_container" },
    desc: "walk up to a ground [item] (armor, weapon, key, quest item) and pick it up into your inventory — or take a specific item OUT of the container you last opened with open_container. This is the ONLY way to take loose world items — use_object does not pick things up. Server validates range/burden; confirm via your inventory line next check-in.",
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
    let res = resolveNearby(h, a.object);
    let fromContainer = null;
    if (res.error && Array.isArray(state.lastContainer?.contents) && state.lastContainer.contents.length) {
      const it = resolveItem(state.lastContainer.contents, { item: a.object });
      if (!it.error) {
        res = { guid: it.row.guid >>> 0, name: it.row.name };
        fromContainer = state.lastContainer.name;
      }
    }
    if (res.error) return fail(res.error);
    // Container loot happens at the already-opened container — no walk needed;
    // ground pickups still close the distance first.
    const walk = fromContainer ? "container" : await approach(bot, res.guid);
    if (!fromContainer) {
      const wf = walkFailedTooFar(h, res.guid, walk);
      if (wf.blocked)
        return fail(`walk failed (${walk}), target ${wf.distanceM.toFixed(0)}m away — not fired`);
    }
    if (!h.TakeObject(res.guid)) return fail("pickup request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(
      ctx,
      `take_item ${res.name} (${hex(res.guid)})${fromContainer ? ` from ${fromContainer}` : ""} — walk:${walk ?? "n/a"}, pickup sent; confirm via inventory next check-in`
    );
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), walk: walk ?? undefined, ...(fromContainer ? { from: fromContainer } : {}) } };
  });
  return def;
}

/** "open_container" — open a chest/corpse and read its contents (gap 3). */
export function openContainerAction(state = {}) {
  const CONTENTS_TIMEOUT_MS = 5000;
  const CONTENTS_POLL_MS = 250;
  const def = {
    type: "open_container",
    params: { object: "name (substring) or guid of a nearby chest/corpse/container" },
    desc: "walk up to and open a container and read what is inside (journaled); take a specific item out with take_item. For CHESTS and unusual containers — corpses of your kills are looted AUTOMATICALLY by the grind kernel, do not spend actions on them.",
    validate(a) {
      const b = baseValidate("open_container")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UseObject !== "function" || typeof h?.GetContainerContents !== "function" ||
        typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    const walk = await approach(bot, res.guid);
    const wf = walkFailedTooFar(h, res.guid, walk);
    if (wf.blocked)
      return fail(`walk failed (${walk}), target ${wf.distanceM.toFixed(0)}m away — not fired`);
    if (!h.UseObject(res.guid)) return fail("open request failed to send");
    // Open-acknowledgment (2026-07-18): ViewContents with ZERO items is a
    // real server reply (a genuinely empty chest), but it left guids empty
    // and read as "no contents streamed" — indistinguishable from the open
    // never being acked (out of range / locked / not a container). The
    // ground-container id flips to this guid on ANY ViewContents for it, so
    // track it as the ack and report empty-vs-silent distinctly.
    let guids = [];
    let opened = false;
    const t0 = Date.now();
    while (Date.now() - t0 < CONTENTS_TIMEOUT_MS) {
      try { opened = opened || (h.GetGroundContainerId?.() >>> 0) === (res.guid >>> 0); } catch {}
      try { guids = h.GetContainerContents(res.guid) || []; } catch { guids = []; }
      if (guids.length) break;
      await sleep(CONTENTS_POLL_MS);
    }
    const contents = [];
    for (const g of guids) {
      let name = null;
      try { name = h.TryGetObjectName(g); } catch {}
      contents.push({ guid: g >>> 0, name: name || "?" });
    }
    state.lastContainer = { guid: res.guid, name: res.name, contents, at: Date.now() };
    ctx.track?.(res.guid, res.name);
    journalNote(
      ctx,
      contents.length
        ? `open_container ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}; contents(${contents.length}): ${contents.map((c) => `${c.name} ${hex(c.guid)}`).join("; ")}`
        : opened
          ? `open_container ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}; opened: container is EMPTY (server confirmed) — do not reopen, move on`
          : `open_container ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}; open NOT acknowledged (out of range, locked, or not a container)`
    );
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), items: contents.length, walk: walk ?? undefined } };
  });
  return def;
}

// Compact, defensive renderer over the EX-05 AppraisalSnapshot JSON
// (build_appraisal_snapshot, src/lib.rs: properties.{strings,ints} keyed by
// enum NAME, plus armorProfile/weaponProfile/creatureProfile/spellBook).
// Unknown/partial shapes degrade to fewer sections, never a throw.
function renderAppraisal(label, ap, fresh) {
  const parts = [];
  try {
    if (ap.identifySuccess === false) parts.push("identify REFUSED (insufficient skill?) — sections may be stale/partial");
    const strs = ap.properties?.strings ?? {};
    for (const k of ["Use", "ShortDesc", "LongDesc", "Inscription"]) {
      if (typeof strs[k] === "string" && strs[k].trim()) parts.push(`${k}: ${strs[k].trim()}`);
    }
    const ints = ap.properties?.ints ?? {};
    const iv = [];
    for (const k of ["Value", "ArmorLevel", "EncumbranceVal", "ItemDifficulty", "WieldDiff", "ItemCurMana", "ItemMaxMana"]) {
      if (Number.isFinite(ints[k])) iv.push(`${k}=${ints[k]}`);
    }
    if (iv.length) parts.push(iv.join(" "));
    const compact = (o) => { try { return JSON.stringify(o); } catch { return null; } };
    for (const [key, lbl] of [["armorProfile", "armor"], ["weaponProfile", "weapon"], ["creatureProfile", "creature"]]) {
      const j = ap[key] != null ? compact(ap[key]) : null;
      if (j && j !== "null") parts.push(`${lbl}: ${j}`);
    }
    if (Array.isArray(ap.spellBook) && ap.spellBook.length)
      parts.push(`spellIds: ${ap.spellBook.slice(0, 10).join(",")}${ap.spellBook.length > 10 ? "…" : ""}`);
  } catch {}
  return clip(`appraise ${label}${fresh ? "" : " (CACHED — no fresh identify arrived)"}: ${parts.join(" | ") || "(no detail sections)"}`, JOURNAL_CLIP);
}

/** "appraise" — identify/assess a nearby object or inventory item (gap 1:
 * the read side went live with the requestAppraisal webhost fix; this is the
 * missing LLM verb over it). */
export function appraiseAction() {
  const APPRAISE_TIMEOUT_MS = 5000;
  const APPRAISE_POLL_MS = 250;
  const def = {
    type: "appraise",
    params: { object: "name (substring) or guid of a nearby object/creature, OR an item in your inventory" },
    desc: "examine/assess an object, creature, NPC or inventory item: description, value, armor level, weapon damage, wield requirements, spells. Result is journaled for your next check-in. Works at sight range — no walk needed.",
    validate(a) {
      const b = baseValidate("appraise")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.RequestId !== "function" || typeof h?.TryGetObjectAppraisal !== "function") return fail("unavailable");
    // Nearby world object first; fall back to the player's own inventory
    // (pack items appraise through the same IdentifyObject round-trip).
    let res = resolveNearby(h, a.object);
    if (res.error && typeof h.TryGetPlayerInventory === "function") {
      const it = resolveItem(h.TryGetPlayerInventory() ?? [], { item: a.object });
      if (!it.error) res = { guid: (it.row.guid ?? it.row.itemGuid) >>> 0, name: it.row.name };
    }
    if (res.error) return fail(res.error);
    const before = typeof h.GetLastIdTime === "function" ? h.GetLastIdTime(res.guid) : 0;
    if (!h.RequestId(res.guid)) return fail("appraise request failed to send");
    // Wait for a FRESH identify: GetLastIdTime advances on each successful
    // round-trip; first-ever data also satisfies via HasAppraisalData.
    let fresh = false;
    const t0 = Date.now();
    while (Date.now() - t0 < APPRAISE_TIMEOUT_MS) {
      try {
        const t = typeof h.GetLastIdTime === "function" ? h.GetLastIdTime(res.guid) : 0;
        if ((before && t > before) || (!before && h.HasAppraisalData?.(res.guid))) { fresh = true; break; }
      } catch {}
      await sleep(APPRAISE_POLL_MS);
    }
    const ap = h.TryGetObjectAppraisal(res.guid);
    if (!ap) return fail(`no appraisal data for ${res.name} (${hex(res.guid)}) — the server may have refused or the object despawned`);
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, renderAppraisal(`${res.name} (${hex(res.guid)})`, ap, fresh));
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), fresh } };
  });
  return def;
}

/** "use_item_on" — UseWithTarget 0x0035: keys, lockpicks, kits, tools (gap 2). */
export function useItemOnAction() {
  const def = {
    type: "use_item_on",
    params: {
      item: "name (substring) or guid of an item in YOUR inventory (key, lockpick, healing kit, tool)",
      target: "name (substring) or guid of a nearby object from your 'nearby' perception line",
    },
    desc: "use an inventory item ON a world object or person: unlock a locked door or chest with its key or a lockpick, use a healing kit on someone, apply a crafting tool. Walks into range first; the server verdict arrives in 'heard' next check-in.",
    validate(a) {
      const b = baseValidate("use_item_on")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item))
        return { ok: false, error: "item must be a name or guid" };
      if ((typeof a.target !== "string" || !a.target.trim()) && !parseGuid(a.target))
        return { ok: false, error: "target must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UseItemOnTarget !== "function" || typeof h?.NearbyGuids !== "function" ||
        typeof h?.TryGetPlayerInventory !== "function") return fail("unavailable");
    const tgt = resolveNearby(h, a.target);
    if (tgt.error) return fail(tgt.error);
    const rows = h.TryGetPlayerInventory();
    if (!rows || !rows.length) return fail("inventory not streamed yet — try again next check-in");
    const it = resolveItem(rows, { item: a.item });
    if (it.error) return fail(it.error);
    const itemGuid = (it.row.guid ?? it.row.itemGuid) >>> 0;
    const walk = await approach(bot, tgt.guid);
    const wf = walkFailedTooFar(h, tgt.guid, walk);
    if (wf.blocked)
      return fail(`walk failed (${walk}), target ${wf.distanceM.toFixed(0)}m away — not fired`);
    if (!h.UseItemOnTarget(itemGuid, tgt.guid)) return fail("use-with-target request failed to send");
    ctx.track?.(tgt.guid, tgt.name);
    journalNote(ctx, `use_item_on ${it.row.name} -> ${tgt.name} (${hex(tgt.guid)}) — walk:${walk ?? "n/a"}, sent; server verdict in 'heard' next check-in`);
    return { type: def.type, ok: true, result: { item: it.row.name, guid: hex(itemGuid), target: tgt.name, targetGuid: hex(tgt.guid), walk: walk ?? undefined } };
  });
  return def;
}

/** "drop_item" — put a pack item on the ground (gap 4: wrapped, zero callers). */
export function dropItemAction() {
  const def = {
    type: "drop_item",
    params: {
      item: "pack item name (substring) or guid (see your inventory line)",
      force: "optional boolean — set true to override the tool/attuned/bonded drop guard and drop deliberately",
    },
    desc: "drop a pack item onto the ground at your feet — it becomes a world [item] anyone can take. Confirm via your inventory line next check-in. GUARDED: usable tools (gem/key/portal/caster/manastone/lifestone/writable) and attuned/bonded items are refused unless force:true — USE such items instead of discarding them.",
    validate(a) {
      const b = baseValidate("drop_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item))
        return { ok: false, error: "item must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.DropItem !== "function" || typeof h?.TryGetPlayerInventory !== "function") return fail("unavailable");
    const rows = (h.TryGetPlayerInventory() ?? []).filter((i) => i.equipMask === 0);
    if (!rows.length) return fail("inventory not streamed yet — try again next check-in");
    const it = resolveItem(rows, { item: a.item });
    if (it.error) return fail(it.error);
    // Planning guard: don't discard an item the director likely wants to USE.
    // Rows from TryGetPlayerInventory carry itemType/attuned/bonded directly.
    // Attuned = bound (server rejects the drop anyway). Usable tools / bonded =
    // very likely a mistake to drop before using. `force:true` overrides.
    if (a.force !== true) {
      const row = it.row;
      const itemType = row.itemType | 0;
      // Gem|Key|Portal|Writable|Caster|ManaStone|LifeStone (ACE ItemType bits)
      const TOOL_MASK = 0x00000800 | 0x00004000 | 0x00010000 | 0x00002000 | 0x00008000 | 0x00080000 | 0x10000000;
      const attuned = (row.attuned | 0) >= 1;
      const bonded = (row.bonded | 0) >= 1;
      if (attuned)
        return fail(`"${row.name}" is attuned (bound to you) — it cannot be dropped or traded; the server will reject this. Not dropping.`);
      if ((itemType & TOOL_MASK) !== 0 || bonded)
        return fail(`"${row.name}" looks like a usable tool${bonded ? " (bonded — kept on death)" : ""} — USE it first (use_object / use_item_on) rather than dropping it. To discard it deliberately, re-issue drop_item with force:true.`);
    }
    const itemGuid = (it.row.guid ?? it.row.itemGuid) >>> 0;
    if (!h.DropItem(itemGuid)) return fail("drop request failed to send");
    journalNote(ctx, `drop_item ${it.row.name} (${hex(itemGuid)}) — dropped at your feet; confirm via inventory next check-in`);
    return { type: def.type, ok: true, result: { item: it.row.name, guid: hex(itemGuid) } };
  });
  return def;
}

/** "confirm" — answer a pending server confirmation dialog (gap 5: an
 * unanswered dialog times out server-side as a decline). */
export function confirmAction() {
  const def = {
    type: "confirm",
    params: {
      accept: "boolean — true to accept, false to decline",
      which: "optional substring of the dialog text to pick one when several are pending (default: the first)",
    },
    desc: "answer a pending server confirmation dialog (see the 'confirmation pending' observation line). Unanswered dialogs auto-decline after a server timeout.",
    validate(a) {
      const b = baseValidate("confirm")(a);
      if (!b.ok) return b;
      if (typeof a.accept !== "boolean") return { ok: false, error: "accept must be a boolean" };
      if (a.which != null && typeof a.which !== "string") return { ok: false, error: "which must be a string" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.SendConfirmationResponse !== "function" || typeof h?.TryGetPendingConfirmations !== "function")
      return fail("unavailable");
    const list = h.TryGetPendingConfirmations();
    if (!list.length) return fail("no confirmation dialog is pending");
    const want = typeof a.which === "string" ? a.which.trim().toLowerCase() : "";
    const pick = want ? list.find((c) => c.text.toLowerCase().includes(want)) : list[0];
    if (!pick) return fail(`no pending dialog matching "${a.which}" — pending: ${list.map((c) => `"${clip(c.text, 80)}"`).join("; ")}`);
    if (!h.SendConfirmationResponse(pick.confirmType, pick.context, a.accept)) return fail("confirmation response failed to send");
    journalNote(ctx, `confirm ${a.accept ? "ACCEPT" : "DECLINE"}: "${clip(pick.text, 200)}"`);
    return { type: def.type, ok: true, result: { accepted: a.accept, text: clip(pick.text, 200) } };
  });
  return def;
}

/** "hunt_start" / "hunt_stop" — director toggle over the combat kernel
 * (2026-07-21 scope addition). RynthCombatLoop (combat_loop.js) otherwise
 * auto-engages every attackable object it scans; these actions let the AI
 * director own that decision (hunt deliberately, or stand down while
 * surveying/traveling/dying) via a plain `enabled` flag on the loop
 * (bot.kernel.combat) — no give-item/teleport/chat-parser involved, and the
 * boot-time ?botKernel=off / config.kernel===false switch (the WHOLE kernel)
 * is untouched. Defensive per spec: a missing kernel/combat handle degrades
 * to an ok:false "kernel not available" result, never a throw. */
export function huntStartAction() {
  const def = {
    type: "hunt_start",
    params: {},
    desc: "enable the combat kernel: from now on it auto-engages any attackable creature it scans, with no further action from you, until you hunt_stop. Use when you deliberately choose to hunt.",
    validate: baseValidate("hunt_start"),
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const combat = bot?.kernel?.combat;
    if (!combat) return fail("kernel not available");
    combat.enabled = true;
    journalNote(ctx, "hunt_start — combat kernel enabled, will auto-engage attackables");
    return { type: def.type, ok: true, result: "hunting enabled — the kernel will engage targets" };
  });
  return def;
}
export function huntStopAction() {
  const def = {
    type: "hunt_stop",
    params: {},
    desc: "disable the combat kernel: it stops acquiring new targets (an in-progress engagement winds down over its normal scan grace, not an abrupt cutoff). Use while surveying, traveling, or anywhere you keep dying — you do not have to out-fight anything.",
    validate: baseValidate("hunt_stop"),
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const combat = bot?.kernel?.combat;
    if (!combat) return fail("kernel not available");
    combat.enabled = false;
    journalNote(ctx, "hunt_stop — combat kernel standing down");
    return { type: def.type, ok: true, result: "hunting disabled — combat kernel standing down" };
  });
  return def;
}

/** "goto_object" — walk to a nearby object WITHOUT using it (approach/scout). */
export function gotoObjectAction() {
  const def = {
    type: "goto_object",
    params: { object: "name (substring) or guid of a nearby object from your 'nearby' perception line — prefer the guid" },
    desc: "walk over to a nearby object or NPC without interacting: get within reach, scout what is around it, and bring new objects into your perception range. Use this to explore toward the farthest interesting thing you can see. Reports ok:false with the failed walk tag when the target is still out of reach afterward (blocked path, dead-end route) — do not assume arrival just because the action ran; check ok/result.walk.",
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
    if (typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    // approach() already composes the indoor door-waypoint leg walk
    // (routeToward, same seam as use_object) with the final same-room/
    // outdoor hop via MoveToPosition (preferred — translates, see the
    // approach() header for the 2026-07-20 live finding on PursueObject) —
    // no separate bare PursueObject call is needed or fired here; a redundant
    // second command after approach() already closed the distance would add
    // nothing. Budget the final hop by distance: a long straight outdoor leg
    // needs headroom beyond the interaction tools' fixed 12s default, a close
    // one shouldn't wait needlessly. RUN_SPEED_MS is the verified base ground
    // speed (rynth/atlas.js); *1500 gives ~1.5x buffer over pure travel time
    // for imperfect straight-line pathing.
    let ms = 12000;
    const d0 = distanceToObject(h, res.guid);
    if (d0 != null) ms = Math.min(30000, Math.max(6000, (d0 / RUN_SPEED_MS) * 1500));
    const walk = await approach(bot, res.guid, ms);
    // "no-walk"/"timeout" are ambiguous on their own (see walkFailedTooFar) —
    // goto_object has no separate action to gate, so it applies the same
    // distance recheck directly to its own ok verdict: close enough now =
    // success regardless of what the tag text says (a routed(N)+no-walk is
    // the COMMON success shape — indoor legs walked us right up to the
    // target, the final hop found nothing left to do), too far = a real
    // failure the director must see.
    const d = distanceToObject(h, res.guid);
    const finalTag = finalWalkTag(walk);
    const ok = d != null ? d <= WALK_FAIL_RANGE_M : finalTag === "settled" || finalTag === "blind";
    ctx.track?.(res.guid, res.name);
    journalNote(
      ctx,
      ok
        ? `goto_object ${res.name} (${hex(res.guid)}) — arrived (walk:${walk ?? "n/a"}); check the pos line next check-in to confirm`
        : `goto_object ${res.name} (${hex(res.guid)}) — walk failed (${walk ?? "n/a"})${d != null ? `, still ${d.toFixed(0)}m away` : ""}`
    );
    return {
      type: def.type,
      ok,
      result: {
        object: res.name,
        guid: hex(res.guid),
        walk: walk ?? undefined,
        ...(d != null ? { distanceM: Math.round(d) } : {}),
      },
    };
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
    const wf = walkFailedTooFar(h, tgt.guid, walk);
    if (wf.blocked)
      return fail(`walk failed (${walk}), target ${wf.distanceM.toFixed(0)}m away — not fired`);
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
  // Shared per-bot state: open_container's contents listing extends
  // take_item's resolution (economyActions has the same shape).
  const state = {}; // { lastContainer: { guid, name, contents:[{guid,name}], at } }
  return [
    useObjectAction(),
    takeItemAction(state),
    giveItemAction(),
    gotoObjectAction(),
    openContainerAction(state),
    appraiseAction(),
    useItemOnAction(),
    dropItemAction(),
    confirmAction(),
    huntStartAction(),
    huntStopAction(),
  ];
}

/** Integrator seam, registerEconomy-shaped. */
export function registerWorld(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerWorld: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = worldActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
