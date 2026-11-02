// scene3d/residency_log.js — the flight-experience residency event log
// (`?residencyLog=on`, DEFAULT OFF; docs/flight-experience-2026-11-01 Phase 0).
//
// WHY. The owner sees trees "flash in and out" and landblocks "flicker or arrive
// late" while flying at 300-400 km/h. Five systems decide what a landblock shows
// (the slot grid / LRU park machinery, the ?objRadius object window, the bake
// guard, the far composite ring's discard square, the terrain LOD re-bake), and
// each one is correct alone. This module answers "what changed, when, and was it
// in view" with numbers instead of code reading.
//
// HOW. A SAMPLER, not a hook in every producer: once per frame it reads the
// authoritative state of every landblock in a window around the aircraft (the
// rig's landblock) and diffs it against the previous frame:
//   TB terrain baked            scene3d.terrainBakedLbs
//   TP parked                   landblockLru.isParked (the slot grid parks through it too)
//   SB statics baked            scene3d.staticsBakedLbs   (statics = ALL procedural scenery: trees)
//   BB buildings baked          scene3d.buildingsBakedLbs
//   OH objects hidden           object_radius.js (the hard visibility toggle)
//   FC far patch drawn          far_terrain.js patch for this LB is in the scene
//   FD far discards it          far_terrain.js discard square (uPlayerLbXy / uNearFadeLb)
//   GL slot-grid tile LIVE      residency_grid.js (tile state is logged separately too)
//   PF presence fade active     lb_presence.js (Phase 1: the fade is mid-flight)
// and derives what the eye gets:
//   T_DRAWN = TB && !TP
//   O_DRAWN = (SB || BB) && !OH && !TP
//   FAR_DRAWN = FC && !FD
//   HOLE = !T_DRAWN && !FAR_DRAWN      (nothing draws this landblock's ground)
// Every change becomes an event {t, lb, kind, a, b}. A few things are not state
// and are logged directly by their producer through `rlogEvent` (bake start /
// done / fail, the vehicle's lead landblock, a terrain LOD re-bake).
//
// QUESTIONS IT ANSWERS (window.__residency):
//   .flips(windowSec)   landblocks whose objects / terrain changed visibility more
//                       than once while they stayed within range (= flicker)
//   .leadTimes()        per landblock the aircraft entered: when it became ready
//                       (terrain drawn, objects drawn) minus when the aircraft got
//                       there (>0 = ready ahead of arrival)
//   .holes()            landblock-frames with no ground at all inside view range
//   .rows()             one row per second: pose, speed, AGL, counts, bakes, fps,
//                       tree coverage in 0-1 / 1-3 / 3-10 km bands (of the landblocks the retail census has trees in)
//   .summary()          everything above reduced to a handful of numbers
//   .events() / .dump() raw log (ring buffer, 262k events)
//
// COST. Flag off: `residencyLogEnabled()` is one cached boolean; the producers'
// `rlogEvent` calls return at once. Flag on: ~441 landblocks x ~8 Set lookups per
// frame (~0.1 ms) plus a 1 Hz coverage pass over the 10 km disc (~11k lookups).

const SAMPLE_R = 10;           // Chebyshev window (LB) sampled every frame
const VIEW_R_FALLBACK = 8;     // holes are counted out to max(near ring, far ring)
const CAP = 1 << 18;           // event ring buffer capacity
const COVER_BANDS_M = [[0, 1000], [1000, 3000], [3000, 10000]];

export const RLOG = Object.freeze({
  STATE: 1,        // a = new bits, b = old bits
  CENTRE: 2,       // the aircraft's landblock changed; a = previous lb
  LEAD: 3,         // the vehicle's streaming lead landblock changed; a = previous lead lb
  BAKE_START: 4,   // a = kind code, b = in-flight count at start
  BAKE_DONE: 5,    // a = kind code, b = duration ms
  BAKE_FAIL: 6,    // a = kind code
  TILE: 7,         // slot-grid tile state change; a = new state code, b = old
  LOD: 8,          // terrain LOD re-bake drained for lb; a = desired level, b = old level
  FADE: 9,         // lb_presence fade started; a = channel, b = target*255
  HINT: 10,        // residency flight hint changed (Phase 1); a = speed m/s, b = agl m
  POLICY: 11,      // LOD policy band change (Phase 3); a = band code, b = previous
});

export const BIT = Object.freeze({
  TB: 1, TP: 2, SB: 4, BB: 8, OH: 16, FC: 32, FD: 64, GL: 128, PF: 256, FF: 512, WT: 1024,
});

const KIND_CODE = { terrain: 1, statics: 2, buildings: 3 };
const TILE_CODE = { EMPTY: 0, FETCHING: 1, STAGED: 2, LIVE: 3, PARKED: 4, QUARANTINED: 5 };

let _enabled; // undefined = unread
/** `?residencyLog=on` (exact-match opt-in: absent / anything else = OFF). */
export function residencyLogEnabled(search) {
  if (search === undefined && _enabled !== undefined) return _enabled;
  let on = false;
  try {
    const s = search !== undefined ? search : (globalThis.location?.search || "");
    const v = (new URLSearchParams(s).get("residencyLog") || "").toLowerCase();
    on = v === "on" || v === "1" || v === "true" || v === "yes";
  } catch (_) { on = false; }
  if (search === undefined) _enabled = on;
  return on;
}
/** Test seam: force on/off (undefined re-reads the URL). */
export function __setResidencyLogForTest(v) { _enabled = v; }

// ---------------------------------------------------------------------------
// The event store (ring buffer of parallel typed arrays)
// ---------------------------------------------------------------------------
const _ev = {
  t: new Float64Array(CAP),
  lb: new Uint32Array(CAP),
  kind: new Uint8Array(CAP),
  a: new Int32Array(CAP),
  b: new Int32Array(CAP),
  n: 0,            // total ever written
};
function _now() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}
function _push(t, lb, kind, a, b) {
  const i = _ev.n & (CAP - 1);
  _ev.t[i] = t; _ev.lb[i] = lb >>> 0; _ev.kind[i] = kind; _ev.a[i] = a | 0; _ev.b[i] = b | 0;
  _ev.n += 1;
}

/** Producer hook: one event (no-op unless `?residencyLog=on`). */
export function rlogEvent(kind, lbKey, a = 0, b = 0) {
  if (!residencyLogEnabled()) return;
  _push(_now(), lbKey >>> 0, kind, a, b);
}
/** Producer hook for the bake guard (kind string → code). */
export function rlogBake(kind, phase, lbKey, x = 0) {
  if (!residencyLogEnabled()) return;
  const code = KIND_CODE[kind] || 0;
  const k = phase === "start" ? RLOG.BAKE_START : phase === "done" ? RLOG.BAKE_DONE : RLOG.BAKE_FAIL;
  _push(_now(), lbKey >>> 0, k, code, x);
  if (phase === "start") _agg.bakeStarts += 1;
  else if (phase === "done") { _agg.bakeDones += 1; _agg.bakeMsSum += x; }
  else _agg.bakeFails += 1;
}
/** Producer hook: count a guard cap skip (aggregate only; too frequent to log). */
export function rlogBakeSkip(reason) {
  if (!residencyLogEnabled()) return;
  if (reason === "cap") _agg.skipCap += 1;
  else if (reason === "cooldown") _agg.skipCooldown += 1;
  else _agg.skipInFlight += 1;
}

/** Events as plain objects (optionally only those at/after `sinceMs`). */
export function rlogEvents(sinceMs = -Infinity) {
  const out = [];
  const n = _ev.n;
  const start = Math.max(0, n - CAP);
  for (let j = start; j < n; j += 1) {
    const i = j & (CAP - 1);
    if (_ev.t[i] < sinceMs) continue;
    out.push({ t: _ev.t[i], lb: _ev.lb[i], kind: _ev.kind[i], a: _ev.a[i], b: _ev.b[i] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/residency_log.test.mjs)
// ---------------------------------------------------------------------------
export function lbKeyXY(x, y) { return (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0; }
export function lbX(k) { return (k >>> 24) & 0xff; }
export function lbY(k) { return (k >>> 16) & 0xff; }
export function cheb(a, b) { return Math.max(Math.abs(lbX(a) - lbX(b)), Math.abs(lbY(a) - lbY(b))); }

export function tDrawn(bits) { return (bits & BIT.TB) !== 0 && (bits & BIT.TP) === 0; }
export function oDrawn(bits) {
  return (bits & (BIT.SB | BIT.BB)) !== 0 && (bits & BIT.OH) === 0 && (bits & BIT.TP) === 0;
}
export function farDrawn(bits) { return (bits & BIT.FC) !== 0 && (bits & BIT.FD) === 0; }
export function isHole(bits) { return !tDrawn(bits) && !farDrawn(bits) && (bits & BIT.WT) === 0; }

export function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/**
 * Flicker: per landblock, the visibility history [{t, on, d}] (d = Chebyshev
 * distance to the aircraft at that moment). A FLIP is two consecutive changes
 * less than `windowMs` apart while the landblock was within `rangeLb` at both
 * (it changed visibility, then changed back, without leaving range).
 * Returns {flips, lbs:[{lb, flips}]}.
 */
export function computeFlips(histories, windowMs, rangeLb) {
  let flips = 0;
  const lbs = [];
  for (const [lb, h] of histories) {
    let n = 0;
    for (let i = 1; i < h.length; i += 1) {
      const p = h[i - 1], c = h[i];
      if (c.on === p.on) continue;
      if (c.t - p.t > windowMs) continue;
      if (p.d > rangeLb || c.d > rangeLb) continue;
      n += 1;
    }
    if (n > 0) { flips += n; lbs.push({ lb, flips: n }); }
  }
  lbs.sort((a, b) => b.flips - a.flips);
  return { flips, lbs };
}

/**
 * Lead time for one crossing: the landblock became ready at `readyT` (the start
 * of its current drawn streak, null = not ready yet) and the aircraft entered it
 * at `enterT`. Positive = ready ahead of arrival, in seconds.
 */
export function leadSeconds(enterT, readyT) {
  if (readyT == null) return null;
  return (enterT - readyT) / 1000;
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------
const _st = {
  bits: new Map(),        // lbKey -> bits (last sample)
  drawnSince: new Map(),  // lbKey -> {t: tDrawn streak start | null, o: oDrawn streak start | null}
  oHist: new Map(),       // lbKey -> [{t, on, d}] (object visibility changes, capped)
  tHist: new Map(),       // lbKey -> [{t, on, d}] (terrain visibility changes, capped)
  tiles: new Map(),       // tileKey -> state code
  centre: 0,
  centreAt: 0,
  crossings: [],          // [{lb, t, leadT, leadO, pendT, pendO}]
  holeFrames: 0,
  holeVisFrames: 0,         // frames with a hole closer than the fog's far (one the eye can see)
  holeVisLbFrames: 0,
  hardToggles: 0,           // object visibility switches within the window while visibly present (pops)
  softToggles: 0,           // the same switches made at presence ~0 (faded)
  holeLbFrames: 0,
  holeAheadLbFrames: 0,
  holeSpans: new Map(),   // lbKey -> start t
  holeLog: [],            // [{lb, t0, ms, d}]
  frames: 0,
  lastFrameT: 0,
  frameMs: [],            // frame gaps in the current second
  rows: [],
  lastRowT: 0,
  lastPos: null,
  loaf: null,
  loafScripts: new Map(),
  startedAt: 0,
};
const _agg = {
  bakeStarts: 0, bakeDones: 0, bakeFails: 0, bakeMsSum: 0,
  skipCap: 0, skipCooldown: 0, skipInFlight: 0,
};
const _aggPrev = { ..._agg };
const HIST_CAP = 64;

function _pushHist(map, lb, rec) {
  let h = map.get(lb);
  if (!h) { h = []; map.set(lb, h); }
  h.push(rec);
  if (h.length > HIST_CAP) h.splice(0, h.length - HIST_CAP);
}

function _objRadiusHides(scene3d, k) {
  const st = scene3d?._objRadius;
  return !!st && st.hidden instanceof Set && st.hidden.has(k);
}

let _farProbe = null;     // installed by far_terrain.js (farRingProbe)
let _presenceProbe = null; // installed by lb_presence.js (Phase 1)
let _farForestProbe = null; // installed by far_forest.js (Phase 2)
// The retail tall-tree census per landblock (dist/world/world_trees.u8, 255 x 255, index y * 255 + x — the world
// tier's canopy tint reads the same file): tree coverage counts only landblocks that HAVE trees, so desert, sea
// and fields do not read as missing forest (1070 arm G: the 1-3 km "coverage" fell to 0 over the southern desert).
let _treeCensus = null;
let _treeCensusLoading = false;
/** Test seam / override: `(x, y) => tall-tree count`, or null for "every landblock counts". */
export function rlogSetTreeCensus(fn) { _treeCensus = typeof fn === "function" ? fn : null; }
function _loadTreeCensus() {
  if (_treeCensus || _treeCensusLoading || typeof fetch !== "function") return;
  _treeCensusLoading = true;
  fetch("../../dist/world/world_trees.u8")
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => {
      if (!buf || buf.byteLength !== 255 * 255) return;
      const t = new Uint8Array(buf);
      _treeCensus = (x, y) => (x >= 0 && y >= 0 && x < 255 && y < 255 ? t[y * 255 + x] : 0);
    })
    .catch(() => { /* coverage falls back to every landblock */ });
}
/** far_terrain.js registers `() => ({plb:{x,y}, nearFadeLb, covered(lbx,lby)})`. */
export function rlogSetFarProbe(fn) { _farProbe = typeof fn === "function" ? fn : null; }
/** lb_presence.js registers `(lbKey) => objectPresence 0..1 | null` (null = never seen by the field). */
export function rlogSetPresenceProbe(fn) { _presenceProbe = typeof fn === "function" ? fn : null; }
let _objFadeActive = false;
/** index.js: object materials really fade (?objFade, or the far-forest crossfade) — a switch at presence ~0 is soft. */
export function rlogSetObjFadeActive(on) { _objFadeActive = !!on; }
/** far_forest.js registers `(lbKey) => bool` (impostors drawn for the LB). */
export function rlogSetFarForestProbe(fn) { _farForestProbe = typeof fn === "function" ? fn : null; }
let _worldTierProbe = null;
/** world_terrain.js registers `(lbKey) => bool` (the world tier draws ground there). */
export function rlogSetWorldTierProbe(fn) { _worldTierProbe = typeof fn === "function" ? fn : null; }

function _sampleBits(scene3d, k, far, grid, rg, lru) {
  let b = 0;
  // A terrain LOD re-bake clears the baked mark while the OLD mesh stays drawn
  // until the replacement lands (terrain.js drainOneTerrainLodRebake): count it
  // as drawn, or every re-bake reads as a hole.
  if (scene3d.terrainBakedLbs?.has?.(k) || scene3d._lodRebakeInFlight?.has?.(k)) b |= BIT.TB;
  try { if (lru?.isParked?.(k)) b |= BIT.TP; } catch (_) { /* no lru */ }
  // objects count once their nodes are ATTACHED (index.js stamps scene3d._objAttach after the bake; the
  // baked marks are set before the fetch, so they say nothing about what is on screen)
  const att = scene3d._objAttach?.get?.(k);
  if (scene3d.staticsBakedLbs?.has?.(k) && att && att.s > 0) b |= BIT.SB;
  if (scene3d.buildingsBakedLbs?.has?.(k) && att && att.b > 0) b |= BIT.BB;
  if (_objRadiusHides(scene3d, k)) b |= BIT.OH;
  if (far) {
    const x = lbX(k), y = lbY(k);
    if (far.covered(x, y)) b |= BIT.FC;
    if (far.plb && Number.isFinite(far.nearFadeLb)) {
      const d = Math.max(Math.abs(x - far.plb.x), Math.abs(y - far.plb.y));
      if (d < far.nearFadeLb) b |= BIT.FD;
    }
  }
  if (grid && rg) {
    try {
      const st = grid.stateOf(rg.tileOfLb(lbX(k), lbY(k)));
      if (st === "LIVE") b |= BIT.GL;
    } catch (_) { /* no grid */ }
  }
  if (_presenceProbe) {
    try { const v = _presenceProbe(k); if (v != null && v > 0.001 && v < 0.999) b |= BIT.PF; } catch (_) { /* fail-soft */ }
  }
  if (_farForestProbe) { try { if (_farForestProbe(k)) b |= BIT.FF; } catch (_) { /* fail-soft */ } }
  if (_worldTierProbe) { try { if (_worldTierProbe(k)) b |= BIT.WT; } catch (_) { /* fail-soft */ } }
  return b;
}

let _rgMod = null; // residency_grid.js (tileOfLb), injected by the caller to keep this module a leaf
/** index.js passes the residency_grid module so tile states can be sampled. */
export function rlogSetGridModule(mod) { _rgMod = mod || null; }

/**
 * Per-frame tick. `pose` = {x, y, z} AC metres of the aircraft / player rig
 * (null = unknown); `centreLb` = its landblock key; `groundZ(x, y)` = terrain
 * height sampler (optional).
 */
export function tickResidencyLog(scene3d, { centreLb, pose = null, groundZ = null, viewRadiusLb = null, objRadiusLb = null } = {}) {
  if (!residencyLogEnabled() || !scene3d || !centreLb) return;
  const t = _now();
  if (_st.startedAt === 0) { _st.startedAt = t; _installLoaf(); }
  // frame timing
  if (_st.lastFrameT > 0) _st.frameMs.push(t - _st.lastFrameT);
  _st.lastFrameT = t;
  _st.frames += 1;

  const c = centreLb >>> 0;
  if (c !== _st.centre) {
    const prev = _st.centre;
    _st.centre = c;
    _st.centreAt = t;
    _push(t, c, RLOG.CENTRE, prev, 0);
    if (prev !== 0) _noteCrossing(c, t);
  }
  const lru = scene3d.landblockLru || null;
  const grid = scene3d._slotGridCtl?.grid || null;
  let far = null;
  if (_farProbe) { try { far = _farProbe(); } catch (_) { far = null; } }
  const viewR = Number.isFinite(viewRadiusLb) ? viewRadiusLb
    : Math.max(Number.isFinite(scene3d.pvsRingRadius) ? scene3d.pvsRingRadius : 5, VIEW_R_FALLBACK);
  const objR = Number.isFinite(objRadiusLb) ? objRadiusLb : 4;
  const cx = lbX(c), cy = lbY(c);
  const seenNow = new Set();
  let holeLbs = 0, holeAhead = 0, holeVis = 0;
  // a landblock at Chebyshev d is at least (d − 1) × 192 m away; visible while that is inside the fog's far
  const fogFar = Number.isFinite(scene3d?.scene?.fog?.far) ? scene3d.scene.fog.far : Infinity;
  const vel = _velocity();
  for (let dx = -SAMPLE_R; dx <= SAMPLE_R; dx += 1) {
    const x = cx + dx;
    if (x < 0 || x > 0xff) continue;
    for (let dy = -SAMPLE_R; dy <= SAMPLE_R; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y > 0xff) continue;
      const k = lbKeyXY(x, y);
      seenNow.add(k);
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const bits = _sampleBits(scene3d, k, far, grid, _rgMod, lru);
      const old = _st.bits.get(k);
      if (old === undefined) {
        _st.bits.set(k, bits);
        _st.drawnSince.set(k, { t: tDrawn(bits) ? t : null, o: oDrawn(bits) ? t : null });
      } else if (old !== bits) {
        _st.bits.set(k, bits);
        _push(t, k, RLOG.STATE, bits, old);
        const ds = _st.drawnSince.get(k) || { t: null, o: null };
        const tn = tDrawn(bits), to = tDrawn(old);
        if (tn !== to) { ds.t = tn ? t : null; _pushHist(_st.tHist, k, { t, on: tn, d }); }
        const on = oDrawn(bits), oo = oDrawn(old);
        if (on !== oo) {
          ds.o = on ? t : null;
          _pushHist(_st.oHist, k, { t, on, d });
          // Q2: a toggle is HARD when the objects were (or became) visibly present at the switch; with the
          // ?lbFade presence field a hide commits at presence 0 and an arrival starts at 0 (soft).
          if (d <= objR + 1) {
            let pv = null;
            if (_presenceProbe) { try { pv = _presenceProbe(k); } catch (_) { pv = null; } }
            if (_objFadeActive && pv != null && pv <= 0.05) _st.softToggles += 1; else _st.hardToggles += 1;
          }
        }
        _st.drawnSince.set(k, ds);
        _resolvePending(k, t, tn && !to, on && !oo);
      }
      if (d <= viewR && isHole(bits)) {
        holeLbs += 1;
        if (vel && _aheadOf(dx, dy, vel)) holeAhead += 1;
        if ((d - 1) * 192 < fogFar) holeVis += 1;
        if (!_st.holeSpans.has(k)) _st.holeSpans.set(k, t);
      } else if (_st.holeSpans.has(k)) {
        const t0 = _st.holeSpans.get(k);
        _st.holeSpans.delete(k);
        if (_st.holeLog.length < 20000) _st.holeLog.push({ lb: k, t0, ms: Math.round(t - t0), d });
      }
    }
  }
  // landblocks that left the window: forget their sample (they re-enter fresh)
  if (_st.bits.size > seenNow.size) {
    for (const k of _st.bits.keys()) {
      if (!seenNow.has(k)) { _st.bits.delete(k); _st.drawnSince.delete(k); _st.holeSpans.delete(k); }
    }
  }
  if (holeLbs > 0) { _st.holeFrames += 1; _st.holeLbFrames += holeLbs; _st.holeAheadLbFrames += holeAhead; }
  if (holeVis > 0) { _st.holeVisFrames += 1; _st.holeVisLbFrames += holeVis; }
  _sampleTiles(grid, t);
  // pose for speed / AGL
  if (pose && Number.isFinite(pose.x)) {
    const lp = _st.lastPos;
    _st.lastPos = { x: pose.x, y: pose.y, z: pose.z, t };
    if (lp && t > lp.t) {
      const dt = (t - lp.t) / 1000;
      _st.vel = { x: (pose.x - lp.x) / dt, y: (pose.y - lp.y) / dt, z: (pose.z - lp.z) / dt, t };
    }
  }
  if (t - _st.lastRowT >= 1000) {
    _st.lastRowT = t;
    _emitRow(scene3d, t, { pose, groundZ, objR, viewR, grid, far });
  }
}

function _velocity() {
  const v = _st.vel;
  if (!v) return null;
  const s = Math.hypot(v.x, v.y);
  return s > 5 ? { x: v.x / s, y: v.y / s, speed: s } : null;
}
function _aheadOf(dx, dy, vel) {
  const n = Math.hypot(dx, dy);
  if (n === 0) return false;
  return (dx * vel.x + dy * vel.y) / n > 0.5; // within ±60° of the travel direction
}

function _noteCrossing(k, t) {
  const ds = _st.drawnSince.get(k);
  const bits = _st.bits.get(k) ?? 0;
  const rec = {
    lb: k, t,
    leadT: tDrawn(bits) && ds?.t != null ? leadSeconds(t, ds.t) : null,
    leadO: oDrawn(bits) && ds?.o != null ? leadSeconds(t, ds.o) : null,
    pendT: !tDrawn(bits),
    pendO: !oDrawn(bits),
  };
  _st.crossings.push(rec);
  if (_st.crossings.length > 5000) _st.crossings.shift();
}
function _resolvePending(k, t, tBecame, oBecame) {
  if (!tBecame && !oBecame) return;
  for (let i = _st.crossings.length - 1; i >= 0 && i >= _st.crossings.length - 64; i -= 1) {
    const r = _st.crossings[i];
    if (r.lb !== k) continue;
    if (tBecame && r.pendT) { r.pendT = false; r.leadT = leadSeconds(r.t, t); }
    if (oBecame && r.pendO) { r.pendO = false; r.leadO = leadSeconds(r.t, t); }
    break;
  }
}

function _sampleTiles(grid, t) {
  if (!grid || !grid.records) return;
  // only the records map (window + hysteresis + parked): ~36-80 entries
  const seen = new Set();
  for (const [tile, rec] of grid.records) {
    seen.add(tile);
    const code = TILE_CODE[rec.state] ?? 9;
    const old = _st.tiles.get(tile);
    if (old !== code) {
      _st.tiles.set(tile, code);
      // tile key → first LB of the tile (2x2 LBs; residency_grid tileLbKeys)
      const tx = (tile >> 8) & 0xff, ty = tile & 0xff;
      _push(t, lbKeyXY(tx * 2, ty * 2), RLOG.TILE, code, old ?? -1);
    }
  }
  for (const tile of _st.tiles.keys()) if (!seen.has(tile)) _st.tiles.delete(tile);
}

function _installLoaf() {
  try {
    if (typeof PerformanceObserver === "undefined") return;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = e.scripts || [];
        for (const s of scripts) {
          const key = `${s.sourceFunctionName || "?"} @ ${(s.sourceURL || "").replace(/^.*\//, "")}`;
          const rec = _st.loafScripts.get(key) || { n: 0, ms: 0, max: 0 };
          rec.n += 1; rec.ms += s.duration; if (s.duration > rec.max) rec.max = s.duration;
          _st.loafScripts.set(key, rec);
        }
      }
    });
    po.observe({ type: "long-animation-frame", buffered: false });
    _st.loaf = po;
  } catch (_) { _st.loaf = null; }
}

function _coverage(scene3d, pose) {
  // per band: landblocks whose centre lies in the band, how many draw objects
  // (real meshes, O_DRAWN) or far-forest impostors (FF), at any LOD
  if (!pose || !Number.isFinite(pose.x)) return null;
  const out = COVER_BANDS_M.map(([lo, hi]) => ({ lo, hi, n: 0, near: 0, far: 0, any: 0 }));
  const maxM = COVER_BANDS_M[COVER_BANDS_M.length - 1][1];
  const r = Math.ceil(maxM / 192) + 1;
  const px = pose.x, py = pose.y;
  const cx = Math.floor(px / 192), cy = Math.floor(py / 192);
  const lru = scene3d.landblockLru || null;
  for (let x = cx - r; x <= cx + r; x += 1) {
    if (x < 0 || x > 0xff) continue;
    const ex = (x + 0.5) * 192 - px;
    for (let y = cy - r; y <= cy + r; y += 1) {
      if (y < 0 || y > 0xff) continue;
      const ey = (y + 0.5) * 192 - py;
      const dist = Math.hypot(ex, ey);
      if (dist >= maxM) continue;
      const band = out.find((b) => dist >= b.lo && dist < b.hi);
      if (!band) continue;
      if (_treeCensus && !(_treeCensus(x, y) > 0)) continue; // no trees there: not part of tree coverage
      const k = lbKeyXY(x, y);
      band.n += 1;
      let parked = false;
      try { parked = !!lru?.isParked?.(k); } catch (_) { parked = false; }
      const att = scene3d._objAttach?.get?.(k);
      const near = ((scene3d.staticsBakedLbs?.has?.(k) && att && att.s > 0) || (scene3d.buildingsBakedLbs?.has?.(k) && att && att.b > 0))
        && !_objRadiusHides(scene3d, k) && !parked;
      let ff = false;
      if (_farForestProbe) { try { ff = !!_farForestProbe(k); } catch (_) { ff = false; } }
      if (near) band.near += 1;
      if (ff) band.far += 1;
      if (near || ff) band.any += 1;
    }
  }
  return out.map((b) => ({ band: `${b.lo / 1000}-${b.hi / 1000}km`, lbs: b.n, near: b.n ? +(b.near / b.n).toFixed(3) : 0, far: b.n ? +(b.far / b.n).toFixed(3) : 0, any: b.n ? +(b.any / b.n).toFixed(3) : 0 }));
}

function _emitRow(scene3d, t, { pose, groundZ, objR, viewR, grid, far }) {
  const fm = _st.frameMs;
  _st.frameMs = [];
  let tD = 0, oD = 0, oIn = 0, holes = 0;
  for (const [k, bits] of _st.bits) {
    const d = cheb(k, _st.centre);
    if (d <= viewR && tDrawn(bits)) tD += 1;
    if (d <= objR) { oIn += 1; if (oDrawn(bits)) oD += 1; }
    if (d <= viewR && isHole(bits)) holes += 1;
  }
  let agl = null;
  if (pose && typeof groundZ === "function") {
    try { const g = groundZ(pose.x, pose.y); if (Number.isFinite(g)) agl = pose.z - g; } catch (_) { agl = null; }
  }
  const v = _st.vel;
  const inFlight = scene3d._streamGuardState?.inFlight?.size ?? null;
  const d = {};
  for (const k of Object.keys(_agg)) { d[k] = _agg[k] - _aggPrev[k]; _aggPrev[k] = _agg[k]; }
  let gridCounts = null;
  try { gridCounts = grid?.counts?.() ?? null; } catch (_) { gridCounts = null; }
  const row = {
    t: +((t - _st.startedAt) / 1000).toFixed(1),
    lb: _st.centre.toString(16).padStart(8, "0"),
    x: pose ? +pose.x.toFixed(1) : null, y: pose ? +pose.y.toFixed(1) : null, z: pose ? +pose.z.toFixed(1) : null,
    agl: agl == null ? null : +agl.toFixed(1),
    speed: v ? +Math.hypot(v.x, v.y).toFixed(1) : null,
    vz: v ? +v.z.toFixed(1) : null,
    terrainDrawn: tD, objWindow: oIn, objDrawn: oD, holes,
    farNearFadeLb: far && Number.isFinite(far.nearFadeLb) ? +far.nearFadeLb.toFixed(2) : null,
    fogFar: Number.isFinite(scene3d?.scene?.fog?.far) ? Math.round(scene3d.scene.fog.far) : null,
    bakes: d, inFlight,
    grid: gridCounts,
    fps: fm.length ? +(1000 / (fm.reduce((a, x) => a + x, 0) / fm.length)).toFixed(1) : null,
    frameP50: fm.length ? +percentile(fm, 50).toFixed(1) : null,
    frameP99: fm.length ? +percentile(fm, 99).toFixed(1) : null,
    frameMax: fm.length ? +Math.max(...fm).toFixed(1) : null,
    cover: _coverage(scene3d, pose),
  };
  _st.rows.push(row);
  if (_st.rows.length > 7200) _st.rows.shift();
}

// ---------------------------------------------------------------------------
// Queries (window.__residency)
// ---------------------------------------------------------------------------
export function residencyFlips(windowSec = 10, { objRangeLb = 5, terrainRangeLb = 5 } = {}) {
  const wms = windowSec * 1000;
  const o = computeFlips(_st.oHist, wms, objRangeLb);
  const tr = computeFlips(_st.tHist, wms, terrainRangeLb);
  const fmt = (r) => ({ flips: r.flips, lbs: r.lbs.slice(0, 20).map((x) => ({ lb: x.lb.toString(16).padStart(8, "0"), flips: x.flips })) });
  return { windowSec, objects: fmt(o), terrain: fmt(tr) };
}

export function residencyLeadTimes() {
  const rows = _st.crossings.map((r) => ({
    lb: r.lb.toString(16).padStart(8, "0"), t: +((r.t - _st.startedAt) / 1000).toFixed(1),
    leadT: r.leadT == null ? null : +r.leadT.toFixed(2), leadO: r.leadO == null ? null : +r.leadO.toFixed(2),
    pendT: r.pendT, pendO: r.pendO,
  }));
  const lt = rows.map((r) => r.leadT).filter((x) => x != null);
  const lo = rows.map((r) => r.leadO).filter((x) => x != null);
  return {
    crossings: rows.length,
    terrain: { n: lt.length, p5: percentile(lt, 5), p50: percentile(lt, 50), min: lt.length ? Math.min(...lt) : null, neverReady: rows.filter((r) => r.pendT).length },
    objects: { n: lo.length, p5: percentile(lo, 5), p50: percentile(lo, 50), min: lo.length ? Math.min(...lo) : null, neverReady: rows.filter((r) => r.pendO).length },
    rows,
  };
}

export function residencyHoles() {
  const spans = _st.holeLog.slice();
  for (const [lb, t0] of _st.holeSpans) spans.push({ lb, t0, ms: Math.round(_now() - t0), d: cheb(lb, _st.centre), open: true });
  const ms = spans.map((s) => s.ms);
  return {
    frames: _st.frames, holeFrames: _st.holeFrames, holeLbFrames: _st.holeLbFrames, holeAheadLbFrames: _st.holeAheadLbFrames,
    visibleHoleFrames: _st.holeVisFrames, visibleHoleLbFrames: _st.holeVisLbFrames,
    spans: spans.length, spanP50: percentile(ms, 50), spanMax: ms.length ? Math.max(...ms) : null,
    worst: spans.sort((a, b) => b.ms - a.ms).slice(0, 15).map((s) => ({ lb: s.lb.toString(16).padStart(8, "0"), ms: s.ms, d: s.d, t: +((s.t0 - _st.startedAt) / 1000).toFixed(1) })),
  };
}

export function residencySummary({ flipWindowSec = 10 } = {}) {
  const rows = _st.rows;
  const fr = rows.map((r) => r.fps).filter((x) => x != null);
  const cover = (band) => {
    const xs = rows.map((r) => r.cover?.find((c) => c.band === band)?.any).filter((x) => x != null);
    return xs.length ? +(xs.reduce((a, x) => a + x, 0) / xs.length).toFixed(3) : null;
  };
  const counts = {};
  const n = _ev.n, start = Math.max(0, n - CAP);
  for (let j = start; j < n; j += 1) {
    const kd = _ev.kind[j & (CAP - 1)];
    counts[kd] = (counts[kd] || 0) + 1;
  }
  const loaf = [..._st.loafScripts.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
    .map(([k, v]) => ({ script: k, n: v.n, ms: Math.round(v.ms), max: Math.round(v.max) }));
  return {
    seconds: rows.length,
    events: _ev.n,
    eventsByKind: Object.fromEntries(Object.entries(counts).map(([k, v]) => [Object.keys(RLOG).find((x) => RLOG[x] === +k) || k, v])),
    flips: residencyFlips(flipWindowSec),
    toggles: { hard: _st.hardToggles, soft: _st.softToggles },
    lead: (() => { const l = residencyLeadTimes(); delete l.rows; return l; })(),
    holes: (() => { const h = residencyHoles(); return h; })(),
    fps: { p50: percentile(fr, 50), p5: percentile(fr, 5) },
    frameP99Max: rows.length ? Math.max(...rows.map((r) => r.frameP99 ?? 0)) : null,
    frameMaxAfter60s: (() => { const xs = rows.filter((r) => r.t > 60).map((r) => r.frameMax ?? 0); return xs.length ? Math.max(...xs) : null; })(),
    cover: { "0-1km": cover("0-1km"), "1-3km": cover("1-3km"), "3-10km": cover("3-10km") },
    bakes: { ..._agg },
    loaf,
  };
}

export function residencyClear() {
  _ev.n = 0;
  _st.bits.clear(); _st.drawnSince.clear(); _st.oHist.clear(); _st.tHist.clear(); _st.tiles.clear();
  _st.crossings.length = 0; _st.holeFrames = 0; _st.holeLbFrames = 0; _st.holeAheadLbFrames = 0;
  _st.holeVisFrames = 0; _st.holeVisLbFrames = 0;
  _st.hardToggles = 0; _st.softToggles = 0;
  _st.holeSpans.clear(); _st.holeLog.length = 0; _st.frames = 0; _st.rows.length = 0;
  _st.loafScripts.clear(); _st.startedAt = 0; _st.lastFrameT = 0; _st.centre = 0; _st.lastRowT = 0;
  for (const k of Object.keys(_agg)) { _agg[k] = 0; _aggPrev[k] = 0; }
}

/** Install `window.__residency` (idempotent). */
export function installResidencyLogProbe() {
  if (typeof window === "undefined" || !residencyLogEnabled()) return;
  if (window.__residency) return;
  _loadTreeCensus();
  window.__residency = {
    events: (sinceSec) => rlogEvents(sinceSec == null ? -Infinity : _st.startedAt + sinceSec * 1000),
    flips: (windowSec, opts) => residencyFlips(windowSec, opts),
    leadTimes: () => residencyLeadTimes(),
    holes: () => residencyHoles(),
    rows: (sinceSec = 0) => _st.rows.filter((r) => r.t >= sinceSec),
    summary: (opts) => residencySummary(opts),
    clear: () => residencyClear(),
    // compact full dump for the bench: events as columns (t rel ms, lb hex, kind, a, b)
    dump: () => {
      const ev = rlogEvents();
      return {
        startedAt: _st.startedAt,
        kinds: RLOG,
        bits: BIT,
        events: ev.map((e) => [Math.round(e.t - _st.startedAt), e.lb.toString(16).padStart(8, "0"), e.kind, e.a, e.b]),
        rows: _st.rows,
        lead: residencyLeadTimes(),
        holes: residencyHoles(),
        summary: residencySummary(),
      };
    },
  };
}
