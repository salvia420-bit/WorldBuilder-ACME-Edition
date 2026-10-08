// scene3d/projectile_sweep.js — physupd-1 (2026-10-08): client-side
// environment collision for a self-integrated ballistic missile.
//
// Retail runs every ACTIVE missile through a CTransition each quantum
// (`CPhysicsObj::UpdateObjectInternal` → `transition()`, acclient.c:322812),
// and `report_environment_collision` / `report_object_collision` clear MISSILE
// on contact (acclient.c:320222 / :320290) — the client stops the bolt at the
// wall or door by itself. ACE's zero-velocity impact VectorUpdate lands a
// round-trip later (SpellProjectile.cs: a late SetState leaves a "ghost"
// projectile that "continue[s] to sail through"), so without a local sweep the
// bolt flew speed × latency past the wall and played its Explode on the far
// side. Indoors nothing stopped it at all.
//
// One integration substep (p0 → p1) is swept against the wasm collision layers
// the follow camera already uses (camera.js `_clipCameraAgainstWorld`):
//   * building physics triangles   `sweepSphereAgainstBuildingMesh` (per LB)
//   * EnvCell shell triangles      `sweepSphereAgainstCellMesh`
//   * EnvCell stab-list statics    `sweepSphereAgainstCellStatics` (BSP)
//   * BSP world-object entities    `sweepSphereAgainstEntities` (closed doors;
//     creatures carry no physics BSP, so the caster and the target are never
//     hit — retail `OBJECTINFO::missile_ignore`, acclient.c:314070, skips
//     non-target creatures and every other MISSILE).
// NOT `sweepSphereAgainstStatics`: that is a whole-AABB slab test, so a tree
// canopy or sign box would stop a bolt retail and ACE fly past. Precise
// outdoor statics and creature cylinders need new wasm exports (follow-up).
//
// Pure: takes the session handle as an argument; no three.js, no window.

/** Sweep-sphere radius (m) — a stand-in for the missile's Setup sphere
 *  (OpenAC's arrow sphere is 0.102 × scale). */
export const PROJECTILE_SWEEP_RADIUS = 0.1;
/** Stop this far (m) short of the contact point along the path. */
export const PROJECTILE_SWEEP_BACKOFF = 0.05;
/** `t` at or below this is an embedded start (the sphere already touches). */
const EMBEDDED_T = 1e-4;
/** Entity scan reach beyond the segment length (door leaf half-width + slack). */
const ENTITY_RANGE_MARGIN_M = 5;

/** Full landblock id (`0xXXYY0000`) of a world-metre position. */
export function landblockOfWorld(x, y) {
  return (((Math.floor(x / 192) & 0xff) << 24) | ((Math.floor(y / 192) & 0xff) << 16)) >>> 0;
}

/**
 * Does a sweep hit stop the missile?
 *   t > 0           — a real contact ahead on this step: stop.
 *   t ≈ 0 (embedded): the wasm triangle sweep returns t=0 whenever the start
 *     sphere already touches a triangle, with the normal turned toward the
 *     start side (physics.rs `sweep_sphere_against_triangles`). Moving away
 *     from / along that surface (n·dir ≥ 0) can never pass through it: ignore.
 *     Moving into it: ignore only inside the launch window (a launch point
 *     embedded in a door frame or the caster's doorway must not kill the
 *     bolt), otherwise stop — a later step must not tunnel through.
 * @param {number} t        parametric hit time in [0, 1]
 * @param {number} nDotDir  hit normal · unit step direction
 * @param {boolean} inLaunchWindow
 */
export function projectileHitStops(t, nDotDir, inLaunchWindow) {
  if (!(t >= 0)) return false;
  if (t > EMBEDDED_T) return true;
  if (!(nDotDir < -1e-3)) return false;
  return !inLaunchWindow;
}

/**
 * The cell ids for the EnvCell sweeps: the PLAYER's depth-1 render set (the
 * same set the camera uses) plus the missile's own indoor cell. A monster's
 * bolt in a room outside that set is a conservative miss (no stop, the server
 * impact still lands).
 * @param {Uint32Array|null} renderSet
 * @param {number} ownCellId full 32-bit cell id (`< 0x100` low half = outdoor)
 * @returns {Uint32Array|null}
 */
export function projectileSweepCells(renderSet, ownCellId) {
  const own = ownCellId >>> 0;
  const indoor = (own & 0xffff) >= 0x0100;
  if (!indoor) return renderSet && renderSet.length > 0 ? renderSet : null;
  if (!renderSet || renderSet.length === 0) return Uint32Array.of(own);
  if (renderSet.includes(own)) return renderSet;
  const out = new Uint32Array(renderSet.length + 1);
  out.set(renderSet);
  out[renderSet.length] = own;
  return out;
}

/**
 * Sweep one substep `p0 → p1` against every collision layer (each export
 * typeof-guarded and try-wrapped, so a stale pkg/ simply finds nothing).
 * @param {object} sh session handle (wasm `SessionHandle` or a mock)
 * @param {{x:number,y:number,z:number}} p0
 * @param {{x:number,y:number,z:number}} p1
 * @param {{radius?:number, cells?:Uint32Array|null, entities?:boolean, launchWindow?:boolean}} [opts]
 * @returns {number|null} the earliest stopping `t` in [0, 1], or null
 */
export function sweepProjectileSegment(sh, p0, p1, opts = {}) {
  if (!sh) return null;
  const R = opts.radius ?? PROJECTILE_SWEEP_RADIUS;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-6)) return null;
  const launch = !!opts.launchWindow;
  let best = null;
  const sweep = (name, last) => {
    const fn = sh[name];
    if (typeof fn !== "function") return;
    let hit = null;
    try {
      hit = fn.call(sh, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, R, last);
      if (!hit) return;
      // Copy before free (wasm-bindgen `CollisionHit` box).
      const t = +hit.t;
      const nd = ((+hit.normalX || 0) * dx + (+hit.normalY || 0) * dy + (+hit.normalZ || 0) * dz) / len;
      if (projectileHitStops(t, nd, launch) && (best == null || t < best)) best = Math.min(t, 1);
    } catch (_) {
      /* stale pkg / borrow conflict → no hit from this layer */
    } finally {
      try { hit?.free?.(); } catch (_) { /* already released */ }
    }
  };
  // Building triangles are indexed per landblock: sweep both ends' LBs when a
  // step crosses a boundary.
  const lb0 = landblockOfWorld(p0.x, p0.y);
  const lb1 = landblockOfWorld(p1.x, p1.y);
  sweep("sweepSphereAgainstBuildingMesh", lb0);
  if (lb1 !== lb0) sweep("sweepSphereAgainstBuildingMesh", lb1);
  const cells = opts.cells;
  if (cells && cells.length > 0) {
    sweep("sweepSphereAgainstCellMesh", cells);
    sweep("sweepSphereAgainstCellStatics", cells);
  }
  if (opts.entities !== false) sweep("sweepSphereAgainstEntities", len + ENTITY_RANGE_MARGIN_M);
  return best;
}

/** The resting point for a hit at `t`: `p0 + (p1 − p0)·t`, backed off along
 *  the path, never behind `p0`. */
export function projectileStopPoint(p0, p1, t, backoff = PROJECTILE_SWEEP_BACKOFF) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const s = len > 1e-9 ? Math.max(0, Math.min(1, t) - backoff / len) : 0;
  return { x: p0.x + dx * s, y: p0.y + dy * s, z: p0.z + dz * s };
}
