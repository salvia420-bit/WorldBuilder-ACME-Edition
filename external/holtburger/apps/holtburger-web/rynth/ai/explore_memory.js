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

// Frozen-pose (movement-dead) watchdog thresholds — mirror bot.js's
// ExplorePressureController._checkMovementDead (raw pose unchanged for minutes
// despite move attempts is a CLIENT freeze, not a routing problem). Overridable
// via constructor opts.frozenMinutes for deterministic tests.
const DEFAULT_FROZEN_MIN = 3; // minutes — raw pose unchanged this long ⇒ frozen
const FROZEN_MIN_OBSERVES = 2; // ≥2 accepted observes confirming the freeze (anti-flicker)

const DEFAULT_FRONTIER_MAX_RADIUS = 120; // tiles (~1440m) — a "sane radius"

// Wedge-avoid set (2026-07-24, unwedge.js): world positions where the bot got
// physically wedged against static geometry. frontier()/frontierChain() skip
// candidate tiles inside an avoid radius so the explorer doesn't immediately
// path back into the same furniture and re-wedge in a loop. Location-agnostic
// by construction — positions only, never cell/landblock ids.
const WEDGE_AVOID_RADIUS_M = 8;
const WEDGE_AVOID_CAP = 32; // long-session hygiene (FIFO), same spirit as _seenPortals

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

// ── world-frame helpers: the ONE copy now lives in nav_frame.js (C3 Stage-0
// dedup). Re-exported here unchanged so this module's frozen public API is
// preserved — extensions.js/bot.js/director.js still import worldX/worldY/…
// from explore_memory.js. worldToDeg (already-world-frame -> /loc degrees) is
// imported for internal use only; it was never part of the public surface.
import {
  worldX, worldY, landblockOf, isIndoorCell,
  locDegrees, worldToDeg, worldToOutdoorCell,
} from "../nav_frame.js";
export { worldX, worldY, landblockOf, isIndoorCell, locDegrees, worldToOutdoorCell };

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
    this.frozenMs =
      (Number.isFinite(opts.frozenMinutes) ? opts.frozenMinutes : DEFAULT_FROZEN_MIN) * 60_000;

    this._resetState();
  }

  // Session RAM state only — NOT the constructor-opts config (this.now,
  // this.stallMs, this.frontierMaxRadius, this.frozenMs survive a reset()).
  // Factored out of the constructor so reset() (P1 #8/08-B-1: a "no-reload
  // clean model test" wipe must not leave stale coverage/frontier behind,
  // since locationBlock's Covered/Frontier/CORRECTION render straight off
  // this state) shares the exact same initial values, not a hand-kept copy.
  _resetState() {
    this.tiles = new Map(); // tileKey -> {visits,firstT,lastT,cell,lb,tx,ty,zb,worldX,worldY,z}
    this.landblocks = new Set(); // 16-bit landblock numbers seen this session
    this._currentKey = null;
    this._previousKey = null;
    this._lastObserveKey = null;
    this._lastObserveT = -Infinity;
    this._history = []; // ring of {key,t} — every ACCEPTED (non-deduped) observe()
    this._lb = null;
    this._lbChangeT = null;
    // Parked-lb frontier exclusion (2026-07-21 scope item 2): every 16-bit
    // landblock this session has ever been classified as a portal-only
    // dungeon/apartment (classifyPlace kind==='dungeon') — a ring-search
    // frontier candidate landing in one of these must never be offered as a
    // walkable outdoor target (it's an ocean-parked slot, not real terrain).
    this._dungeonLandblocks = new Set();
    // Wedge-avoid set (unwedge.js markWedge) — [{wx,wy,r}], FIFO-capped.
    this._wedgeAvoid = [];

    // Per-observe-cycle memo (C5-5) for the two derived queries whose cost or
    // consistency the reports flag: frontier() (an O(r) ring search) and the
    // loopVerdict() that internally re-calls it. Both are queried 3-4× per
    // check-in/step (extensions.locationBlock: loopVerdict()+frontier(); bot.js
    // ladder: _frontierSafe()+_loopVerdictSafe()). Caching each on _observeSeq —
    // bumped by every ACCEPTED observe() — means every caller within one cycle
    // sees the SAME object: one ring search instead of 3-4, and no intra-cycle
    // inconsistency where loopVerdict's internal frontier disagreed with a
    // caller's direct frontier(). The cache is transparent — callers keep the
    // frozen frontier(opts)/loopVerdict() signatures unchanged.
    this._observeSeq = 0;
    this._frontierCache = null; // { seq, maxRadius, result }
    this._verdictCache = null; // { seq, result }

    // Frozen-pose (movement-dead) watchdog state — the RAW pose fingerprint of
    // the last accepted observe, the time it last actually changed, and how
    // many accepted observes have since landed on the unchanged pose. Fed in
    // observe(); read by _isFrozen() so loopVerdict() can escalate a stuck
    // client to severity 3 (FM-9).
    this._lastPoseKey = null;
    this._lastPoseMoveT = null;
    this._observesSincePoseChange = 0;
  }

  /**
   * Wipe all session RAM (coverage/frontier/history/caches/frozen-watchdog)
   * back to a fresh instance's state, keeping the constructor config (now,
   * stallMs, frontierMaxRadius, frozenMs). This is the RAM half of a "clean
   * model test" — ExploreMemory has never persisted to localStorage (there
   * is nothing to remove there), so a caller doing a no-reload memory wipe
   * MUST call this or the prior run's Covered/Frontier/CORRECTION keep
   * rendering into the LOCATION block (P1 #8, 08-B-1).
   */
  reset() {
    this._resetState();
    return this;
  }

  /** Record the current tile from a raw pose; bumps visits; updates was/is. */
  observe(pose) {
    if (!pose || typeof pose.objCellId !== "number" || typeof pose.x !== "number" || typeof pose.y !== "number") {
      return this.current;
    }
    const cell = pose.objCellId >>> 0;
    // A streaming/respawn gap (e.g. death -> academy respawn reports an
    // unresolved position for a beat) is not a real location — objCellId=0's
    // (cell&0xffff) is 0, which the indoor/outdoor split (isIndoorCell) would
    // otherwise wrongly read as OUTDOOR while the player is physically
    // indoors. Treat as UNKNOWN: no-op entirely (no tile recorded, no
    // visit/variation bump, no was/is transition) so a respawn beat can never
    // masquerade as a real revisit or corrupt the frontier/loop math with
    // garbage coordinates.
    //
    // C1 fix (rynth-review 07/17-SYNTHESIS #9, 2026-07-23): the wasm
    // WP-2/WP-3 pose-retention layers never regress a resolved objCellId
    // back to 0 once a good pose has been seen, so a bare `cell === 0` check
    // is now dead on a live host — the respawn beat instead reports the
    // last-known (pre-death) cell. Prefer the honest `pose.cellResolved`
    // signal (`getLocalPlayerPoseCellResolved`, carried through
    // webhost.js/extensions.js's rawPoseOf); `cellResolved` undefined/null
    // (host predates the capability, or a caller-built plain pose — e.g. the
    // unit tests below) falls back to the legacy `cell === 0` check, so HOLD
    // semantics are unchanged wherever the new signal isn't available.
    const cellUnresolved = pose.cellResolved === false || (pose.cellResolved == null && cell === 0);
    if (cellUnresolved) return this.current;
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

    // Accepted (non-deduped) observation: bump the cycle sequence so the
    // per-cycle frontier()/loopVerdict() memo invalidates, and fold this raw
    // pose into the frozen-pose watchdog. Placed AFTER the dedupe guard so a
    // dual-driver double-poll (same tile within DEDUPE_WINDOW_MS) neither
    // invalidates the cache nor counts as a fresh frozen-pose sample.
    this._observeSeq += 1;
    const poseKey = `${cell}|${pose.x.toFixed(1)}|${pose.y.toFixed(1)}|${z.toFixed(1)}`;
    if (this._lastPoseKey == null || poseKey !== this._lastPoseKey) {
      this._lastPoseKey = poseKey;
      this._lastPoseMoveT = now;
      this._observesSincePoseChange = 0;
    } else {
      this._observesSincePoseChange += 1;
    }

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
    // Classify at observe time (2026-07-21 scope item 2) so frontier() can
    // restrict a portal-only dungeon's ring search to its own landblock, and
    // outdoors can exclude every landblock ever seen parked as one.
    const place = this.classifyPlace(cell, wx, wy);
    tile.kind = place.kind;
    if (place.kind === "dungeon") this._dungeonLandblocks.add(lb);

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
      kind: t.kind,
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

  /**
   * Nearest UNVISITED tile (same z-band as `here`) by expanding ring search.
   * Memoized per observe-cycle (keyed on _observeSeq + maxRadius) so the 3-4
   * callers in one check-in/step share a single ring search — see the
   * _frontierCache note in the constructor.
   */
  frontier(opts = {}) {
    const maxR = Number.isFinite(opts.maxRadius) ? opts.maxRadius : this.frontierMaxRadius;
    const c = this._frontierCache;
    if (c && c.seq === this._observeSeq && c.maxRadius === maxR) return c.result;
    const result = this._computeFrontier(maxR);
    this._frontierCache = { seq: this._observeSeq, maxRadius: maxR, result };
    return result;
  }

  /**
   * ADDITIVE (2026-07-24, unwedge.js — same additive tier as frontierChain/
   * reset): record a world position where the bot got physically WEDGED
   * against static geometry. frontier()/frontierChain() then skip candidate
   * tiles within `radiusM` of it, so the explorer never immediately re-targets
   * the wedge spot. Purely positional — no cell/landblock/content ids.
   */
  markWedge(wx, wy, radiusM = WEDGE_AVOID_RADIUS_M) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    this._wedgeAvoid.push({ wx, wy, r: Number.isFinite(radiusM) && radiusM > 0 ? radiusM : WEDGE_AVOID_RADIUS_M });
    if (this._wedgeAvoid.length > WEDGE_AVOID_CAP) this._wedgeAvoid.shift();
    // The avoid set changed outside an observe() cycle — the per-cycle memo
    // would otherwise keep serving a frontier that now sits inside the wedge.
    this._frontierCache = null;
    this._verdictCache = null;
  }

  /** Snapshot of the wedge-avoid set (introspection/tests). */
  wedgeAvoids() {
    return this._wedgeAvoid.slice();
  }

  _nearWedge(wx, wy) {
    for (const w of this._wedgeAvoid) {
      if (Math.hypot(wx - w.wx, wy - w.wy) <= w.r) return true;
    }
    return false;
  }

  _computeFrontier(maxR) {
    const cur = this.current;
    if (!cur) return null;
    const curTx = Math.floor(cur.worldX / TILE_M);
    const curTy = Math.floor(cur.worldY / TILE_M);
    const zb = cur.zb;

    // Parked-lb frontier exclusion (2026-07-21 scope item 2). A portal-only
    // dungeon (cur.kind==='dungeon') is parked in its OWN landblock — there
    // is no walkable route out of it, so the ring search must never wander
    // outside that one landblock. Outdoors, a candidate landing inside any
    // landblock ever classified as a parked dungeon/apartment (ocean-parked,
    // portal-only) must never be offered as a walkable frontier — it isn't
    // reachable on foot, only by portal.
    const restrictToLb = cur.kind === "dungeon" ? cur.lb : null;

    let best = null;
    for (let r = 1; r <= maxR; r++) {
      for (const [dx, dy] of ringOffsets(r)) {
        const tx = curTx + dx;
        const ty = curTy + dy;
        const key = tileKeyOf(tx, ty, zb);
        if (this.tiles.has(key)) continue;
        const wx = (tx + 0.5) * TILE_M;
        const wy = (ty + 0.5) * TILE_M;
        const { lb: candLbRaw } = worldToOutdoorCell(wx, wy, cur.z);
        const candLb = landblockOf(candLbRaw);
        if (restrictToLb != null && candLb !== restrictToLb) continue;
        if (restrictToLb == null && this._dungeonLandblocks.has(candLb)) continue;
        if (this._nearWedge(wx, wy)) continue; // never re-offer a known wedge spot
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

  /**
   * ADDITIVE (2026-07-23, movement-utilization / "cruise" work — NOT part of
   * the frozen WS-A surface above, same additive tier as reset()/townNameAt/
   * classifyPlace): a DISTANCE-BUDGETED chain of unvisited-tile waypoints for
   * the pressure controller's frontier cruise. Starts at the exact tile
   * frontier() would return (same ring search, same dungeon-landblock
   * exclusions), then greedily extends: from each waypoint, the nearest tile
   * unvisited both for real (this.tiles) and in this chain's own simulated
   * overlay, within maxLegM of the previous waypoint — so the chain always
   * walks REACHABLE-looking nearby frontier rather than projecting a long
   * blind bearing, and it naturally stops (re-aims next call) when the local
   * frontier is exhausted. Each chosen waypoint marks its own tile plus the
   * 8 neighbors as simulated-visited, which keeps consecutive waypoints
   * >= ~2 tiles (~24 m) apart.
   *
   * opts: { budgetM (total chain length target, default 120),
   *         maxWaypoints (default 24), maxLegM (chain-leg cap, default 60) }.
   * Returns { waypoints: [{worldX,worldY,legM}], totalM } — the FIRST
   * waypoint's legM is the distance from the current tile (it may exceed
   * maxLegM when the nearest frontier itself is far; callers subdivide) —
   * or null when there is no frontier at all (frontier() itself null).
   */
  frontierChain(opts = {}) {
    const budgetM = Number.isFinite(opts.budgetM) ? Math.max(0, opts.budgetM) : 120;
    const maxWaypoints = Number.isFinite(opts.maxWaypoints) ? Math.max(1, opts.maxWaypoints) : 24;
    const maxLegM = Number.isFinite(opts.maxLegM) ? Math.max(TILE_M, opts.maxLegM) : 60;
    const cur = this.current;
    if (!cur) return null;
    const first = this.frontier(); // shared cache + ALL exclusion rules (dungeon parking etc.)
    if (!first) return null;
    const zb = cur.zb;
    const restrictToLb = cur.kind === "dungeon" ? cur.lb : null;
    const localR = Math.max(1, Math.min(20, Math.ceil(maxLegM / TILE_M)));
    const sim = new Set();
    const waypoints = [];
    let totalM = 0;
    let px = cur.worldX;
    let py = cur.worldY;
    let next = { worldX: first.worldX, worldY: first.worldY };
    while (next && waypoints.length < maxWaypoints) {
      const legM = Math.hypot(next.worldX - px, next.worldY - py);
      waypoints.push({ worldX: next.worldX, worldY: next.worldY, legM });
      totalM += legM;
      px = next.worldX;
      py = next.worldY;
      const wtx = Math.floor(px / TILE_M);
      const wty = Math.floor(py / TILE_M);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) sim.add(tileKeyOf(wtx + dx, wty + dy, zb));
      }
      if (totalM >= budgetM) break;
      next = null;
      for (let r = 1; r <= localR && !next; r++) {
        let best = null;
        for (const [dx, dy] of ringOffsets(r)) {
          const tx = wtx + dx;
          const ty = wty + dy;
          const key = tileKeyOf(tx, ty, zb);
          if (this.tiles.has(key) || sim.has(key)) continue;
          const wxc = (tx + 0.5) * TILE_M;
          const wyc = (ty + 0.5) * TILE_M;
          const candLb = landblockOf(worldToOutdoorCell(wxc, wyc, cur.z).lb);
          if (restrictToLb != null && candLb !== restrictToLb) continue;
          if (restrictToLb == null && this._dungeonLandblocks.has(candLb)) continue;
          if (this._nearWedge(wxc, wyc)) continue; // never chain through a known wedge spot
          const d = Math.hypot(wxc - px, wyc - py);
          if (d > maxLegM) continue;
          if (!best || d < best.d) best = { worldX: wxc, worldY: wyc, d };
        }
        if (best) next = { worldX: best.worldX, worldY: best.worldY };
      }
    }
    return waypoints.length ? { waypoints, totalM } : null;
  }

  /**
   * {looping, severity:0..3, reason, correction}. Memoized per observe-cycle
   * (keyed on _observeSeq) so a check-in/step that queries it AND queries
   * frontier() separately shares one computation — the internal frontier() call
   * below and any direct caller's frontier() then return the same cached object.
   */
  loopVerdict() {
    const c = this._verdictCache;
    if (c && c.seq === this._observeSeq) return c.result;
    const result = this._computeVerdict();
    this._verdictCache = { seq: this._observeSeq, result };
    return result;
  }

  // Raw-pose freeze test (movement-dead watchdog, FM-9): the pose has not
  // changed for longer than frozenMs AND at least FROZEN_MIN_OBSERVES accepted
  // observes have confirmed it — so a single stale/late reading can never trip
  // it (anti-trigger-happiness guard).
  _isFrozen() {
    return this._lastPoseMoveT != null
      && this.now() - this._lastPoseMoveT > this.frozenMs
      && this._observesSincePoseChange >= FROZEN_MIN_OBSERVES;
  }

  _computeVerdict() {
    const cur = this.current;
    if (!cur) return { looping: false, severity: 0, reason: "", correction: "" };
    const v = this.variation();
    const osc = this._isOscillating();
    const sinceLbChangeMs = this._lbChangeT != null ? this.now() - this._lbChangeT : 0;
    const fr = this.frontier();
    const frontierLocal = !!fr && fr.lb === cur.lb;
    const stalled = sinceLbChangeMs > this.stallMs;
    const frozenPose = this._isFrozen();

    // Severity 3 (WEDGED — strongest CORRECTION + the sev3 exit ladder) fires on
    // ANY of:
    //   • a deep single-tile revisit (>= SEV3_VARIATION), OR
    //   • stalled in this landblock past stallMs AND the only reachable frontier
    //     is inside this same landblock (classic wedge), OR
    //   • stalled past stallMs AND there is NO reachable frontier anywhere
    //     (fr === null) — the previously-missing arm (C5-6): a bot with nothing
    //     unvisited in range would otherwise never escalate, OR
    //   • the raw pose is frozen (movement-dead, FM-9) — a client-side freeze
    //     the exit ladder must react to, not a mild loop.
    const sev3 = v >= SEV3_VARIATION
      || (stalled && frontierLocal)
      || (stalled && fr === null)
      || frozenPose;
    const sev2 = v >= SEV2_VARIATION || osc;
    const sev1 = v >= SEV1_VARIATION;

    let severity = 0;
    let reason = "";
    if (sev3) {
      severity = 3;
      if (v >= SEV3_VARIATION) {
        reason = `revisited this tile ${v}×`;
      } else if (frozenPose) {
        reason = `pose frozen ~${Math.round((this.now() - this._lastPoseMoveT) / 60_000)} min — movement appears dead`;
      } else if (fr === null) {
        reason = `stalled ${Math.round(sinceLbChangeMs / 60_000)} min with no reachable unvisited tile anywhere`;
      } else {
        reason = `wedged ${Math.round(sinceLbChangeMs / 60_000)} min in this landblock with no reachable frontier outside it`;
      }
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
