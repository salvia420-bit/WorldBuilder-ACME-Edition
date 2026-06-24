// particle.brazierEmbers — P3.6 brazier/torch flame-bowl effect (Visual-Behavior
// Suite, Phase 3). TWO synthesized persistent emitters anchored to the flame-bowl
// part: rising ADDITIVE embers (short life, upward accel, shrink) + a slower ALPHA
// smoke plume (grows, drifts, fades). design doc §4.5 "brazier embers+smoke",
// §5.3 cost class = MEDIUM (additive overdraw / fill).
//
// MECH "particle" (registry.js MECHS / FAMILY_ORDER.particle=9): NO shader, NO
// begin_vertex patch — it implements the Phase-3 emit(ctx) hook, synthesising plain-JS
// emitterInfo POJOs handed to particle_attach.attachParticleEmitters (P3.1) → the
// EXISTING ParticleManager.addEmitter seam. Reuses the whole shipped pipeline (RP6
// 220 m cull, maxParticlesPerEmitter per quality, owner-registry teardown). Builds NO
// engine and replays NO DAT 0x32 — it names EXISTING additive/alpha sprite gfxobjs
// (DAT-confirmed: flameCore 0x01000FF4 additive, smokeDark 0x01000FBF alpha) so the
// entities.js geometry/material factories render with zero wasm rebuild.
//
// THE FIREWALL (constraints §5): READS only static/derived inputs (geometry + clock);
// WRITES only synthesized client-local billboard emitters ("emitter" cap) — no wire
// value, no physics/collision, no replicated state, no light-count change
// (lightCountDelta:0). Deterministic (per-particle variety = the engine's seeded rng
// over the *Rand fields; cross-DID phase = SET-scoped hash01 — NEVER Math.random,
// NEVER argless Date.now, NEVER a per-instance key; cacheKeyScope:"none" — no shader).
// Purely cosmetic + client-local ⇒ cannot desync.
//
// COEXISTENCE (§9 #14): the classifier (CommandEngine.Vfx VfxClassify, P3.6 C#) gates
// this OUT for any DID whose SetupModel carries a default_script (the Track-B DAT
// flame, e.g. the lit brazier family 0x02000D02.. / Setup 0x0200051C). The unscripted
// worked-ref 0x02000CE2 (bowl = part 1) is the Phase-3 seed.
//
// ANCHORING (the real particle_attach contract, particle_attach.js:356): emit(ctx)
// gets ONE ctx { did, numParts, partBoxes, rig, hash01, seed, clock, weather, config }.
// A live `ctx.rig` (with partFrames) = the ENTITY seam → anchor to the bowl partIndex
// with the in-part LOCAL offset; no rig = the STATIC (frozen instanced) seam → anchor
// to root (-1) with the MODEL-space offset (the bowl-rim height). The attach layer's
// _resolveAnchorFrame converts partFrames WORLD→scene-local (do NOT double-apply the
// worldRoot −π/2 X rotation).
//
// DEFAULT-OFF: enabled = brazierEnabled (?brazier, composed under ?visual). Off ⇒
// particle_attach drops the entry ⇒ emit() never runs ⇒ byte-identical.

import { registerComponent } from "../registry.js";
import { brazierEnabled } from "../../vfx_flags.js";
import { PARTICLE_SPRITES } from "../particle_sprites.js"; // flameCore 0x01000FF4 (additive), smokeDark 0x01000FBF (alpha)

const EMITTER_TYPE_BIRTHRATE_PER_SEC = 1; // EmitterType.BirthratePerSec
const PARTICLE_TYPE_LOCAL_VELOCITY = 1;   // position = lifetime*A + origin + offset (drift)

// Authoring guards (runtime ALSO clamps maxParticles to the per-quality cap, low:64).
const MAX_PARTICLES_CAP = 48;
function _clamp(v, lo, hi) {
  const n = Number.isFinite(+v) ? +v : lo;
  return Math.max(lo, Math.min(hi, n));
}
function _vec3(a, fallback) {
  return Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(+n))
    ? { x: +a[0], y: +a[1], z: +a[2] }
    : { x: fallback[0], y: fallback[1], z: fallback[2] };
}

/**
 * Rising ADDITIVE ember emitterInfo POJO (pure; node-testable — no three). Persistent
 * (totalSeconds:0 + totalParticles:0). Rises (aZ>0, LocalVelocity) and SHRINKS
 * (startScale>finalScale) while fading out (finalTrans:1 ⇒ opacity 0; ACE polarity:
 * translucency 0=opaque,1=invisible). Additive blend comes from the sprite Surface
 * (0x01000FF4 surfaceType 0x10102), NOT this POJO.
 */
export function buildEmberInfo(cfg) {
  const c = { ...brazierEmbers.defaults, ...(cfg || {}) };
  const rise = _clamp(c.emberRiseSpeed, 0.05, 4);
  return {
    id: 0,
    emitterType: EMITTER_TYPE_BIRTHRATE_PER_SEC,
    particleType: PARTICLE_TYPE_LOCAL_VELOCITY,
    gfxObjId: 0,
    hwGfxObjId: (c.hwGfxObjIdEmber >>> 0),
    birthrate: _clamp(c.emberBirthrate, 0.02, 2),
    maxParticles: Math.round(_clamp(c.emberMaxParticles, 1, MAX_PARTICLES_CAP)),
    initialParticles: Math.round(_clamp(c.emberInitial, 0, c.emberMaxParticles)),
    totalParticles: 0,
    totalSeconds: 0,
    lifespan: _clamp(c.emberLifespan, 0.1, 10),
    lifespanRand: _clamp(c.emberLifespanRand, 0, 3),
    // small spawn ball at the bowl rim
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0,
    maxOffset: _clamp(c.bowlRadius, 0.01, 1),
    // velocity A = unit +Z · rise (minA==maxA==rise ⇒ sortingSphere = rise*lifespan, tight cull)
    aX: 0, aY: 0, aZ: 1,
    minA: rise, maxA: rise,
    bX: 0, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,
    // born bright, SHRINK as it fades
    scaleRand: _clamp(c.emberScaleRand, 0, 1),
    startScale: _clamp(c.emberStartScale, 0.001, 3),
    finalScale: _clamp(c.emberFinalScale, 0.001, 3),
    // born OPAQUE → fade to INVISIBLE
    transRand: _clamp(c.emberTransRand, 0, 1),
    startTrans: 0.0,
    finalTrans: 1.0,
    isParentLocal: true,
  };
}

/**
 * Slower ALPHA smoke plume emitterInfo POJO. GROWS (finalScale>startScale), rises
 * gently, fades out (finalTrans:1). Alpha blend from the sprite Surface (0x01000FBF
 * surfaceType 0x00102), NOT this POJO.
 */
export function buildSmokeInfo(cfg) {
  const c = { ...brazierEmbers.defaults, ...(cfg || {}) };
  const rise = _clamp(c.smokeRiseSpeed, 0.02, 3);
  return {
    id: 0,
    emitterType: EMITTER_TYPE_BIRTHRATE_PER_SEC,
    particleType: PARTICLE_TYPE_LOCAL_VELOCITY,
    gfxObjId: 0,
    hwGfxObjId: (c.hwGfxObjIdSmoke >>> 0),
    birthrate: _clamp(c.smokeBirthrate, 0.05, 4),
    maxParticles: Math.round(_clamp(c.smokeMaxParticles, 1, MAX_PARTICLES_CAP)),
    initialParticles: Math.round(_clamp(c.smokeInitial, 0, c.smokeMaxParticles)),
    totalParticles: 0,
    totalSeconds: 0,
    lifespan: _clamp(c.smokeLifespan, 0.2, 15),
    lifespanRand: _clamp(c.smokeLifespanRand, 0, 4),
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0,
    maxOffset: _clamp(c.bowlRadius, 0.01, 1),
    aX: 0, aY: 0, aZ: 1,
    minA: rise, maxA: rise,
    bX: 0, bY: 0, bZ: 0,
    cX: 0, cY: 0, cZ: 0,
    // born small, GROW as it rises and disperses
    scaleRand: _clamp(c.smokeScaleRand, 0, 1),
    startScale: _clamp(c.smokeStartScale, 0.001, 3),
    finalScale: _clamp(c.smokeFinalScale, 0.001, 5),
    transRand: _clamp(c.smokeTransRand, 0, 1),
    startTrans: 0.0,
    finalTrans: 1.0,
    isParentLocal: true,
  };
}

export const brazierEmbers = {
  id: "particle.brazierEmbers",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none", // D2 — no shader/variant to key (matches gemSparkle / windBend / flameFlicker)
  deterministic: true,
  lightCountDelta: 0,
  enabled: brazierEnabled,
  reads: ["geometry", "clock"],
  writes: ["emitter"],
  defaults: {
    hwGfxObjIdEmber: PARTICLE_SPRITES.flameCore, // 0x01000FF4 additive (DAT-confirmed)
    hwGfxObjIdSmoke: PARTICLE_SPRITES.smokeDark, // 0x01000FBF alpha   (DAT-confirmed)
    // anchor (baked by `vfx anchor-parts 0x02000CE2 bowl`, D11): bowl = part 1;
    // STATIC root anchor uses the MODEL-space bowl-rim offset; ENTITY uses the in-part LOCAL offset.
    partIndex: 1,
    offset: [0, 0, 0.77],            // model-space (static root anchor): bowl rim height
    localOffset: [0, -0.304, 0.303], // in-part local (entity bowl-part anchor): top-centre
    bowlRadius: 0.1,                 // metres — spawn-ball radius at the rim
    // ember (additive, rises, shrinks)
    emberMaxParticles: 24,
    emberInitial: 6,
    emberBirthrate: 0.06,
    emberLifespan: 1.1,
    emberLifespanRand: 0.4,
    emberRiseSpeed: 0.9,
    emberStartScale: 0.07,
    emberFinalScale: 0.015,
    emberScaleRand: 0.02,
    emberTransRand: 0.0,
    // smoke (alpha, grows, drifts)
    smokeMaxParticles: 12,
    smokeInitial: 2,
    smokeBirthrate: 0.5,
    smokeLifespan: 3.0,
    smokeLifespanRand: 0.8,
    smokeRiseSpeed: 0.4,
    smokeStartScale: 0.08,
    smokeFinalScale: 0.34,
    smokeScaleRand: 0.03,
    smokeTransRand: 0.0,
  },

  /**
   * Phase-3 emit hook (real particle_attach contract, one-arg ctx). Returns TWO specs
   * (ember + smoke). Static-vs-entity anchor is chosen from `ctx.rig` (a live rig with
   * partFrames = entity seam → bowl partIndex + in-part local offset; no rig = static
   * frozen seam → root anchor + model-space offset). Deterministic for a given ctx/cfg.
   */
  emit(ctx) {
    const cfg = { ...brazierEmbers.defaults, ...((ctx && ctx.config) || {}) };
    const isEntity = !!(ctx && ctx.rig);
    const partIndex = isEntity ? (Number.isInteger(cfg.partIndex) ? cfg.partIndex : 1) : -1;
    const offVec = isEntity ? _vec3(cfg.localOffset, [0, -0.304, 0.303]) : _vec3(cfg.offset, [0, 0, 0.77]);
    const parentOffset = { position: offVec, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
    return [
      { emitterInfo: buildEmberInfo(cfg), partIndex, parentOffset },
      { emitterInfo: buildSmokeInfo(cfg), partIndex, parentOffset },
    ];
  },
};

registerComponent(brazierEmbers);
export default brazierEmbers;
