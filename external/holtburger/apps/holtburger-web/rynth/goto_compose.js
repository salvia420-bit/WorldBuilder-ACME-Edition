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
// findExitPath still PRUNE every drop/jump edge for ROUTE PLANNING — no
// jump-feasibility test exists in the graph search (that's Phase 3 of
// docs/rynth-integration/DESIGN-jump-primitive-2026-07-21.md) — so a goal (or
// an exit) reachable only by taking a drop is still UNREACHABLE by design and
// composeGoto fails honestly rather than walking off a ledge. This is now
// ONLY a planning-time limitation, not an execution one: the REPLAY path
// (replayRoute below) DOES have a jump primitive (attemptJumpLeg) for
// corpus-recorded `jmp` legs (nav_import.js meta.navType==='jmp') — see the
// "jmp legs" section near replayRoute.

// ── jmp legs (2026-07-21, DESIGN-jump-primitive Phase 1) ───────────────────
// A corpus-imported jmp leg (nav_import.js meta.navType==='jmp', carrying
// headingDeg/holdShift/delayMs) is NOT a walkable waypoint — the router's
// ordinary MoveToPosition walk toward it (or toward a sentinel-fixed cht/pau
// leg immediately before it, which nav_import.js's fixupSentinelLegs
// collapses onto the SAME coordinate) times out against whatever gap/ledge
// the jump was recorded to cross. attemptJumpLeg below fires the EXISTING
// wasm jump pipeline (SessionHandle.jump/setMovementInput/canJumpNow — no
// new physics code, see the design doc §2a) instead of retrying the walk:
// face headingDeg, hold forward (walk if holdShift, run if not — retail's
// launch velocity is read from whatever motion is active AT THE MOMENT
// jump() fires, so a standstill call is a near-vertical hop, not a gap
// clearance), release the jump, then a bounded settle before resuming. See
// findUpcomingJumpLeg's call site in replayRoute for how a FAILED walk leg
// gets recognized as jump-adjacent.
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
  edgeKey,
} from "./indoor_router.js";
// deriveRouteFlags moved out to route_flags.js (2026-07-20) so nav_import.js
// (VTank/.nav import) can share the SAME v2 flag semantics without pulling in
// this whole outdoor<->indoor composition module. Re-exported below unchanged
// so existing importers of goto_compose.js see no API difference.
import { deriveRouteFlags } from "./route_flags.js";
export { deriveRouteFlags }; // re-exported: named-export surface unchanged for existing importers

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
const cellHex = (id) => "0x" + (id >>> 0).toString(16).toUpperCase();

// Portal-entity classification (observe_ext.js:27,248): ItemType.Portal on
// PropertyInt 1, or the Portal ObjectDescriptionFlag — either marks a portal.
const ITEM_TYPE_PORTAL = 0x00010000;
const ODF_PORTAL = 0x40000;
const PORTAL_JUMP_M = 30; // world-frame pose jump that confirms a teleport (router.js SEAM_JUMP_M)
const REPLAY_INDOOR_LEG_TIMEOUT_MS = 240_000;

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

/**
 * Is the cell read above actually BACKED by live data? `currentCell` collapses
 * "outdoors" and "unreadable" onto 0; this separates them so a caller can
 * refuse to conclude anything from the ambiguous case (2026-08-03 review).
 */
function poseIsReadable(host) {
  try {
    const s = host && host.s;
    if (s && typeof s.getCurrentCellId === "function") return true;
  } catch (_) { /* fall through */ }
  try {
    const p = host && host.TryGetPlayerPose && host.TryGetPlayerPose();
    if (p && typeof p.objCellId === "number") return true;
  } catch (_) { /* hostile host */ }
  return false;
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
// Returns { legs, path, exitCell, outdoorId } or null (no reachable exit).
//
// opts (2026-07-23, egress retry ladder — see exitToOutdoors):
//   excludeEdges     Set<edgeKey> forwarded to findExitPath — re-route to the
//                    NEXT-nearest exit around a wedged doorway edge.
//   doorwayApproach  use toLegs' two-stage 30%/50% doorway pre-approach
//                    (the offset-doorframe fix) instead of {midpoints}.
function buildExitLegs(graph, nodes, fromCell, pose, opts = {}) {
  const exit = findExitPath(graph, fromCell, opts.excludeEdges ? { excludeEdges: opts.excludeEdges } : {});
  if (!exit) return null;
  const legs = toLegs(graph, exit.path, opts.doorwayApproach ? { doorwayApproach: true } : { midpoints: true });
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
  return { legs, path: exit.path, exitCell: exit.exitCell >>> 0, outdoorId };
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

// Name-based entity lookup — the SAME NearbyGuids()+TryGetObjectName
// technique ai/tools/world.js's use_object resolver (resolveNearby) uses to
// let the LLM "use" any nearby object by name, reused here at the router
// layer (goto_compose sits below ai/, so this is a local port, not an
// import) for nav-imported ptl/tlk legs that carry the object's real name
// (nav_import.js meta.objName). Case-insensitive substring match, nearest
// exact match to `targetWx,targetWy` wins on ambiguity. Returns
// { guid, name, dTarget } | null. Never throws.
function findEntityByName(host, name, targetWx, targetWy, maxRangeM) {
  const want = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!want || !host || typeof host.NearbyGuids !== "function") return null;
  let guids;
  try {
    guids = host.NearbyGuids() || [];
  } catch (_) {
    return null;
  }
  let best = null;
  for (const g of guids) {
    let nm = null;
    try {
      nm = host.TryGetObjectName ? host.TryGetObjectName(g) : null;
    } catch (_) {
      nm = null;
    }
    if (!nm) continue;
    const lower = nm.toLowerCase();
    if (lower !== want && !lower.includes(want) && !want.includes(lower)) continue;
    let p = null;
    try {
      p = host.TryGetObjectPosition ? host.TryGetObjectPosition(g) : null;
    } catch (_) {
      p = null;
    }
    if (!p) continue;
    const pwx = worldX(p.objCellId >>> 0, p.x);
    const pwy = worldY(p.objCellId >>> 0, p.y);
    const dTarget = Math.hypot(pwx - targetWx, pwy - targetWy);
    if (dTarget > maxRangeM) continue;
    const exact = lower === want ? 0 : 1;
    if (!best || exact < best.exact || (exact === best.exact && dTarget < best.dTarget)) {
      best = { guid: g >>> 0, name: nm, dTarget, exact };
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
  // Transit origin: a portal-jump-sized displacement from here at ANY later
  // stage means the hop already happened (live v11: the walk's final leg
  // walked INTO the exit portal and teleported to Holtburg — then the touch
  // step searched the DESTINATION for a portal and mislabeled success).
  const owx = worldX(pose.objCellId >>> 0, pose.x);
  const owy = worldY(pose.objCellId >>> 0, pose.y);
  // Threshold must exceed any legitimate INDOOR WALK displacement — the
  // transit's own hallway path is ~40m, and 30m (portalJumpM) false-fired
  // mid-corridor (v14: "walk-in hop" declared while still in the network ->
  // outdoor re-plan from an EnvCell -> HTTP 400). Real hops here are
  // cross-map (49km); 500m cleanly separates the classes.
  const TRANSIT_HOP_M = 500;
  const alreadyHopped = (p) =>
    Math.hypot(worldX(p.objCellId >>> 0, p.x) - owx, worldY(p.objCellId >>> 0, p.y) - owy) >= TRANSIT_HOP_M;
  const fromCell = resolveCell(nodes, cell, pose.objCellId >>> 0, pose.x, pose.y, pose.z);
  if (!fromCell) return stage("indoor graph unavailable");
  const targetCell = nearestCell(nodes, twx, twy, blockedLeg.z);
  if (!targetCell) return stage("portal cell not found");
  // Walk the interior to the portal's cell (unless already in it).
  if ((targetCell >>> 0) !== (fromCell >>> 0)) {
    const path = findPath(graph, fromCell, targetCell >>> 0);
    if (!path) return stage("portal cell unreachable"); // drop-gated / disconnected
    // Two-stage doorway pre-approach (DungeonPathfinder.cs:377-399, ported into
    // toLegs {doorwayApproach}) so the walker lines up on the offset doorframe
    // instead of cutting the corner into it — the live Town-Network wedge that
    // {midpoints:true} never threaded. World-frame normalize + a generous
    // per-leg deadline (the network sim can crawl ~0.3 m/s, live v9: a 5m hall
    // leg blew 90s), stall guard outliving the per-leg watchdog.
    const buildLegs = (p) =>
      toLegs(graph, p, { doorwayApproach: true })
        .map((l) => ({ ...normalizeLegWorldFrame(l), timeoutMs: tune.indoorLegTimeoutMs }));
    const walkStallMs = tune.indoorLegTimeoutMs + 15_000;
    let w = await walk(buildLegs(path), { label: "portal-approach", stallMs: walkStallMs });
    if (!w.ok) {
      // ONE re-walk retry of the REMAINING path from the wedge pose: a fresh
      // MoveToPosition sometimes threads the offset doorway that the first pass
      // ground on (live v11: success is nondeterministic). Re-derive the current
      // cell and re-findPath so a partial first walk shortens the retry.
      const pr = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || pose;
      if (alreadyHopped(pr)) return { ok: true, portal: "(walk-in hop)", exitCell: targetCell >>> 0 };
      const reFrom = resolveCell(nodes, currentCell(host), pr.objCellId >>> 0, pr.x, pr.y, pr.z);
      if (reFrom && (reFrom >>> 0) !== (targetCell >>> 0)) {
        const rePath = findPath(graph, reFrom >>> 0, targetCell >>> 0);
        if (rePath && rePath.length >= 2) {
          w = await walk(buildLegs(rePath), { label: "portal-approach-retry", stallMs: walkStallMs });
        }
      }
    }
    if (!w.ok) {
      // Desperate touch: live v9/v10 wedged on the SAME 5m doorway leg while
      // 11m from the exit portal. UseObject has its own retail auto-approach
      // that threads doorway geometry MoveToPosition wedges on — if the portal
      // entity is findable in extended range, USE it and give the approach a
      // long teleport window before conceding.
      const p2 = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || pose;
      if (alreadyHopped(p2)) return { ok: true, portal: "(walk-in hop)", exitCell: targetCell >>> 0 };
      const p2wx = worldX(p2.objCellId >>> 0, p2.x);
      const p2wy = worldY(p2.objCellId >>> 0, p2.y);
      const desperate = findNearbyPortal(host, p2wx, p2wy, twx, twy, tune.portalDesperateRangeM);
      if (desperate && typeof host.UseObject === "function") {
        let sent2 = false;
        try { sent2 = !!host.UseObject(desperate.guid); } catch (_) { sent2 = false; }
        if (sent2) {
          const j2 = await awaitTeleport(host, p2wx, p2wy, Math.max(tune.portalTeleportMs, 60_000), tune.teleportPollMs, tune.portalJumpM);
          if (j2) return { ok: true, portal: desperate.name, exitCell: targetCell >>> 0 };
        }
      }
      return stage(`indoor walk ${(w.state || "failed").toLowerCase()}`);
    }
    pose = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || pose;
  }
  // Walk-in hop: the final approach leg can walk INTO the portal and teleport
  // without any touch — success, no entity search needed (v11: this is how the
  // first full Arwic->Holtburg run actually completed).
  if (alreadyHopped(pose)) return { ok: true, portal: "(walk-in hop)", exitCell: targetCell >>> 0 };
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
 * Meta-aware portal-touch assist (task: nav-imported ptl legs, live
 * MatronHive leg-8 finding). An imported route's ptl leg carries ground-truth
 * object data (nav_import.js meta.objName / meta.objPos) — this is strictly
 * better evidence than attemptOutdoorPortalTouch's plain nearest-any-portal
 * heuristic, which searches around the LEG's own coordinate (the VTank
 * approach point, which can be tens of metres from the real object — see
 * nav_import.js header). Search order:
 *   (a) NAME match (findEntityByName — the same NearbyGuids+TryGetObjectName
 *       technique ai/tools/world.js's use_object resolver uses) within reach
 *       of the OBJECT's real position.
 *   (b) fall back to the nearest PORTAL-flagged entity to the object's real
 *       position (findNearbyPortal, target = objPos not the leg anchor).
 *   (c) if nothing is in range yet, walk one leg toward the object's real
 *       position and retry the search once from there.
 * Returns {ok:true, portal} | {ok:false, error} (always a complete "portal
 * touch failed: ..." message — never relies on the caller to fill one in).
 * Never throws.
 */
async function attemptMetaPortalTouch(ctx, leg, tune) {
  const { host, walk } = ctx;
  const stage = (s) => ({ ok: false, error: `portal touch failed: ${s}` });
  const meta = leg && leg.meta;
  const objPos = meta && meta.objPos;
  if (!objPos) return stage("no object ground truth on this leg");
  const objName = meta.objName || "";
  const twx = worldX(objPos.lb >>> 0, objPos.x);
  const twy = worldY(objPos.lb >>> 0, objPos.y);

  const searchAndUse = async () => {
    const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
    if (!pose) return stage("no player pose");
    const pwx = worldX(pose.objCellId >>> 0, pose.x);
    const pwy = worldY(pose.objCellId >>> 0, pose.y);
    const byName = objName ? findEntityByName(host, objName, twx, twy, tune.portalDesperateRangeM ?? tune.portalRangeM) : null;
    const found = byName || findNearbyPortal(host, pwx, pwy, twx, twy, tune.portalRangeM);
    if (!found) return null; // not found YET — caller may retry after walking closer
    if (typeof host.UseObject !== "function") return stage("use unavailable");
    let sent = false;
    try {
      sent = !!host.UseObject(found.guid);
    } catch (_) {
      sent = false;
    }
    if (!sent) return stage("use rejected");
    const jumped = await awaitTeleport(host, pwx, pwy, tune.portalTeleportMs, tune.teleportPollMs, tune.portalJumpM);
    if (!jumped) return stage("no teleport");
    return { ok: true, portal: found.name };
  };

  let res = await searchAndUse();
  if (res) return res;

  if (typeof walk === "function") {
    const w = await walk([{ lb: objPos.lb >>> 0, x: objPos.x, y: objPos.y, z: objPos.z }], {
      label: "portal-object-approach",
      stallMs: tune.indoorLegTimeoutMs,
    });
    if (w && w.ok) {
      res = await searchAndUse();
      if (res) return res;
    }
  }
  return stage(`portal entity not found${objName ? ` (looked for "${objName}")` : ""}`);
}

/**
 * Recall-cast handling (rcl legs — nav_import.js meta.spellId/spellName). A
 * recall is a SELF-CAST spell with NO physical entity to touch — unlike a
 * portal leg, there is nothing for a touch-assist to find (the live
 * MatronHive report's misleading "portal entity not found" on a recall-
 * anchored hub is exactly this: the search was always going to fail). The
 * only path to the far side is the character actually knowing and
 * successfully casting the spell. Casts untargeted/self (mirrors
 * buff_loop.js/vitals.js's CastSpell(0, spellId) convention), waits out any
 * already-open cast gesture first, then awaits the resulting teleport like a
 * portal hop. Returns {ok:true, portal:spellName} on a confirmed hop, or a
 * LOUD, correctly-labelled {ok:false, error, reason:"recall-unavailable"}
 * naming the spell on any failure — never a portal-entity-shaped message.
 * Never throws.
 */
const RECALL_TELEPORT_MS = 20_000; // server-side cast + fade animation before the hop
// Exported (2026-07-24): unwedge.js's last-resort extraction reuses this as
// THE recall primitive rather than growing a second cast-and-await-teleport.
export async function attemptRecallCast(ctx, leg, tune) {
  const { host } = ctx;
  const meta = leg && leg.meta;
  const spellId = (meta && meta.spellId) >>> 0;
  const spellName = (meta && meta.spellName) || (spellId ? `spell ${spellId}` : "an unknown recall spell");
  const unavailable = (why) => ({
    ok: false,
    error: `recall-unavailable: ${spellName} ${why}`,
    reason: "recall-unavailable",
  });
  if (!spellId) return unavailable("has no recorded spell id");
  let known = [];
  try {
    const s = host && host.s;
    known = s && typeof s.playerKnownSpells === "function" ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
  } catch (_) {
    known = [];
  }
  if (!known.includes(spellId)) return unavailable("is not in the character's spellbook");
  if (typeof host.CastSpell !== "function") return unavailable("cast API unavailable");
  const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
  if (!pose) return unavailable("could not confirm a player pose to detect the teleport");
  const pwx = worldX(pose.objCellId >>> 0, pose.x);
  const pwy = worldY(pose.objCellId >>> 0, pose.y);
  // Let an already-open cast gesture clear before issuing a new one (same
  // gate combat_loop.js/buff_loop.js respect).
  try {
    if (typeof host.GetCastBusyState === "function") {
      const deadline = Date.now() + 3000;
      while (host.GetCastBusyState() !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, tune.posePollMs));
      }
    }
  } catch (_) {
    /* gate read is best-effort */
  }
  let sent = false;
  try {
    sent = !!host.CastSpell(0, spellId);
  } catch (_) {
    sent = false;
  }
  if (!sent) return unavailable("cast was refused");
  const jumped = await awaitTeleport(host, pwx, pwy, tune.recallTeleportMs, tune.teleportPollMs, tune.portalJumpM);
  if (!jumped) return unavailable("cast did not produce a teleport in time");
  return { ok: true, portal: spellName };
}

/**
 * Fire the jump primitive for a corpus `jmp` leg (nav_import.js
 * meta.navType==='jmp', {headingDeg, holdShift, delayMs}) — DESIGN-jump-
 * primitive-2026-07-21.md Phase 1. No new physics: this is JS glue over the
 * already-complete, parity-tested wasm pipeline (design doc §2a) — turn,
 * build launch velocity, fire, settle.
 *
 * Field mapping (design doc Risk #2 flags this as UNDETERMINED from the
 * corpus alone — this is Phase 1's own documented, calibratable choice, not
 * a retail-verified fact):
 *   - headingDeg -> TurnToHeading (VTank compass convention == this engine's
 *     bearing convention already established in combat_loop.js's _faceGate:
 *     yaw 0 = +Y north, pi/2 = +X east, bearing to (dx,dy) = atan2(dx,dy) —
 *     so headingRad = headingDeg * pi/180 directly, no axis flip).
 *   - holdShift -> gait: retail Shift-held while moving is WALK, not RUN (the
 *     codebase's own "Always Run" convention — MoveToPosition/setMovementInput
 *     both default run=true elsewhere); so holdShift===true -> run:false.
 *   - delayMs -> BOTH the pre-jump forward-hold/charge duration (clamped) AND
 *     the jump()'s power/extent (delayMs/1000, retail's charge curve is a
 *     ~1.0s hold-to-full-power ramp per the design doc §1a) AND a floor on
 *     the post-landing settle wait. src/lib.rs's SessionCommand::Jump arm
 *     reads `local_player_runtime_kinematics()` for the launch velocity's
 *     x/y (design doc §1c/2a) — a jump fired from a standstill is a near-
 *     vertical hop, so the forward-hold window before firing is load-bearing
 *     for horizontal distance, not cosmetic.
 *
 * Sequence: turn (rate-limited TurnToHeading, polled) -> gate on
 * CanJumpNow() -> hold forward (walk/run per holdShift) to build velocity ->
 * gate again -> Jump(power) -> brief hold past the fire (avoid a same-tick
 * stop racing the velocity read) -> release input -> poll for re-grounding
 * (CanJumpNow() flipping true again, §1d on_ground) bounded, then a
 * conservative settle pause (UB's documented resume-on-land flakiness, design
 * doc §5 — a bare state-flip is not trusted alone; the corpus's own
 * jmp->pau(1000ms)->chk idiom independently confirms human authors treat this
 * as a real, necessary wait).
 *
 * Returns {ok:true, power, headingRad, runFlag} or a typed
 * {ok:false, error, reason:"jump-unavailable"} (mirrors attemptRecallCast's
 * typed-failure pattern) — never throws.
 */
async function attemptJumpLeg(ctx, leg, tune) {
  const { host } = ctx;
  const meta = leg && leg.meta;
  const unavailable = (why) => ({ ok: false, error: `jump-unavailable: ${why}`, reason: "jump-unavailable" });
  if (!meta || meta.navType !== "jmp") return unavailable("leg carries no jump meta");
  if (!host || typeof host.Jump !== "function" || typeof host.SetMovementInput !== "function") {
    return unavailable("SessionHandle jump/setMovementInput not present (stale pkg/ build)");
  }

  const headingDeg = Number(meta.headingDeg) || 0;
  const headingRad = (((headingDeg % 360) + 360) % 360) * (Math.PI / 180);
  const runFlag = !meta.holdShift; // holdShift(True) -> Shift-held -> WALK (run:false)
  const delayMs = Math.max(0, Number(meta.delayMs) || 0);
  const approachMs = Math.min(tune.jumpApproachMaxMs, Math.max(tune.jumpApproachMinMs, delayMs));
  const power = Math.min(1, Math.max(tune.jumpPowerMin, delayMs / 1000));

  const canJumpNow = () => {
    try {
      return typeof host.CanJumpNow === "function" ? !!host.CanJumpNow() : true;
    } catch (_) {
      return true;
    }
  };

  // 1. Face the recorded heading. TurnToHeading is rate-limited (webhost.js /
  //    the .d.ts docblock), so poll + reissue rather than a single call.
  const turnDeadline = Date.now() + tune.jumpTurnTimeoutMs;
  for (;;) {
    const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
    if (!pose || pose.heading == null) break; // no facing telemetry -> best-effort, never hang here
    let err = headingRad - pose.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) <= tune.jumpHeadingToleranceRad) break;
    if (typeof host.TurnToHeading === "function") host.TurnToHeading(headingRad);
    if (Date.now() >= turnDeadline) break; // don't block the jump on a stuck turn
    await new Promise((r) => setTimeout(r, tune.posePollMs));
  }

  // 2. Gate, build launch velocity, fire.
  if (!canJumpNow()) return unavailable("canJumpNow() false (airborne or motion state blocks it)");
  let moving = false;
  try {
    host.SetMovementInput(1, 0, 0, runFlag);
    moving = true;
  } catch (_) {
    moving = false;
  }
  if (approachMs > 0) await new Promise((r) => setTimeout(r, approachMs));
  if (!canJumpNow()) {
    if (moving) { try { host.SetMovementInput(0, 0, 0, false); } catch (_) { /* best-effort stop */ } }
    return unavailable("canJumpNow() false after the approach hold (airborne or motion state blocks it)");
  }
  let fired = false;
  try {
    host.Jump(power);
    fired = true;
  } catch (_) {
    fired = false;
  }
  if (moving) {
    // Hold the input a beat past the fire — the wasm recv loop reads
    // current velocity when it PROCESSES the Jump command, not synchronously
    // on this call, so releasing input in the same tick risks a zeroed read.
    await new Promise((r) => setTimeout(r, tune.posePollMs));
    try { host.SetMovementInput(0, 0, 0, false); } catch (_) { /* best-effort stop */ }
  }
  if (!fired) return unavailable("Jump() call threw");

  // 3. Landing/settle: poll for re-grounding (bounded), then a conservative
  //    pause regardless (§5 — resume-on-land is documented-flaky; a bare
  //    state-flip is not trusted alone).
  const airborneDeadline = Date.now() + tune.jumpAirborneTimeoutMs;
  while (Date.now() < airborneDeadline) {
    await new Promise((r) => setTimeout(r, tune.jumpLandingPollMs));
    if (canJumpNow()) break;
  }
  const settleMs = Math.min(delayMs, tune.jumpApproachMaxMs) + tune.jumpLandingSettlePadMs;
  await new Promise((r) => setTimeout(r, settleMs));

  return { ok: true, power, headingRad, runFlag };
}

// Scan forward from a FAILED walk leg for the nearest upcoming `jmp` leg
// within a bounded window. nav_import.js's fixupSentinelLegs collapses any
// cht/pau sentinel legs immediately BEFORE a jmp record onto that record's
// OWN coordinate (see nav_import.js header) — so the walk that actually times
// out approaching a jump gap can fail several legs before the real
// `jmp`-tagged one, not on the jmp leg itself. Live-verified against the
// vr-bridge-jump corpus fixture's OWN compiled leg list (routes-json): the
// first of its 14 jump attempts is preceded by chk/cht(x2)/cht-sentinel/chk/
// pau BEFORE the jmp record — a 5-leg gap from the failing walk leg (index 1)
// to the jmp leg (index 6); every later attempt's own gap is only 3
// (chk->cht->pau->jmp). The window is generous but still small, bounded, and
// forward-only, so a genuine unrelated wall failure elsewhere in a route
// (zero jmp legs nearby) never misfires this path (zero behavior change for
// jmp-less routes).
const JUMP_LEG_SEARCH_WINDOW = 12;
function findUpcomingJumpLeg(legs, fromIdx) {
  const end = Math.min(legs.length, fromIdx + JUMP_LEG_SEARCH_WINDOW);
  for (let i = fromIdx; i < end; i++) {
    const m = legs[i] && legs[i].meta;
    if (m && m.navType === "jmp") return i;
  }
  return -1;
}

/**
 * Walk OUT of whatever building/dungeon the pose is currently in (task #16
 * re-entrancy; upgraded 2026-07-23 to the bounded EGRESS RETRY LADDER — the
 * live Holtburg-tavern egress fix). A hop — the intended exit, a WRONG
 * hallway portal, whatever — can leave us parked in an EnvCell, and the
 * sidecar HTTP-400s an indoor `from`; and a bot that WALKED deep into a
 * furnished building (two doors to the tavern barkeeper) has to get back out
 * through real interior obstructions.
 *
 * Ladder, per attempt (bounded by tune.egressAttempts, default 4):
 *   1. Re-resolve the CURRENT cell/pose (a partial walk keeps its progress)
 *      and findExitPath to the nearest outdoor mouth, honoring accumulated
 *      excludeEdges. Legs use the two-stage doorway pre-approach
 *      (toLegs {doorwayApproach} — offset doorframes), frame-normalized, with
 *      the long indoor watchdog.
 *   2. Walk. Success — or a "failed" walk that nonetheless left us outdoors
 *      (the last legs straddle the door plane) — is egress complete.
 *   3. On a wedge: best-effort OPEN the nearest closed door (ACE auto-closes
 *      doors ~30s after use, so the doors the bot entered THROUGH are shut
 *      again by the time it leaves — the live two-door tavern case), and
 *      blame the stalled doorway edge (stalledEdgeFromWalk). An edge that
 *      wedges TWICE gets excluded so findExitPath re-routes to the
 *      NEXT-nearest exit — the live tavern wedge was a CellPortal edge that
 *      is a serving-window opening over the bar counter (real in the DAT,
 *      not walkable at floor level); exclusion is the only remedy there,
 *      while a first wedge on a merely-closed door must NOT detour (the
 *      repathIndoor door-before-exclusion lesson).
 *   4. A retry that would repeat the identical path with no door opened and
 *      no new exclusion is going nowhere — fail honestly instead of burning
 *      attempts.
 *
 * Returns {ok:true, alreadyOutdoors} when the pose is already outdoors;
 * {ok:true, state, attempts, legsWalked, exitCell, outdoorId} on egress;
 * honest {ok:false, error} otherwise. Pushes ONE summary entry onto `phases`
 * (labelled opts.label) when any walk ran. Never throws.
 */
async function exitToOutdoors(ctx, tune, phases, { label = "re-exit" } = {}) {
  const { host, walk, buildGraph } = ctx;
  // `currentCell` returns 0 for BOTH "genuinely outdoors" and "could not read
  // the cell" — its own comment says `0 -> outdoors` (2026-08-03 review). A
  // pose-null window (post-portal, pre-first-tick) therefore made this return
  // `{ ok: true, alreadyOutdoors: true }` while the character was still inside
  // a dungeon: the exact false success the module docblock says egress
  // eliminates. Distinguish the two before claiming victory.
  const cell0 = currentCell(host);
  if (cell0 === 0 && !poseIsReadable(host)) {
    return { ok: false, reason: "cell unreadable (pose not yet live) — cannot claim outdoors", phases };
  }
  if (!isEnvCellId(cell0)) return { ok: true, alreadyOutdoors: true };
  const maxAttempts = Math.max(1, tune.egressAttempts ?? 4);
  const excludeEdges = new Set();
  const wedgeCounts = new Map(); // canonical edgeKey -> stall count
  let legsWalkedTotal = 0;
  let lastError = null;
  let lastState = "FAILED";
  let lastSig = "";
  const pushPhase = (ok, state, attempts) => {
    if (phases) phases.push({ phase: label, ok, state, legsWalked: legsWalkedTotal, attempts });
  };
  const succeed = (state, attempt, exit) => {
    pushPhase(true, state, attempt);
    return {
      ok: true,
      state,
      attempts: attempt,
      legsWalked: legsWalkedTotal,
      ...(exit ? { exitCell: exit.exitCell, outdoorId: exit.outdoorId } : {}),
    };
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cell = currentCell(host);
    if (!isEnvCellId(cell)) return succeed("DONE", attempt - 1, null); // a prior attempt got us out
    const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
    if (!pose) return { ok: false, error: "no player pose" };
    const graph = await safeBuild(buildGraph, cell & 0xffff0000);
    const nodes = toMap(graph);
    if (nodes.size === 0) return { ok: false, error: "indoor graph unavailable" };
    const fromCell = resolveCell(nodes, cell, pose.objCellId >>> 0, pose.x, pose.y, pose.z);
    if (!fromCell) return { ok: false, error: "indoor graph unavailable" };
    const exit = buildExitLegs(graph, nodes, fromCell, pose, { excludeEdges, doorwayApproach: true });
    if (!exit) {
      // No walk ever ran -> genuinely no exit in the graph. After exclusions,
      // prefer the honest walk error (the wedge is the story, not the BFS).
      if (lastError) break;
      return { ok: false, error: "no reachable exit" };
    }
    const legs = exit.legs.map((l) => ({ ...normalizeLegWorldFrame(l), timeoutMs: tune.indoorLegTimeoutMs }));
    const walkLabel = attempt === 1 ? label : `${label}-retry${attempt}`;
    const w = await walk(legs, { label: walkLabel, stallMs: tune.indoorLegTimeoutMs + 15_000 });
    legsWalkedTotal += w.legsWalked ?? 0;
    if (w.ok) return succeed(w.state ?? "DONE", attempt, exit);
    lastError = w.error || "exit walk failed";
    lastState = w.state ?? "FAILED";
    // A "failed" final leg can still have carried us through the door plane.
    if (!isEnvCellId(currentCell(host))) return succeed(lastState, attempt, exit);
    // Remedy 1 — closed door (checked from the FRESH wedge pose: the stalled
    // walk usually parks us right against it). Best-effort; opening a door
    // never hurts egress (attemptDoorOpen skips already-open doors).
    const doorPose = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || pose;
    const dr = await attemptDoorOpen(host, doorPose);
    if (dr.opened && ctx.log) ctx.log(`${label}: opened closed door ${dr.name} — retrying (attempt ${attempt})`);
    // Remedy 2 — blame the stalled doorway edge; exclude only on the SECOND
    // wedge of the SAME edge (a first wedge may have been just the door).
    let newExclusion = false;
    const stalled = stalledEdgeFromWalk(exit.path, w.legsWalked ?? 0);
    if (stalled) {
      const n = (wedgeCounts.get(stalled) || 0) + 1;
      wedgeCounts.set(stalled, n);
      if (n >= 2 && !excludeEdges.has(stalled)) {
        excludeEdges.add(stalled);
        newExclusion = true;
        if (ctx.log) ctx.log(`${label}: doorway edge ${stalled} wedged twice — excluding, re-routing to the next exit`);
      }
    }
    // No-progress guard: identical plan, nothing opened, nothing excluded —
    // the next attempt would replay this wedge verbatim.
    const sig = `${fromCell >>> 0}:${exit.path.join(",")}`;
    if (sig === lastSig && !dr.opened && !newExclusion) break;
    lastSig = sig;
  }
  pushPhase(false, lastState, undefined);
  return { ok: false, state: lastState, error: lastError || "egress attempts exhausted", legsWalked: legsWalkedTotal };
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
 *
 * RE-ENTRANCY (task #16): a hop can land us in an EnvCell — the intended exit,
 * or a WRONG hallway portal that flung us into another dungeon (live v15: the
 * Town Network clipped a non-target portal into the academy interior 44km away).
 * After a hop, before the NEXT sidecar call, re-compose from wherever we are: if
 * we're in an EnvCell, exit to outdoors first (the sidecar 400s an indoor
 * `from`), so a wrong-portal hop becomes an expensive DETOUR, not a terminal
 * failure. Each re-exit counts against tune.maxTransits so a portal ping-pong
 * can't loop forever; on exhaustion we fail honestly with the current location.
 * The FIRST sidecar call is never re-entrancy-checked — the caller only enters
 * here from outdoors (case 0, or Phase A already walked us out), so the
 * pure-outdoor / normal-transit paths stay byte-identical.
 */
async function outdoorWithAssist(ctx, to, opts, tune, phases) {
  let transits = 0;
  const budgetFail = (why) => ({
    ok: false,
    state: "FAILED",
    error: `portal transit failed: ${why} at ${cellHex(currentCell(ctx.host))}`,
    composed: true,
    ...(phases ? { phases } : {}),
  });
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
    // Post-hop re-entrancy: the hop may have landed us indoors (the intended
    // exit, or a WRONG portal into another dungeon). Walk out before the next
    // sidecar call. Bounded by the transit budget (a ping-pong can't loop).
    while (isEnvCellId(currentCell(ctx.host))) {
      if (transits >= tune.maxTransits) return budgetFail("transit budget exhausted, stranded indoors");
      const ex = await exitToOutdoors(ctx, tune, phases);
      transits += 1;
      if (ctx.log) ctx.log(ex.ok ? "re-exit to outdoors — re-composing" : `re-exit failed: ${ex.error}`);
      // A failed exit that is STILL indoors is terminal (re-planning an indoor
      // `from` just 400s); an exit that hopped us back outdoors falls through.
      if (!ex.ok && isEnvCellId(currentCell(ctx.host))) return budgetFail(`re-exit ${ex.error}`);
    }
    // outdoors now — loop and re-plan the outdoor route from the new pose.
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
    // Desperate-touch discovery radius after a wedged indoor walk.
    portalDesperateRangeM: opts.portalDesperateRangeM ?? 25,
    // Bounded egress retry ladder (exitToOutdoors, 2026-07-23 tavern fix).
    egressAttempts: opts.egressAttempts ?? 4,
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

    // Otherwise (goal outdoors, or a DIFFERENT dungeon): exit the building via
    // the bounded egress ladder (exitToOutdoors — doorway pre-approach legs,
    // closed-door opening, twice-wedged edge exclusion; 2026-07-23 tavern fix).
    // The ladder re-resolves cell/graph itself, so the graph built above for
    // the Case-2 check is simply the first (cached-by-wasm) build.
    const ex = await exitToOutdoors(ctx, tune, phases, { label: "exit" });
    legsWalked += ex.legsWalked ?? 0;
    if (!ex.ok) {
      return {
        ok: false,
        state: ex.state ?? "FAILED",
        error: ex.error || "exit walk failed",
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

/**
 * Standalone building/dungeon EGRESS (2026-07-23, live Holtburg-tavern fix):
 * the awaited "walk OUT to the nearest outdoor mouth" primitive, runnable
 * WITHOUT the nav sidecar (indoor-only — no outdoorGoto needed, unlike
 * composeGoto). This is what bot.egress() / the exit_building action drive:
 * the full multi-door route to the mouth via exitToOutdoors' bounded retry
 * ladder (doorway pre-approach legs, closed-door opening, twice-wedged edge
 * exclusion re-routing to the next-nearest exit), with an HONEST awaited
 * result — the predecessor (exitRoute + fire-and-forget bot.travel) reported
 * ok the moment the router ACCEPTED the legs, wedged on the bar counter, and
 * looped ("PLAN-DONE exit_building but I only shifted 2m").
 *
 * `deps`: { host, router, buildGraph?, walk?, fetchEnvCells?, log? } — same
 * seams as composeGoto/replayRoute. `opts`: the shared tune knobs
 * (egressAttempts, indoorLegTimeoutMs, ...) plus label (default "egress").
 * Resolves { ok, state?, attempts?, legsWalked, exitCell?, outdoorId?,
 * alreadyOutdoors?, composed:true, phases:[...] , error? }; never rejects.
 */
export async function composeEgress(deps, opts = {}) {
  const { host, router } = deps;
  const log = deps.log || (() => {});
  const pollMs = opts.pollMs ?? 500;
  const stallMs = opts.stallMs ?? 45_000;
  const buildGraph =
    deps.buildGraph ||
    ((lb) => buildStitchedGraphFromWasm([lb], deps.fetchEnvCells ? { fetchEnvCells: deps.fetchEnvCells } : {}));
  const walk = deps.walk || ((legs, wopts = {}) => walkLegs(router, legs, { pollMs, stallMs, log, ...wopts }));
  const ctx = { host, router, walk, buildGraph, log };
  // Building egress legs are metres long (cell-to-cell inside one structure),
  // not Town-Network transit strides — default the per-leg watchdog to 60s
  // (vs buildTune's 240s replay default) so a hopeless wedge fails a whole
  // 4-attempt ladder in minutes, not tens of minutes. Callers can still
  // override via opts.indoorLegTimeoutMs.
  const tune = buildTune({ ...opts, indoorLegTimeoutMs: opts.indoorLegTimeoutMs ?? 60_000 }, router);
  const phases = [];
  try {
    const r = await exitToOutdoors(ctx, tune, phases, { label: opts.label ?? "egress" });
    return { legsWalked: 0, ...r, state: r.state ?? (r.ok ? "DONE" : "FAILED"), composed: true, phases };
  } catch (e) {
    // exitToOutdoors never throws by contract; this guard keeps the promise
    // airtight against hostile injected deps (same belt as composeGoto).
    return { ok: false, state: "FAILED", error: String((e && e.message) || e), legsWalked: 0, composed: true, phases };
  }
}

// ── replay contract v2 (task #17) ───────────────────────────────────────────
// deriveRouteFlags itself now lives in route_flags.js (imported above) —
// shared with nav_import.js. Only the replay-side consumers stay here.

// Portal-transit tuning shared by composeGoto's transit and the replayer.
function buildTune(opts = {}, router = null) {
  const pollMs = opts.pollMs ?? 500;
  return {
    poseTimeoutMs: opts.poseTimeoutMs ?? 15_000,
    posePollMs: Math.min(pollMs, 250),
    portalRangeM: opts.portalRangeM ?? 10,
    portalTeleportMs: opts.portalTeleportMs ?? 12_000,
    teleportPollMs: Math.min(pollMs, 500),
    portalJumpM: opts.portalJumpM ?? router?.seamJumpM ?? PORTAL_JUMP_M,
    maxTransits: opts.portalTransits ?? 3,
    indoorLegTimeoutMs: opts.indoorLegTimeoutMs ?? REPLAY_INDOOR_LEG_TIMEOUT_MS,
    portalDesperateRangeM: opts.portalDesperateRangeM ?? 25,
    recallTeleportMs: opts.recallTeleportMs ?? RECALL_TELEPORT_MS,
    // Bounded indoor-wedge repath retry ladder (2026-07-20, live MatronHive
    // report #3: the one-shot repath found a real path, walked 2 of 3 legs,
    // then stalled on the 3rd and gave up entirely). See repathIndoor below.
    wedgeAttempts: opts.wedgeAttempts ?? 3,
    // Bounded egress retry ladder (exitToOutdoors, 2026-07-23 tavern fix).
    egressAttempts: opts.egressAttempts ?? 4,
    // Jump-leg tuning (2026-07-21, DESIGN-jump-primitive Phase 1). See
    // attemptJumpLeg's docblock for the field-mapping rationale.
    jumpHeadingToleranceRad: opts.jumpHeadingToleranceRad ?? 0.12, // ~6.9 deg
    jumpTurnTimeoutMs: opts.jumpTurnTimeoutMs ?? 6_000,
    jumpApproachMinMs: opts.jumpApproachMinMs ?? 200,
    jumpApproachMaxMs: opts.jumpApproachMaxMs ?? 1_500,
    jumpPowerMin: opts.jumpPowerMin ?? 0.05,
    jumpAirborneTimeoutMs: opts.jumpAirborneTimeoutMs ?? 6_000,
    jumpLandingPollMs: opts.jumpLandingPollMs ?? 200,
    jumpLandingSettlePadMs: opts.jumpLandingSettlePadMs ?? 3_000,
    // Bound on jump attempts per replayRoute() call — generous vs. the
    // corpus's own max (14 attempts at one gap in vr-bridge-jump).
    maxJumpAttempts: opts.jumpAttempts ?? 20,
  };
}

/**
 * Flag + prepare a recorded route for the replay walker: derive v2 flags, then
 * for INDOOR legs re-bucket to the canonical outdoor-format frame
 * (normalizeLegWorldFrame — the recorded native EnvCell frames carry negative
 * locals) and stamp the long indoor watchdog. Outdoor/portal-departure legs are
 * left as recorded. Returns a NEW leg array.
 */
export function prepareReplayLegs(legs, opts = {}) {
  const timeoutMs = opts.indoorLegTimeoutMs ?? REPLAY_INDOOR_LEG_TIMEOUT_MS;
  return deriveRouteFlags(legs, opts.fmt).map((l) =>
    l.indoor ? { ...normalizeLegWorldFrame(l), timeoutMs, indoor: true, ...(l.portal ? { portal: true } : {}) } : l
  );
}

/** True when a (prepared) route contains any portal-departure leg. */
export function routeHasPortals(legs) {
  return Array.isArray(legs) && legs.some((l) => l.portal === true);
}

/** True when a (prepared) route contains any jmp leg (nav_import.js
 *  meta.navType==='jmp') — bot.js's doFollowRoute uses this alongside
 *  routeHasPortals to decide whether a route needs replayRoute's recovery
 *  branches (jmp legs are plain waypoints, never flagged .portal). */
export function routeHasJumps(legs) {
  return Array.isArray(legs) && legs.some((l) => l.meta && l.meta.navType === "jmp");
}

// ── closed-door detection for recovery walks (gap 3, HANDOFF-metanav-
// 2026-07-20 "Door-state in navigation") ────────────────────────────────────
// The MAIN goto/route path (rynth/ai/tools/world.js walkRoute) already opens
// a nearby closed door on a retryable follow outcome (handoff-6 §3.3): ACE
// doors flip PhysicsState.Ethereal (0x4) when OPEN and clear it when closed,
// so "closed door" is client-detectable via TryGetObjectDescFlags' Door bit
// + TryGetObjectState. repathIndoor's bounded-retry recovery walk (below) had
// NO such check — a closed door sitting on the recovery path just stalled the
// walk like any other wedge, and the doorway edge it stalled on got excluded
// (findPath would then detour AROUND a door that only needed opening, or
// exhaust the graph and give up if there was no detour — the frozen-tomb
// corpus route's leg-47 timeout). Same ODF/PhysicsState bits and technique as
// ai/tools/world.js's nearestClosedDoor, ported here (goto_compose sits below
// ai/, so this is a local port, not an import) and threaded into the retry
// ladder BEFORE edge exclusion.
const ODF_DOOR = 0x1000; // ObjectDescriptionFlag.Door (observe_ext.js ODF map)
const PHYS_ETHEREAL = 0x4; // PhysicsState.Ethereal — set while a door stands open
const DOOR_RETRY_RANGE_M = 10;
const DOOR_SWING_SETTLE_MS = 1500; // door swing + physics flip before re-walking

// Nearest CLOSED door within DOOR_RETRY_RANGE_M of `pose`. Returns
// {guid,name,d} | null. Never throws.
function nearestClosedDoor(host, pose) {
  if (!host || typeof host.NearbyGuids !== "function" || typeof host.TryGetObjectDescFlags !== "function") return null;
  if (!pose) return null;
  const px = worldX(pose.objCellId >>> 0, pose.x);
  const py = worldY(pose.objCellId >>> 0, pose.y);
  let guids;
  try {
    guids = host.NearbyGuids() || [];
  } catch (_) {
    return null;
  }
  let best = null;
  for (const g of guids) {
    try {
      const flags = host.TryGetObjectDescFlags(g);
      if (flags == null || !(flags & ODF_DOOR)) continue;
      const st = host.TryGetObjectState ? host.TryGetObjectState(g) : 0;
      if (st & PHYS_ETHEREAL) continue; // already open — using it would CLOSE it
      const p = host.TryGetObjectPosition ? host.TryGetObjectPosition(g) : null;
      if (!p) continue;
      const dx = worldX(p.objCellId >>> 0, p.x) - px;
      const dy = worldY(p.objCellId >>> 0, p.y) - py;
      const dz = (p.z || 0) - (pose.z || 0);
      const d = Math.hypot(dx, dy, dz);
      if (d <= DOOR_RETRY_RANGE_M && (!best || d < best.d)) {
        let name = "Door";
        try {
          name = (host.TryGetObjectName && host.TryGetObjectName(g)) || "Door";
        } catch (_) {
          /* keep default */
        }
        best = { guid: g >>> 0, name, d };
      }
    } catch (_) {
      /* skip a hostile/partial record */
    }
  }
  return best;
}

// Open the nearest closed door within reach (if any) and wait out the swing.
// Returns {opened:true,name} | {opened:false}. Never throws.
async function attemptDoorOpen(host, pose) {
  const door = nearestClosedDoor(host, pose);
  if (!door || typeof host.UseObject !== "function") return { opened: false };
  try {
    if (!host.UseObject(door.guid)) return { opened: false };
  } catch (_) {
    return { opened: false };
  }
  await new Promise((r) => setTimeout(r, DOOR_SWING_SETTLE_MS));
  return { opened: true, name: door.name };
}

// doorwayApproach emits exactly 2 legs (30% pre-approach, 50% doorway
// midpoint) per path EDGE, then one trailing "last cell centre" leg
// (indoor_router.js toLegs {doorwayApproach} docblock). Map a walk's
// legsWalked count back to the specific edge it stalled ON, so the next
// findPath attempt can exclude exactly that doorway rather than guessing.
// Returns null when the stall was on the trailing centre/goal leg (not a
// mid-path edge — nothing to exclude there; see repathIndoor below).
const DOORWAY_LEGS_PER_EDGE = 2;
function stalledEdgeFromWalk(path, legsWalked) {
  const approachLegCount = DOORWAY_LEGS_PER_EDGE * (path.length - 1);
  if (!(legsWalked >= 0) || legsWalked >= approachLegCount) return null;
  const edgeIdx = Math.floor(legsWalked / DOORWAY_LEGS_PER_EDGE);
  if (edgeIdx < 0 || edgeIdx >= path.length - 1) return null;
  return edgeKey(path[edgeIdx] >>> 0, path[edgeIdx + 1] >>> 0);
}

// Graph re-path to `target`'s cell from the current (wedged) indoor pose,
// walked via the doorway pre-approach. BOUNDED-RETRY (up to
// tune.wedgeAttempts, default 3) instead of one shot (2026-07-20, live
// MatronHive report #3): the prior one-shot version found a real 3-leg path,
// walked 2 legs, stalled on the 3rd, and gave up outright with no way to
// distinguish "the graph genuinely doesn't connect" from "this walk attempt
// hit a fixable transient" (an offset doorway jamb, a momentarily-blocked
// path). Each retry:
//   - re-resolves the CURRENT cell/pose (a partial walk may have moved us),
//   - excludes any doorway edge a PRIOR attempt's walk stalled inside (via
//     findPath's opts.excludeEdges — the char may have made real progress
//     toward the goal even though the overall walk failed, so re-planning
//     from where we actually are, around the jammed edge, is strictly better
//     than repeating the identical walk),
//   - ends with the EXACT requested target coordinate (goalLeg-style, like
//     composeGoto's case2/case3), not just the nearest cell's bbox-derived
//     centre — a raw centre can sit inside static-object clutter (live: the
//     Town Network room at the far side of the stall is densely furnished;
//     walking to its geometric bbox centre rather than the actual requested
//     point is an avoidable source of exactly this kind of wedge).
// If excludeEdges makes the goal genuinely unreachable (findPath returns
// null), we stop retrying immediately rather than burn the remaining
// attempts — that's the "graph doesn't connect" case, not a "walk stalled"
// case, and no further exclusion will change the answer.
async function repathIndoor(ctx, tune, target) {
  const { host, buildGraph, walk, log } = ctx;
  const maxAttempts = Math.max(1, tune.wedgeAttempts ?? 3);
  const excludeEdges = new Set();
  let lastError = "indoor re-path: not indoors";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const cell = currentCell(host);
    if (!isEnvCellId(cell)) return { ok: false, error: lastError };
    const graph = await safeBuild(buildGraph, (cell & 0xffff0000) >>> 0);
    const nodes = toMap(graph);
    if (nodes.size === 0) return { ok: false, error: "indoor re-path: graph unavailable" };
    const pose = await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs);
    if (!pose) return { ok: false, error: "indoor re-path: no player pose" };
    const fromCell = resolveCell(nodes, cell, pose.objCellId >>> 0, pose.x, pose.y, pose.z);
    const toCell = resolveCell(nodes, target.lb >>> 0, target.lb >>> 0, target.x, target.y, target.z);
    if (!fromCell || !toCell) return { ok: false, error: "indoor re-path: cell not in graph" };
    if ((fromCell >>> 0) === (toCell >>> 0)) return { ok: true }; // already in the target cell
    const path = findPath(graph, fromCell, toCell >>> 0, { excludeEdges });
    if (!path) {
      // Unreachable even after excluding every edge a prior attempt wedged
      // on: a genuine disconnect, not a fixable stall. Stop early.
      return { ok: false, error: excludeEdges.size ? "indoor re-path: unreachable (all recovery edges exhausted)" : "indoor re-path: unreachable" };
    }
    const rlegs = toLegs(graph, path, { doorwayApproach: true }).map((l) => ({
      ...normalizeLegWorldFrame(l),
      timeoutMs: tune.indoorLegTimeoutMs,
    }));
    // Nail the EXACT requested target instead of stopping at the last cell's
    // bbox-derived centre (see header note above).
    rlegs.push(normalizeLegWorldFrame({ lb: toCell >>> 0, x: target.x, y: target.y, z: target.z }));
    const label = attempt === 1 ? "wedge-repath" : `wedge-repath-retry${attempt}`;
    const w = await walk(rlegs, { label, stallMs: tune.indoorLegTimeoutMs + 15_000 });
    if (w.ok) return { ok: true };
    lastError = `indoor re-path ${(w.state || "failed").toLowerCase()}`;
    // Closed-door check BEFORE edge exclusion: a door standing shut on this
    // path stalls the walk exactly like a jammed doorway, but excluding the
    // edge would make findPath detour around (or, with no detour available,
    // give up on) a route that only needed the door opened. Re-resolve the
    // pose fresh — the stalled walk may have moved us right up to the door.
    const doorPose = (await awaitPose(host, tune.poseTimeoutMs, tune.posePollMs)) || null;
    const dr = await attemptDoorOpen(host, doorPose);
    if (dr.opened) {
      lastError = `indoor re-path door(${dr.name}) opened — retrying`;
      if (log) log(`repathIndoor: opened closed door ${dr.name} — retrying attempt ${attempt}`);
      continue; // same excludeEdges (no edge blamed), consumes one attempt slot
    }
    const stalled = stalledEdgeFromWalk(path, w.legsWalked ?? 0);
    if (stalled) excludeEdges.add(stalled);
  }
  return { ok: false, error: lastError };
}

/**
 * Portal-aware route replay (task #17). Feeds the router ONE contiguous flagged
 * leg list and lets it own the walk: the router's native portal-hold recognizes
 * a walk-in hop and _resumeAfterPortal picks up on the far side, so most portal
 * legs need no help here. We only intervene on a terminal FAILED:
 *   - portalBlocked (arrived at a portal but no hop in the contact window): the
 *     compose touch assist USEs the portal we're standing on, then we resume the
 *     REMAINING legs from the far side (bounded by tune.maxTransits).
 *   - an indoor-leg wedge: one graph re-path to that waypoint, then resume.
 * Deps: { host, router, buildGraph?, walk?, fetchEnvCells?, log? }. Resolves
 * { ok, state, legsWalked, ... }; never throws. (Segmenting is implicit — the
 * router owns the contiguous list; explicit segment lists would duplicate its
 * _resumeAfterPortal nearest-leg logic.)
 */
export async function replayRoute(deps, legs, opts = {}) {
  const { host, router } = deps;
  const log = deps.log || (() => {});
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const buildGraph =
    deps.buildGraph ||
    ((lb) => buildStitchedGraphFromWasm([lb], deps.fetchEnvCells ? { fetchEnvCells: deps.fetchEnvCells } : {}));
  const walk = deps.walk || ((wl, wopts = {}) => walkLegs(router, wl, { pollMs, stallMs: 45_000, log, ...wopts }));
  const ctx = { host, router, buildGraph, walk, log };
  const tune = buildTune(opts, router);

  let base = 0; // index of the current sub-follow's first leg within `legs`
  let walkedTotal = 0;
  let touches = 0;
  let wedges = 0;
  let jumps = 0;
  const t0 = Date.now();
  router.follow(legs.slice(base));
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const st = router.status;
    if (st.state === "DONE") return { ok: true, state: "DONE", legsWalked: walkedTotal + (st.walked ?? st.legs) };
    if (st.state === "IDLE") return { ok: false, state: "CANCELLED", legsWalked: walkedTotal + (st.walked ?? 0) };
    if (Date.now() - t0 > timeoutMs) {
      router.cancel();
      return { ok: false, state: "TIMEOUT", legsWalked: walkedTotal + (router.status.walked ?? 0) };
    }
    if (st.state !== "FAILED") continue; // WALK/PORTAL: the router owns the hop + resume

    const failIdx = base + st.leg;
    walkedTotal += st.walked ?? 0;
    const failed = legs[failIdx];
    const failedMeta = failed && failed.meta;

    // Stalled walk approaching (or immediately preceding, per
    // fixupSentinelLegs' coordinate collapse) a `jmp` leg -> fire the jump
    // primitive instead of retrying the walk, then resume past it. Checked
    // before the portalBlocked/indoor-wedge branches: a jmp leg is never a
    // portal leg, and this is a distinct recovery class from both.
    if (!st.portalBlocked && jumps < tune.maxJumpAttempts) {
      const jumpIdx = findUpcomingJumpLeg(legs, failIdx);
      if (jumpIdx >= 0) {
        jumps += 1;
        const jumpLeg = legs[jumpIdx];
        log(`replay: jump leg ${jumpIdx} (heading ${jumpLeg.meta.headingDeg}deg, holdShift=${!!jumpLeg.meta.holdShift}) — firing`);
        const jr = await attemptJumpLeg(ctx, jumpLeg, tune);
        if (!jr.ok) {
          return { ok: false, state: "FAILED", error: jr.error, reason: jr.reason, leg: jumpIdx, legsWalked: walkedTotal };
        }
        log(`replay: jump leg ${jumpIdx} fired (power=${jr.power.toFixed(2)})`);
        base = jumpIdx + 1;
        if (base >= legs.length) return { ok: true, state: "DONE", legsWalked: walkedTotal };
        router.follow(legs.slice(base));
        continue;
      }
    }

    // Portal leg whose walk-in hop didn't fire -> resume it, then the
    // remaining legs from the far side.
    if (st.portalBlocked && touches < tune.maxTransits) {
      touches += 1;
      // rcl (recall spell): there is no physical entity to touch at all —
      // cast the recorded spell instead of searching for one (the live
      // MatronHive report's "portal entity not found" on a recall-anchored
      // hub was always going to fail the entity search; see nav_import.js).
      if (failedMeta && failedMeta.navType === "rcl") {
        log(`replay: recall leg ${failIdx} — casting ${failedMeta.spellName || failedMeta.spellId}`);
        const tr = await attemptRecallCast(ctx, failed, tune);
        if (!tr.ok) {
          return { ok: false, state: "FAILED", error: tr.error, reason: tr.reason, leg: failIdx, legsWalked: walkedTotal };
        }
        base = failIdx + 1;
        if (base >= legs.length) return { ok: true, state: "DONE", legsWalked: walkedTotal };
        router.follow(legs.slice(base));
        continue;
      }
      log(`replay: portal leg ${failIdx} blocked — touch assist`);
      // A ptl leg with nav_import.js ground-truth (meta.objPos) gets the
      // name/position-aware assist; everything else (recorded atlas routes,
      // which never carry leg.meta) keeps the original nearest-any-portal
      // heuristic — zero behavior change for flag-less routes.
      const tr =
        failedMeta && failedMeta.objPos
          ? await attemptMetaPortalTouch(ctx, failed, tune)
          : await attemptOutdoorPortalTouch(ctx, tune);
      if (!tr.ok) {
        return {
          ok: false,
          state: "FAILED",
          error: tr.error || `portal touch failed: ${tr.noPortal ? "portal entity not found" : "unknown"}`,
          leg: failIdx,
          legsWalked: walkedTotal,
        };
      }
      base = failIdx + 1;
      if (base >= legs.length) return { ok: true, state: "DONE", legsWalked: walkedTotal };
      router.follow(legs.slice(base));
      continue;
    }

    // Indoor-leg wedge -> one graph re-path to the wedged waypoint, then
    // resume. Runtime indoor check: nav-imported routes never carry
    // leg.indoor (VTank coordinates are outdoor-projected only — nav_import.js
    // IND1) even when a portal hop has actually landed the character inside a
    // dungeon, so trust the LIVE pose's cell (isEnvCellId) as well as the
    // recorded flag when deciding this is an indoor wedge worth a re-path.
    const wedgeIsIndoor = (failed && failed.indoor === true) || isEnvCellId(currentCell(host));
    if (!st.portalBlocked && failed && wedgeIsIndoor && wedges < 1) {
      wedges += 1;
      log(`replay: indoor wedge at leg ${failIdx} — one re-path`);
      const rr = await repathIndoor(ctx, tune, failed);
      if (!rr.ok) return { ok: false, state: "FAILED", error: rr.error, leg: failIdx, legsWalked: walkedTotal };
      base = failIdx + 1;
      if (base >= legs.length) return { ok: true, state: "DONE", legsWalked: walkedTotal };
      router.follow(legs.slice(base));
      continue;
    }

    return {
      ok: false,
      state: "FAILED",
      leg: failIdx,
      legsWalked: walkedTotal,
      ...(st.portalBlocked ? { portalBlocked: true } : {}),
      ...(st.stitchBlocked ? { stitchBlocked: true } : {}),
    };
  }
}

export default { composeGoto, composeEgress, walkLegs, deriveRouteFlags, prepareReplayLegs, routeHasPortals, routeHasJumps, replayRoute, attemptRecallCast };
