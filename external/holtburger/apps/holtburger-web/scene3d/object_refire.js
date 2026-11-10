// scene3d/object_refire.js — `?objRefire` (2026-11-01; DEFAULT ON since the 1070 A/B the same day, `=off` escapes): keep the
// `?objRadius` window's statics/buildings bakes flowing BETWEEN landblock
// crossings on the slot-grid arm, ahead-of-travel first.
//
// WHY (owner, vehicle tour on the 1070, 2026-11-01: "doesnt seem like we are
// seeing many trees while we are out flying around"; earlier, over a slow
// tunnel: "terrain kept up, trees / scenery lagged").
//
// Scenery (trees, rocks, bushes) is part of the statics bake. The per-LB
// bakers sit behind the stream-bake guard (stream_bake_guard.js), a skip-cap
// SEMAPHORE: at most 6 non-urgent bakes in flight, every fire beyond that is
// DROPPED (`skipCap`), and only the player's own 3x3 is cap-exempt (urgent).
// The guard's contract is that "the caller re-fires on later ticks". On the
// slot-grid arm (`?slotGrid`, default ON since 2026-10-25) nobody re-fires the
// objects of a LIVE tile between crossings:
//   * index.js sgCtl.tick re-fires the whole window once per CROSSING
//     (`refireWindowFeeds`), synchronously, so ~6 non-urgent bakes start and
//     the rest of that crossing's demand is dropped;
//   * the 250 ms retry (`refireStagedFeeds`) covers STAGED tiles only, and a
//     tile turns LIVE as soon as its TERRAIN is baked (`bakedPredicate` reads
//     terrainBakedLbs alone), usually before its statics got a slot;
//   * cells.js's own 500 ms re-sweep collapses to the player's LB under the
//     grid (`_slotGridDrivesRing` ⇒ ringRadius 0).
// So a dropped statics bake for a landblock 2..N away waits for the NEXT
// crossing — tens of seconds on foot, and at 300-400 km/h (a crossing every
// 1.7-2.3 s) the window's demand (2N+1 to 4N+1 new landblocks per crossing,
// each statics + buildings, plus terrain for the admitted tiles) far exceeds
// the ~6 starts a crossing gets, so the window ahead stays bare. The legacy
// ring (`?slotGrid=off`) did not have this gap: its sweep re-entered every
// 500 ms while any ring landblock was unbaked (cells.js `_pvsSweepIncomplete`).
//
// WHAT. Every OBJ_REFIRE_MS the caller (index.js sgCtl.tick, after the staged
// refire so terrain keeps first claim on free slots) hands this module the
// window; it fires `feeds.fireLb` for each LIVE/STAGED-tile landblock within the
// object radius whose statics or buildings are not baked yet, sorted by
// distance to the player with landblocks AHEAD of the direction of travel first
// (direction = the last few landblock crossings, forgotten after
// TRAVEL_MEMORY_MS; no motion ⇒ plain nearest-first). Same guard, same
// idempotency, same cap: this only stops the pipe from going idle between
// crossings and spends the free slots on landblocks the player is heading
// into rather than ones about to leave the window behind.
//
// NOT CHANGED: the guard cap, the urgent lane, the object radius, the grid's
// own events. Parked landblocks are skipped (park belongs to the grid).
// Flag OFF (absent): the caller never constructs this — byte-identical.

import { getFlightHint } from "./residency.js";

export const OBJ_REFIRE_MS = 250;
export const OBJ_REFIRE_FLIGHT_MS = 80;
export const OBJ_REFIRE_FLIGHT_CAP = 12;
export const TRAVEL_MEMORY_MS = 8000;
// Score = Chebyshev distance − AHEAD_WEIGHT·cos(angle to travel dir): an LB
// 3 away dead ahead (1.5) outranks one 2 away abeam (2) and one 2 behind (3.5).
export const AHEAD_WEIGHT = 1.5;
export const AHEAD_WEIGHT_FLIGHT = 2.4;
const TRAVEL_HISTORY = 4;

/** `?objRefire` — DEFAULT ON (owner flip 2026-11-01 after the 1070 A/B: statics baked in the object window in flight
 *  0.63 → 0.96); `off`/`0`/`false`/`no` turn it off, anything else (absent included) ON. */
export function objRefireEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    const v = (new URLSearchParams(s).get("objRefire") || "").trim().toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

function _cheb(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Travel-direction memory fed from landblock crossings. */
export function createTravelTracker() {
  return { last: null, hist: [] };
}

/**
 * Note the player's landblock. A step of more than 2 landblocks is a teleport:
 * the history is dropped (a teleport has no direction of travel).
 */
export function noteTravel(tr, lbx, lby, nowMs) {
  if (!tr) return;
  const last = tr.last;
  if (last && (last.x !== lbx || last.y !== lby)) {
    const dx = lbx - last.x;
    const dy = lby - last.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      tr.hist.length = 0;
    } else {
      tr.hist.push({ dx, dy, t: nowMs });
      if (tr.hist.length > TRAVEL_HISTORY) tr.hist.shift();
    }
  }
  tr.last = { x: lbx, y: lby };
}

/** Unit travel direction in landblock space, or null (no recent crossing). */
export function travelDir(tr, nowMs) {
  if (!tr) return null;
  let sx = 0;
  let sy = 0;
  for (const h of tr.hist) {
    if (nowMs - h.t > TRAVEL_MEMORY_MS) continue;
    sx += h.dx;
    sy += h.dy;
  }
  const len = Math.hypot(sx, sy);
  return len > 1e-6 ? { x: sx / len, y: sy / len } : null;
}

/** Refire score of `lbKey` (lower = sooner). */
export function refireScore(lbKey, plx, ply, dir, aheadWeight = AHEAD_WEIGHT) {
  const x = (lbKey >>> 24) & 0xff;
  const y = (lbKey >>> 16) & 0xff;
  const d = _cheb(x, y, plx, ply);
  if (!dir || d === 0) return d;
  const ox = x - plx;
  const oy = y - ply;
  const cos = (ox * dir.x + oy * dir.y) / Math.hypot(ox, oy);
  return d - aheadWeight * cos;
}

/**
 * The landblocks to re-fire, in fire order: tiles in `liveStates` (LIVE and
 * STAGED), landblocks within `radius` (Chebyshev) of the player, `needs(lbKey)`
 * true (statics or buildings unbaked, not parked — the caller's predicate).
 *
 * @param {object} a
 * @param {Iterable<number>} a.windowTiles  grid.windowTiles
 * @param {(tile:number)=>string} a.stateOf  grid.stateOf
 * @param {Set<string>} a.liveStates  tile states eligible for the refire
 * @param {(tile:number)=>number[]} a.tileLbKeys  residency_grid.js tileLbKeys
 * @param {number} a.playerLbKey  0xXXYY0000
 * @param {number} a.radius  object radius (landblocks)
 * @param {(lbKey:number)=>boolean} a.needs
 * @param {{x:number,y:number}|null} a.dir  unit travel direction or null
 * @param {number} [a.aheadWeight]  directional bias weight
 * @returns {number[]}
 */
export function collectObjectRefire({
  windowTiles,
  stateOf,
  liveStates,
  tileLbKeys,
  playerLbKey,
  radius,
  needs,
  dir,
  aheadWeight = AHEAD_WEIGHT,
}) {
  const plx = (playerLbKey >>> 24) & 0xff;
  const ply = (playerLbKey >>> 16) & 0xff;
  const out = [];
  for (const tile of windowTiles) {
    if (!liveStates.has(stateOf(tile))) continue;
    for (const lbKey of tileLbKeys(tile)) {
      const x = (lbKey >>> 24) & 0xff;
      const y = (lbKey >>> 16) & 0xff;
      if (_cheb(x, y, plx, ply) > radius) continue;
      if (!needs(lbKey)) continue;
      out.push(lbKey >>> 0);
    }
  }
  if (out.length > 1) {
    const score = new Map();
    for (const k of out) score.set(k, refireScore(k, plx, ply, dir, aheadWeight));
    out.sort((a, b) => score.get(a) - score.get(b) || a - b);
  }
  return out;
}

/**
 * The per-tick driver the slot-grid controller owns. `tick(...)` is cheap when
 * nothing is missing (one Set lookup pair per window landblock within the
 * radius, every OBJ_REFIRE_MS) and never throws.
 *
 * @param {object} deps
 * @param {(lbx:number, lby:number)=>void} deps.fireLb  the grid feeds' fireLb
 * @param {(lbKey:number)=>boolean} deps.needs
 * @param {()=>number|null} deps.radius  object radius (null ⇒ `fallbackRadius`)
 * @param {number} deps.fallbackRadius  radius when ?objRadius is off (the ring)
 * @param {Set<string>} deps.liveStates
 * @param {(tile:number)=>number[]} deps.tileLbKeys
 */
export function createObjectRefire({ fireLb, needs, radius, fallbackRadius, liveStates, tileLbKeys }) {
  const tracker = createTravelTracker();
  const stats = { ticks: 0, sweeps: 0, fired: 0, lastCandidates: 0, lastDir: null, lastError: null };
  let lastAtMs = -Infinity;
  let nextAtMs = -Infinity;
  return {
    stats,
    tracker,
    /** Call on every grid tick with the player's landblock (crossing memory). */
    notePlayer(lbKey, nowMs) {
      if (lbKey == null) return;
      noteTravel(tracker, (lbKey >>> 24) & 0xff, (lbKey >>> 16) & 0xff, nowMs);
    },
    /** Throttled refire; returns the number of landblocks fired this call. */
    tick(grid, playerLbKey, nowMs) {
      stats.ticks += 1;
      if (playerLbKey == null || !grid) return 0;
      const fh = getFlightHint(nowMs);
      const flying = !!(fh && fh.active !== false);
      const cadenceMs = flying ? OBJ_REFIRE_FLIGHT_MS : OBJ_REFIRE_MS;
      if (nowMs - lastAtMs < cadenceMs && nowMs < nextAtMs) return 0;
      lastAtMs = nowMs;
      nextAtMs = nowMs + cadenceMs;
      try {
        let r = radius();
        if (!(Number.isFinite(r) && r >= 0)) r = fallbackRadius;
        let dir;
        let aheadW = AHEAD_WEIGHT;
        const fSpd = flying ? Math.hypot(fh.vx, fh.vy) : 0;
        if (flying && fSpd > 1.0) {
          dir = { x: fh.vx / fSpd, y: fh.vy / fSpd };
          aheadW = AHEAD_WEIGHT_FLIGHT;
        } else {
          dir = travelDir(tracker, nowMs);
        }
        stats.lastDir = dir;
        const lbs = collectObjectRefire({
          windowTiles: grid.windowTiles,
          stateOf: (t) => grid.stateOf(t),
          liveStates,
          tileLbKeys,
          playerLbKey: playerLbKey >>> 0,
          radius: r,
          needs,
          dir,
          aheadWeight: aheadW,
        });
        stats.sweeps += 1;
        stats.lastCandidates = lbs.length;
        const toFire = flying && lbs.length > OBJ_REFIRE_FLIGHT_CAP ? lbs.slice(0, OBJ_REFIRE_FLIGHT_CAP) : lbs;
        for (const k of toFire) fireLb((k >>> 24) & 0xff, (k >>> 16) & 0xff);
        stats.fired += toFire.length;
        return toFire.length;
      } catch (e) {
        stats.lastError = String(e && e.message ? e.message : e);
        return 0;
      }
    },
  };
}
