// terrain.sandDevils — the SAND/DESERT dust devil (Wave 1B; design plan
// `docs/2026-07-31-terrain-vfx-plan.md` §3.2 item 2).
//
// WHAT IT IS. A synthesized ambient particle emitter, exactly like the
// foliageAmbient family next door — same registry, same lint, same
// owner-registry teardown, ZERO new particle machinery (plan §3.2 "Package
// verdict": every npm particle engine duplicates `particles/particle_manager.js`
// and bypasses the owner registry / quality cap / degrade chain).
//
// THE ROTATIONAL TERM, for free. Retail `ParticleType.Swarm` (5) integrates
//   x = cos(b.x*t) * c.x + t*a.x + …
//   y = sin(b.y*t) * c.y + t*a.y + …
//   z = cos(b.z*t) * c.z + t*a.z + …
// (`particles/particle.js` Swarm case, ported from acclient.c:330502-330510 —
// note the deliberate sin on Y). With `b.x == b.y` and `c.x == c.y` that is a
// TRUE CIRCLE in the ground plane, and a positive `a.z` lifts it into a helix:
// a dust devil is a Swarm with matched horizontal b/c and an upward drift. No
// new trajectory type, no engine change. `minB/maxB` and `minC/maxC` give each
// grain its own angular rate and radius, so the column reads as turbulent
// rather than as a rotating ring.
//
// WHAT IT IS *NOT*. The devil is NOT a light (§5.2: `lightCountDelta: 0` — a
// glowing column would be an additive sprite, never a PointLight) and it adds
// no shader program (`linkVariant() === ""`, `cacheKeyScope: "none"`).
//
// THE ANCHOR IS THE NEW PART (plan §3.2). Foliage anchors resolve a canopy
// GfxObj part bbox at BAKE time; a terrain ambient has no GfxObj, so the HOST
// (`scene3d/terrain_sand.js`) resolves the anchor at LANDBLOCK-READY time from
// the oracle: `ctx.anchor = {partIndex: -1, center, radius}` and
// `ctx.seed = lbKey`-derived. That is a new ANCHOR SOURCE, not a new VFX
// mechanism — this descriptor stays in the same registry and passes the same
// lint.
//
// THE FIREWALL (plan §5.1). Reads: the resolved anchor (geometry, from static
// terrain), the derived weather/sky env, the client clock. Writes: ONE
// synthesized client-local emitter. No wire, no physics/collision, no
// replicated field, no light count, no `Math.random` (hash01 + the clock only).
//
// Node-safe: imports only the registry, the flag readers, the pure sprite table
// and the pure gate. No THREE, no window.

import { registerComponent } from "../registry.js";
import { terrainSandEnabled, terrainSandDevilsEnabled } from "../../vfx_flags.js";
import { PARTICLE_SPRITES } from "../particle_sprites.js";

/** `ParticleType.Swarm` — mirrored as a constant so this leaf stays free of the
 *  THREE-bearing particle graph (`particles/particle.js:63-77`). */
const PT_SWARM = 5;
/** `EmitterType.BirthratePerSec` (the foliageAmbient convention). */
const EMITTER_PER_SEC = 1;

/** Below this gate value NO emitter is synthesized at all — a gated-out devil
 *  costs exactly what flag-off costs (foliageAmbient's GATE_MIN contract). */
export const DEVIL_GATE_MIN = 0.03;

/** Deterministic 32-bit integer hash → [0,1). Identical to
 *  `foliageAmbient.js::hash01` / `flameFlicker.js:48`. No `Math.random`. */
export function devilHash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Environmental gate for a dust devil, in the `particle_env_gates.js` shape
 * (env → 0..1). PURE and total: a null env reads as a calm, dry, daylit desert
 * (1.0 baseline) rather than throwing, exactly like the foliage gates.
 *
 * Devils are a DRY-WEATHER, DAYTIME phenomenon: rain kills them, wind feeds
 * them, and the ground stops convecting after sunset.
 *  • storm (`isStorm`)            ⇒ 0 — wet sand does not lift.
 *  • wetness (0..1)               ⇒ scales the whole gate down (the smoothed,
 *                                   pop-free rain signal, so it fades rather
 *                                   than snapping when the storm clears).
 *  • wind (`stormness`, 0..1)     ⇒ 0.45 → 1.0; a dead calm still throws the
 *                                   occasional devil (they are convective, not
 *                                   purely wind-driven).
 *  • night (`nightFactor`, 0..1)  ⇒ down to 0.25 at full night. A client that
 *                                   never resolves the sky reads nightFactor 0
 *                                   (calm midday), so this can never black-hole.
 * @param {object|null} env `readParticleEnv` snapshot.
 * @returns {number} 0..1
 */
export function dustDevilGate(env) {
  if (!env) return 1;
  if (env.isStorm === true) return 0;
  const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const storm = clamp01(env.stormness);
  const wet = clamp01(env.wetness);
  const night = clamp01(env.nightFactor);
  const g = (0.45 + 0.55 * storm) * (1 - wet) * (1 - 0.75 * night);
  return Math.min(1, Math.max(0, g));
}

/**
 * Build ONE dust-devil emitter spec.
 *
 * `birthrate` is the inter-spawn PERIOD IN SECONDS, not a rate
 * (`particle_emitter_info.js:266`) — the foliageAmbient convention: divide the
 * authored period by the gate so a stronger gate spawns faster.
 */
function buildDevilEmitter(p, anchor, hwGfxObjId, seed, g) {
  const h = devilHash01(seed);
  const h2 = devilHash01(seed ^ 0x5bd1e995);
  const h3 = devilHash01(seed ^ 0x27d4eb2f);
  // Deterministic per-devil variety: period, column radius and spin rate.
  const period = (p.basePeriodSec * (0.8 + 0.4 * h)) / Math.max(g, DEVIL_GATE_MIN);
  const radius = (Number.isFinite(anchor?.radius) ? anchor.radius : p.columnRadiusM)
    * (0.8 + 0.4 * h2);
  // Angular rate, rad/s. b.x == b.y is what makes cos/sin a CIRCLE; a different
  // pair would draw a Lissajous figure, which is not a vortex.
  const omega = p.spinRadPerSec * (0.75 + 0.5 * h3);
  // Anti-clockwise or clockwise, hashed — a field of devils should not all
  // turn the same way.
  const spinSign = h3 < 0.5 ? -1 : 1;

  const emitterInfo = {
    id: p.synthId >>> 0,
    emitterType: EMITTER_PER_SEC,
    particleType: PT_SWARM,
    hwGfxObjId: hwGfxObjId >>> 0,
    birthrate: period,
    maxParticles: p.maxParticles,
    initialParticles: p.initialParticles,
    totalParticles: 0,              // 0 = infinite → persistent ambient
    totalSeconds: 0,
    lifespan: p.lifespan,
    lifespanRand: p.lifespanRand,
    // Spawn volume: a small filled sphere at the column's foot.
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0,
    maxOffset: radius * 0.35,
    // a = the UPDRAFT (metres/sec, AC z-up). The horizontal components stay 0:
    // all lateral motion is the rotation below, so the column does not walk.
    aX: 0, aY: 0, aZ: p.riseMetersPerSec,
    minA: p.minRise, maxA: p.maxRise,
    // b = angular rate per axis. x == y ⇒ circle; z = 0 ⇒ no vertical wobble.
    bX: omega, bY: omega * spinSign, bZ: 0,
    minB: 0.8, maxB: 1.35,
    // c = oscillation AMPLITUDE — the column radius (x == y ⇒ round).
    cX: radius, cY: radius, cZ: 0,
    minC: 0.35, maxC: 1.0,
    scaleRand: p.scaleRand, startScale: p.startScale, finalScale: p.finalScale,
    transRand: p.transRand, startTrans: p.startTrans, finalTrans: p.finalTrans,
    isParentLocal: false,           // spawn at the anchor, then drift in world
    // Distance draw-cull (metres) — ParticleManager's RP6/degrade chain skips
    // update AND draw beyond it and restores on approach. A devil is a
    // silhouette effect: it reads much further than a canopy mote.
    degradeDistanceMeters: p.drawRadiusM,
  };

  const c = (anchor && anchor.center) || { x: 0, y: 0, z: 0 };
  const parentOffset = {
    position: { x: c.x, y: c.y, z: c.z + (p.footLiftM || 0) },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };

  return {
    emitterInfo,
    partIndex: Number.isFinite(anchor?.partIndex) ? anchor.partIndex : -1,
    parentOffset,
  };
}

export const terrainDustDevil = {
  id: "terrain.sandDevils",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },     // particles add NO shader program
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  // Composed: the family master AND the per-effect flag (plan §2.4 firewall).
  enabled() { return terrainSandEnabled() && terrainSandDevilsEnabled(); },
  gateFn: dustDevilGate,
  spriteName: "smokePuff",
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    synthId: 0xF0E00010,
    hwGfxObjId: PARTICLE_SPRITES.smokePuff,   // alpha dust puff (NOT additive)
    basePeriodSec: 0.28,           // dense-ish: a devil is a visible column
    maxParticles: 40,
    initialParticles: 12,
    lifespan: 5.0, lifespanRand: 1.5,
    columnRadiusM: 1.6,            // used when the host supplies no anchor radius
    spinRadPerSec: 2.4,            // ~0.38 rev/s at the reference radius
    riseMetersPerSec: 1.5,
    minRise: 0.5, maxRise: 1.4,
    footLiftM: 0.2,                // start just above the sand, not inside it
    scaleRand: 0.25, startScale: 0.6, finalScale: 1.9,   // puffs grow as they rise
    transRand: 0.15, startTrans: 0.45, finalTrans: 1.0,  // thin out at the top
    drawRadiusM: 260,
  },

  /**
   * PURE planner: ctx in, emitter specs out. Never touches the scene graph
   * (runtime anchoring is `particle_emitter._resolveAnchorFrame`'s job).
   * @param {{anchor?:object, env?:object, seed?:number, config?:object}} ctx
   */
  emit(ctx) {
    const g = this.gateFn(ctx && ctx.env);
    if (!(g > DEVIL_GATE_MIN)) return [];        // gated out → no emitter at all
    const cfg = { ...this.defaults, ...(ctx && ctx.config) };
    const sprites = (ctx && ctx.sprites) || {};
    const hwGfxObjId = (sprites[this.spriteName] || cfg.hwGfxObjId || 0) >>> 0;
    if (hwGfxObjId === 0) return [];             // no sprite resolved → invisible-guard
    const anchor = (ctx && ctx.anchor)
      || { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: cfg.columnRadiusM };
    const seed = (ctx && ctx.seed) >>> 0;
    return [buildDevilEmitter(cfg, anchor, hwGfxObjId, seed, g)];
  },
};

registerComponent(terrainDustDevil);
export default terrainDustDevil;
