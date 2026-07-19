// tools/dungeon_nav.js — dungeon-navigation ADVISOR for the rynth AI
// director: the SPEC.md:19 / README.md "Roadmap" "dungeon nav helper" item,
// built as the v2 layer. PLANNING-ONLY: describeSurroundings() renders a
// compact block for the observation, suggestRoute() returns router.js-shaped
// legs as ADVICE — the "dungeon_suggest" action never moves the bot (v1
// keeps execution in rynthsuite; the director may follow up with goto_lb,
// or the integrator can feed the legs to bot.travel(), bot.js:142). All
// pathfinding is DELEGATED to rynth/indoor_router.js (findPath / toLegs /
// buildPatrolRoute / buildGraphFromWasm) — no A* reimplementation here.
//
// Graph sources, in order (first hit wins):
//   1. constructor { graph }        — static injected graph (tests)
//   2. constructor { graphSource }  — (bot) -> graph | Promise<graph> | null
//   3. bot.indoorGraph              — advisory field the wiring may maintain
//   4. per-landblock cache          — primed by any prior async resolution
//   5. buildGraphFromWasm(bot.host.s) — live wasm session (webhost.js:86
//      keeps the SessionHandle as host.s); async path only. Pass
//      { fetchEnvCells } through for headless/nullRender contexts
//      (indoor_router.js:506-510).
//
// describeSurroundings is deliberately SYNC (sources 1-4 only): the
// director's injectable observe seam is not awaited (director.js:137), so a
// wrapped observe must compose synchronously. Prime the cache for it with
// await refreshGraph(bot) — or any suggestRoute call — once per check-in.
//
// Same survival invariant as actions.js: every entry point degrades to
// {ok:false, error, reason} / an "n/a" string — nothing here ever throws
// into the director loop.

import {
  isEnvCellId,
  isDropEdge,
  nearestCell,
  findPath,
  findExitPath,
  toLegs,
  buildPatrolRoute,
  buildGraphFromWasm,
} from "../../indoor_router.js";

export const TO_MAX_CHARS = 24; // hex cell id <= 10 chars; hints <= 10
const EXITS_MAX = 8;
const UNEXPLORED_MAX = 4;
const DESCRIBE_MAX_CHARS = 700;
const NOTE_MAX_CHARS = 450; // under the 500-char note cap (SPEC §actions)

// Hint keyword -> canonical hint. Every keyword contains a non-hex letter
// (hex alphabet [0-9a-f]), so the action's single `to` param can carry
// either a cell id or a hint without ambiguity.
const HINTS = new Map(Object.entries({
  farthest: "farthest", far: "farthest", deep: "farthest", deepest: "farthest",
  unexplored: "unexplored", frontier: "unexplored", explore: "unexplored",
  patrol: "patrol", loop: "patrol",
  up: "up", exit: "up", surface: "up",
  down: "down", bottom: "down",
}));
export const HINT_NAMES = "farthest|unexplored|patrol|up|down";

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s); // llm_client.js clip shape
const hex = (id) => `0x${(id >>> 0).toString(16).padStart(8, "0")}`;

/** observe.js:13-20 shape: throw/undefined -> null. */
function safe(fn) {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch (_) {
    return null;
  }
}

// indoor_router.js:70-79 asMap semantics (private there): Map or plain
// object, keys -> u32, nodes without pos skipped. Needed for our own
// iteration (exits/hints); path queries below go through the exported fns.
function asNodeMap(graph) {
  const m = new Map();
  if (!graph || typeof graph !== "object") return m;
  const entries = graph instanceof Map ? graph.entries() : Object.entries(graph);
  for (const [k, v] of entries) {
    if (!v || !v.pos) continue;
    m.set(Number(k) >>> 0, v);
  }
  return m;
}

// World-frame metres from a full objCellId + landblock-local x/y
// (router.js:45-47 worldXY) — the frame the graph's pos already uses.
const worldX = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
const worldY = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;

function getPose(bot) {
  return safe(() => {
    const p = bot?.host?.TryGetPlayerPose?.();
    if (!p || typeof p.objCellId !== "number") return null;
    return { cell: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z };
  });
}

// Drop-free reachable set with portal-hop counts — the BFS of
// getMainRouteNodes (indoor_router.js:286-301) plus distances, which that
// export doesn't return. Selection only; routing stays findPath's job.
function bfsHops(nodes, start) {
  const hops = new Map([[start, 0]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    const node = nodes.get(cur);
    for (const nbRaw of node.neighbors || []) {
      const nb = Number(nbRaw) >>> 0;
      if (hops.has(nb) || !nodes.has(nb)) continue;
      if (isDropEdge(node, nodes.get(nb))) continue;
      hops.set(nb, hops.get(cur) + 1);
      q.push(nb);
    }
  }
  return hops;
}

// Compass label for an exit. AC world frame: +X = east, +Y = north
// (observe.js:29-31: EW from world-X, NS from world-Y). Vertical tag at the
// 0.5 m flat threshold (indoor_router.js:54 FLAT_DZ_M).
function exitLabel(cur, nb) {
  const dx = nb.pos.x - cur.pos.x;
  const dy = nb.pos.y - cur.pos.y;
  const dz = nb.pos.z - cur.pos.z;
  const vert = dz >= 0.5 ? "up" : dz <= -0.5 ? "down" : "";
  if (Math.hypot(dx, dy) < 1) return vert || "here"; // vertical shaft / same spot
  const ang = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(ang / 45) % 8];
  return vert ? `${dir} ${vert}` : dir;
}

// actions.js:56-58 landblock shape: non-negative int, or hex string with
// optional 0x prefix. -> u32 or null.
function parseCellId(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v >>> 0;
  if (typeof v === "string" && /^(0x)?[0-9a-f]{1,8}$/i.test(v.trim())) return parseInt(v.trim(), 16) >>> 0;
  return null;
}

export class DungeonNavAdvisor {
  constructor({ graph, graphSource, fetchEnvCells, log } = {}) {
    this.graph = graph ?? null;
    this.graphSource = typeof graphSource === "function" ? graphSource : null;
    this.fetchEnvCells = typeof fetchEnvCells === "function" ? fetchEnvCells : null;
    this._log = typeof log === "function" ? log : () => {};
    this._cache = null; // { lb, graph } — primed by async resolution
  }

  // Sync sources only (see header); a thenable from graphSource is ignored
  // here (its rejection swallowed) and left to the async path.
  _graphSync(bot) {
    if (this.graph) return this.graph;
    if (this.graphSource) {
      const g = safe(() => this.graphSource(bot));
      if (g && typeof g.then === "function") safe(() => g.catch(() => {}));
      else if (g) return g;
    }
    const ig = safe(() => bot?.indoorGraph);
    if (ig) return ig;
    const pose = getPose(bot);
    if (pose && this._cache && this._cache.lb === pose.cell >>> 16) return this._cache.graph;
    return null;
  }

  async _graphAsync(bot) {
    if (this.graph) return this.graph;
    if (this.graphSource) {
      let g = null;
      try { g = await this.graphSource(bot); } catch { g = null; }
      if (g) return this._remember(bot, g);
    }
    const ig = safe(() => bot?.indoorGraph);
    if (ig) return ig;
    const pose = getPose(bot);
    if (!pose || !isEnvCellId(pose.cell)) return null;
    if (this._cache && this._cache.lb === pose.cell >>> 16) return this._cache.graph;
    const handle = safe(() => bot?.host?.s ?? bot?.sessionHandle); // webhost.js:86
    if (!handle) return null;
    let g = null;
    try {
      // buildGraphFromWasm never throws by contract (indoor_router.js:489-491);
      // the guard keeps the advisor airtight against injected replacements.
      g = await buildGraphFromWasm(handle, 0, this.fetchEnvCells ? { fetchEnvCells: this.fetchEnvCells } : {});
    } catch { g = null; }
    return g ? this._remember(bot, g) : null;
  }

  _remember(bot, graph) {
    const pose = getPose(bot);
    if (pose) this._cache = { lb: pose.cell >>> 16, graph };
    return graph;
  }

  /** Prime the sync cache (call once per check-in, before the observation).
   *  Resolves the graph or null; never rejects. */
  async refreshGraph(bot) {
    try {
      return await this._graphAsync(bot);
    } catch {
      return null;
    }
  }

  // Pose cell if it is a graph node, else the nearest node in the pose's
  // world frame (same-floor preferred within 8 m Z, indoor_router.js:95-122).
  _currentCell(nodes, pose) {
    if (nodes.has(pose.cell)) return { id: pose.cell, approx: false };
    const id = nearestCell(nodes, worldX(pose.cell, pose.x), worldY(pose.cell, pose.y), pose.z);
    return id ? { id: id >>> 0, approx: true } : null;
  }

  /** Compact, line-oriented surroundings block for the observation. SYNC;
   *  always returns a string, never throws. */
  describeSurroundings(bot) {
    try {
      const pose = getPose(bot);
      if (!pose) return "dungeon-nav: no player pose";
      if (!isEnvCellId(pose.cell))
        return `dungeon-nav: outdoors (cell ${hex(pose.cell)}) — no indoor graph; use goto (outdoor) with {ns,ew} for travel`;
      const nodes = asNodeMap(this._graphSync(bot));
      if (!nodes.size)
        return `dungeon-nav: indoors (cell ${hex(pose.cell)}) but indoor graph unavailable (dungeon_suggest builds it)`;
      const cur = this._currentCell(nodes, pose);
      if (!cur) return `dungeon-nav: indoors (cell ${hex(pose.cell)}) but no graph cell near the player`;

      const curNode = nodes.get(cur.id);
      const hops = bfsHops(nodes, cur.id);
      const exits = [];
      const unknownHere = []; // portals from HERE into cells the graph lacks
      for (const nbRaw of curNode.neighbors || []) {
        const nb = Number(nbRaw) >>> 0;
        const nbNode = nodes.get(nb);
        if (!nbNode) {
          unknownHere.push(nb);
          continue;
        }
        const drop = isDropEdge(curNode, nbNode);
        exits.push(`${hex(nb)} ${exitLabel(curNode, nbNode)}${drop ? " DROP(no-jump)" : ""}`);
      }
      let frontier = 0; // reachable cells with a portal into unknown space
      for (const id of hops.keys()) {
        if ((nodes.get(id).neighbors || []).some((nb) => !nodes.has(Number(nb) >>> 0))) frontier++;
      }

      const lines = [];
      lines.push(
        `dungeon: cell=${hex(cur.id)}${cur.approx ? " (nearest known)" : ""} cells=${nodes.size} reachable=${hops.size}`
      );
      lines.push(
        exits.length
          ? `exits: ${exits.slice(0, EXITS_MAX).join(" | ")}${exits.length > EXITS_MAX ? ` (+${exits.length - EXITS_MAX} more)` : ""}`
          : "exits: none known"
      );
      if (unknownHere.length)
        lines.push(
          `unexplored portals here: ${unknownHere.slice(0, UNEXPLORED_MAX).map(hex).join(", ")}${unknownHere.length > UNEXPLORED_MAX ? ` (+${unknownHere.length - UNEXPLORED_MAX} more)` : ""}`
        );
      if (frontier)
        lines.push(`unexplored frontier: ${frontier} reachable cell(s) with unknown portals (dungeon_suggest {to:"unexplored"})`);
      return clip(lines.join("\n"), DESCRIBE_MAX_CHARS);
    } catch (e) {
      return `dungeon-nav: n/a (${safe(() => e.message) || "error"})`;
    }
  }

  /**
   * Route SUGGESTION (never executed here). Async — the live graph build is
   * async; resolves, never rejects:
   *   { ok:true, to, legs, reason }   legs = indoor_router toLegs output
   *   { ok:false, error, reason }     error in {no-pose, outdoors, no-graph,
   *                                   no-target, bad-target, unreachable,
   *                                   no-frontier, internal}
   * Target: { toCellId } (full hex/number id, or a bare low word promoted
   * into the current dungeon's landblock) or { toHint } (HINT_NAMES).
   * toCellId wins when both are passed.
   */
  async suggestRoute(bot, { toCellId, toHint } = {}) {
    try {
      const pose = getPose(bot);
      if (!pose) return no("no-pose", "no player pose — cannot anchor a dungeon route");
      if (!isEnvCellId(pose.cell))
        return no("outdoors", `outdoors (cell ${hex(pose.cell)}) — dungeon navigation n/a; use goto (outdoor) with {ns,ew} /loc degrees`);
      const graph = await this._graphAsync(bot);
      const nodes = asNodeMap(graph);
      if (!nodes.size) return no("no-graph", "indoor graph unavailable (no injected graph and no live wasm session)");
      const cur = this._currentCell(nodes, pose);
      if (!cur) return no("no-graph", "no graph cell near the player");
      if (toCellId == null && toHint == null)
        return no("no-target", `no target — pass toCellId (cell hex) or toHint (${HINT_NAMES})`);
      if (toCellId != null) return suggestCell(graph, nodes, cur.id, toCellId);
      return suggestHint(graph, nodes, cur.id, String(toHint));
    } catch (e) {
      return no("internal", `dungeon-nav error: ${safe(() => e.message) || e}`);
    }
  }

  /**
   * EXECUTABLE exit route (exit_building action): path from the player's
   * cell to the nearest cell holding an outdoor exit portal, plus a final
   * leg at the outdoor LandCell's center — the "just outside the door"
   * target that carries the walk THROUGH the portal plane. Same resolve
   * contract as suggestRoute; never rejects.
   */
  async exitRoute(bot) {
    try {
      const pose = getPose(bot);
      if (!pose) return no("no-pose", "no player pose — cannot anchor an exit route");
      if (!isEnvCellId(pose.cell))
        return no("outdoors", `already outdoors (cell ${hex(pose.cell)}) — exit_building n/a; use goto`);
      const graph = await this._graphAsync(bot);
      const nodes = asNodeMap(graph);
      if (!nodes.size) return no("no-graph", "indoor graph unavailable (no live wasm session)");
      const cur = this._currentCell(nodes, pose);
      if (!cur) return no("no-graph", "no graph cell near the player");
      const exit = findExitPath(graph, cur.id);
      if (!exit)
        return no("unreachable", "no outdoor exit reachable from here (no exit portals in the walkable graph)");
      const legs = toLegs(graph, exit.path, { midpoints: true });
      const exitNode = nodes.get(exit.exitCell);
      let outdoorId, ox, oy;
      if (exit.outdoorId != null) {
        // Direct outdoor LandCell id: walk to its center. Retail cell index
        // decode (LandDefs::gid_to_lcoord, acclient.c:209521): idx-1 = cx*8+cy,
        // 24-unit cells.
        outdoorId = exit.outdoorId >>> 0;
        const idx = (outdoorId & 0xffff) - 1;
        ox = ((idx >> 3) & 7) * 24 + 12;
        oy = (idx & 7) * 24 + 12;
      } else {
        // Retail outside-sentinel exit (other_cell_id == -1): no target cell
        // in the DAT — derive one from geometry. Project ~9 units past the
        // exit cell's center along the approach direction (previous path
        // cell -> exit cell; player -> exit when the player is already in
        // the exit cell), then bin the projected point into its outdoor
        // LandCell (world/192 -> landblock byte, %192/24 -> cell, idx =
        // cx*8+cy+1 — gid_to_lcoord inverted).
        const prevId = exit.path.length > 1 ? exit.path[exit.path.length - 2] : null;
        const from = prevId != null ? nodes.get(prevId)?.pos : null;
        const base = exitNode.pos;
        let dx = base.x - (from ? from.x : pose.x);
        let dy = base.y - (from ? from.y : pose.y);
        const len = Math.hypot(dx, dy);
        if (len > 0.01) { dx /= len; dy /= len; } else { dx = 0; dy = 1; }
        const wx = base.x + dx * 9;
        const wy = base.y + dy * 9;
        const lbx = Math.floor(wx / 192), lby = Math.floor(wy / 192);
        const cx = Math.floor((wx - lbx * 192) / 24), cy = Math.floor((wy - lby * 192) / 24);
        outdoorId = (((lbx & 0xff) << 24) | ((lby & 0xff) << 16) | (cx * 8 + cy + 1)) >>> 0;
        ox = wx - lbx * 192;
        oy = wy - lby * 192;
      }
      legs.push({
        lb: outdoorId,
        x: ox,
        y: oy,
        z: exitNode?.pos.z ?? pose.z,
      });
      return {
        ok: true,
        legs,
        exitCell: exit.exitCell,
        outdoorId,
        reason: `${exit.path.length} cell(s) to exit ${hex(exit.exitCell)}, then outdoors at ${hex(outdoorId)}`,
      };
    } catch (e) {
      return no("internal", `exit-route error: ${safe(() => e.message) || e}`);
    }
  }
}

const no = (error, reason) => ({ ok: false, error, reason });

function suggestCell(graph, nodes, from, toCellId) {
  let to = parseCellId(toCellId);
  if (to == null)
    return no("bad-target", `bad target ${JSON.stringify(toCellId)} — pass a cell id (hex) or a hint (${HINT_NAMES})`);
  if (!nodes.has(to) && to <= 0xffff) {
    // Bare low word: promote into the current dungeon's landblock.
    const promoted = (((from & 0xffff0000) >>> 0) | to) >>> 0;
    if (nodes.has(promoted)) to = promoted;
  }
  if (!nodes.has(to))
    return no("bad-target", `target cell ${hex(to)} is not in the indoor graph (${nodes.size} known cells)`);
  const path = findPath(graph, from, to);
  if (!path)
    return no("unreachable", `no drop-free path ${hex(from)} -> ${hex(to)} (drops need a jump the bot lacks — indoor_router.js:34-37; drop-gated or disconnected)`);
  return { ok: true, to, legs: toLegs(graph, path), reason: `path of ${path.length} cell(s) ${hex(from)} -> ${hex(to)}` };
}

function suggestHint(graph, nodes, from, rawHint) {
  const hint = HINTS.get(rawHint.trim().toLowerCase());
  if (!hint) return no("bad-target", `unknown hint ${JSON.stringify(rawHint)} — try ${HINT_NAMES} or a cell id`);

  if (hint === "patrol") {
    const walk = buildPatrolRoute(graph, from);
    if (!walk.length) return no("unreachable", "no patrol loop — no walkable corridors from here");
    const end = walk[walk.length - 1] >>> 0;
    return {
      ok: true,
      to: end,
      legs: toLegs(graph, walk),
      reason: `closed patrol walk: ${walk.length} cell visits over the main route (ends at ${hex(end)})`,
    };
  }

  // Deterministic target pick over the drop-free reachable set: primary
  // criterion per hint, ties broken by smaller cell id.
  const hops = bfsHops(nodes, from);
  let target = null;
  let why = "";
  if (hint === "farthest") {
    let bestH = -1;
    for (const [id, h] of hops) if (h > bestH || (h === bestH && id < target)) { bestH = h; target = id; }
    why = `farthest reachable cell (${bestH} portal hop(s))`;
  } else if (hint === "unexplored") {
    let bestH = Infinity;
    for (const [id, h] of hops) {
      if (!(nodes.get(id).neighbors || []).some((nb) => !nodes.has(Number(nb) >>> 0))) continue;
      if (h < bestH || (h === bestH && id < target)) { bestH = h; target = id; }
    }
    if (target == null) return no("no-frontier", "no unexplored exits — every portal in the graph leads to a known cell");
    why = `nearest cell with an unexplored portal (${bestH} hop(s) away)`;
  } else {
    // up | down — highest/lowest reachable cell (surface exits trend high).
    let bestZ = hint === "up" ? -Infinity : Infinity;
    for (const id of hops.keys()) {
      const z = nodes.get(id).pos.z;
      const better = hint === "up" ? z > bestZ : z < bestZ;
      if (better || (z === bestZ && id < target)) { bestZ = z; target = id; }
    }
    why = `${hint === "up" ? "highest" : "lowest"} reachable cell (z=${bestZ.toFixed(1)})`;
  }
  if (target == null) return no("unreachable", "nothing reachable from here");
  const path = findPath(graph, from, target);
  if (!path) return no("unreachable", `no drop-free path to ${hex(target)}`);
  return {
    ok: true,
    to: target,
    legs: toLegs(graph, path),
    reason: `${why}: ${hex(target)}${target === from ? " — already there" : ""}`,
  };
}

// Compact journal note so the NEXT observation's journal tail carries the
// advice back to the LLM (same trick as tools/knowledge.js:159-163 — the
// director's own "result" line is only `dungeon_suggest:ok`, director.js:194).
function noteText(result) {
  const parts = [`dungeon_suggest: ${result.surroundings.split("\n").slice(0, 2).join(" ; ")}`];
  const s = result.suggestion;
  if (s) {
    const last = s.ok && Array.isArray(s.legs) && s.legs.length ? s.legs[s.legs.length - 1] : null;
    parts.push(
      last
        ? `route: ${s.reason}; ${s.legs.length} leg(s), dest lb=${hex(last.lb)} xyz=(${last.x.toFixed(1)},${last.y.toFixed(1)},${last.z.toFixed(1)})`
        : `route: ${s.reason}`
    );
  }
  return parts.join(" | ");
}

/**
 * The "dungeon_suggest" action definition for a future actions registry —
 * `params`/`desc` are exactly the ACTIONS entry shape (actions.js:12-39) so
 * renderActionCatalog()'s rendering (actions.js:41-50) works unchanged;
 * `type`/`validate`/`apply` are the additive registration surface, matching
 * tools/knowledge.js:149-163 (validateAction rejects unknown types, so a
 * registered action carries its own bounds check; `apply` follows
 * executeAction's result contract + never-throws invariant,
 * actions.js:109-118).
 *
 * ADVISORY: apply never moves the bot. `to` absent -> surroundings only;
 * `to` = hint keyword or cell id -> surroundings + suggestion. The action is
 * ok:true whenever advice was produced — a negative suggestion
 * (unreachable/outdoors) rides inside result.suggestion, it is not an
 * executor failure.
 *
 * ctx: { advisor?, journal?, log? } — ctx.advisor overrides the bound one;
 * ctx.journal (AiJournal duck type) gets a "note" with the advice.
 */
export function dungeonSuggestAction(advisor) {
  const def = {
    type: "dungeon_suggest",
    params: { to: `optional — target cell (hex id) or hint ${HINT_NAMES}; omit to just scan surroundings` },
    desc: "ADVISORY dungeon-nav: surroundings + a suggested indoor route (does NOT move the bot); journaled for your next check-in",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "dungeon_suggest") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (a.to == null) return { ok: true };
      if (typeof a.to === "number") {
        if (!Number.isInteger(a.to) || a.to < 0)
          return { ok: false, error: "to must be a non-negative integer cell id, a hex string, or a hint" };
        return { ok: true };
      }
      if (typeof a.to !== "string" || !a.to.trim())
        return { ok: false, error: "to must be a non-empty string or non-negative integer" };
      if (a.to.length > TO_MAX_CHARS) return { ok: false, error: `to must be <= ${TO_MAX_CHARS} chars` };
      return { ok: true };
    },
    async apply(bot, a, ctx = {}) {
      const fail = (error) => {
        try {
          ctx.log && ctx.log(`[ai] action dungeon_suggest: ${error}`);
        } catch {}
        return { type: "dungeon_suggest", ok: false, error: String(error) };
      };
      try {
        const v = def.validate(a);
        if (!v.ok) return fail(v.error);
        const adv = ctx.advisor ?? advisor;
        if (!adv || typeof adv.describeSurroundings !== "function" || typeof adv.suggestRoute !== "function")
          return fail("unavailable");
        let surroundings;
        try {
          surroundings = String(adv.describeSurroundings(bot));
        } catch (e) {
          surroundings = `dungeon-nav: n/a (${(e && e.message) || e})`; // hostile ctx.advisor
        }
        const result = { surroundings };
        if (a.to != null) {
          const t = typeof a.to === "string" ? a.to.trim().toLowerCase() : a.to;
          let suggestion;
          try {
            suggestion = await (typeof t === "string" && HINTS.has(t)
              ? adv.suggestRoute(bot, { toHint: t })
              : adv.suggestRoute(bot, { toCellId: a.to }));
          } catch (e) {
            suggestion = no("internal", String((e && e.message) || e));
          }
          if (!suggestion || typeof suggestion !== "object") suggestion = no("internal", "advisor returned nothing");
          result.suggestion = suggestion;
        }
        try {
          ctx.journal?.add?.("note", clip(noteText(result), NOTE_MAX_CHARS));
        } catch {} // journal loss must not fail the action (journal.js contract)
        return { type: "dungeon_suggest", ok: true, result };
      } catch (e) {
        return fail((e && e.message) || e);
      }
    },
  };
  return def;
}

/**
 * Integrator seam (mirror of tools/knowledge.js:211-217): mutates a
 * PASSED-IN actions map (pass a copy of ACTIONS — ES module namespaces are
 * frozen and the real v1 module must never be rewritten), adding the
 * "dungeon_suggest" definition bound to advisor. Returns the definition.
 * Integrator-time wiring, so bad input throws loudly here instead of
 * silently no-opping in the LLM path.
 */
/**
 * "exit_building" — the EXECUTABLE counterpart of dungeon_suggest (2026-07-18):
 * live soak-13 showed an indoors bot has NO working movement primitive —
 * goto/goto_lb refuse indoor cells by design, and goto_object's straight-line
 * walk fails through walls — so a bot that wandered into a shop stranded
 * there for 35+ minutes. This action walks the indoor cell graph to the
 * nearest outdoor exit portal via bot.travel(legs) (the integrator execution
 * path the dungeon_nav docblock reserves). Grind pauses during the walk; the
 * model resumes (or goto's) on the next check-in.
 */
export function exitBuildingAction(advisor) {
  const def = {
    type: "exit_building",
    params: {},
    desc: "walk OUT of the building/dungeon you are inside (paths the indoor cell graph to the nearest outdoor exit and walks it; pauses grind — resume or goto next check-in). Indoors only; this is the ONLY reliable way outside — goto does not work indoors",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "exit_building") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      return { ok: true };
    },
    async apply(bot, a, ctx = {}) {
      const fail = (error) => {
        try { ctx.log && ctx.log(`[ai] action exit_building: ${error}`); } catch {}
        return { type: "exit_building", ok: false, error: String(error) };
      };
      try {
        const v = def.validate(a);
        if (!v.ok) return fail(v.error);
        const adv = ctx.advisor ?? advisor;
        if (!adv || typeof adv.exitRoute !== "function") return fail("unavailable");
        if (typeof bot?.travel !== "function") return fail("unavailable (bot.travel)");
        const route = await adv.exitRoute(bot);
        if (!route.ok) return fail(`${route.error}: ${route.reason}`);
        const t = bot.travel(route.legs);
        if (!t || t.ok !== true) return fail((t && t.error) || "travel refused");
        try {
          ctx.journal?.add?.("note", `exit_building: walking ${route.reason} — grind paused; confirm pos next check-in, then resume or goto`);
        } catch {}
        return { type: "exit_building", ok: true, result: { legs: route.legs.length, outdoor: `0x${route.outdoorId.toString(16).toUpperCase()}` } };
      } catch (e) {
        return fail((e && e.message) || e);
      }
    },
  };
  return def;
}

export function registerDungeonNav(actionsMap, advisor) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerDungeonNav: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const def = dungeonSuggestAction(advisor);
  actionsMap[def.type] = def;
  const exitDef = exitBuildingAction(advisor);
  actionsMap[exitDef.type] = exitDef;
  return def;
}
