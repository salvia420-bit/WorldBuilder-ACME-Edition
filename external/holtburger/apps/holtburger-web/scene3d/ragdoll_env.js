// scene3d/ragdoll_env.js — environment interaction for the death ragdoll.
//
// The verlet ragdoll in `ragdoll.js` used to fall onto ONE number: a flat
// plane at the dying entity's root Z. That is wrong in three ways the owner
// can see: bodies sink into / float over sloped terrain, they walk through
// dungeon walls, and they intersect the corpses already lying there instead
// of draping over them. This module answers those three questions and
// nothing else — it owns no state on the entity, mutates no scene object,
// and never throws.
//
//   envForRagdoll(inst) -> { floorZAt(acX, acY), constrainAC(pos, radius) } | null
//
// FRAME. Everything here is the AC frame, which IS `liveScene3d.entitiesGroup`
// local space: +Z up, metres, `wx = lbX*192 + x`. `EntityInstance.setPose`
// writes those coordinates straight into `inst.root.position` (see the long
// comment on `picking.js::entityAcPosition`), and `worldRoot.rotation.x =
// -π/2` is the ONLY thing that turns it into three's Y-up world. So AC↔world
// is a rigid rotation: positions convert through `entitiesGroup.matrixWorld`,
// directions through `transformDirection`, and DISTANCES ARE THE SAME NUMBER
// in both frames — which is why the wall probe can store raw hit distances
// and compare them against AC-frame radii with no conversion at all.
//
// COST MODEL. `envForRagdoll` runs ONCE per death and is allowed a few ms:
// it fires a bounded number of raycasts (25 floor + 8 wall, hard-capped by a
// wall-clock budget) and snapshots every dynamic input into plain typed
// arrays. `floorZAt` / `constrainAC` then run ~25 nodes × 60 fps × ~3 s ≈
// 4,500 times each and are pure arithmetic over those arrays: a bilinear tap
// plus a ≤8-iteration loop, ZERO allocation, zero wasm calls, zero scene-graph
// reads. The one escape hatch is a query that lands outside the pre-sampled
// grid, which falls back to a 32-entry direct-mapped memo over
// `terrainHeightAt` (still allocation-free).
//
// MODULE-SCOPE POLICY (matches `play_effect_vfx.js::_getFxScratch`): `import *
// as THREE` is fine, but NOTHING may be constructed at module scope — the
// bare-node suites resolve "three" to `_three_stub.mjs`, which has no
// Raycaster, no Matrix4, no Box3. Every THREE object here is minted lazily
// inside `_getScratch()`, behind a try/catch, and its absence degrades the
// module to "no raycasting" rather than to an import-time crash.
//
// DEGRADATION LADDER. Every input is optional and independently absent-able:
//   terrain oracle missing  -> flat floor at the death Z
//   raycast unavailable     -> sectors stay Infinity (constrainAC is a no-op)
//   no corpses nearby       -> stacking contributes nothing
// When ALL of them are absent there is nothing better than today's flat
// plane, so `envForRagdoll` returns null and `ragdoll.js` keeps its legacy
// path byte-identical.

import * as THREE from "three";

/* ── tunables (exported for the 1070 retune session) ──────────────────── */

/** Half-extent of the pre-sampled floor grid, metres. A ragdoll that travels
 *  further than this falls off the fast path (terrain: memoised oracle call;
 *  indoor: the flat death plane). */
export const FLOOR_GRID_HALF_M = 2.4;
/** Samples per side of the floor grid (odd ⇒ the death spot is a sample). */
export const FLOOR_GRID_N = 5;
/** How far the 8 wall rays reach, metres. Beyond this a sector reads clear. */
export const WALL_PROBE_RANGE_M = 6.0;
/** Wall rays leave the death spot at this height — chest, not ankles, so a
 *  doorway threshold or a corpse on the floor does not read as a wall. */
export const WALL_PROBE_HEIGHT_M = 0.9;
/** Floor rays start this far above the death Z and reach this far below it. */
export const FLOOR_PROBE_UP_M = 1.2;
export const FLOOR_PROBE_DOWN_M = 3.0;
/** A point is never pushed closer to the death spot than this by a wall. */
export const WALL_MIN_CLEARANCE_M = 0.05;
/** Deviation between the death Z and the terrain under it above which we stop
 *  believing the terrain: the entity died on a bridge / cottage floor / roof. */
export const FLOOR_ELEVATED_EPS_M = 1.0;
/** Stacking: how many settled bodies one env may consider (nearest wins). */
export const MAX_STACK_BODIES = 8;
/** Stacking: only bodies within this horizontal radius of the death spot. */
export const STACK_SEARCH_RADIUS_M = 8.0;
/** Stacking: bodies closer than this to the death spot are assumed to be the
 *  dying entity itself or its own about-to-spawn corpse, and are skipped. */
export const STACK_SELF_RADIUS_M = 0.35;
/** Stacking: fallback / clamp range for "how tall is a body lying down". */
export const STACK_BODY_HEIGHT_M = 0.35;
export const STACK_BODY_HEIGHT_MIN_M = 0.15;
export const STACK_BODY_HEIGHT_MAX_M = 0.90;
/** Stacking: fallback / clamp range for a lying body's footprint radius. */
export const STACK_BODY_RADIUS_M = 0.8;
export const STACK_BODY_RADIUS_MIN_M = 0.5;
export const STACK_BODY_RADIUS_MAX_M = 1.6;
/** Wall-clock budget for the whole of `envForRagdoll`, milliseconds. Probing
 *  stops mid-flight when this is spent; whatever was sampled is still used. */
export const ENV_BUILD_BUDGET_MS = 6.0;
/** Hard caps on the scene walk that feeds the raycast target list. */
export const MAX_RAY_TARGETS = 64;
export const MAX_SCENE_VISITS = 3000;
/** Explicit registry: capacity and time-to-live (ms). */
export const REGISTRY_MAX = 64;
export const REGISTRY_TTL_MS = 120000;

/** ObjectDescriptionFlag.Corpse — same constant `entities.js` uses (0x2000). */
const ODF_CORPSE = 0x00002000;

const SECTOR_COUNT = 8;
const TAU = Math.PI * 2;
const SECTOR_RAD = TAU / SECTOR_COUNT;

/* ── time (node-safe) ─────────────────────────────────────────────────── */

function _now() {
  try {
    if (typeof performance !== "undefined" && performance && performance.now) {
      return performance.now();
    }
  } catch (_) { /* fall through */ }
  return Date.now();
}

function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ── lazy THREE scratch (never at module scope) ───────────────────────── */

let _scratch = null;
let _scratchFailed = false;

/**
 * Mint (once) the THREE objects the probes need. Returns null — permanently,
 * after the first failure — when the loaded "three" is the bare-node stub or
 * anything else without Raycaster/Vector3. Callers treat null as "no
 * raycasting available" and carry on.
 */
function _getScratch() {
  if (_scratch) return _scratch;
  if (_scratchFailed) return null;
  try {
    const ray = new THREE.Raycaster();
    // cellsGroup + entitiesGroup live on render layer 1 (the PView depth-clear
    // split, commit 476362fd). A default Raycaster tests layer 0 ONLY and would
    // silently miss every dungeon wall — the exact bug `picking.js` documents
    // at its `raycaster.layers.enable(1)`.
    ray.layers.enable(0);
    ray.layers.enable(1);
    _scratch = {
      ray,
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      probe: new THREE.Vector3(),
      center: new THREE.Vector3(),
      bs: new THREE.Vector3(),
      targets: [],
      stack: [],
    };
    return _scratch;
  } catch (_) {
    _scratchFailed = true;
    return null;
  }
}

/* ── settled-body registry ───────────────────────────────────────────────
 * A module-level, bounded, append-only-with-eviction list of "there is a body
 * lying here" facts. `ragdoll.js` calls `registerSettledBody` when a sim
 * freezes and `dismember.js` when a limb comes to rest; `envForRagdoll` also
 * self-populates from the live entity map, so the registry is an ENRICHMENT,
 * never a prerequisite. Records are plain objects in one array — at
 * REGISTRY_MAX = 64 the linear scans are cheaper than any index.
 */

const _registry = [];

/**
 * Record a body/limb that has come to rest, so later ragdolls drape over it.
 * Silently ignores non-finite input. Oldest records are evicted at capacity
 * and anything past REGISTRY_TTL_MS is pruned on the way in.
 *
 * @param {number} acX     AC-frame x, metres
 * @param {number} acY     AC-frame y, metres
 * @param {number} topZ    AC-frame Z of the body's UPPER surface
 * @param {number} [radius] footprint radius, metres (default STACK_BODY_RADIUS_M)
 * @returns {boolean} true when the record was stored
 */
export function registerSettledBody(acX, acY, topZ, radius) {
  const x = +acX, y = +acY, z = +topZ;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  let r = +radius;
  if (!Number.isFinite(r) || r <= 0) r = STACK_BODY_RADIUS_M;
  r = _clamp(r, STACK_BODY_RADIUS_MIN_M, STACK_BODY_RADIUS_MAX_M);
  // Blood-decals hook (?blood=on): a settled body leaves a pool. The blood
  // module resolves the true floor height itself; topZ is just a hint.
  try { window.__bloodPools?.(x, y, z - 0.2, r); } catch (_e) { /* optional */ }
  const t = _now();
  _pruneRegistry(t);
  if (_registry.length >= REGISTRY_MAX) _registry.shift();
  _registry.push({ x, y, z, r, t });
  return true;
}

function _pruneRegistry(now) {
  // Records are appended in time order, so the stale ones are a prefix.
  let drop = 0;
  while (drop < _registry.length && (now - _registry[drop].t) > REGISTRY_TTL_MS) drop++;
  if (drop > 0) _registry.splice(0, drop);
}

/** Drop every registered body (test/diag hook; also safe on zone change). */
export function clearSettledBodies() { _registry.length = 0; }

/** How many bodies the registry currently holds (test/diag hook). */
export function settledBodyCount() { return _registry.length; }

/* ── corpse discovery ────────────────────────────────────────────────── */

/**
 * Does this entity instance look like something already lying on the ground?
 * Three independent tells, any one of which is enough:
 *   `_ragdollFrozenPose` — a corpse holding a transferred ragdoll sprawl
 *   `_deathAt`           — a creature mid-collapse (its own ragdoll or the
 *                          authored Dead animation)
 *   ODF Corpse bit       — the server's lootable corpse object
 */
function _isSettledBodyInstance(other) {
  if (!other) return false;
  if (other._ragdollFrozenPose || other._ragdollPendingPose) return true;
  if (typeof other._deathAt === "number") return true;
  const odf = (other.meta && other.meta.objDescFlags) ? (other.meta.objDescFlags >>> 0) : 0;
  return (odf & ODF_CORPSE) !== 0;
}

/**
 * Estimate a lying body's top surface height and footprint radius from its
 * part Groups. Part positions are root-local (AC axes), so `max z` is exactly
 * "how tall is the heap" and `max hypot(x, y)` is exactly "how wide". Both are
 * clamped hard: a corpse rig that never got re-posed still reads as standing,
 * and we must not turn that into a 1.8 m platform.
 *
 * Falls back to the constants when the rig has no parts. ~25 reads per body,
 * ≤ 8 bodies — measured in nanoseconds, done once per env.
 */
function _measureLyingBody(other, out) {
  let h = STACK_BODY_HEIGHT_M;
  let r = STACK_BODY_RADIUS_M;
  const parts = other && other.parts;
  if (parts && parts.length) {
    let maxZ = -Infinity;
    let maxR2 = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pos = p && p.position;
      if (!pos) continue;
      const z = pos.z;
      if (z > maxZ) maxZ = z;
      const d2 = pos.x * pos.x + pos.y * pos.y;
      if (d2 > maxR2) maxR2 = d2;
    }
    if (Number.isFinite(maxZ) && maxZ > -Infinity) {
      // +0.10 m: part ORIGINS are joint centres, the mesh skin sits above them.
      h = _clamp(maxZ + 0.10, STACK_BODY_HEIGHT_MIN_M, STACK_BODY_HEIGHT_MAX_M);
    }
    if (maxR2 > 0) {
      r = _clamp(Math.sqrt(maxR2), STACK_BODY_RADIUS_MIN_M, STACK_BODY_RADIUS_MAX_M);
    }
  }
  out.h = h;
  out.r = r;
  return out;
}

/* ── scene-graph helpers ─────────────────────────────────────────────── */

function _liveScene(opts) {
  if (opts && opts.live) return opts.live;
  try {
    if (typeof window !== "undefined" && window) return window.liveScene3d || null;
  } catch (_) { /* fall through */ }
  return null;
}

/** The wasm session handle, wherever it currently lives. */
function _terrainFn(live) {
  try {
    let sh = live && live.sessionHandle;
    if ((!sh || typeof sh.terrainHeightAt !== "function") && typeof window !== "undefined") {
      sh = window.__sessionHandle;
    }
    if (sh && typeof sh.terrainHeightAt === "function") {
      return (x, y) => {
        try {
          const z = sh.terrainHeightAt(x, y);
          return (typeof z === "number" && Number.isFinite(z)) ? z : null;
        } catch (_) { return null; }
      };
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Collect the meshes a probe could plausibly hit: a bounded, bounding-sphere
 * culled walk of `cellsGroup` + `buildingsGroup`. Handing `intersectObjects` a
 * pre-culled ≤64-mesh list instead of two whole groups is the difference
 * between a few hundred microseconds and an unbounded stall in a dungeon.
 *
 * Instanced/batched meshes are never culled — their geometry bounding sphere
 * is per-instance-local and says nothing about where the instances are.
 */
function _collectTargets(groups, centerWorld, range, s) {
  const out = s.targets;
  out.length = 0;
  const stack = s.stack;
  stack.length = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g && g.children && g.children.length) stack.push(g);
  }
  let visits = 0;
  while (stack.length > 0 && out.length < MAX_RAY_TARGETS && visits < MAX_SCENE_VISITS) {
    const o = stack.pop();
    visits++;
    if (!o || o.visible === false) continue;
    const kids = o.children;
    if (kids && kids.length) {
      for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh) continue;
    if (o.isInstancedMesh || o.isBatchedMesh) { out.push(o); continue; }
    let keep = true;
    try {
      const geom = o.geometry;
      if (geom) {
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const bs = geom.boundingSphere;
        if (bs && Number.isFinite(bs.radius)) {
          s.bs.copy(bs.center).applyMatrix4(o.matrixWorld);
          if (s.bs.distanceTo(centerWorld) > range + bs.radius * 1.05) keep = false;
        }
      }
    } catch (_) { keep = true; }
    if (keep) out.push(o);
  }
  return out;
}

/**
 * One raycast in the AC frame. `acDir` need not be normalised. Returns the hit
 * DISTANCE in metres (identical in both frames — the AC↔world transform is a
 * pure rotation) or Infinity. Never throws.
 */
function _castAC(s, frame, ox, oy, oz, dx, dy, dz, far, targets) {
  if (!targets || targets.length === 0) return Infinity;
  try {
    s.origin.set(ox, oy, oz);
    s.dir.set(dx, dy, dz);
    if (frame) {
      s.origin.applyMatrix4(frame.matrixWorld);
      s.dir.transformDirection(frame.matrixWorld);
    }
    s.dir.normalize();
    s.ray.set(s.origin, s.dir);
    s.ray.near = 0;
    s.ray.far = far;
    const hits = s.ray.intersectObjects(targets, true);
    if (hits && hits.length > 0) {
      const d = hits[0].distance;
      if (Number.isFinite(d) && d >= 0) return d;
    }
  } catch (_) { /* degrade to "clear" */ }
  return Infinity;
}

/* ── the env ─────────────────────────────────────────────────────────── */

/**
 * Build the environment model for one dying entity.
 *
 * @param {object} inst  the dying EntityInstance (needs `root.position`)
 * @param {object} [opts] `{ live }` — inject the scene facade (tests)
 * @returns {{
 *   floorZAt: (acX:number, acY:number) => number,
 *   constrainAC: (pos:{x:number,y:number,z:number}, radius:number) => void,
 *   sectors: Float64Array, centerX:number, centerY:number, centerZ:number,
 *   indoor:boolean, floorMode:string, bodyCount:number, walls:boolean,
 *   buildMs:number
 * } | null}
 */
export function envForRagdoll(inst, opts) {
  try {
    return _buildEnv(inst, opts);
  } catch (_) {
    // Contract: never throw. A broken env is indistinguishable from no env.
    return null;
  }
}

function _buildEnv(inst, opts) {
  const t0 = _now();
  const live = _liveScene(opts);
  if (!live) return null;
  const root = inst && inst.root;
  const rp = root && root.position;
  if (!rp || !Number.isFinite(rp.x) || !Number.isFinite(rp.y) || !Number.isFinite(rp.z)) {
    return null;
  }
  const cx = rp.x, cy = rp.y, cz = rp.z;

  // Indoor EnvCell? `entities.js::_groundClampZ` uses exactly this test: the
  // low 16 bits of the landcell >= 0x0100 means an EnvCell interior, where
  // terrain sampling is not merely imprecise but meaningless.
  //
  // But this is a SPAWN-TIME STAMP, not a live reading (2026-08-03).
  // `_outdoorCellIdx` has exactly ONE writer in the tree — `entities.js:4551`,
  // inside the ObjectCreate path — and `_cellIdx` has none at all; nothing
  // refreshes either when the creature MOVES, because the position-update seam
  // (`entities.js:5969`) is handed world-folded x/y/z with no landcell in it.
  // So it is a HINT, and it is used as one: it decides nothing on its own, it
  // only answers when the live probe below cannot.
  const cellIdx = (inst._outdoorCellIdx ?? inst._cellIdx ?? 0) >>> 0;
  let indoor = (cellIdx & 0xffff) >= 0x0100;

  /* --- base floor ---------------------------------------------------- */

  // Probe the terrain oracle UNCONDITIONALLY. Previously a stale "indoor"
  // stamp vetoed the probe outright (`indoor ? null : …`), so a creature that
  // spawned in a cottage and died on the lawn got no terrain floor at all —
  // it fell back to the flat death plane this module exists to replace, and
  // silently, since a flat plane is exactly what "no env" looks like. The
  // agreement test below is a LIVE, geometric read and is strictly better
  // evidence than the stamp in both directions; one oracle call per death is
  // nanoseconds against the 6 ms budget.
  const terrainAt = _terrainFn(live);
  let terrainOk = false;
  if (terrainAt) {
    const z0 = terrainAt(cx, cy);
    if (z0 !== null) {
      // Died a metre or more off the terrain surface ⇒ standing on a cottage
      // floor, a bridge, a rooftop, or underground. Terrain is the wrong
      // answer there; fall through to the raycast/flat path, which reads the
      // actual surface. Within a metre of your own terrain column, though,
      // you ARE outdoors — that overrides a stale indoor stamp.
      if (Math.abs(cz - z0) <= FLOOR_ELEVATED_EPS_M) {
        terrainOk = true;
        indoor = false;
      } else {
        indoor = true; // "treat like an interior": no terrain, probe or flat
      }
    }
  }

  /* --- raycast targets (shared by the floor grid and the wall probe) --- */

  const s = _getScratch();
  const frame = (live.entitiesGroup || live.worldRoot || null);
  let targets = null;
  if (s) {
    try {
      // Refresh only the ANCESTOR chain — `updateMatrixWorld(true)` on
      // entitiesGroup would walk every entity rig in the PVS.
      if (frame && typeof frame.updateWorldMatrix === "function") {
        frame.updateWorldMatrix(true, false);
      }
      s.center.set(cx, cy, cz + WALL_PROBE_HEIGHT_M);
      if (frame && frame.matrixWorld) s.center.applyMatrix4(frame.matrixWorld);
      const groups = [live.cellsGroup, live.buildingsGroup];
      targets = _collectTargets(groups, s.center, WALL_PROBE_RANGE_M + 4.0, s);
      if (targets.length === 0) targets = null;
    } catch (_) {
      targets = null;
    }
  }

  /* --- pre-sampled floor grid ---------------------------------------- */

  const N = FLOOR_GRID_N;
  const step = (FLOOR_GRID_HALF_M * 2) / (N - 1);
  const gx0 = cx - FLOOR_GRID_HALF_M;
  const gy0 = cy - FLOOR_GRID_HALF_M;
  const grid = new Float64Array(N * N);
  let gridSamples = 0;
  let floorMode = "flat";

  if (terrainOk) {
    floorMode = "terrain";
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const z = terrainAt(gx0 + ix * step, gy0 + iy * step);
        if (z === null) { grid[iy * N + ix] = cz; continue; }
        grid[iy * N + ix] = z;
        gridSamples++;
      }
    }
  } else if (s && targets) {
    // Indoor / elevated: no analytic floor exists, so sample the actual
    // geometry with a small fan of downward rays. Budgeted — a dungeon with
    // pathological mesh counts stops early and keeps the flat plane.
    const far = FLOOR_PROBE_UP_M + FLOOR_PROBE_DOWN_M;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const k = iy * N + ix;
        grid[k] = cz;
        if ((_now() - t0) > ENV_BUILD_BUDGET_MS) continue;
        const px = gx0 + ix * step;
        const py = gy0 + iy * step;
        const d = _castAC(s, frame, px, py, cz + FLOOR_PROBE_UP_M, 0, 0, -1, far, targets);
        if (d !== Infinity) {
          grid[k] = cz + FLOOR_PROBE_UP_M - d;
          gridSamples++;
        }
      }
    }
    if (gridSamples > 0) floorMode = "raycast";
  } else {
    for (let i = 0; i < N * N; i++) grid[i] = cz;
  }

  // Terrain is smooth, so interpolate it; a raycast floor can straddle a step
  // or a stair nosing, where interpolating would invent a ramp — take the
  // nearest sample there instead.
  const bilinear = (floorMode === "terrain");

  /* --- wall probe: 8-sector radial clearance --------------------------- */

  const sectors = new Float64Array(SECTOR_COUNT);
  let walls = false;
  for (let k = 0; k < SECTOR_COUNT; k++) sectors[k] = Infinity;
  if (s && targets) {
    const oz = cz + WALL_PROBE_HEIGHT_M;
    for (let k = 0; k < SECTOR_COUNT; k++) {
      if ((_now() - t0) > ENV_BUILD_BUDGET_MS) break;
      const a = k * SECTOR_RAD;
      const d = _castAC(
        s, frame, cx, cy, oz, Math.cos(a), Math.sin(a), 0, WALL_PROBE_RANGE_M, targets,
      );
      if (d !== Infinity) { sectors[k] = d; walls = true; }
    }
  }

  /* --- settled bodies -------------------------------------------------- */

  const bodies = _gatherBodies(live, inst, cx, cy);
  const bodyCount = bodies.count;
  const bX = bodies.x, bY = bodies.y, bTop = bodies.top, bR2 = bodies.r2;

  /* --- nothing better than a flat floor? -------------------------------- */

  if (!terrainOk && floorMode !== "raycast" && !walls && bodyCount === 0) return null;

  /* --- out-of-grid fallback: 32-entry direct-mapped memo ---------------- */

  const memoKey = new Int32Array(32).fill(-1);
  const memoVal = new Float64Array(32);

  function baseAt(x, y) {
    const fx = (x - gx0) / step;
    const fy = (y - gy0) / step;
    if (fx >= 0 && fy >= 0 && fx <= N - 1 && fy <= N - 1) {
      if (!bilinear) {
        const ix = (fx + 0.5) | 0;
        const iy = (fy + 0.5) | 0;
        return grid[iy * N + ix];
      }
      let ix = fx | 0; if (ix > N - 2) ix = N - 2;
      let iy = fy | 0; if (iy > N - 2) iy = N - 2;
      const tx = fx - ix;
      const ty = fy - iy;
      const r0 = iy * N + ix;
      const r1 = r0 + N;
      const a = grid[r0] + (grid[r0 + 1] - grid[r0]) * tx;
      const b = grid[r1] + (grid[r1 + 1] - grid[r1]) * tx;
      return a + (b - a) * ty;
    }
    if (!terrainOk) return cz;
    // Outside the grid and outdoors: one memoised oracle call per 0.5 m cell.
    const qx = Math.round(x * 2) | 0;
    const qy = Math.round(y * 2) | 0;
    const key = (((qx & 0xffff) << 16) | (qy & 0xffff)) | 0;
    const slot = (Math.imul(key, 2654435761) >>> 27) & 31;
    if (memoKey[slot] === key) return memoVal[slot];
    const z = terrainAt(qx * 0.5, qy * 0.5);
    const v = (z === null) ? cz : z;
    memoKey[slot] = key;
    memoVal[slot] = v;
    return v;
  }

  /* --- the contract ----------------------------------------------------- */

  /**
   * Support height at an AC column: the max of the base floor and the top of
   * every settled body whose footprint covers it. Pure arithmetic, ≤ 8 extra
   * iterations, zero allocation.
   */
  function floorZAt(acX, acY) {
    let z = baseAt(acX, acY);
    for (let i = 0; i < bodyCount; i++) {
      const dx = acX - bX[i];
      const dy = acY - bY[i];
      if (dx * dx + dy * dy <= bR2[i] && bTop[i] > z) z = bTop[i];
    }
    return z;
  }

  /**
   * Push `pos` back inside the radial clearance profile. Approximate lateral
   * containment, deliberately NOT exact collision: the profile is 8 rays cast
   * once from the death spot, so this keeps a sprawl inside a corridor or a
   * room without ever pretending to know the BSP.
   *
   * A sector that never hit anything is Infinity, so the whole body is a
   * couple of compares and an early return in the common outdoor case.
   */
  function constrainAC(pos, radius) {
    if (!pos) return;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const d2 = dx * dx + dy * dy;
    if (!(d2 > 1e-8)) return;
    let a = Math.atan2(dy, dx);
    if (a < 0) a += TAU;
    // Nearest RAY, not a bucket floor: each stored distance is the measurement
    // along that exact direction, so the closest direction is the best proxy.
    const k = Math.round(a / SECTOR_RAD) & (SECTOR_COUNT - 1);
    const clear = sectors[k];
    if (!Number.isFinite(clear)) return;
    let lim = clear - (Number.isFinite(radius) ? radius : 0);
    if (lim < WALL_MIN_CLEARANCE_M) lim = WALL_MIN_CLEARANCE_M;
    const d = Math.sqrt(d2);
    if (d <= lim) return;
    const scale = lim / d;
    pos.x = cx + dx * scale;
    pos.y = cy + dy * scale;
  }

  return {
    floorZAt,
    constrainAC,
    // Informational / retune surface. `sectors` is the LIVE array the
    // constraint reads, so a diag session (or a test) can poke a clearance in.
    sectors,
    centerX: cx,
    centerY: cy,
    centerZ: cz,
    indoor,
    floorMode,
    gridSamples,
    bodyCount,
    walls,
    buildMs: _now() - t0,
  };
}

/**
 * Snapshot the nearest MAX_STACK_BODIES settled bodies around (cx, cy) into
 * flat plain arrays: the live entity map (corpses / dying creatures) merged
 * with the explicit registry. Called once per env; the arrays it returns are
 * the only thing `floorZAt` ever touches.
 */
function _gatherBodies(live, self, cx, cy) {
  const R = STACK_SEARCH_RADIUS_M;
  const R2 = R * R;
  const SELF2 = STACK_SELF_RADIUS_M * STACK_SELF_RADIUS_M;
  const cand = [];
  const m = { h: STACK_BODY_HEIGHT_M, r: STACK_BODY_RADIUS_M };

  try {
    const em = live && live.entityManager;
    const map = em && em.entityMap;
    if (map && typeof map.forEach === "function") {
      map.forEach((other) => {
        if (!other || other === self) return;
        if (!_isSettledBodyInstance(other)) return;
        const p = other.root && other.root.position;
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
        const dx = p.x - cx;
        const dy = p.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > R2) return;
        // Too close to be anything but ourselves or our own pending corpse —
        // standing on our own corpse-top would float the ragdoll.
        if (d2 < SELF2) return;
        _measureLyingBody(other, m);
        cand.push({ d2, x: p.x, y: p.y, top: p.z + m.h, r: m.r });
      });
    }
  } catch (_) { /* the registry alone is still useful */ }

  try {
    const now = _now();
    for (let i = 0; i < _registry.length; i++) {
      const e = _registry[i];
      if ((now - e.t) > REGISTRY_TTL_MS) continue;
      const dx = e.x - cx;
      const dy = e.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < SELF2) continue;
      cand.push({ d2, x: e.x, y: e.y, top: e.z, r: e.r });
    }
  } catch (_) { /* fall through */ }

  if (cand.length > 1) cand.sort((a, b) => a.d2 - b.d2);
  const n = Math.min(cand.length, MAX_STACK_BODIES);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const top = new Float64Array(n);
  const r2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = cand[i];
    x[i] = c.x;
    y[i] = c.y;
    top[i] = c.top;
    r2[i] = c.r * c.r;
  }
  return { count: n, x, y, top, r2 };
}

export default envForRagdoll;
