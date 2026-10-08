// scene3d/visual_ground.js — TERRAIN ROUNDING STEP 3: whatever stands on the
// ground is DRAWN standing on the drawn (rounded) ground.
//
// ===========================================================================
// HISTORY (2026-10-07, owner-approved terrain plan, step 3)
// ===========================================================================
//   Steps 1-2 (scene3d/terrain_round.js) round the DRAWN terrain: a shading
//   bevel plus a centimetre fillet that moves only in-cell subdivided points —
//   every retail 9x9 vertex keeps its exact height. Physics, ACE positions and
//   every PhysObj/GfxObj placement stay on the retail triangles (the earlier
//   approach moved retail vertices and floated the owner ~0.5 m above a
//   rounded peak: "we need compatibility with legacy").
//   This module is the other half of that contract. The drawn ground is
//   DETACHED from the physics ground for things standing on it, by a
//   RENDER-ONLY vertical offset
//
//       dz(x, y) = visualZ(x, y) - physicsZ(x, y)
//
//   so feet meet the rounded surface while server positions, client physics,
//   pick distances, targeting and collision all stay on the retail surface.
//   Today |dz| <= 8 cm (terrainRoundMax); the point is that stronger rounding
//   (terrainRoundMax 0.5, terrainRoundLevel 4/8, synthesized detail) can land
//   later without feet floating or sinking.
//
// ===========================================================================
// 1. THE ONE AUTHORITATIVE FUNCTION — visualGroundDeltaAt(acX, acY, lbKey)
// ===========================================================================
//   The drawn terrain at a point is the subdivided triangle that contains it,
//   with its three vertices lifted by `aRoundZ * w` (terrain_round.js vertex
//   shader; w = uRoundScale * fade). The faceted physics surface is planar on
//   that same triangle (terrain_subdiv.rs: every sub-quad inherits its retail
//   cell's split diagonal), so visual - physics is EXACTLY the planar
//   interpolation of the three baked offsets on the drawn triangle, times w:
//     * the offsets are the very Float32Array the terrain bake uploaded
//       (`noteVisualGroundBake`, called after the LB mesh is attached), so it
//       is bit-for-bit the bake: same retail heights, split, cap, width,
//       subdivision factor and the neighbour heights seen at bake time;
//     * the triangle is picked the way the index buffer splits the sub-quad
//       (`triangleHeightInCell` with the retail cell's `cellSwToNeCut`);
//     * w is `terrainRoundFilletWeight(camDist)` — the live uniforms.
//   0 at every retail vertex (the offsets are exactly 0 there), 0 on an LB
//   drawn at factor 1 (no fillet), 0 with `?terrainRound=off` (no offsets are
//   ever baked) and 0 with this module's own escape. O(1): one Map lookup, a
//   split hash and a 3-tap interpolation, no allocation.
//
// ===========================================================================
// 2. WHO GETS IT (render-only)
// ===========================================================================
//   ENTITIES (creatures, players, NPCs, corpses, items on the ground): the
//     rig root keeps its PHYSICS position; only its local MATRIX gets +dz
//     (an own `updateMatrix` on the root, installed by `installVisualGround
//     Root`). Everything under the root — parts, held items (parented to a
//     hand part), nameplate sprites, the death ragdoll's root-local nodes —
//     follows the drawn body; everything that reads `root.position` (camera
//     follow, separation, targeting/range maths, picking.js
//     `entityAcPosition`, dead-reckon, ragdoll_env's physics floor) is
//     untouched. Computed at most once per entity per frame (memo below).
//     INVARIANT: never `root.applyMatrix4(m)` / `parent.attach(root)` — three
//     decomposes the (offset) matrix back into `position` there, which would
//     leak dz into physics. Neither is used on entity roots today (audited
//     2026-10-07: scene3d/app/plugins); attach uses `mount.add(root)`.
//   STATICS (LandblockInfo props, scenery trees/rocks, animated scenery, wind
//     trees, every batch/atlas/pool path): baked ONCE into the placement's z
//     before any node is built (`applyVisualGroundToPlacements`), so the
//     instanced/batched matrices carry it with zero per-frame cost.
//   NEVER: indoor/EnvCell objects; anything attached to a parent; missiles in
//     flight; objects whose PhysicsState lacks GRAVITY (0x400 — doors and other
//     fixed weenies; ~every creature/item/corpse/portal/lifestone has it); and
//     anything not touching the ground — a smooth contact taper on the height
//     above the RETAIL ground (full <= 0.25 m, none >= 1.0 m) handles jumps
//     (no pop at take-off/landing), bridges, porches, tables, wall lamps.
//     Buildings are never offset (their EnvCell interiors are drawn at
//     physics), so things fixed to them are not either.
//
// ===========================================================================
// 3. DECISIONS (physics root vs visual root)
// ===========================================================================
//   camera follow ........ PHYSICS (camera.js reads the integrator/predicted
//                          pose; unchanged — no fillet kinks in the camera).
//   pick hit-test ........ VISUAL (raycasts the drawn rig: you click what you
//                          see); pick/target distances PHYSICS (root.position).
//   nameplates/brackets .. VISUAL (sprite is a root child; DOM plate and
//                          selection brackets read getWorldPosition) — they
//                          ride with the drawn body, never against it.
//   ragdoll / corpse ..... ragdoll_env keeps the PHYSICS floor (terrain oracle);
//                          the sim is root-local in the physics frame
//                          (ragdoll.js setSimRoot reads root.position) and the
//                          root's render offset lifts the whole settled body
//                          onto the drawn ground. One mechanism, no double
//                          offset, and the settled-body stacking registry stays
//                          in one frame. Residual: dz varies by <= cap across
//                          a 2 m body.
//   No jitter: dz is a continuous function of the physics position (the
//   drawn surface is C0, LB seams included — terrain_round samples shared
//   edges identically on both sides) times a smooth contact weight.
//
// ===========================================================================
// 4. STATICS AND TERRAIN LOD
// ===========================================================================
//   The drawn fillet depends on the LB's CURRENT subdivision factor, which the
//   LOD re-bake (terrain.js F12-6) changes as the player moves; statics are
//   baked once. They use the factor the LB is drawn at WHEN THE PLAYER IS
//   NEAR IT (Chebyshev <= 1: max(half the quality level, terrainRoundLevel) —
//   `visualGroundObjectLevel`, a mirror of terrain.js `pickSubdivLevelForLb`
//   pinned by the test), so they are exact where feet can be seen. Far away
//   (an LB drawn coarser) a static is off by at most the cap, at >= ~200 m.
//   With `terrainRoundLevel` >= half the quality level every LB shares one
//   factor and statics are exact everywhere — the recommended setting for a
//   stronger fillet. The baked offsets are used when the LB is already drawn
//   at that factor; otherwise the SAME `computeTerrainRoundOffsets` runs on
//   the same inputs (retail heights -> the f32 faceted positions of
//   terrain_subdiv.rs, emulated op-for-op with Math.fround), with all four
//   edge-neighbour heights (fetched if unseen): the bake only uses the
//   neighbours seen at ITS time, and by the time the player is near, the
//   neighbours (inside the streamed ring) have been. A neighbour unseen at
//   that later bake shifts only the edge cells, by <= the cap. Live
//   `__terrainRound.set({filletCm})` is not re-baked into statics (entities
//   follow it every frame); the default scale is 1.
//
// FLAG: `?terrainRoundObjects=off` (also 0/false) — no root override, no
// placement change: byte-identical to step 2. Also inert whenever the fillet
// is off (`?terrainRound=off`, `?terrainRoundMax=0`, wireframe).
// Diag: window.__visualGround (.at(x, y), .underPlayer(), .near(r),
// .entity(guid), .stats(), .staticsSample()).

import {
  TERRAIN_ROUND,
  computeTerrainRoundOffsets,
  terrainRoundNeighbours,
  terrainRoundFilletWeight,
  terrainRoundMinLevel,
} from "./terrain_round.js";
import { cellSwToNeCut, triangleHeightInCell } from "./terrain_oracle.js";
import { readLocalPlayerPose } from "./frame_pose.js";

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/**
 * `?terrainRoundObjects` — DEFAULT-ON, `off`/`0`/`false` escape. Effective
 * only while the terrain fillet itself is on.
 * @param {string} [search] query string (default: the page URL)
 * @param {object} [roundCfg] a readTerrainRoundConfig() result
 */
export function readVisualGroundConfig(search, roundCfg = TERRAIN_ROUND) {
  let raw = null;
  try {
    if (typeof search === "string") raw = new URLSearchParams(search).get("terrainRoundObjects");
    else if (typeof window !== "undefined" && window.location) {
      raw = new URLSearchParams(window.location.search || "").get("terrainRoundObjects");
    }
  } catch (_) {
    raw = null;
  }
  const v = typeof raw === "string" ? raw.toLowerCase() : "";
  const flagOn = !(v === "off" || v === "0" || v === "false");
  const filletOn = !!(roundCfg && roundCfg.enabled && roundCfg.fillet);
  return { enabled: flagOn && filletOn, flagOn, filletOn, raw };
}

const _cfg = readVisualGroundConfig();

/** True when this session draws objects on the rounded ground. */
export function visualGroundEnabled() {
  return _cfg.enabled;
}

/** Test seam: force the effective switch (node has no URL). */
export function _setVisualGroundEnabledForTest(on) {
  _cfg.enabled = !!on;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Height above the RETAIL ground at or below which the full offset applies. */
export const CONTACT_FULL_M = 0.25;
/** Height above the retail ground at or beyond which no offset applies. */
export const CONTACT_NONE_M = 1.0;
/** PhysicsState::GRAVITY (ACE PhysicsState.cs 0x400). */
export const PHYSICS_STATE_GRAVITY = 0x400;
/** Frames between re-reads of an entity's PhysicsState (staggered by guid). */
const STATE_REFRESH_FRAMES = 30;
const DRAWN_MAX = 512;     // LBs whose drawn fillet we remember (resident ring ~169)
const HEIGHTS_MAX = 1024;  // 81 floats each
const COMPUTED_MAX = 64;   // statics-level fields

/** Why an entity got (or did not get) the offset — `inst._vg.why`. */
export const VG_WHY = Object.freeze({
  APPLIED: 0,
  ATTACHED: 1,
  MISSILE: 2,
  INDOOR: 3,
  NO_GRAVITY: 4,
  NO_FILLET: 5,   // the LB under it is drawn without a fillet (factor 1 / not baked)
  ELEVATED: 6,    // >= CONTACT_NONE_M above the retail ground (jump apex, bridge, table)
  OFF: 7,
});
const WHY_NAMES = Object.keys(VG_WHY);

// ---------------------------------------------------------------------------
// Per-landblock caches (fed by the terrain bake)
// ---------------------------------------------------------------------------

const _heights = new Map();  // key16 -> Float32Array(81), x*9 + y (retail Z)
const _drawn = new Map();    // key16 -> { f, n, off: Float32Array|null, maxAbs }
const _computed = new Map(); // key16 * 16 + f -> { f, n, off: Float32Array|null }
let _gen = 0;                // bumped on every _drawn change
let _seenOpts = null;        // last terrain ring opts a bake reported

function _key16(lbX, lbY) {
  return ((lbX & 0xff) << 8) | (lbY & 0xff);
}

function _lru(map, key, value, cap) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= cap) map.delete(map.keys().next().value);
  map.set(key, value);
}

/**
 * Terrain-bake hook (terrain.js `bakeTerrainForLandblock`, right after the LB
 * mesh is attached): remember what this landblock now DRAWS.
 * @param {number} lbX
 * @param {number} lbY
 * @param {ArrayLike<number>} heights81 retail vertex Z, `x*9 + y`
 * @param {number} factor subdivision factor the mesh was built at
 * @param {Float32Array|null} offsets the uploaded `aRoundZ` array (null = none)
 * @param {object} [opts] the terrain ring opts (subdivLevel/roundMinLevel/canSubdivide)
 */
export function noteVisualGroundBake(lbX, lbY, heights81, factor, offsets, opts) {
  try {
    const key = _key16(lbX, lbY);
    if (heights81 && heights81.length >= 81) {
      const h = new Float32Array(81);
      for (let v = 0; v < 81; v += 1) h[v] = heights81[v];
      _lru(_heights, key, h, HEIGHTS_MAX);
      _heightsMissing.delete(key);
    }
    const f = factor | 0;
    const n = 8 * f + 1;
    const off = offsets && f >= 2 && offsets.length === n * n ? offsets : null;
    let maxAbs = 0;
    if (off) for (let v = 0; v < off.length; v += 1) { const a = Math.abs(off[v]); if (a > maxAbs) maxAbs = a; }
    _lru(_drawn, key, { f: Math.max(1, f), n, off, maxAbs }, DRAWN_MAX);
    // Statics fields of this LB were computed with the neighbours known then;
    // let the next statics bake recompute with the fresher set.
    for (const lvl of [2, 4, 8]) _computed.delete(key * 16 + lvl);
    if (opts && typeof opts === "object") {
      _seenOpts = {
        subdivLevel: opts.subdivLevel,
        roundMinLevel: opts.roundMinLevel,
        canSubdivide: opts.canSubdivide,
      };
    }
    _gen = (_gen + 1) | 0;
  } catch (_) { /* fail-soft: no record = no offset */ }
}

/** Test seam. */
export function _resetVisualGroundForTest() {
  _heights.clear(); _drawn.clear(); _computed.clear(); _heightsMissing.clear();
  _seenOpts = null; _gen = 0; _frame = 0;
  _sh = null; _localGuid = 0; _localIndoor = false; _liveW = 1; _fadeActive = false; _camAc = null;
  _staticsStats.lbs = 0; _staticsStats.placements = 0; _staticsStats.adjusted = 0;
  _staticsStats.maxAbsDz = 0; _staticsStats.elevated = 0; _staticsStats.noHeights = 0; _staticsStats.noLevel = 0;
  _staticsSample.length = 0;
}

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

/**
 * Planar interpolation of the per-vertex fillet offsets on the DRAWN
 * subdivided triangle containing LB-local (lx, ly) metres.
 * Layout = terrain_subdiv.rs: `idx = i*n + j`, i east, j north, n = 8f + 1;
 * sub-quad (i0, j0) belongs to retail cell (i0/f, j0/f) and inherits its split.
 */
export function filletOffsetAt(off, f, n, lbX, lbY, lx, ly) {
  let gi = (lx * f) / 24;
  let gj = (ly * f) / 24;
  const last = n - 1;
  if (!(gi > 0)) gi = 0; else if (gi > last) gi = last;
  if (!(gj > 0)) gj = 0; else if (gj > last) gj = last;
  let i0 = Math.floor(gi);
  let j0 = Math.floor(gj);
  if (i0 > last - 1) i0 = last - 1;
  if (j0 > last - 1) j0 = last - 1;
  const a = gi - i0;
  const b = gj - j0;
  const cu = (i0 / f) | 0;
  const cv = (j0 / f) | 0;
  const o = i0 * n + j0;
  const oSW = off[o];
  const oSE = off[o + n];
  const oNW = off[o + 1];
  const oNE = off[o + n + 1];
  // Explicit barycentric weights (the GPU's form, and the triangles of
  // terrain_subdiv.rs's index buffer): a weight of exactly 1 returns that
  // vertex's offset bit-for-bit — so every retail vertex reads exactly 0,
  // including the far LB edges where the sub-quad is clamped (a or b = 1).
  if (cellSwToNeCut(((lbX & 0xff) << 3) + cu, ((lbY & 0xff) << 3) + cv)) {
    // SW-NE diagonal: (SW, SE, NE) below it, (SW, NE, NW) above.
    if (a >= b) return oSW * (1 - a) + oSE * (a - b) + oNE * b;
    return oSW * (1 - b) + oNE * a + oNW * (b - a);
  }
  // NW-SE diagonal: (SW, SE, NW) below it, (NE, NW, SE) above.
  if (a + b <= 1) return oSW * (1 - a - b) + oSE * a + oNW * b;
  return oNE * (a + b - 1) + oNW * (1 - a) + oSE * (1 - b);
}

/** Retail (physics) terrain Z at LB-local (lx, ly) from the 81 heights. */
export function retailGroundZ(h, lbX, lbY, lx, ly) {
  let gx = lx / 24;
  let gy = ly / 24;
  if (!(gx > 0)) gx = 0; else if (gx > 8) gx = 8;
  if (!(gy > 0)) gy = 0; else if (gy > 8) gy = 8;
  const cu = Math.min(7, Math.floor(gx));
  const cv = Math.min(7, Math.floor(gy));
  const cut = cellSwToNeCut(((lbX & 0xff) << 3) + cu, ((lbY & 0xff) << 3) + cv);
  return triangleHeightInCell(
    h[cu * 9 + cv], h[(cu + 1) * 9 + cv], h[cu * 9 + cv + 1], h[(cu + 1) * 9 + cv + 1],
    gx - cu, gy - cv, cut);
}

const _fr = Math.fround;

/** terrain_subdiv.rs::triangle_height_in_cell in f32, op for op. */
function _triF32(z00, z10, z01, z11, fx, fy, cut) {
  if (cut) {
    if (fx >= fy) return _fr(_fr(z00 + _fr(_fr(z10 - z00) * fx)) + _fr(_fr(z11 - z10) * fy));
    return _fr(_fr(z00 + _fr(_fr(z11 - z01) * fx)) + _fr(_fr(z01 - z00) * fy));
  }
  if (_fr(fx + fy) <= 1) return _fr(_fr(z00 + _fr(_fr(z10 - z00) * fx)) + _fr(_fr(z01 - z00) * fy));
  return _fr(_fr(z11 + _fr(_fr(z01 - z11) * _fr(1 - fx))) + _fr(_fr(z10 - z11) * _fr(1 - fy)));
}

/**
 * The subdivided faceted positions `fetch_subdivided_landblock` returns
 * (terrain_subdiv.rs `subdivide_landblock` position loop, f32 emulated with
 * Math.fround: `step_ctrl = 1/f`, `u = i*step_ctrl`, `fx = u - cu`).
 * @returns {Float32Array} 3*n*n, n = 8f + 1
 */
export function facetPositionsF32(h, lbX, lbY, f) {
  const n = 8 * f + 1;
  const pos = new Float32Array(n * n * 3);
  const stepCtrl = _fr(1 / f);
  const stepM = _fr(24 / f);
  const gx0 = (lbX & 0xff) << 3;
  const gy0 = (lbY & 0xff) << 3;
  for (let i = 0; i < n; i += 1) {
    const u = _fr(i * stepCtrl);
    const cu = Math.min(Math.floor(u), 7);
    const fx = _fr(u - cu);
    for (let j = 0; j < n; j += 1) {
      const v = _fr(j * stepCtrl);
      const cv = Math.min(Math.floor(v), 7);
      const fy = _fr(v - cv);
      const idx3 = (i * n + j) * 3;
      pos[idx3] = i * stepM;
      pos[idx3 + 1] = j * stepM;
      pos[idx3 + 2] = _triF32(h[cu * 9 + cv], h[(cu + 1) * 9 + cv], h[cu * 9 + cv + 1], h[(cu + 1) * 9 + cv + 1],
        fx, fy, cellSwToNeCut(gx0 + cu, gy0 + cv));
    }
  }
  return pos;
}

/** Contact weight from the height above the retail ground (smooth taper). */
export function contactWeight(hAbove) {
  if (!(hAbove > CONTACT_FULL_M)) return 1; // on / below the ground (sunk rocks follow it too)
  if (hAbove >= CONTACT_NONE_M) return 0;
  const t = (hAbove - CONTACT_FULL_M) / (CONTACT_NONE_M - CONTACT_FULL_M);
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Fields: what is drawn now (baked) / what statics bake against (object level)
// ---------------------------------------------------------------------------

/**
 * The factor an LB is drawn at while the player is within one LB of it:
 * terrain.js `pickSubdivLevelForLb` for Chebyshev distance <= 1, i.e.
 * `max(roundMinLevel, max(1, floor(subdivLevel / 2)))`; 1 without subdivision.
 */
export function visualGroundObjectLevel(opts) {
  if (!opts || !opts.canSubdivide) return 1;
  const half = Math.max(1, Math.floor((opts.subdivLevel | 0) / 2));
  const floor = opts.roundMinLevel | 0;
  return floor > half ? floor : half;
}

/**
 * Edge-neighbour heights for the fillet's slopes ACROSS this LB's edges: this
 * module's cache (terrain bakes + statics fetches) first, then terrain_round's
 * own neighbour cache. Same `x*9 + y` arrays either way.
 */
function _neighbourHeights(lbX, lbY) {
  const mine = (x, y) => (x < 0 || y < 0 || x > 0xff || y > 0xff ? null : _heights.get(_key16(x, y)) || null);
  const theirs = terrainRoundNeighbours(lbX, lbY);
  return {
    east: mine(lbX + 1, lbY) || theirs.east,
    west: mine(lbX - 1, lbY) || theirs.west,
    north: mine(lbX, lbY + 1) || theirs.north,
    south: mine(lbX, lbY - 1) || theirs.south,
  };
}

function _fieldAtLevel(key, level) {
  const drawn = _drawn.get(key);
  if (drawn && drawn.f === level) return drawn; // exactly what the bake uploaded
  const ck = key * 16 + level;
  const hit = _computed.get(ck);
  if (hit) return hit;
  const h = _heights.get(key);
  if (!h || level < 2) return null;
  const lbX = key >> 8;
  const lbY = key & 0xff;
  const n = 8 * level + 1;
  let off = null;
  try {
    // The bake passes terrainRoundNeighbours() as seen at ITS time; by the
    // time this LB is re-baked at the near-player factor its four neighbours
    // (all within two LBs of the player, inside the streamed ring) have been
    // baked, so the steady state is "all four known" — statics compute that.
    off = computeTerrainRoundOffsets(facetPositionsF32(h, lbX, lbY, level), n, level, lbX, lbY,
      TERRAIN_ROUND, _neighbourHeights(lbX, lbY));
  } catch (_) {
    off = null;
  }
  const field = { f: level, n, off };
  _lru(_computed, ck, field, COMPUTED_MAX);
  return field;
}

function _keyFor(acX, acY, lbKey) {
  let lbX;
  let lbY;
  if (typeof lbKey === "number" && Number.isFinite(lbKey)) {
    lbX = (lbKey >>> 24) & 0xff;
    lbY = (lbKey >>> 16) & 0xff;
  } else {
    lbX = Math.floor(acX / 192);
    lbY = Math.floor(acY / 192);
    if (!(lbX >= 0 && lbX <= 0xff && lbY >= 0 && lbY <= 0xff)) return -1;
  }
  return (lbX << 8) | lbY;
}

/**
 * THE authoritative drawn-ground query: visual minus physics terrain height
 * (metres, AC +Z) at AC world (acX, acY).
 * @param {number} acX world X (lbX*192 + local)
 * @param {number} acY world Y
 * @param {number} [lbKey] landblock key/cell id (`0xXXYY....`); derived from
 *   (acX, acY) when omitted. The point is clamped into that landblock.
 * @param {number} [camDistM] camera distance for `?terrainRoundFade` (omit = none)
 * @param {number} [level] 0 = the factor the LB is drawn at NOW; 2|4|8 = the
 *   fillet that factor would draw (statics, see header §4)
 * @returns {number} 0 on retail vertices, flat ground, factor-1 LBs, unknown
 *   LBs and whenever the fillet / this module is off
 */
export function visualGroundDeltaAt(acX, acY, lbKey, camDistM = Infinity, level = 0) {
  if (!_cfg.enabled) return 0;
  const key = _keyFor(acX, acY, lbKey);
  if (key < 0) return 0;
  const field = level > 0 ? _fieldAtLevel(key, level | 0) : _drawn.get(key);
  if (!field || !field.off) return 0;
  const w = terrainRoundFilletWeight(camDistM);
  if (!(w > 0)) return 0;
  const lbX = key >> 8;
  const lbY = key & 0xff;
  return w * filletOffsetAt(field.off, field.f, field.n, lbX, lbY, acX - lbX * 192, acY - lbY * 192);
}

/** Retail terrain Z at AC world (acX, acY) from the cached heights; NaN if unknown. */
export function physicsGroundZAt(acX, acY, lbKey) {
  const key = _keyFor(acX, acY, lbKey);
  const h = key >= 0 ? _heights.get(key) : null;
  if (!h) return NaN;
  const lbX = key >> 8;
  const lbY = key & 0xff;
  return retailGroundZ(h, lbX, lbY, acX - lbX * 192, acY - lbY * 192);
}

// ---------------------------------------------------------------------------
// Entities — render-only root offset
// ---------------------------------------------------------------------------

let _frame = 0;
let _sh = null;           // window.__sessionHandle this frame
let _localGuid = 0;
let _localIndoor = false;
let _liveW = 1;           // terrainRoundFilletWeight() this frame
let _fadeActive = false;
let _camAc = null;        // [x, y, z] camera in the AC frame (fade only)
let _diagInstalled = false;

function _readGravity(guid) {
  const sh = _sh;
  if (!sh || typeof sh.objectPhysicsState !== "function") return true;
  try {
    const st = sh.objectPhysicsState(guid >>> 0) >>> 0;
    // 0 = GUID unknown to the wasm side (not "no flags"): assume a grounded body.
    return st === 0 ? true : (st & PHYSICS_STATE_GRAVITY) !== 0;
  } catch (_) {
    return true;
  }
}

function _updateCamAc(scene3d) {
  _camAc = null;
  try {
    const cam = scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
    const frame = scene3d?.entitiesGroup ?? null;
    const ce = cam?.matrixWorld?.elements;
    const fe = frame?.matrixWorld?.elements;
    if (!ce || !fe) return;
    // AC = R^T (p - t) for the rigid entitiesGroup frame (worldRoot's -pi/2 about X).
    const px = ce[12] - fe[12];
    const py = ce[13] - fe[13];
    const pz = ce[14] - fe[14];
    _camAc = [
      fe[0] * px + fe[1] * py + fe[2] * pz,
      fe[4] * px + fe[5] * py + fe[6] * pz,
      fe[8] * px + fe[9] * py + fe[10] * pz,
    ];
  } catch (_) {
    _camAc = null;
  }
}

/**
 * Once per frame (top of EntityManager.tick): advance the memo clock and
 * snapshot the inputs every entity shares — live fillet weight, the local
 * player's guid + indoor state (frame_pose.js snapshot, no extra wasm
 * crossing inside the frame window), the camera (fade only).
 */
export function visualGroundBeginFrame(scene3d) {
  // Diag first, so `?terrainRoundObjects=off` can be confirmed live too.
  if (!_diagInstalled && scene3d) installVisualGroundDiag(scene3d);
  if (!_cfg.enabled) return;
  _frame = (_frame + 1) | 0;
  _liveW = terrainRoundFilletWeight();
  _fadeActive = terrainRoundFilletWeight(1) !== _liveW;
  let sh = null;
  let lg = 0;
  try {
    if (typeof window !== "undefined") {
      sh = window.__sessionHandle || null;
      if (typeof window.getLocalPlayerGuid === "function") lg = (window.getLocalPlayerGuid() >>> 0) || 0;
    }
  } catch (_) { /* fail-soft */ }
  _sh = sh;
  _localGuid = lg;
  let pose = null;
  try { pose = sh ? readLocalPlayerPose(sh) : null; } catch (_) { pose = null; }
  _localIndoor = !!pose && ((pose.landblockId >>> 0) & 0xffff) >= 0x0100;
  if (_fadeActive) _updateCamAc(scene3d); else _camAc = null;
}

/** Test seam: drive the per-frame inputs without a window. */
export function _setFrameInputsForTest({ sessionHandle = null, localGuid = 0, localIndoor = false } = {}) {
  _frame = (_frame + 1) | 0;
  _sh = sessionHandle;
  _localGuid = localGuid >>> 0;
  _localIndoor = !!localIndoor;
  _liveW = terrainRoundFilletWeight();
  _fadeActive = false;
  _camAc = null;
}

/**
 * The render offset for one entity this frame (metres, AC +Z). Gating per the
 * header §2; the reason lands in `inst._vg.why`. Memoised: recomputed only
 * when the root moved, a terrain bake changed what is drawn, the live weight
 * changed, a fade is active, or the PhysicsState re-read is due.
 */
export function entityVisualGroundDz(inst) {
  const s = inst && inst._vg;
  if (!s) return 0;
  const root = inst.root;
  const p = root && root.position;
  if (!p) return 0;
  const x = p.x;
  const y = p.y;
  const z = p.z;
  if (s.x === x && s.y === y && s.z === z && s.gen === _gen && s.w === _liveW) {
    if (s.frame === _frame) return s.dz;
    if (!_fadeActive && (_frame - s.stateFrame) < STATE_REFRESH_FRAMES) {
      s.frame = _frame;
      return s.dz;
    }
  }
  s.frame = _frame;
  s.x = x; s.y = y; s.z = z; s.gen = _gen; s.w = _liveW;
  if ((_frame - s.stateFrame) >= STATE_REFRESH_FRAMES) s.stateFrame = _frame;
  let dz = 0;
  let why = VG_WHY.APPLIED;
  s.h = NaN;
  s.delta = 0;
  if (!_cfg.enabled) {
    why = VG_WHY.OFF;
  } else if (inst._attachedParentGuid != null || (root.userData && root.userData.__attachedChildOf != null)) {
    why = VG_WHY.ATTACHED;
  } else if (inst._ballistic) {
    why = VG_WHY.MISSILE;
  } else {
    const isLocal = _localGuid !== 0 && (inst.guid >>> 0) === _localGuid;
    let indoor;
    if (isLocal) {
      indoor = _localIndoor;
    } else {
      const ci = inst._wireCellIdx ?? inst._outdoorCellIdx;
      indoor = ci != null && Number.isFinite(ci) && (ci & 0xffff) >= 0x0100;
    }
    if (indoor) {
      why = VG_WHY.INDOOR;
    } else {
      if (!isLocal && (_frame - s.gravityFrame) >= STATE_REFRESH_FRAMES) {
        s.gravity = _readGravity(inst.guid);
        s.gravityFrame = _frame;
      }
      if (!isLocal && !s.gravity) {
        why = VG_WHY.NO_GRAVITY;
      } else {
        const lbX = Math.floor(x / 192);
        const lbY = Math.floor(y / 192);
        const key = lbX >= 0 && lbX <= 0xff && lbY >= 0 && lbY <= 0xff ? (lbX << 8) | lbY : -1;
        const drawn = key >= 0 ? _drawn.get(key) : null;
        const h = key >= 0 ? _heights.get(key) : null;
        if (!drawn || !drawn.off || !h) {
          why = VG_WHY.NO_FILLET;
        } else {
          const lx = x - lbX * 192;
          const ly = y - lbY * 192;
          const hAbove = z - retailGroundZ(h, lbX, lbY, lx, ly);
          s.h = hAbove;
          const c = contactWeight(hAbove);
          if (!(c > 0)) {
            why = VG_WHY.ELEVATED;
          } else {
            let w = _liveW;
            if (_fadeActive && _camAc) {
              w = terrainRoundFilletWeight(Math.hypot(x - _camAc[0], y - _camAc[1], z - _camAc[2]));
            }
            const delta = w * filletOffsetAt(drawn.off, drawn.f, drawn.n, lbX, lbY, lx, ly);
            s.delta = delta;
            dz = c * delta;
          }
        }
      }
    }
  }
  s.dz = dz;
  s.why = why;
  return dz;
}

/**
 * Install the render-only offset on an entity's rig root (EntityInstance
 * constructor). The root gets ONE own property, `updateMatrix`: three's
 * compose (incl. r184 pivot) runs unchanged, then the AC-Z translation
 * (`matrix.elements[14]`, the entitiesGroup frame is AC with +Z up) gains dz.
 * `root.position` is never written. Fail-soft no-op on stubs / flag off.
 */
export function installVisualGroundRoot(inst) {
  if (!_cfg.enabled || !inst || inst._vg) return false;
  const root = inst.root;
  if (!root || typeof root.updateMatrix !== "function" || !root.matrix || !root.matrix.elements) return false;
  const proto = Object.getPrototypeOf(root);
  if (!proto || typeof proto.updateMatrix !== "function") return false;
  inst._vg = {
    dz: 0, why: VG_WHY.NO_FILLET, h: NaN, delta: 0,
    x: NaN, y: NaN, z: NaN, gen: -1, w: -1, frame: -1,
    // Staggered so the PhysicsState re-reads spread over the refresh window.
    stateFrame: -STATE_REFRESH_FRAMES - ((inst.guid >>> 0) % STATE_REFRESH_FRAMES),
    gravityFrame: -STATE_REFRESH_FRAMES - ((inst.guid >>> 0) % STATE_REFRESH_FRAMES),
    gravity: true,
  };
  root.updateMatrix = function visualGroundUpdateMatrix() {
    proto.updateMatrix.call(this);
    const dz = entityVisualGroundDz(inst);
    if (dz !== 0) this.matrix.elements[14] += dz;
  };
  return true;
}

// ---------------------------------------------------------------------------
// Statics — baked into the placement z
// ---------------------------------------------------------------------------

const _staticsStats = {
  lbs: 0, placements: 0, adjusted: 0, maxAbsDz: 0, elevated: 0, noHeights: 0, noLevel: 0,
};
const _staticsSample = []; // ring of the last adjusted placements (diag)
const SAMPLE_MAX = 32;

const _heightsMissing = new Set(); // keys the export could not serve (ocean / world edge)

async function _fetchHeights(key, wasmExports, urgent) {
  const fn = wasmExports && wasmExports.fetch_landblock_heightmaps;
  if (typeof fn !== "function" || _heightsMissing.has(key)) return null;
  const lbX = key >> 8;
  const lbY = key & 0xff;
  const cellId = ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0;
  let meshes = null;
  try {
    meshes = await fn.call(wasmExports, new Uint32Array([cellId]), !!urgent);
    const m = meshes && meshes[0];
    const raw = m ? m.heights : null;
    if (!raw || raw.length < 81) { _noteMissing(key); return null; }
    const h = new Float32Array(81);
    for (let v = 0; v < 81; v += 1) h[v] = raw[v];
    _lru(_heights, key, h, HEIGHTS_MAX);
    return h;
  } catch (_) {
    _noteMissing(key);
    return null;
  } finally {
    if (meshes) for (const m of meshes) { try { m && m.free && m.free(); } catch (_) { /* released */ } }
  }
}

function _noteMissing(key) {
  if (_heightsMissing.size >= HEIGHTS_MAX) _heightsMissing.clear();
  _heightsMissing.add(key);
}

function _objectLevelFor(scene3d, wasmExports) {
  const o = (scene3d && scene3d.terrainOpts) || _seenOpts;
  if (o) return visualGroundObjectLevel(o);
  // The terrain ring opts are resolved lazily by the FIRST terrain load and
  // only assigned after its atlas build, which a statics bake can outrun at
  // login. Derive the same numbers resolveTerrainRingOpts would: the quality
  // preset's subdivLevel snapped like terrain.js `pickSubdivLevel`, subdivision
  // available iff the wasm export exists, the terrainRoundLevel floor.
  const raw = scene3d?.quality?.flags?.subdivLevel;
  if (!Number.isFinite(raw)) return 0; // unknown
  const subdivLevel = raw >= 8 ? 8 : raw >= 4 ? 4 : raw >= 2 ? 2 : 1;
  const canSubdivide = !!wasmExports && typeof wasmExports.fetch_subdivided_landblocks === "function";
  return visualGroundObjectLevel({ subdivLevel, canSubdivide, roundMinLevel: canSubdivide ? terrainRoundMinLevel() : 1 });
}

/**
 * Bake the drawn-ground offset into each ground-standing OUTDOOR placement's
 * z, in place (statics.js, on the bake's own plain placement copies, BEFORE
 * any node / peel / batch consumes them). Placements carry `landblockId` and
 * LB-local x/y/z. A placement more than CONTACT_NONE_M above the retail ground
 * keeps its z. Never throws; returns how many placements moved.
 */
export async function applyVisualGroundToPlacements(placements, scene3d, wasmExports, urgent = false) {
  try {
    if (!_cfg.enabled || !Array.isArray(placements) || placements.length === 0) return 0;
    if (scene3d && scene3d.wireframeMode) return 0;
    const w = terrainRoundFilletWeight();
    if (!(w > 0)) return 0;
    const level = _objectLevelFor(scene3d, wasmExports);
    if (level === 0) { _staticsStats.noLevel += 1; return 0; }
    if (level < 2) return 0; // that factor draws no fillet
    const byLb = new Map();
    for (const p of placements) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      const id = p.landblockId >>> 0;
      const key = (((id >>> 24) & 0xff) << 8) | ((id >>> 16) & 0xff);
      let list = byLb.get(key);
      if (!list) { list = []; byLb.set(key, list); }
      list.push(p);
    }
    let moved = 0;
    for (const [key, list] of byLb) {
      _staticsStats.lbs += 1;
      _staticsStats.placements += list.length;
      const h = _heights.get(key) || await _fetchHeights(key, wasmExports, urgent);
      if (!h) { _staticsStats.noHeights += list.length; continue; }
      const lbX = key >> 8;
      const lbY = key & 0xff;
      const drawn = _drawn.get(key);
      if (!(drawn && drawn.f === level) && !_computed.has(key * 16 + level)) {
        // Recompute ahead: complete the edge neighbours first (header §4).
        const nb = _neighbourHeights(lbX, lbY);
        for (const [dx, dy, side] of [[1, 0, "east"], [-1, 0, "west"], [0, 1, "north"], [0, -1, "south"]]) {
          const nx = lbX + dx;
          const ny = lbY + dy;
          if (nb[side] || nx < 0 || ny < 0 || nx > 0xff || ny > 0xff) continue;
          await _fetchHeights(_key16(nx, ny), wasmExports, urgent);
        }
      }
      const field = _fieldAtLevel(key, level);
      if (!field || !field.off) continue;
      for (const p of list) {
        const lx = Math.min(192, Math.max(0, p.x));
        const ly = Math.min(192, Math.max(0, p.y));
        const c = contactWeight(p.z - retailGroundZ(h, lbX, lbY, lx, ly));
        if (!(c > 0)) { _staticsStats.elevated += 1; continue; }
        const dz = c * w * filletOffsetAt(field.off, field.f, field.n, lbX, lbY, lx, ly);
        if (dz === 0) continue;
        p.z += dz;
        moved += 1;
        const a = Math.abs(dz);
        if (a > _staticsStats.maxAbsDz) _staticsStats.maxAbsDz = a;
        if (_staticsSample.length >= SAMPLE_MAX) _staticsSample.shift();
        _staticsSample.push({ lb: ((key << 16) >>> 0).toString(16), x: p.x, y: p.y, z: p.z, dz, modelId: p.modelId, source: p.source });
      }
    }
    _staticsStats.adjusted += moved;
    return moved;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Diag: window.__visualGround
// ---------------------------------------------------------------------------

function _entityRow(inst) {
  const s = inst._vg;
  const p = inst.root && inst.root.position;
  if (!p) return null;
  const physZ = physicsGroundZAt(p.x, p.y);
  const drawnDelta = visualGroundDeltaAt(p.x, p.y);
  // Fresh (memoised) read, not the last render's: correct under ?nullRender
  // and for hidden rigs whose matrix walk is skipped.
  const dz = s ? entityVisualGroundDz(inst) : 0;
  return {
    guid: "0x" + ((inst.guid >>> 0).toString(16)),
    name: inst.meta?.name ?? null,
    x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(4),
    dzApplied: dz,
    why: s ? WHY_NAMES[s.why] : "NOT_INSTALLED",
    heightAboveRetailM: s && Number.isFinite(s.h) ? s.h : null,
    groundDeltaM: drawnDelta,
    // Drawn root Z minus the drawn ground under it. A standing body: 0 with
    // this module, -groundDeltaM without it (feet in / above the fillet).
    feetGapM: Number.isFinite(physZ) ? (p.z + dz) - (physZ + drawnDelta) : null,
    legacyFeetGapM: Number.isFinite(physZ) ? p.z - (physZ + drawnDelta) : null,
  };
}

/** Install `window.__visualGround` (idempotent; browser only). */
export function installVisualGroundDiag(scene3d) {
  _diagInstalled = true;
  if (typeof window === "undefined") return null;
  const em = () => scene3d?.entityManager || (typeof window !== "undefined" ? window.liveScene3d?.entityManager : null);
  const playerPos = () => {
    let p = null;
    try {
      const sh = window.__sessionHandle;
      p = sh && typeof sh.getLocalPlayerPose === "function" ? sh.getLocalPlayerPose() : null;
      if (!p) return null;
      const lb = p.landblockId >>> 0;
      return { x: ((lb >>> 24) & 0xff) * 192 + p.x, y: ((lb >>> 16) & 0xff) * 192 + p.y, z: p.z, cell: lb };
    } catch (_) {
      return null;
    } finally {
      try { p && p.free && p.free(); } catch (_) { /* released */ }
    }
  };
  const api = {
    config: { ..._cfg, contactFullM: CONTACT_FULL_M, contactNoneM: CONTACT_NONE_M },
    /** Drawn-ground delta + both grounds at a world AC point. */
    at(x, y) {
      const key = _keyFor(x, y);
      const drawn = key >= 0 ? _drawn.get(key) : null;
      const physZ = physicsGroundZAt(x, y);
      const deltaM = visualGroundDeltaAt(x, y);
      const level = _objectLevelFor(scene3d, scene3d?.wasmExports);
      return {
        lb: key >= 0 ? ((key << 16) >>> 0).toString(16) : null,
        factor: drawn ? drawn.f : null,
        lbMaxAbsM: drawn ? drawn.maxAbs : null,
        physicsZ: physZ, visualZ: physZ + deltaM, deltaM,
        objectLevel: level, objectDeltaM: level >= 2 ? visualGroundDeltaAt(x, y, undefined, Infinity, level) : 0,
      };
    },
    /** The local player: ground delta under the feet + the offset its rig got. */
    underPlayer() {
      const pp = playerPos();
      if (!pp) return null;
      const m = em();
      const inst = m?.entityMap?.get?.(_localGuid);
      return { ...pp, ...api.at(pp.x, pp.y), entity: inst ? _entityRow(inst) : null };
    },
    entity(guid) {
      const inst = em()?.entityMap?.get?.(guid >>> 0);
      return inst ? _entityRow(inst) : null;
    },
    /** Entities within `radiusM` of the player, nearest first. */
    near(radiusM = 40) {
      const pp = playerPos();
      const m = em();
      if (!pp || !m?.entityMap) return [];
      const rows = [];
      for (const inst of m.entityMap.values()) {
        const p = inst?.root?.position;
        if (!p) continue;
        const d = Math.hypot(p.x - pp.x, p.y - pp.y);
        if (d > radiusM) continue;
        const r = _entityRow(inst);
        if (r) rows.push({ distM: +d.toFixed(1), ...r });
      }
      return rows.sort((a, b) => a.distM - b.distM);
    },
    stats() {
      const byWhy = {};
      let total = 0;
      let maxAbsDz = 0;
      const m = em();
      if (m?.entityMap) {
        for (const inst of m.entityMap.values()) {
          const s = inst?._vg;
          if (!s) continue;
          total += 1;
          const k = WHY_NAMES[s.why] || "?";
          byWhy[k] = (byWhy[k] || 0) + 1;
          maxAbsDz = Math.max(maxAbsDz, Math.abs(s.dz));
        }
      }
      return {
        enabled: _cfg.enabled, frame: _frame, gen: _gen, liveWeight: _liveW, fadeActive: _fadeActive,
        drawnLbs: _drawn.size, heightLbs: _heights.size, computedFields: _computed.size,
        objectLevel: _objectLevelFor(scene3d, scene3d?.wasmExports),
        entities: { installed: total, maxAbsDz, byWhy },
        statics: { ..._staticsStats },
      };
    },
    staticsSample: () => _staticsSample.slice(),
  };
  try { window.__visualGround = api; } catch (_) { /* fail-soft */ }
  return api;
}
