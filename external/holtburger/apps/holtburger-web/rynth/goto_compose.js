// goto_compose.js — outdoor<->indoor composition for bot.goto (task #7,
// report 09 §1b integration). bot.goto's sidecar planner (global_router.js)
// only routes OUTDOORS: the Detour bake has no dungeon/building interiors, so
// a goto that starts indoors, ends indoors, or must cross a building door
// falls to a blind straight line. This module stitches the two routers:
//
//   - OUTDOOR legs  -> global_router (sidecar Detour tiles + portal Dijkstra),
//     driven exactly as before via the injected `outdoorGoto` (== a bound
//     globalRouter.goto). The pure-outdoor path is IDENTICAL to pre-compose.
//   - INDOOR legs   -> indoor_router (EnvCell portal-record A*), walked with
//     router.follow + a poll loop mirroring global_router's walk poll.
//
// Four cases (guarded by the current cell id / goal cell id — an EnvCell
// objCellId has a low word >= 0x0100, isEnvCellId):
//   0. neither end indoors -> outdoorGoto(to) unchanged.
//   1. START indoors, goal outdoors -> findExitPath -> walk exit legs (through
//      the door to just-outside), then outdoorGoto from the exit.
//   2. START indoors, goal indoors, SAME landblock -> pure indoor findPath.
//      Cross-landblock indoor->indoor is handled as: exit (case 1 walk) then
//      case 3 (we are outdoors after the exit) — no cross-dungeon A*.
//   3. goal indoors (different/again landblock) -> outdoorGoto to the goal
//      landblock's world position, then indoor A* from the entry doorway
//      (nearestCell to the arrival pose) to the goal cell. If the entry can't
//      be reached (empty graph / cell not streamed / drop-gated) it is an
//      HONEST {ok:false, error:"indoor graph unavailable"} — never a guess.
//
// DROP-EDGE LIMITATION (carried from indoor_router.js:34-37): indoor A* and
// findExitPath PRUNE every drop/jump edge — the executor has no jump primitive
// — so a goal (or an exit) reachable only by taking a drop is UNREACHABLE by
// design and composeGoto fails honestly rather than walking off a ledge.
//
// Every branch degrades to {ok:false, error, ...} — nothing here throws into
// the kernel (doGoto's caller). Result shape matches global_router.goto's
// ({ok, state, legsWalked, replans, coverage, ...}) so doGoto's mission/journal
// wiring reads it unchanged, plus {composed:true, phases:[...]} for diagnosis.

import {
  isEnvCellId,
  nearestCell,
  findPath,
  findExitPath,
  toLegs,
  buildStitchedGraphFromWasm,
} from "./indoor_router.js";

// World-frame metres from a full objCellId + landblock-local x/y (router.js:50).
const worldX = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
const worldY = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;

// Re-bucket a leg to the landblock whose base actually contains its world
// point (the sidecar WorldToLeg convention). Dungeon EnvCell frames can put a
// cell at NEGATIVE lb-local coords (live: Town Network 0x00070143 pose
// x 73.4, y -62.8) — same world point, but negative locals feed
// MoveToPosition's internal cell re-derivation garbage. Identity for legs
// whose locals are already in [0,192).
function normalizeLegWorldFrame(leg) {
  const wx = worldX(leg.lb >>> 0, leg.x);
  const wy = worldY(leg.lb >>> 0, leg.y);
  const lbX = Math.max(0, Math.min(255, Math.floor(wx / 192)));
  const lbY = Math.max(0, Math.min(255, Math.floor(wy / 192)));
  const lx = wx - lbX * 192;
  const ly = wy - lbY * 192;
  const cell = 1 + Math.min(7, Math.max(0, Math.floor(lx / 24))) * 8 + Math.min(7, Math.max(0, Math.floor(ly / 24)));
  return { ...leg, lb: (((lbX << 24) | (lbY << 16) | cell) >>> 0), x: lx, y: ly };
}
// World metres -> /loc degrees (sidecar DegToWorld inverse; rynth_sidecar_smoke.cjs:13).
const degFromWorld = (w) => (w / 24 - 1019.5) / 10;

// Portal-entity classification (observe_ext.js:27,248): ItemType.Portal on
// PropertyInt 1, or the Portal ObjectDescriptionFlag — either marks a portal.
const ITEM_TYPE_PORTAL = 0x00010000;
const ODF_PORTAL = 0x40000;
const PORTAL_JUMP_M = 30; // world-frame pose jump that confirms a teleport (router.js SEAM_JUMP_M)

// Map | plain-object graph -> Map<u32,node> (indoor_router.js:70-79 asMap; not exported there).
function toMap(graph) {
  const m = new Map();
  if (!graph || typeof graph !== "object") return m;
  const entries = graph instanceof Map ? graph.entries() : Object.entries(graph);
  for (const [k, v] of entries) if (v && v.pos) m.set(Number(k) >>> 0, v);
  return m;
}

// Current cell id: prefer the wasm getCurrentCellId() (no side effect), fall
// back to the per-tick pose snapshot. 0 when neither is available (-> outdoors).
function currentCell(host) {
  try {
    const s = host && host.s;
    if (s && typeof s.getCurrentCellId === "function") {
      const c = s.getCurrentCellId() >>> 0;
      if (c) return c;
    }
  } catch (_) {
    /* wasm read may throw pre-spawn */
  }
  try {
    const p = host && host.TryGetPlayerPose && host.TryGetPlayerPose();
    if (p && typeof p.objCellId === "number") return p.objCellId >>> 0;
  } catch (_) {
    /* hostile host */
  }
  return 0;
}

// Wait up to timeoutMs for a pose (null during boot / mid-teleport). Never throws.
async function awaitPose(host, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let p = null;
    try {
      p = host.TryGetPlayerPose();
    } catch (_) {
      p = null;
    }
    if (p) return p;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The graph cell to route FROM/TO: the exact id if it is a node, else the
// nearest node in the pose's world frame (same-floor preferred, 8m Z band).
// Returns a u32 id or 0.
function resolveCell(nodes, exactId, frameCell, x, y, z) {
  const id = exactId >>> 0;
  if (nodes.has(id)) return id;
  const near = nearestCell(nodes, worldX(frameCell, x), worldY(frameCell, y), z);
  return near ? near >>> 0 : 0;
}

// A precise final leg at the requested indoor goal (exact x/y/z, not the cell centre).
const goalLeg = (to) => ({ lb: to.lb >>> 0, x: to.x, y: to.y, z: to.z });

/**
 * Walk `legs` via `router` (RynthRouter, ticked off the host heartbeat) and
 * resolve when the walk reaches a terminal state. Mirrors global_router.js's
 * walk poll: a stall deadline (host stopped ticking) and external-cancel
 * detection (state left WALK/PORTAL without DONE/FAILED). Never throws.
 * Returns { ok, state, legsWalked, stitchBlocked? }.
 */
export async function walkLegs(router, legs, { pollMs = 500, stallMs = 45_000, log } = {}) {
  if (!Array.isArray(legs) || legs.length === 0) return { ok: true, state: "DONE", legsWalked: 0 };
  if (log) log(`indoor walk: ${legs.length} legs`);
  router.follow(legs);
  let lastSig = "";
  let lastChangeAt = Date.now();
  for (;;) {
    const st = router.status;
    if (st.state === "DONE" || st.state === "FAILED") break;
    if (st.state !== "WALK" && st.state !== "PORTAL") {
      // cancel()ed or re-follow()ed from under us — abort (last command wins).
      return { ok: false, state: st.state, error: "route cancelled", legsWalked: st.walked ?? 0 };
    }
    const sig = `${st.state}:${st.leg}:${st.walked}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt > stallMs) {
      router.cancel();
      return { ok: false, state: "STALLED", error: "walk stalled (host stopped ticking?)", legsWalked: router.status.walked ?? 0 };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const walked = router.status.walked ?? router.status.leg;
  return {
    ok: router.status.state === "DONE",
    state: router.status.state,
    legsWalked: walked,
    stitchBlocked: router.status.stitchBlocked === true,
  };
}

// Exit-route legs: indoor path to the nearest outdoor-exit portal cell, plus a
// final "just outside the door" outdoor leg that carries the walk THROUGH the
// portal plane. Port of dungeon_nav.js exitRoute:316-358 (outdoor-target
// derivation), but pure (no advisor/bot) and world-frame throughout.
// Returns { legs, exitCell, outdoorId } or null (no reachable exit).
function buildExitLegs(graph, nodes, fromCell, pose) {
  const exit = findExitPath(graph, fromCell);
  if (!exit) return null;
  const legs = toLegs(graph, exit.path, { midpoints: true });
  const exitNode = nodes.get(exit.exitCell >>> 0);
  if (!exitNode) return null;
  let outdoorId, ox, oy;
  if (exit.outdoorId != null) {
    // Direct outdoor LandCell id: walk to its centre (gid_to_lcoord: idx-1 = cx*8+cy, 24u cells).
    outdoorId = exit.outdoorId >>> 0;
    const idx = (outdoorId & 0xffff) - 1;
    ox = ((idx >> 3) & 7) * 24 + 12;
    oy = (idx & 7) * 24 + 12;
  } else {
    // Retail outside-sentinel (other_cell_id == -1): project ~9u past the exit
    // cell centre along the approach direction, then bin into its LandCell.
    const prevId = exit.path.length > 1 ? exit.path[exit.path.length - 2] >>> 0 : null;
    const from = prevId != null ? nodes.get(prevId)?.pos : null;
    const base = exitNode.pos;
    const pwx = worldX(pose.objCellId >>> 0, pose.x);
    const pwy = worldY(pose.objCellId >>> 0, pose.y);
    let dx = base.x - (from ? from.x : pwx);
    let dy = base.y - (from ? from.y : pwy);
    const len = Math.hypot(dx, dy);
    if (len > 0.01) {
      dx /= len;
      dy /= len;
    } else {
      dx = 0;
      dy = 1;
    }
    const wx = base.x + dx * 9;
    const wy = base.y + dy * 9;
    const lbx = Math.floor(wx / 192);
    const lby = Math.floor(wy / 192);
    const cx = Math.floor((wx - lbx * 192) / 24);
    const cy = Math.floor((wy - lby * 192) / 24);
    outdoorId = (((lbx & 0xff) << 24) | ((lby & 0xff) << 16) | (cx * 8 + cy + 1)) >>> 0;
    ox = wx - lbx * 192;
    oy = wy - lby * 192;
  }
  legs.push({ lb: outdoorId, x: ox, y: oy, z: exitNode.pos.z ?? pose.z });
  return { legs, exitCell: exit.exitCell >>> 0, outdoorId };
}

async function safeBuild(buildGraph, lbWord) {
  try {
    return await buildGraph(lbWord >>> 0);
  } catch (_) {
    return null;
  }
}

// Nearest PORTAL entity to `target` among those within `playerMaxM` of the
// player (observe_ext.js nearbyPortals pattern: ItemType.Portal on PropertyInt
// 1, or the Portal descFlag). Disambiguates a cluster (a town network has many
// portals) by picking the one closest to the intended target world point.
// Returns { guid, name, dPlayer, dTarget } | null. Never throws.
function findNearbyPortal(host, playerWx, playerWy, targetWx, targetWy, playerMaxM) {
  if (!host || typeof host.NearbyGuids !== "function") return null;
  let guids;
  try {
    guids = host.NearbyGuids() || [];
  } catch (_) {
    return null;
  }
  let best = null;
  for (const g of guids) {
    let portalish = false;
    try {
      const it = host.TryGetObjectIntProperty ? host.TryGetObjectIntProperty(g, 1) : null;
      if (typeof it === "number" && (it & ITEM_TYPE_PORTAL)) portalish = true;
    } catch (_) {
      /* skip */
    }
    if (!portalish) {
      try {
        const f = host.TryGetObjectDescFlags ? host.TryGetObjectDescFlags(g) : null;
        if (typeof f === "number" && (f & ODF_PORTAL)) portalish = true;
      } catch (_) {
        /* skip */
      }
    }
    if (!portalish) continue;
    let p = null;
    try {
      p = host.TryGetObjectPosition ? host.TryGetObjectPosition(g) : null;
    } catch (_) {
      p = null;
    }
    if (!p) continue;
    const pwx = worldX(p.objCellId >>> 0, p.x);
    const pwy = worldY(p.objCellId >>> 0, p.y);
    if (Math.hypot(pwx - playerWx, pwy - playerWy) > playerMaxM) continue;
    const dTarget = Math.hypot(pwx - targetWx, pwy - targetWy);
    if (!best || dTarget < best.dTarget) {
      let name = "portal";
      try {
        name = (host.TryGetObjectName && host.TryGetObjectName(g)) || "portal";
      } catch (_) {
        /* keep default */
      }
      best = { guid: g >>> 0, name, dTarget };
    }
  }
  return best;
}

// Poll the pose until it jumps >= jumpM in the world frame (a teleport) or the
// timeout expires. Returns the far-side pose or null. Never throws.
async function awaitTeleport(host, fromWx, fromWy, timeoutMs, pollMs, jumpM) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let p = null;
    try {
      p = host.TryGetPlayerPose();
    } catch (_) {
      p = null;
    }
    if (p) {
      const wx = worldX(p.objCellId >>> 0, p.x);
      const wy = worldY(p.objCellId >>> 0, p.y);
      if (Math.hypot(wx - fromWx, wy - fromWy) >= jumpM) return p;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * In-EnvCell portal transit (task #14). The outdoor planner fails fast on a
 * straight stitch leg it can't thread through a dungeon interior (the Town
 * Network -> Holtburg exit-portal case): when we are parked in an EnvCell and
 * that blocked leg points at a portal, walk the indoor cell graph to the
 * portal's cell, USE the portal entity (arriving within 3m does not reliably
 * fire the hop), and wait for the teleport. Then the caller re-plans the outer
 * route from the far side. Honest {ok:false,error:"portal transit failed:<stage>"}
 * at every stage — never hangs, never throws.
 */
async function attemptPortalTransit(ctx, blockedLeg, tune) {
  const { host, walk, buildGraph } = ctx;
  const stage = (s) => ({ ok: false, error: `portal transit failed: ${s}` });
  if (!blockedLeg) return stage("no blocked leg");
  const cell = currentCell(host);
  if (!isEnvCellId(cell)) return stage("not indoors");
  const twx = worldX(blockedLeg.lb >>> 0, blockedLeg.x);
  const twy = worldY(blockedLeg.lb >>> 0, blockedLeg.y);
  const graph = await safeBuild(buildGraph, cell & 0xffff0000);
  const nodes = toMap(graph);
  if (nodes.size === 0) return stage("indoor graph unavailable");
  let pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
  if (!pose) return stage("no player pose");
  const fromCell = resolveCell(nodes, cell, pose.objCellId >>> 0, pose.x, pose.y, pose.z);
  if (!fromCell) return stage("indoor graph unavailable");
  const targetCell = nearestCell(nodes, twx, twy, blockedLeg.z);
  if (!targetCell) return stage("portal cell not found");
  // Walk the interior to the portal's cell (unless already in it).
  if ((targetCell >>> 0) !== (fromCell >>> 0)) {
    const path = findPath(graph, fromCell, targetCell >>> 0);
    if (!path) return stage("portal cell unreachable"); // drop-gated / disconnected
    // World-frame normalize + generous per-leg deadline: the Town Network has a
    // known perf pathology (sim can crawl ~0.3 m/s there), so short indoor
    // cell-hop legs still need a long watchdog.
    const legs = toLegs(graph, path, { midpoints: true })
      .map((l) => ({ ...normalizeLegWorldFrame(l), timeoutMs: tune.indoorLegTimeoutMs }));
    // Stall guard must outlive the long per-leg watchdog (one slow leg keeps
    // the router status signature constant for its whole duration).
    const w = await walk(legs, { label: "portal-approach", stallMs: tune.indoorLegTimeoutMs + 15_000 });
    if (!w.ok) return stage(`indoor walk ${(w.state || "failed").toLowerCase()}`);
    pose = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || pose;
  }
  // Portal-touch assist: locate the portal entity in reach and USE it.
  const pwx = worldX(pose.objCellId >>> 0, pose.x);
  const pwy = worldY(pose.objCellId >>> 0, pose.y);
  const portal = findNearbyPortal(host, pwx, pwy, twx, twy, tune.portalRangeM);
  if (!portal) return stage("portal entity not found");
  if (typeof host.UseObject !== "function") return stage("use unavailable");
  let sent = false;
  try {
    sent = !!host.UseObject(portal.guid);
  } catch (_) {
    sent = false;
  }
  if (!sent) return stage("use rejected");
  const jumped = await awaitTeleport(host, pwx, pwy, tune.portalTeleportMs, tune.teleportPollMs, tune.portalJumpM);
  if (!jumped) return stage("no teleport");
  return { ok: true, portal: portal.name, exitCell: targetCell >>> 0 };
}

/**
 * Outdoor portal-touch assist: the hop-by-contact at an outdoor portal leg is
 * not reliable (live: 2-in-3) — arrival can stop just outside the trigger
 * radius. When a blocked-leg failure lands while OUTDOORS with a portal entity
 * within reach of the pose, USE it and await the teleport. Returns
 * {ok:true,portal} on a hop; {ok:false, noPortal:true} when there is simply no
 * portal in reach (caller keeps the raw failure); honest error otherwise.
 */
async function attemptOutdoorPortalTouch(ctx, tune) {
  const { host } = ctx;
  const stage = (s) => ({ ok: false, error: `portal touch failed: ${s}` });
  const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
  if (!pose) return stage("no player pose");
  const pwx = worldX(pose.objCellId >>> 0, pose.x);
  const pwy = worldY(pose.objCellId >>> 0, pose.y);
  // Target = the pose itself: nearest portal to where the walk stopped.
  const portal = findNearbyPortal(host, pwx, pwy, pwx, pwy, tune.portalRangeM);
  if (!portal) return { ok: false, noPortal: true };
  if (typeof host.UseObject !== "function") return stage("use unavailable");
  let sent = false;
  try {
    sent = !!host.UseObject(portal.guid);
  } catch (_) {
    sent = false;
  }
  if (!sent) return stage("use rejected");
  const jumped = await awaitTeleport(host, pwx, pwy, tune.portalTeleportMs, tune.teleportPollMs, tune.portalJumpM);
  if (!jumped) return stage("no teleport");
  return { ok: true, portal: portal.name };
}

/**
 * Run the OUTDOOR planner, transparently recovering an in-EnvCell portal leg it
 * fails fast on: on a blocked-leg failure while parked in an EnvCell, run the
 * portal transit, then re-plan from the far side (bounded by tune.maxTransits).
 * While OUTDOORS, a blocked-leg failure with a portal entity in reach gets the
 * portal-touch assist (the flaky hop-by-contact case) — no portal in reach
 * keeps the raw failure. On a plain success it returns the outdoor result
 * UNCHANGED (pure-outdoor stays identical); a transit that fails returns the
 * outdoor result with the honest portal-transit error.
 */
async function outdoorWithAssist(ctx, to, opts, tune, phases) {
  let transits = 0;
  for (;;) {
    const out = await ctx.outdoorGoto(to, opts);
    if (out && out.ok === true) return out;
    if (!out || !out.blockedLeg || transits >= tune.maxTransits) {
      return out;
    }
    let tr;
    if (isEnvCellId(currentCell(ctx.host))) {
      // Aim the transit at the next PORTAL leg of the failed plan when the
      // blockage is a mid-dungeon waypoint (nextPortalLeg falls back to the
      // blocked leg for older global_router results).
      tr = await attemptPortalTransit(ctx, out.nextPortalLeg || out.blockedLeg, tune);
    } else {
      tr = await attemptOutdoorPortalTouch(ctx, tune);
      if (!tr.ok && tr.noPortal) return out; // genuine obstacle, no portal near
    }
    if (phases) phases.push({ phase: "portal-transit", ok: tr.ok, ...(tr.ok ? { portal: tr.portal } : { error: tr.error }) });
    if (ctx.log) ctx.log(tr.ok ? `portal transit via ${tr.portal} — re-planning from the far side` : tr.error);
    if (!tr.ok) return { ...out, ok: false, error: tr.error, portalTransit: false };
    transits += 1;
    // teleported — loop and re-plan the outdoor route from the new pose.
  }
}

// Honest terminal failure, composed-shape.
const fail = (error, extra = {}) => ({
  ok: false,
  state: extra.state ?? "FAILED",
  error,
  legsWalked: extra.legsWalked ?? 0,
  replans: 0,
  coverage: extra.coverage ?? null,
  composed: true,
  phases: extra.phases ?? [],
});

/**
 * Compose an outdoor<->indoor goto. `deps`:
 *   host        RynthWebHost (pose + .s SessionHandle for getCurrentCellId)
 *   router      RynthRouter (leg executor, ticked off the host)
 *   outdoorGoto async (to, opts) => globalRouter.goto result — the OUTDOOR planner
 *   buildGraph? async (lbWord) => graph|null (default: buildStitchedGraphFromWasm)
 *   walk?       async (legs, {label}) => walkLegs-shape (default: walkLegs over router)
 *   fetchEnvCells? passed to buildStitchedGraphFromWasm in headless contexts
 *   log?        (msg) => void
 * `to`: {ns,ew} | {lb,x,y[,z]} (an EnvCell lb -> indoor goal). `opts`: goto opts.
 * Resolves the goto result; never rejects.
 */
export async function composeGoto(deps, to, opts = {}) {
  const { host, router } = deps;
  const outdoorGoto = deps.outdoorGoto;
  const log = deps.log || (() => {});
  const pollMs = opts.pollMs ?? 500;
  const stallMs = opts.stallMs ?? 45_000;
  const poseTimeoutMs = opts.poseTimeoutMs ?? 15_000;
  const posePollMs = Math.min(pollMs, 250);
  const buildGraph =
    deps.buildGraph ||
    ((lb) => buildStitchedGraphFromWasm([lb], deps.fetchEnvCells ? { fetchEnvCells: deps.fetchEnvCells } : {}));
  const walk = deps.walk || ((legs, wopts = {}) => walkLegs(router, legs, { pollMs, stallMs, log, ...wopts }));

  // Portal-transit assist context/tuning (task #14): the OUTDOOR planner fails
  // fast on a straight stitch leg into a dungeon interior; when we are parked in
  // an EnvCell we recover by walking the cell graph to the portal, USE-ing it,
  // and re-planning from the far side. `outdoorWithAssist` is transparent on a
  // plain outdoor success (pure-outdoor stays identical).
  const ctx = { host, router, outdoorGoto, walk, buildGraph, log };
  const tune = {
    poseTimeoutMs,
    posePollMs,
    portalRangeM: opts.portalRangeM ?? 10,
    portalTeleportMs: opts.portalTeleportMs ?? 12_000,
    teleportPollMs: Math.min(pollMs, 500),
    portalJumpM: opts.portalJumpM ?? router?.seamJumpM ?? PORTAL_JUMP_M,
    maxTransits: opts.portalTransits ?? 3,
    // Town Network perf pathology: the sim can crawl there, so indoor transit
    // legs get a long per-leg watchdog (router honors leg.timeoutMs).
    // Live v9: network leg speeds fluctuate 0.1-1 m/s; a 5m hall leg blew 90s.
    indoorLegTimeoutMs: opts.indoorLegTimeoutMs ?? 240_000,
  };

  const startCell = currentCell(host);
  const startIndoor = isEnvCellId(startCell);
  const goalIndoor = !!(to && typeof to === "object" && "lb" in to && isEnvCellId((to.lb >>> 0)));

  // ── Case 0 — pure outdoor: IDENTICAL to the pre-composition path on success
  //    (outdoorWithAssist only diverges to recover an in-EnvCell portal leg). ─
  if (!startIndoor && !goalIndoor) return outdoorWithAssist(ctx, to, opts, tune, null);

  const phases = [];
  let legsWalked = 0;

  // ── Phase A — if indoors, get OUT of the current building first (unless the
  //    goal is in the SAME dungeon landblock: then it's a pure indoor walk). ──
  if (startIndoor) {
    const pose = await awaitPose(host, poseTimeoutMs, posePollMs);
    if (!pose) return fail("no player pose", { phases, legsWalked });
    const startLb = startCell & 0xffff0000;
    const graph = await safeBuild(buildGraph, startLb);
    const nodes = toMap(graph);
    if (nodes.size === 0) return fail("indoor graph unavailable", { phases, legsWalked });
    const fromCell = resolveCell(nodes, startCell, pose.objCellId >>> 0, pose.x, pose.y, pose.z);
    if (!fromCell) return fail("indoor graph unavailable", { phases, legsWalked });

    // Case 2 — same-landblock indoor -> indoor: pure indoor A*.
    if (goalIndoor && ((to.lb >>> 0) & 0xffff0000) === startLb) {
      const goalCell = resolveCell(nodes, to.lb >>> 0, to.lb >>> 0, to.x, to.y, to.z);
      if (!goalCell) return fail("indoor graph unavailable (goal cell not in graph)", { phases, legsWalked });
      const path = findPath(graph, fromCell, goalCell);
      if (!path) return fail("indoor route unreachable (drop-gated or disconnected)", { phases, legsWalked });
      const legs = toLegs(graph, path, { midpoints: true });
      legs.push(goalLeg(to));
      const w = await walk(legs, { label: "indoor" });
      legsWalked += w.legsWalked || 0;
      phases.push({ phase: "indoor", ok: w.ok, state: w.state, legsWalked: w.legsWalked || 0 });
      return {
        ok: w.ok,
        state: w.state,
        legsWalked,
        replans: 0,
        coverage: "indoor",
        composed: true,
        phases,
        ...(w.ok ? {} : { error: w.error || "indoor walk failed" }),
      };
    }

    // Otherwise (goal outdoors, or a DIFFERENT dungeon): exit the building.
    const exit = buildExitLegs(graph, nodes, fromCell, pose);
    if (!exit) return fail("indoor graph unavailable (no reachable exit)", { phases, legsWalked });
    const w = await walk(exit.legs, { label: "exit" });
    legsWalked += w.legsWalked || 0;
    phases.push({ phase: "exit", ok: w.ok, state: w.state, legsWalked: w.legsWalked || 0 });
    if (!w.ok) {
      return {
        ok: false,
        state: w.state,
        error: w.error || "exit walk failed",
        legsWalked,
        replans: 0,
        coverage: "indoor",
        composed: true,
        phases,
      };
    }
    // We are outdoors now — fall through to Phase B/C.
  }

  // ── Phase B — outdoors, goal outdoors: hand the rest to the sidecar planner
  //    (with in-EnvCell portal-transit recovery). ─────────────────────────────
  if (!goalIndoor) {
    const w = await outdoorWithAssist(ctx, to, opts, tune, phases);
    phases.push({ phase: "outdoor", ok: w.ok, state: w.state, legsWalked: w.legsWalked ?? 0 });
    return {
      ok: w.ok === true,
      state: w.state ?? (w.ok ? "DONE" : "FAILED"),
      legsWalked: legsWalked + (w.legsWalked ?? 0),
      replans: w.replans ?? 0,
      coverage: w.coverage ?? null,
      estUnits: w.estUnits,
      portalsUsed: w.portalsUsed,
      stitchedLegs: w.stitchedLegs,
      partial: w.partial,
      composed: true,
      phases,
      ...(w.ok ? {} : { error: w.error || "outdoor walk failed" }),
    };
  }

  // ── Phase C — goal indoors: outdoor-approach the building landblock, then
  //    indoor A* from the entry doorway (nearest cell to the arrival pose). ────
  const goalLb = (to.lb >>> 0) & 0xffff0000;
  const gwx = worldX(to.lb >>> 0, to.x);
  const gwy = worldY(to.lb >>> 0, to.y);
  const approach = await outdoorWithAssist(ctx, { ns: degFromWorld(gwy), ew: degFromWorld(gwx) }, opts, tune, phases);
  phases.push({ phase: "approach", ok: approach.ok, state: approach.state, legsWalked: approach.legsWalked ?? 0 });
  legsWalked += approach.legsWalked ?? 0;
  if (approach.ok !== true) {
    return {
      ok: false,
      state: approach.state ?? "FAILED",
      error: approach.error || "outdoor approach to building landblock failed",
      legsWalked,
      replans: approach.replans ?? 0,
      coverage: approach.coverage ?? null,
      composed: true,
      phases,
    };
  }

  const graph = await safeBuild(buildGraph, goalLb);
  const nodes = toMap(graph);
  if (nodes.size === 0) return fail("indoor graph unavailable", { phases, legsWalked, coverage: approach.coverage });
  const pose = await awaitPose(host, poseTimeoutMs, posePollMs);
  if (!pose) return fail("no player pose", { phases, legsWalked, coverage: approach.coverage });
  const entryCell = nearestCell(nodes, worldX(pose.objCellId >>> 0, pose.x), worldY(pose.objCellId >>> 0, pose.y), pose.z);
  const goalCell = resolveCell(nodes, to.lb >>> 0, to.lb >>> 0, to.x, to.y, to.z);
  if (!entryCell || !goalCell) return fail("indoor graph unavailable", { phases, legsWalked, coverage: approach.coverage });
  const path = findPath(graph, entryCell >>> 0, goalCell >>> 0);
  // Entry doorway not reachable (graph empty / cell not streamed / drop-gated):
  // honest failure per the task contract — no guessing an interior path.
  if (!path) return fail("indoor graph unavailable", { phases, legsWalked, coverage: approach.coverage });
  const legs = toLegs(graph, path, { midpoints: true });
  legs.push(goalLeg(to));
  const w = await walk(legs, { label: "enter" });
  legsWalked += w.legsWalked || 0;
  phases.push({ phase: "enter", ok: w.ok, state: w.state, legsWalked: w.legsWalked || 0 });
  return {
    ok: w.ok,
    state: w.state,
    legsWalked,
    replans: approach.replans ?? 0,
    coverage: approach.coverage ?? "mixed",
    composed: true,
    phases,
    ...(w.ok ? {} : { error: w.error || "indoor entry walk failed" }),
  };
}

export default { composeGoto, walkLegs };
