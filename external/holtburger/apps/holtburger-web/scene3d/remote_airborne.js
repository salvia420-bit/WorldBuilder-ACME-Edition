// scene3d/remote_airborne.js — remote-entity jump arc (OpenAC comparison
// 2026-10-04, remote motion D3 + D7). Pure: no THREE, no DOM, no wasm, so
// tests/remote_airborne.test.mjs drives it under plain node.
//
// ## What retail does for a REMOTE object (acclient.c line numbers)
//
// * `CPhysics::UseTime` walks EVERY object and calls `CPhysicsObj::update_object`
//   (:311375). `update_object` (:323081) keeps an object within 96 m of the
//   player active and integrates it in quanta of at most MAX_QUANTUM = 1/5 s
//   (:784235); a gap over 2.0 s is skipped, not integrated (:323125, :323149-323153).
// * `UpdateObjectInternal` (:322719) → `UpdatePositionInternal` (:319989):
//   part-array root motion is ZEROED unless the object is on a walkable
//   surface (transient bit 2, :320013-320024), then
//   `UpdatePhysicsInternal` (:317701) integrates the velocity:
//       |v| clamped to 50 m/s (:317740-317747)
//       friction only on walkable  (calc_friction :316091, bit 2 at :316107)
//       offset += v*q + 0.5*a*q*q            (:317756-317769)
//       v      += a*q                        (:317771-317776)
//   with `a` from `calc_acceleration` (:317787): zero when in contact AND on
//   walkable, else (0, 0, PhysicsGlobals::gravity) = -9.8 (:45824) for a
//   GRAVITY object. The transition sweep (:322812) then lands it on the
//   ground.
// * The velocity comes from `SmartBox::DoVectorUpdate` (:143459) →
//   `set_velocity`, which ACE broadcasts for a player jump
//   (Player.cs:954 `EnqueueBroadcast(new GameMessageVectorUpdate(this))`).
// * While it flies, a wire position WITHOUT contact is dropped:
//   `SmartBox::HandleReceivedPosition` (:145125) → `MoveOrTeleport`
//   (:323451) returns 0 on `!contact` unless the teleport stamp advanced
//   (:323469, :323481-323482). Retail's InterpolationManager also does nothing while
//   the object is out of contact (`adjust_offset` :389208-389209).
//
// ## What we do
//
// holtburger has no physics body for remotes in JS, and the wasm remote body
// only follows wire poses (it no-ops `!contact` frames, like retail). So a
// remote jump used to rise along the linear 500 ms velocity extrapolation and
// then pop to whatever the next wire pose said. This module flies the arc the
// way `UpdatePhysicsInternal` does (exact for constant gravity, so a per-frame
// step equals retail's quantum steps) and lands it on the terrain surface
// (outdoors) or the take-off height (indoors / terrain not resident — no
// env-cell floor sampler on this side). While the arc owns the entity, a
// `!contact` wire pose is ignored (retail MoveOrTeleport); the first grounded
// pose ends it.
//
// Scope: only entities that received a jump VectorUpdate. A remote that is
// never grounded (a flyer) keeps the legacy wire-pose path — retail moves
// those with a client-side MoveToManager we do not run for remotes yet (D5).
//
// `?remoteJumpArc=off` restores the legacy linear extrapolation.

/** `PhysicsGlobals::gravity` (acclient.c:45824). */
export const RETAIL_GRAVITY = -9.8;
/** `UpdatePhysicsInternal` velocity clamp, m/s (acclient.c:317740-317747). */
export const RETAIL_MAX_VELOCITY = 50.0;
/** `update_object` skips (does not integrate) a gap over 2 s (acclient.c:323125). */
export const RETAIL_MAX_GAP_S = 2.0;
/**
 * |vz| above which a remote VectorUpdate is a jump. Same threshold as the wasm
 * airborne heuristic (src/session/messages/position.rs `VZ_THRESHOLD`): walking
 * on terrain never produces 1 m/s of vertical velocity.
 */
export const REMOTE_JUMP_VZ_MIN = 1.0;
/**
 * Safety cap (ms) on how long an arc may own the entity, and how long a landed
 * arc keeps dropping `!contact` poses while it waits for the first grounded
 * one. Not retail (retail has real collision and needs no cap) — it only stops
 * a lost landing packet from stranding the rig.
 */
export const REMOTE_JUMP_MAX_MS = 4000;
/** Marker bit on a KIND_POSITION row's `weenieFlags` (position.rs mirror). */
export const WIRE_FLAGS_PRESENT = 0x80000000;
/** `UpdatePositionFlag::IS_GROUNDED` — ACE PositionPack.BuildFlags (OnWalkable). */
export const WIRE_FLAG_IS_GROUNDED = 0x04;

/** `?remoteJumpArc` reader — opt-in (`=on`) since the wave-1 critic: with the
 *  JS-only arc the wasm body stays at the take-off point (no root motion while
 *  `!contact`), so a running jump likely snaps back on landing, and the remote
 *  arms-up pose is never cleared. Default flips back once the arc lives in the
 *  Rust body (one body, as retail). */
export function readRemoteJumpArcFlag(search) {
  try {
    const v = new URLSearchParams(search ?? "").get("remoteJumpArc");
    return v != null && v.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
}

/**
 * Decode the wire contact bit carried on a KIND_POSITION row.
 * @returns {true|false|null} null when the row has no flags (stale pkg).
 */
export function decodeWireContact(weenieFlags) {
  if (weenieFlags == null) return null;
  const f = weenieFlags >>> 0;
  if ((f & WIRE_FLAGS_PRESENT) === 0) return null;
  return (f & WIRE_FLAG_IS_GROUNDED) !== 0;
}

/** True when a remote VectorUpdate is a jump (upward launch). */
export function isRemoteJumpVelocity(vz) {
  return Number.isFinite(vz) && vz > REMOTE_JUMP_VZ_MIN;
}

/**
 * Seed an arc from the current rendered pose and the VectorUpdate velocity
 * (AC world frame, z up).
 * @param {{x:number,y:number,z:number}} pos
 * @param {{vx:number,vy:number,vz:number}} vel
 * @param {number} cellIdx low 16 bits of the landcell (>= 0x100 ⇒ indoors)
 * @param {number} nowMs
 */
export function startRemoteJump(pos, vel, cellIdx, nowMs) {
  return {
    vx: +vel.vx || 0,
    vy: +vel.vy || 0,
    vz: +vel.vz || 0,
    takeoffZ: pos.z,
    indoor: ((cellIdx >>> 0) & 0xffff) >= 0x0100,
    startMs: nowMs,
  };
}

/**
 * Advance one arc by `dt` seconds (retail UpdatePhysicsInternal, gravity on,
 * no friction — friction only applies on walkable contact). Mutates `pos` and
 * `arc`. `terrainZAt(x, y)` returns the outdoor surface height or null.
 * @returns {"flying"|"landed"}
 */
export function stepRemoteJump(arc, pos, dt, terrainZAt) {
  if (!(dt > 0)) return "flying";
  if (dt > RETAIL_MAX_GAP_S) {
    // Retail does not integrate a gap this long; put it down where it is.
    const floor = landingFloor(arc, pos, terrainZAt);
    pos.z = floor;
    return "landed";
  }
  const v2 = arc.vx * arc.vx + arc.vy * arc.vy + arc.vz * arc.vz;
  if (v2 > RETAIL_MAX_VELOCITY * RETAIL_MAX_VELOCITY) {
    const s = RETAIL_MAX_VELOCITY / Math.sqrt(v2);
    arc.vx *= s;
    arc.vy *= s;
    arc.vz *= s;
  }
  pos.x += arc.vx * dt;
  pos.y += arc.vy * dt;
  pos.z += arc.vz * dt + 0.5 * RETAIL_GRAVITY * dt * dt;
  arc.vz += RETAIL_GRAVITY * dt;
  if (arc.vz <= 0) {
    const floor = landingFloor(arc, pos, terrainZAt);
    if (pos.z <= floor) {
      pos.z = floor;
      return "landed";
    }
  }
  return "flying";
}

function landingFloor(arc, pos, terrainZAt) {
  if (!arc.indoor && typeof terrainZAt === "function") {
    const gz = terrainZAt(pos.x, pos.y);
    if (typeof gz === "number" && Number.isFinite(gz)) return gz;
  }
  return arc.takeoffZ;
}
