// explore_memory.js — the coverage/frontier/loop core (DESIGN-surveyor-frontier-
// 2026-07-21.md WS-A). A single source of truth for "where have I been", fed the
// raw pose on every check-in AND every ExplorePressure tick. Pure JS, no wasm,
// fully unit-testable — replaces the four scattered visit-trackers the design
// doc's root-cause table lists (extensions.js loopWarning/coverageLines/
// stallLine, bot.js ExplorePressureController._visitedCells).
//
// Frozen public API (do not change signatures — extensions.js/bot.js/director.js
// program against this exact shape):
//   observe(pose)             // raw {objCellId,x,y,z} — bumps visits, updates was/is
//   get current / get previous / get here / get was
//   variation()                // revisit count of the CURRENT tile
//   frontier(opts)             // -> {worldX,worldY,dist,bearingDeg,lb} | null
//   loopVerdict()               // -> {looping,severity:0..3,reason,correction}
//   coverage()                  // -> {tiles,landblocks,thisLbTiles,sinceLbChangeMs}
//   townFrontier(towns,pose)    // -> nearest TARGETABLE unvisited town | null
//
// Pose & world frame (VALIDATION COROLLARY): canonical pose is the RAW
// {objCellId,x,y,z} (landblock-local metres, Z-up). worldX/worldY/locDegrees are
// duplicated inline here per house convention (do NOT import from observe.js).

import { TOWNS } from "./tools/towns.js";

// ── tile model ──────────────────────────────────────────────────────────────
export const TILE_M = 12; // ~one indoor cell
export const Z_BAND_M = 6; // coarse vertical band — a stacked floor is a different tile

// A call whose tile equals the previous .observe() call's tile, within this
// window, is treated as a double-poll (director check-in + pressure tick
// landing on the same real moment) and skipped — see "Dual-driver double-count"
// in the validation corollary.
export const DEDUPE_WINDOW_MS = 1500;

// loopVerdict() thresholds (tunable; overridable via constructor opts for tests).
const DEFAULT_STALL_MIN = 10; // minutes
const SEV1_VARIATION = 3;
const SEV2_VARIATION = 5;
const SEV3_VARIATION = 8;
const OSC_WINDOW = 6; // last N accepted observations checked for A<->B bounce

const DEFAULT_FRONTIER_MAX_RADIUS = 120; // tiles (~1440m) — a "sane radius"

// town catchment radius (degrees) used by townFrontier()'s "has a visited tile"
// test — coarse on purpose (townFrontier is an escalation-target picker, not a
// precise boundary check).
const TOWN_RADIUS_DEG = 0.4;

// "AT this town" radius (degrees; 1 unit ≈ 240 m). A position is only labelled
// with a town name when it is within this of the nearest town center. This is
// the load-bearing distinction for cell taxonomy (2026-07-21, operator
// briefing): AC cells come in three kinds —
//   1. OUTDOOR LandCell (objCellId low16 0x01..0xFF): 24×24 terrain, walkable.
//   2. BUILDING-INTERIOR EnvCell: an interior cell inside a town's OWN
//      landblock, so its world coords sit right on the town (≈0.4 units away).
//   3. DUNGEON / APARTMENT EnvCell: parked in the ocean regions (a vertical bar
//      in the left ocean, two horizontal bars in the south ocean, a square in
//      the interior ocean) — deliberately unreachable overland (portal-only) to
//      prevent proximity-fellowship / level-gate exploits. Its landblock coords
//      are a PARKING SLOT, not a real location, so resolving them to a surface
//      town is meaningless (this is what mislabeled the south-ocean training
//      academy as "Qalaba'r").
// Because parked env cells are always tens of units from every town while
// building interiors are ~0.4 units from theirs, a distance threshold cleanly
// separates all three. Not all dungeons are ocean-parked (some have a terrain
// mouth), but those still resolve near their real town, so this stays correct.
export const TOWN_AT_DEG = 4;

const CORRECTIONS = {
  1: "You have already been on this tile before — try something you have not tried, or move toward the Frontier below.",
  2: "You are looping (repeating tiles/actions here). Stop and head toward the Frontier now. Do NOT re-enter a visited tile or re-poke an object you have already tried.",
  3: "You are WEDGED — no real progress for a while and nothing new reachable nearby. Leave this landblock immediately and head toward the Frontier; if none is reachable, escalate to a distant unvisited town.",
};

// ── inline world-frame helpers (house convention: duplicated, not imported) ──
export function worldX(objCellId, x) {
  return ((objCellId >>> 24) & 0xff) * 192 + x;
}
export function worldY(objCellId, y) {
  return ((objCellId >>> 16) & 0xff) * 192 + y;
}
export function landblockOf(objCellId) {
  return (objCellId >>> 16) & 0xffff;
}
export function isIndoorCell(objCellId) {
  const low = objCellId & 0xffff;
  return low >= 0x0100 && low <= 0xfffd;
}
// /loc degrees — verbatim per observe.js:30-34 / VALIDATION COROLLARY. NS from
// world-Y, EW from world-X. Do not "simplify"; goto {ns,ew} feeds the sidecar's
// inverse DegToWorld.
export function locDegrees(objCellId, x, y) {
  const wx = worldX(objCellId, x);
  const wy = worldY(objCellId, y);
  return { ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10 };
}
function worldToDeg(wx, wy) {
  return { ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10 };
}

// Outdoor LandCell index (LandDefs::gid_to_lcoord) — same formula bot.js:896-904
// (_outdoorHop), dungeon_nav.js's exitRoute() and goto_compose.js's
// normalizeLegWorldFrame() each independently derive; reimplemented here too so
// frontier() output can be converted to a movable target without a cross-file
// import. `lb` here is the FULL outdoor objCellId (landblock + cellIdx), the
// shape host.MoveToPosition / bot.goto need — NOT the 16-bit landblock number
// used elsewhere in this file for tile bookkeeping.
export function worldToOutdoorCell(wx, wy, z = 0) {
  const lbX = Math.max(0, Math.min(255, Math.floor(wx / 192)));
  const lbY = Math.max(0, Math.min(255, Math.floor(wy / 192)));
  const lx = wx - lbX * 192;
  const ly = wy - lbY * 192;
  const cellIdx = 1 + Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24));
  const lb = (((lbX << 24) | (lbY << 16) | cellIdx) >>> 0);
  return { lb, x: lx, y: ly, z };
}

function tileKeyOf(tx, ty, zb) {
  return `${tx}:${ty}:${zb}`;
}

// 8-point compass from a bearing degree (0=N, 90=E, ...).
const COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function compassOf(deg) {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS8[Math.round(d / 45) % 8];
}

function bearingFrom(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let deg = (Math.atan2(dx, dy) * 180) / Math.PI; // dy->N(0deg), dx->E(90deg)
  if (deg < 0) deg += 360;
  return deg;
}

// Perimeter cells of a Chebyshev ring at radius r around (0,0) — O(r), not O(r^2).
function ringOffsets(r) {
  if (r <= 0) return [[0, 0]];
  const pts = [];
  for (let dx = -r; dx <= r; dx++) {
    pts.push([dx, -r]);
    pts.push([dx, r]);
  }
  for (let dy = -r + 1; dy <= r - 1; dy++) {
    pts.push([-r, dy]);
    pts.push([r, dy]);
  }
  return pts;
}

// ── @telepoi alias table (VALIDATION COROLLARY) ──────────────────────────────
// ~14 towns.js names don't match ace_world.points_of_interest rows (exact
// case-insensitive match only, no fuzzy match on the ACE side).
export const TELEPOI_ALIAS = new Map([
  ["Qalaba'r", "Qalabar"],
  ["Fiun Outpost", "Fiun"],
  ["MacNiall's Freehold", "Freehold"],
  ["Neydisa Castle", "Neydisa"],
  ["Oolutanga's Refuge", "Refuge"],
  ["Plateau Village", "Plateau"],
  ["Underground City", "Underground"],
]);
// 7 towns have NO points_of_interest row at all — must be excluded as telepoi
// targets entirely (not just aliased).
export const TELEPOI_EXCLUDED = new Set([
  "Candeth Keep",
  "Crater Lake Village",
  "Danby's Outpost",
  "Kor-Gursha",
  "Mar'uun",
  "Merwart Village",
  "Wai Jhou",
]);
export function telepoiTargetable(name) {
  return typeof name === "string" && name.length > 0 && !TELEPOI_EXCLUDED.has(name);
}
export function telepoiAlias(name) {
  return TELEPOI_ALIAS.get(name) ?? name;
}

// ── ExploreMemory ─────────────────────────────────────────────────────────────
export class ExploreMemory {
  /**
   * opts (all optional):
   *   now:          () => ms clock (default Date.now) — the ONLY clock, per
   *                 house convention (observe.js header) so tests are deterministic.
   *   stallMinutes: STALL_MIN in minutes for loopVerdict severity 3 (default 10).
   *   frontierMaxRadius: ring-search cap in tiles (default 120).
   */
  constructor(opts = {}) {
    this.now = typeof opts.now === "function" ? opts.now : Date.now;
    this.stallMs =
      (Number.isFinite(opts.stallMinutes) ? opts.stallMinutes : DEFAULT_STALL_MIN) * 60_000;
    this.frontierMaxRadius =
      Number.isFinite(opts.frontierMaxRadius) ? opts.frontierMaxRadius : DEFAULT_FRONTIER_MAX_RADIUS;

    this.tiles = new Map(); // tileKey -> {visits,firstT,lastT,cell,lb,tx,ty,zb,worldX,worldY,z}
    this.landblocks = new Set(); // 16-bit landblock numbers seen this session
    this._currentKey = null;
    this._previousKey = null;
    this._lastObserveKey = null;
    this._lastObserveT = -Infinity;
    this._history = []; // ring of {key,t} — every ACCEPTED (non-deduped) observe()
    this._lb = null;
    this._lbChangeT = null;
  }

  /** Record the current tile from a raw pose; bumps visits; updates was/is. */
  observe(pose) {
    if (!pose || typeof pose.objCellId !== "number" || typeof pose.x !== "number" || typeof pose.y !== "number") {
      return this.current;
    }
    const cell = pose.objCellId >>> 0;
    // objCellId===0 is a streaming/respawn gap (e.g. death -> academy respawn
    // reports cell 0 for a beat), not a real location — (cell&0xffff) is 0,
    // which the indoor/outdoor split (isIndoorCell) would otherwise wrongly
    // read as OUTDOOR while the player is physically indoors. Treat as
    // UNKNOWN: no-op entirely (no tile recorded, no visit/variation bump, no
    // was/is transition) so a respawn beat can never masquerade as a real
    // revisit or corrupt the frontier/loop math with garbage coordinates.
    if (cell === 0) return this.current;
    const z = typeof pose.z === "number" && Number.isFinite(pose.z) ? pose.z : 0;
    const wx = worldX(cell, pose.x);
    const wy = worldY(cell, pose.y);
    const lb = landblockOf(cell);
    const tx = Math.floor(wx / TILE_M);
    const ty = Math.floor(wy / TILE_M);
    const zb = Math.floor(z / Z_BAND_M);
    const key = tileKeyOf(tx, ty, zb);

    const now = this.now();
    // dual-driver double-count guard
    if (key === this._lastObserveKey && now - this._lastObserveT < DEDUPE_WINDOW_MS) {
      return this.current;
    }
    this._lastObserveKey = key;
    this._lastObserveT = now;

    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { visits: 0, firstT: now, tx, ty, zb };
      this.tiles.set(key, tile);
    }
    tile.visits += 1;
    tile.lastT = now;
    tile.cell = cell;
    tile.lb = lb;
    tile.worldX = wx;
    tile.worldY = wy;
    tile.z = z;

    this.landblocks.add(lb);
    if (this._lb !== lb) {
      this._lb = lb;
      this._lbChangeT = now;
    }

    if (key !== this._currentKey) {
      this._previousKey = this._currentKey;
      this._currentKey = key;
    }
    this._history.push({ key, t: now });
    if (this._history.length > OSC_WINDOW * 4) this._history.splice(0, this._history.length - OSC_WINDOW * 4);

    return this.current;
  }

  _tileView(key) {
    if (key == null) return null;
    const t = this.tiles.get(key);
    if (!t) return null;
    return {
      tileKey: key,
      worldX: t.worldX,
      worldY: t.worldY,
      z: t.z,
      cell: t.cell,
      lb: t.lb,
      visits: t.visits,
      tx: t.tx,
      ty: t.ty,
      zb: t.zb,
    };
  }

  get current() {
    return this._tileView(this._currentKey);
  }
  get previous() {
    return this._tileView(this._previousKey);
  }
  /** Alias for readability at call sites. */
  get here() {
    return this.current;
  }
  /** Alias for readability at call sites. */
  get was() {
    return this.previous;
  }

  /** Revisit count of the CURRENT tile — the "redundancy". */
  variation() {
    const cur = this.current;
    return cur ? cur.visits : 0;
  }

  // 2-tile A<->B oscillation over the last OSC_WINDOW accepted observations:
  // exactly 2 distinct tiles, strictly alternating.
  _isOscillating() {
    const hist = this._history.slice(-OSC_WINDOW);
    if (hist.length < 4) return false;
    const keys = hist.map((h) => h.key);
    if (new Set(keys).size !== 2) return false;
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] === keys[i - 1]) return false;
    }
    return true;
  }

  /** Nearest UNVISITED tile (same z-band as `here`) by expanding ring search. */
  frontier(opts = {}) {
    const cur = this.current;
    if (!cur) return null;
    const maxR = Number.isFinite(opts.maxRadius) ? opts.maxRadius : this.frontierMaxRadius;
    const curTx = Math.floor(cur.worldX / TILE_M);
    const curTy = Math.floor(cur.worldY / TILE_M);
    const zb = cur.zb;

    let best = null;
    for (let r = 1; r <= maxR; r++) {
      for (const [dx, dy] of ringOffsets(r)) {
        const tx = curTx + dx;
        const ty = curTy + dy;
        const key = tileKeyOf(tx, ty, zb);
        if (this.tiles.has(key)) continue;
        const wx = (tx + 0.5) * TILE_M;
        const wy = (ty + 0.5) * TILE_M;
        const dist = Math.hypot(wx - cur.worldX, wy - cur.worldY);
        if (!best || dist < best.dist) best = { worldX: wx, worldY: wy, dist };
      }
      if (best) break; // this ring is the nearest possible — stop expanding
    }
    if (!best) return null;
    const bearingDeg = bearingFrom(cur.worldX, cur.worldY, best.worldX, best.worldY);
    const { lb } = worldToOutdoorCell(best.worldX, best.worldY, cur.z);
    return { worldX: best.worldX, worldY: best.worldY, dist: best.dist, bearingDeg, lb: landblockOf(lb) };
  }

  /** {looping, severity:0..3, reason, correction}. */
  loopVerdict() {
    const cur = this.current;
    if (!cur) return { looping: false, severity: 0, reason: "", correction: "" };
    const v = this.variation();
    const osc = this._isOscillating();
    const sinceLbChangeMs = this._lbChangeT != null ? this.now() - this._lbChangeT : 0;
    const fr = this.frontier();
    const frontierLocal = !!fr && fr.lb === cur.lb;

    const sev3 = v >= SEV3_VARIATION || (sinceLbChangeMs > this.stallMs && frontierLocal);
    const sev2 = v >= SEV2_VARIATION || osc;
    const sev1 = v >= SEV1_VARIATION;

    let severity = 0;
    let reason = "";
    if (sev3) {
      severity = 3;
      reason =
        v >= SEV3_VARIATION
          ? `revisited this tile ${v}×`
          : `wedged ${Math.round(sinceLbChangeMs / 60_000)} min in this landblock with no reachable frontier outside it`;
    } else if (sev2) {
      severity = 2;
      reason = osc ? "bouncing between the same two tiles" : `revisited this tile ${v}×`;
    } else if (sev1) {
      severity = 1;
      reason = `revisited this tile ${v}×`;
    }
    return {
      looping: severity > 0,
      severity,
      reason,
      correction: severity > 0 ? CORRECTIONS[severity] : "",
    };
  }

  /** {tiles, landblocks, thisLbTiles, sinceLbChangeMs}. */
  coverage() {
    const cur = this.current;
    const lb = cur ? cur.lb : this._lb;
    let thisLbTiles = 0;
    if (lb != null) {
      for (const t of this.tiles.values()) if (t.lb === lb) thisLbTiles++;
    }
    const sinceLbChangeMs = this._lbChangeT != null ? this.now() - this._lbChangeT : 0;
    return { tiles: this.tiles.size, landblocks: this.landblocks.size, thisLbTiles, sinceLbChangeMs };
  }

  // Nearest town (by ns/ew) to an arbitrary world point — convenience for
  // callers building a "Here: <town>" line. Not part of the frozen contract
  // proper but lives here since it shares locDegrees/TOWNS with townFrontier().
  townNameAt(wx, wy, towns = TOWNS, maxDeg = TOWN_AT_DEG) {
    const { ns, ew } = worldToDeg(wx, wy);
    let best = null;
    for (const t of towns) {
      const d = Math.hypot(ns - t.ns, ew - t.ew);
      if (!best || d < best.d) best = { t, d };
    }
    // Only name a town the position is actually AT — a far "nearest town" is a
    // parked env cell (dungeon/apartment in the ocean) or open wilderness, and
    // labelling it with a distant town is exactly the mislabel that seeded the
    // "Qalaba'r" fixation. Return null when beyond maxDeg (pass Infinity for the
    // old unconditional nearest-town behavior).
    return best && best.d <= maxDeg ? best.t.name : null;
  }

  // Three-way cell-kind classification (operator briefing 2026-07-21). Returns
  // { kind: 'outdoor' | 'building' | 'dungeon', town: string|null, lb }. Callers
  // build a truthful "Here:" line from this instead of blindly naming a town.
  //   outdoor  — LandCell terrain (walkable); town = nearest town if AT one.
  //   building — interior EnvCell in a town's landblock; town = that town.
  //   dungeon  — parked EnvCell (ocean region) / apartment / far dungeon; no
  //              town, and reachable only by portal (not overland).
  classifyPlace(cell, wx, wy, towns = TOWNS) {
    const town = this.townNameAt(wx, wy, towns);
    if (!isIndoorCell(cell)) return { kind: "outdoor", town, lb: landblockOf(cell) };
    // Indoors: AT a town ⇒ building interior; otherwise a parked/dungeon env cell.
    return town
      ? { kind: "building", town, lb: landblockOf(cell) }
      : { kind: "dungeon", town: null, lb: landblockOf(cell) };
  }

  _townHasVisitedTile(town) {
    for (const t of this.tiles.values()) {
      const { ns, ew } = worldToDeg(t.worldX, t.worldY);
      if (Math.hypot(ns - town.ns, ew - town.ew) < TOWN_RADIUS_DEG) return true;
    }
    return false;
  }

  /**
   * Nearest TARGETABLE town with 0 visited tiles (and not the town `pose` is
   * currently nearest to) — the last-resort @telepoi escalation target.
   * towns defaults to tools/towns.js TOWNS.
   */
  townFrontier(towns, pose) {
    const list = Array.isArray(towns) && towns.length ? towns : TOWNS;
    if (!pose || typeof pose.objCellId !== "number") return null;
    const { ns, ew } = locDegrees(pose.objCellId >>> 0, pose.x, pose.y);

    let currentName = null;
    let currentD = Infinity;
    for (const t of list) {
      const d = Math.hypot(ns - t.ns, ew - t.ew);
      if (d < currentD) {
        currentD = d;
        currentName = t.name;
      }
    }

    let best = null;
    for (const t of list) {
      if (t.name === currentName) continue;
      if (!telepoiTargetable(t.name)) continue;
      if (this._townHasVisitedTile(t)) continue;
      const d = Math.hypot(ns - t.ns, ew - t.ew);
      if (!best || d < best.d) best = { t, d };
    }
    return best ? { name: best.t.name, ns: best.t.ns, ew: best.t.ew, dist: best.d } : null;
  }
}
