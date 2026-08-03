// scene3d/vfx/components/breathFog.js — synthesized creature breath-fog
// (Visual-Behavior Suite, Phase 3 / P3.7 — 2026-06-24).
//
// A soft alpha puff emitted from a creature's HEAD part, visible only in the
// COLD (ties to the same derived cold drive the frost wash uses — see
// breathFogGate). One persistent ambient emitter per creature, owner-scoped to
// the entity guid so despawn teardown is FREE (owner_registry.destroyAllForOwner).
//
// HEAD ANCHORING (handoff §7 + the entity attach path play_effect_vfx.js:1449):
// the emitter anchors to the creature's head part via ctx.anchor.partIndex
// (resolved by P3.6's `vfx anchor-parts <SetupDID> head` selector → buildBboxRig
// pick). At runtime the attach layer passes parent=inst.root + parent.partFrames
// to addEmitter; particle_emitter.js _resolveAnchorFrame converts the WORLD-space
// partFrames[headIndex] to scene-local (the 2026-06-20 fix) — we do NOT
// double-apply the worldRoot −π/2 X rotation. Because partFrames update every
// frame from the SERVER-AUTHORITATIVE pose, the puff tracks the live head as the
// creature walks/turns — a read-only serverPose consumption handled entirely by
// the pipeline (the component only names the partIndex + a mouth offset).
//
// THE FIREWALL: reads the resolved head-anchor bbox (geometry) + derived cold
// env (weather) + the client clock; writes ONLY a synthesized alpha billboard
// emitter. No wire/physics/collision/replicated state, no light count.
// Deterministic (hash01 + clock, never Math.random). cacheKeyScope "none".
//
// SYNTHESIZE: a plain emitterInfo POJO naming an existing SOFT (alpha, NOT
// additive) smoke/fog sprite gfxobj from particle_sprites.js (P3.2) — breath is
// translucent vapour, so the sprite Surface must be NON-additive (additive would
// read as glowing breath). Renders with zero wasm rebuild.

import { registerComponent } from "../registry.js";
import { breathFogEnabled } from "../../vfx_flags.js";
import { breathFogGate } from "../particle_env_gates.js";
import { PARTICLE_SPRITES } from "../particle_sprites.js"; // D6: import sprite directly

const PT_LOCAL_VELOCITY = 2;   // LocalVelocity — drifts along `a` (out + up from mouth)
const EMITTER_PER_SEC = 1;     // EmitterType.BirthratePerSec
const GATE_MIN = 0.05;         // breath needs a clear cold signal to show at all

// Deterministic 32-bit integer hash → [0,1) (flameFlicker.js:48 parity).
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const breathFog = {
  id: "particle.breathFog",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled: breathFogEnabled,            // ?visual && ?breathFog
  gateFn: breathFogGate,
  spriteName: "smoke",                  // alpha soft puff (NON-additive)
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    // 0xF0E00004 — the next free id after the three foliage emitters
    // (0xF0E00001/02/03). Was 0xF0E00010, which COLLIDED with
    // terrainDustDevil's synthId; both also default to the smokePuff sprite, so
    // the composite `${info.id}|${info.hwGfxObjId}` keys used for warn dedup
    // (particle_manager.js:1114 `_nullGeometryWarned`, particle_emitter.js:219
    // `_e6WarnedEmitterIds`) were byte-identical: a "geometryFactory returned
    // null, the effect will not render" warning fired once for breath fog
    // permanently silenced the same diagnostic for sand devils, and vice versa.
    // terrainSwampAmbient.js:140 states the invariant this violated ("a distinct
    // emitter id (two ambient sources must not collide)").
    synthId: 0xF0E00004,
    hwGfxObjId: PARTICLE_SPRITES.smokePuff,   // alpha puff (breath MUST be non-additive)
    particleType: PT_LOCAL_VELOCITY,
    basePeriodSec: 1.3,                 // a slow exhale cadence (~0.8/sec at g=1)
    maxParticles: 5,                    // tiny — a couple of puffs at a time
    initialParticles: 0,
    lifespan: 1.6, lifespanRand: 0.5,   // brief — the puff dissipates fast
    // Mouth offset: nudge the spawn point FORWARD (+Z head-local) + a small
    // radius so puffs originate at the muzzle, not the skull centre.
    mouthForward: 0.18, mouthUp: 0.04, spawnRadius: 0.06,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,  // small filled sphere at mouth
    // a = exhale velocity: forward (+Z) and slightly up (+Y), head-local.
    aX: 0, aY: 0.12, aZ: 0.28, minA: 0.6, maxA: 1.2,
    bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1,
    cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1,
    // Expand + dissipate: small → larger, opaque-ish → invisible.
    scaleRand: 0.15, startScale: 0.35, finalScale: 1.3,
    transRand: 0.1, startTrans: 0.35, finalTrans: 1.0,
  },

  /**
   * @param {object} ctx { config, env, anchor:{partIndex,center,radius}, sprites, seed }
   * @returns {Array<{emitterInfo:object, partIndex:number, parentOffset:object}>}
   */
  emit(ctx) {
    const g = breathFogGate(ctx && ctx.env);
    if (!(g > GATE_MIN)) return [];                    // warm → no breath → byte-free
    const cfg = { ...this.defaults, ...(ctx && ctx.config) };
    const sprites = (ctx && ctx.sprites) || {};
    const hwGfxObjId = (sprites[this.spriteName] || cfg.hwGfxObjId || 0) >>> 0;
    if (hwGfxObjId === 0) return [];                   // unresolved sprite → invisible-guard
    const anchor = (ctx && ctx.anchor) || { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 0 };
    const seed = (ctx && ctx.seed) >>> 0;
    const h = hash01(seed);

    const period = (cfg.basePeriodSec * (0.85 + 0.3 * h)) / Math.max(g, GATE_MIN);

    const emitterInfo = {
      id: cfg.synthId >>> 0,
      emitterType: EMITTER_PER_SEC,
      particleType: cfg.particleType,
      hwGfxObjId,
      birthrate: period,                // seconds-per-particle (info.js:266)
      maxParticles: cfg.maxParticles,
      initialParticles: cfg.initialParticles,
      totalParticles: 0,                // persistent (owner-scoped teardown on despawn)
      totalSeconds: 0,
      lifespan: cfg.lifespan, lifespanRand: cfg.lifespanRand,
      offsetDirX: cfg.offsetDirX, offsetDirY: cfg.offsetDirY, offsetDirZ: cfg.offsetDirZ,
      minOffset: 0, maxOffset: cfg.spawnRadius,
      aX: cfg.aX, aY: cfg.aY, aZ: cfg.aZ, minA: cfg.minA, maxA: cfg.maxA,
      bX: cfg.bX, bY: cfg.bY, bZ: cfg.bZ, minB: cfg.minB, maxB: cfg.maxB,
      cX: cfg.cX, cY: cfg.cY, cZ: cfg.cZ, minC: cfg.minC, maxC: cfg.maxC,
      scaleRand: cfg.scaleRand, startScale: cfg.startScale, finalScale: cfg.finalScale,
      transRand: cfg.transRand, startTrans: cfg.startTrans, finalTrans: cfg.finalTrans,
      isParentLocal: false,             // detach from head after spawn → puff lingers as creature moves
    };

    // Mouth offset in head-part-local space (forward = +Z, up = +Y). The
    // pipeline resolves partFrames[headIndex] world→scene-local; this static
    // offset rides on top of that resolved frame.
    const c = (anchor && anchor.center) || { x: 0, y: 0, z: 0 };
    const parentOffset = {
      position: { x: c.x, y: c.y + cfg.mouthUp, z: c.z + cfg.mouthForward },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };

    return [{ emitterInfo, partIndex: anchor.partIndex != null ? anchor.partIndex : -1, parentOffset }];
  },
};

registerComponent(breathFog);
export default breathFog;
