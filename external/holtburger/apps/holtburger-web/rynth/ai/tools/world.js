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
  buildStitchedGraphFromWasm,
} from "../../indoor_router.js";

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
  if (!isEnvCellId(pc) || !isEnvCellId(tc)) return null; // an endpoint is outdoors
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
  return legs.length ? legs : null;
}

/** One router.follow pass over `legs`. -> { tag, walked, retryable } */
async function followLegs(router, legs) {
  router.follow(legs);
  const deadline = Date.now() + Math.min(90_000, 8_000 + legs.length * 15_000);
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
  // Mover choice (2026-07-18, live-diagnosed in the Holtburg tavern):
  // PursueObject/pursueEntity only reliably TURNS the local player, it never
  // translates it (url-flags.md wasmPursuit DEFUNCT note, 2026-07-06 combat
  // rewrite) — every soak "walk:no-walk" was this. StickToObject only steps
  // inside an active manual-drive slice, so it too is a no-op from standstill
  // (verified live: sticky latched, pose frozen, 1 s timeout never ticked).
  // The mover that actually translates is MoveToPosition — the router's
  // proven walk primitive — aimed at the target's tracked position.
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
    if (Date.now() - lastMoveT > 1600)
      return tag(Date.now() - t0 <= 2200 ? "no-walk" : "settled");
  }
  cancelMove(); // still mid-walk at deadline — don't fight the next action
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
    params: { item: "pack item name (substring) or guid (see your inventory line)" },
    desc: "drop a pack item onto the ground at your feet — it becomes a world [item] anyone can take. Confirm via your inventory line next check-in.",
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
