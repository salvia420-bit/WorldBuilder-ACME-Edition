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
//   * BSP world-object entities    `sweepSphereAgainstEntities` (closed doors)
//   * every other solid object     `sweepSphereAgainstObjects` (physics-
//     collision-1, `?missileObjSweep=off` escape): creatures, players,
//     chests, props, by their Setup cylspheres / spheres. Retail
//     `OBJECTINFO::missile_ignore` (acclient.c:314070) ignores only another
//     MISSILE, an ETHEREAL object, or a creature when `targetID != 0` — and
//     the client only ever writes `targetID = 0` (:311603, :312155), so the
//     target, bystanders and the local player all stop a missile locally.
//     Our own launch exempts the local player (`projectileExemptsLocalPlayer`).
//   * procedural scenery           `sweepSphereAgainstScenery` (physics-
//     collision-3, `?projectileScenerySweep=off` escape): trunk cylspheres
//     and boulder spheres over the 3×3 landblock ring, for an OUTDOOR
//     missile only (the caller gates). ACE loads the same scenery into its
//     server physics (Landblock.get_land_scenes), so its bolt stops on a
//     trunk. Retail builds scenery STATIC (`CPhysicsObj::makeObject(id, 0,
//     0)` → `InitObjectBegin` state |= 1, acclient.c:317273), so it stops an
//     ETHEREAL missile too.
// An ETHEREAL missile (ACE Rolling Death, `spell_projectile_ethereal`)
// passes every non-STATIC object (`FindObjCollisions` :316201-316212): the
// door layer is skipped and the object layer keeps only STATIC objects.
// NOT `sweepSphereAgainstStatics`: that is a whole-AABB slab test, so a tree
// canopy or sign box would stop a bolt retail and ACE fly past. Precise
// LandBlockInfo outdoor statics need a new wasm BSP export, and the 0.1 m
// sphere stands in for the missile's Setup sphere × scale (follow-ups).
//
// The client terrain stop runs per substep too (`projectileTerrainCrossing`,
// physics-collision-3): it parks the bolt at the first crossing instead of
// the frame's overshot end point.
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
/** Terrain probe spacing (m) along a substep. AC terrain is planar per 24 m
 *  cell triangle, so the chord can dip under a ridge between two probes by
 *  at most ~slope × spacing / 2 beyond the stop tolerance. A 60 fps bolt
 *  (≲ 0.5 m per substep) still costs one terrain sample per frame. */
export const PROJECTILE_TERRAIN_PROBE_M = 0.5;
/** Bisection refinements of a terrain crossing (0.5 m / 2^8 ≈ 2 mm). */
const TERRAIN_BISECT_ITERS = 8;
/** PhysicsState::ETHEREAL (acclient.c:316201 `state & 4`). */
export const PHYSICS_STATE_ETHEREAL = 0x4;
/** A missile that spawned within this distance (m) of the local player is
 *  our own launch (or point-blank): the player's body never stops it. ACE
 *  spawns a bolt ~1–2 m in front of the SERVER-side caster pose
 *  (Creature_Missile.cs / WorldObject_Magic.cs `CalculateProjectileOrigins`),
 *  which a running or fast-casting predicted player can be ahead of. */
export const PROJECTILE_OWN_LAUNCH_M = 4;

/**
 * Does this missile leave the local player's body out of the object layer
 * for its whole flight? True when it spawned within
 * `PROJECTILE_OWN_LAUNCH_M` of the player, or when either pose is unknown
 * (never a false self-hit; the server impact still lands).
 * @param {{x:number,y:number,z:number}|null} launch the missile's spawn point
 * @param {{x:number,y:number,z:number}|null} player the local player's pose
 */
export function projectileExemptsLocalPlayer(launch, player) {
  if (!launch || !player) return true;
  const d = Math.hypot(launch.x - player.x, launch.y - player.y, launch.z - player.z);
  return !(d >= PROJECTILE_OWN_LAUNCH_M);
}

/** Is the missile's PhysicsState ETHEREAL? (`0` = unknown → not ethereal.) */
export function projectileIsEthereal(state) {
  return ((state >>> 0) & PHYSICS_STATE_ETHEREAL) !== 0;
}

/** PhysicsState::REPORT_COLLISIONS (acclient.c:320207 `state & 8`). */
export const PHYSICS_STATE_REPORT_COLLISIONS = 0x8;
/** PhysicsState::MISSILE (acclient.c:320221 `state & 0x40`). */
export const PHYSICS_STATE_MISSILE = 0x40;
/** PhysicsState::SCRIPTED_COLLISION (acclient.c:436866 `SBYTE1(state) < 0`). */
export const PHYSICS_STATE_SCRIPTED_COLLISION = 0x8000;

/**
 * physics-collision-4: does this stop play the missile's collision script?
 * Retail `report_environment_collision` / `report_object_collision`
 * (acclient.c:320194-320290) hand a REPORT_COLLISIONS missile's contact to
 * `ACCWeenieObject::DoCollision` (the Env and Atk overloads share one body,
 * :436857), which plays `play_default_script` when SCRIPTED_COLLISION is
 * set. Only a CLIENT contact (`client-sweep:<layer>`, `client-terrain`)
 * counts, never a server impact; the wire state must still report
 * collisions and still be MISSILE (ACE's ProjectileImpact SetState clears
 * REPORT_COLLISIONS, SpellProjectile.cs). An arrow (0x20414) has no
 * SCRIPTED_COLLISION.
 * @param {string|null|undefined} cause the `_ballisticStopCause`
 * @param {number} state the missile's wire PhysicsState (`0` = unknown → no)
 */
export function projectileCollisionScriptPlays(cause, state) {
  if (typeof cause !== "string") return false;
  if (cause !== "client-terrain" && !cause.startsWith("client-sweep:")) return false;
  const s = state >>> 0;
  return (s & PHYSICS_STATE_REPORT_COLLISIONS) !== 0
    && (s & PHYSICS_STATE_MISSILE) !== 0
    && (s & PHYSICS_STATE_SCRIPTED_COLLISION) !== 0;
}

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
 * @param {{radius?:number, cells?:Uint32Array|null, scenery?:boolean, entities?:boolean, objects?:boolean, missileGuid?:number, ethereal?:boolean, exemptLocalPlayer?:boolean, launchWindow?:boolean, out?:object}} [opts]
 *   `out` (optional) receives `{ layer }` — the sweep export that produced
 *   the stopping hit — for the stop-cause diagnostic. `scenery` (default
 *   off; true for an outdoor missile) runs the scenery layer. `objects`
 *   (default on) runs the object layer for `missileGuid`; `ethereal` (the
 *   missile's own ETHEREAL bit) skips the door layer; `exemptLocalPlayer`
 *   leaves the local player's body out of the object layer.
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
  let bestLayer = null;
  const sweep = (name, ...extra) => {
    const fn = sh[name];
    if (typeof fn !== "function") return;
    let hit = null;
    try {
      hit = fn.call(sh, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, R, ...extra);
      if (!hit) return;
      // Copy before free (wasm-bindgen `CollisionHit` box).
      const t = +hit.t;
      const nd = ((+hit.normalX || 0) * dx + (+hit.normalY || 0) * dy + (+hit.normalZ || 0) * dz) / len;
      if (projectileHitStops(t, nd, launch) && (best == null || t < best)) {
        best = Math.min(t, 1);
        bestLayer = name;
      }
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
  // physics-collision-3: the scenery export scans the 3×3 landblock ring
  // around lb0, so one call also covers a step that crosses a boundary.
  if (opts.scenery) sweep("sweepSphereAgainstScenery", lb0);
  // An ETHEREAL missile passes the (non-STATIC) doors — retail
  // `obstruction_ethereal` (acclient.c:316201-316212 → OK_TS at :316296).
  const ethereal = !!opts.ethereal;
  if (opts.entities !== false && !ethereal) sweep("sweepSphereAgainstEntities", len + ENTITY_RANGE_MARGIN_M);
  // The wasm object layer reads the missile's own state (ETHEREAL → STATIC
  // objects only) and skips MISSILE / ETHEREAL / parented / BSP objects.
  if (opts.objects !== false) {
    sweep("sweepSphereAgainstObjects", (opts.missileGuid ?? 0) >>> 0, !!opts.exemptLocalPlayer);
  }
  if (best != null && opts.out && typeof opts.out === "object") opts.out.layer = bestLayer;
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

/**
 * physics-collision-3: where the substep `p0 → p1` first passes under the
 * terrain — the client terrain stop, run per integration substep rather than
 * once per frame at the frame's end point (where a fast bolt tunnelled a thin
 * ridge and the stop snapped to the ground at the overshot xy). Retail tests
 * the missile against the terrain polygon inside every quantum's transition
 * (`CLandCell::find_env_collisions`, acclient.c:354992).
 *
 * The trigger keeps the PROJ-VIS tolerance: a probe more than `eps` under the
 * sample (a launch can be authored just below our sample). Probes every
 * PROJECTILE_TERRAIN_PROBE_M along the chord (the march of WebAC
 * MissilePhysics.ts `sweepHeightfield`, AGPL-3.0), then bisects the first
 * bracket for the surface crossing. A bracket that already starts under the
 * surface (within `eps`) stops at its start. Unknown terrain (`terrainZAt`
 * → null) never triggers.
 * @param {{x:number,y:number,z:number}} p0
 * @param {{x:number,y:number,z:number}} p1
 * @param {(x:number, y:number) => (number|null)} terrainZAt
 * @param {number} eps below-surface tolerance (m) before a probe counts
 * @returns {{s:number, x:number, y:number, z:number}|null} the stop — path
 *   fraction `s` and the point, `z` on the terrain surface — or null
 */
export function projectileTerrainCrossing(p0, p1, terrainZAt, eps) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1e-9)) return null;
  // The path point at fraction `s`, its terrain height `gz` and height
  // above it `h`; null where the terrain is unknown.
  const probe = (s) => {
    const x = p0.x + dx * s, y = p0.y + dy * s;
    const gz = terrainZAt(x, y);
    if (typeof gz !== "number" || !Number.isFinite(gz)) return null;
    return { x, y, gz, h: p0.z + dz * s - gz };
  };
  const n = Math.max(1, Math.ceil(len / PROJECTILE_TERRAIN_PROBE_M));
  let lo; // the probe at `loS`; undefined = s 0, not sampled yet
  let loS = 0;
  for (let k = 1; k <= n; k += 1) {
    const s = k / n;
    const p = probe(s);
    if (p && p.h < -eps) {
      if (lo === undefined) lo = probe(0);
      if (lo && lo.h < 0) return { s: loS, x: lo.x, y: lo.y, z: lo.gz };
      // `a` stays on or above the surface, `bS` under it.
      let a = lo, aS = loS, bS = s;
      for (let i = 0; i < TERRAIN_BISECT_ITERS; i += 1) {
        const mS = 0.5 * (aS + bS);
        const m = probe(mS);
        if (m && m.h < 0) {
          bS = mS;
        } else {
          aS = mS;
          a = m;
        }
      }
      if (a) return { s: aS, x: a.x, y: a.y, z: a.gz };
      return { s: aS, x: p0.x + dx * aS, y: p0.y + dy * aS, z: p0.z + dz * aS };
    }
    lo = p;
    loS = s;
  }
  return null;
}
