// scene3d/vfx/components/foliageAmbient.js — synthesized ambient-foliage
// particle components (Visual-Behavior Suite, Phase 3 / P3.7 — 2026-06-24).
//
// THREE registered components share this one file (DRY) because they share the
// sprite/anchor/spawn-volume math but differ in gate, sprite, trajectory, and
// per-effect flag — and the registry/cost-model/flag-router are all keyed by a
// DISTINCT component id, so a shared id could not carry three independent
// ?flags or three cost rows:
//   • particle.foliagePollen — sphere-spread soft motes, DAY + calm + growing
//     season (pollenGate). Alpha-ish soft sprite. ParticleType.LocalVelocity.
//   • particle.fireflies     — sphere-spread ADDITIVE sparks, DUSK/NIGHT + warm
//     season (firefliesGate). Additive sprite. ParticleType.Swarm (cos(b·t)·C
//     hover, particle.js:231 — the retail firefly/swarm trajectory).
//   • particle.leaves        — canopy-PART emitter, downward flutter + fade
//     before ground, AUTUMN + wind (leavesGate). Alpha leaf sprite.
//     ParticleType.ParabolicLVGAGR (local vel + gravity + resist → falling arc).
// (This mirrors how weathering.{frost,wetness} share ensureWorldNormalVarying +
// the "precip" channel yet register as separate components with separate flags.)
//
// THE FIREWALL (build-spec §1.2 / handoff §5): a particle component READS only
// static/derived inputs (the resolved anchor bbox = geometry, the client clock,
// derived weather/sky env) and WRITES only a SYNTHESIZED client-local additive/
// alpha billboard emitter ("emitter" cap) — never wire, physics/collision,
// replicated state, or a light count. Variety is deterministic: hash01(seed) +
// the clock, NEVER Math.random. cacheKeyScope "none" (particles add NO shader
// program → linkVariant() === "" → nothing to key). lightCountDelta 0.
//
// SYNTHESIZE, don't replay DAT 0x32: emit() returns a plain emitterInfo POJO
// (particle_emitter_info.js accepts POJOs) naming an EXISTING sprite hwGfxObjId
// from particle_sprites.js (P3.2) — so it renders with zero wasm rebuild via the
// entities.js:9019 geometry/material factories. additive-vs-alpha is decided by
// the sprite's Surface (surfaceTypeFlags & 0x10000), NOT this POJO.
//
// Node-safe + lint-clean: imports only the registry, the per-effect flags, and
// the pure gates. No THREE, no window, no forbidden source pattern.

import { registerComponent } from "../registry.js";
import {
  foliagePollenEnabled, foliageFirefliesEnabled, foliageLeavesEnabled,
} from "../../vfx_flags.js";
import { pollenGate, firefliesGate, leavesGate } from "../particle_env_gates.js";
import { PARTICLE_SPRITES } from "../particle_sprites.js"; // D6: components import sprites directly (not via ctx)

// ParticleType enum mirror (scene3d/particles/particle.js:63-77). Inlined as a
// constant so this leaf stays free of the THREE-bearing particle graph (the
// legacy-safety harness imports it under plain node).
const PT_LOCAL_VELOCITY = 2;     // LocalVelocity — drift along `a`
const PT_SWARM = 5;              // Swarm — cos(b·t)*C hover oscillation (fireflies)
const PT_PARABOLIC_LVGAGR = 4;   // ParabolicLVGAGR — local vel + gravity + resist (fall)
const EMITTER_PER_SEC = 1;       // EmitterType.BirthratePerSec

// Below this gate value the attach layer creates NO emitter (so a gated-out
// effect costs exactly what flag-off costs: zero draw calls). Smooth ramp above.
const GATE_MIN = 0.03;

// Distance draw-cull for foliage ambient (2026-07-04). Foliage motes/sparks are
// canopy-local and imperceptible past a few tens of metres, yet the streaming
// ring is 13×13 LBs (~1.15 km) — a live Holtburg census found 3,733 pollen
// emitters (96% of ALL static emitters), nearly all far from the player. We
// stamp each foliage emitter with a short `degradeDistanceMeters`; ParticleManager
// honours it via the RP6/degrade cull (skips BOTH updateParticles + draw beyond
// the radius, restores on approach — NOT a bake-time skip, so foliage still
// appears up close and never needs a re-bake). `?foliageParticleRadius=N` scales
// all three radii (N metres at the reference 90 m pollen tuning; 0 disables the
// cull → foliage draws to the full ring as before). Additive/night fireflies read
// further than daytime pollen. NEEDS a 1070 eye-test to tune the pop-in distance.
const FOLIAGE_DRAW_RADIUS_REF_M = 90;   // reference radius (pollen); per-effect scales off this
let _foliageRadiusOverride;
function _foliageRadiusScale() {
  if (_foliageRadiusOverride !== undefined) return _foliageRadiusOverride;
  let scale = 1;
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const raw = new URLSearchParams(globalThis.location.search).get("foliageParticleRadius");
      if (raw != null) {
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) scale = v / FOLIAGE_DRAW_RADIUS_REF_M; // N metres → scale
      }
    }
  } catch (_) { scale = 1; }
  _foliageRadiusOverride = scale;
  return scale;
}
// Resolve a component's draw radius (metres). `p.drawRadiusM` is the per-effect
// authored value; the URL override scales it. 0 (or ≤0) ⇒ no cull (Infinity).
function _foliageDrawRadiusM(baseM) {
  const scale = _foliageRadiusScale();
  if (scale === 0) return 0;                       // ?foliageParticleRadius=0 → disable
  const r = (Number.isFinite(baseM) ? baseM : FOLIAGE_DRAW_RADIUS_REF_M) * scale;
  return r > 0 ? r : 0;
}

// Deterministic 32-bit integer hash → [0,1) (identical to flameFlicker.js:48).
// No Math.random / no Date.now.
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Build ONE synthesized ambient emitter spec for the foliage family.
 * Returns the `{emitterInfo, partIndex, parentOffset}` shape the attach layer
 * forwards to ParticleManager.addEmitter (handoff §2).
 *
 * `birthrate` is the inter-spawn PERIOD IN SECONDS (NOT a rate): the emitter
 * spawns when `currentTime - lastEmitTime > birthrate`
 * (particle_emitter_info.js:266). We divide the authored base period by the
 * gate scalar `g`, so a brighter gate → shorter period → more particles, and
 * g→GATE_MIN → sparse. maxParticles stays fixed (small) and quality-capped by
 * the pipeline (particle_emitter.js:164-196, 64/256/1024/2048 per preset).
 *
 * @param {object} p      per-effect spawn params (see each component's defaults).
 * @param {{partIndex:number, center:{x,y,z}, radius:number}} anchor  resolved by
 *        P3.6's `vfx anchor-parts` selector (canopy part-local bbox).
 * @param {number} hwGfxObjId  the sprite gfxobj (from ctx.sprites, P3.2).
 * @param {number} seed   deterministic per-placement seed (ctx.seed / instanceHash).
 * @param {number} g      gate visibility ∈ (GATE_MIN, 1].
 */
function buildEmitter(p, anchor, hwGfxObjId, seed, g) {
  const h = hash01(seed);
  const h2 = hash01(seed ^ 0x5bd1e995);
  // ±15% per-placement jitter on period + radius so co-located trees differ
  // (deterministic — no Math.random).
  const periodJitter = 0.85 + 0.30 * h;
  const radiusJitter = 0.90 + 0.20 * h2;
  const radius = (anchor && Number.isFinite(anchor.radius) ? anchor.radius : 1.0) * radiusJitter;
  const period = (p.basePeriodSec * periodJitter) / Math.max(g, GATE_MIN);

  const emitterInfo = {
    id: p.synthId >>> 0,
    emitterType: EMITTER_PER_SEC,
    particleType: p.particleType,
    hwGfxObjId: hwGfxObjId >>> 0,
    birthrate: period,                 // seconds-per-particle (see above)
    maxParticles: p.maxParticles,
    initialParticles: p.initialParticles,
    totalParticles: 0,                 // 0 = infinite → persistent ambient
    totalSeconds: 0,                   // 0 = infinite
    lifespan: p.lifespan,
    lifespanRand: p.lifespanRand,
    // Spawn volume: offsetDir (0,0,0) + minOffset 0 + maxOffset radius =
    // a filled sphere of `radius` (getRandomOffset projects out offsetDir, then
    // scales a random unit vector by [minOffset,maxOffset] — info.js:185-212).
    offsetDirX: p.offsetDirX, offsetDirY: p.offsetDirY, offsetDirZ: p.offsetDirZ,
    minOffset: 0,
    maxOffset: radius,
    // Velocity / accel / oscillation vectors (a/b/c) + their min/max scalars.
    aX: p.aX, aY: p.aY, aZ: p.aZ, minA: p.minA, maxA: p.maxA,
    bX: p.bX, bY: p.bY, bZ: p.bZ, minB: p.minB, maxB: p.maxB,
    cX: p.cX, cY: p.cY, cZ: p.cZ, minC: p.minC, maxC: p.maxC,
    // Scale + translucency envelopes (trans: 0=opaque, 1=invisible).
    scaleRand: p.scaleRand, startScale: p.startScale, finalScale: p.finalScale,
    transRand: p.transRand, startTrans: p.startTrans, finalTrans: p.finalTrans,
    isParentLocal: false,              // spawn at anchor, then drift in world space
    // Distance draw-cull radius (metres): ParticleManager stamps this onto
    // emitter.degradeDistance + _forceDegrade so the RP6/degrade cull skips this
    // emitter's update+draw beyond the radius, flag-independently. 0 ⇒ no cull.
    degradeDistanceMeters: _foliageDrawRadiusM(p.drawRadiusM),
  };

  // Raise the spawn-sphere centre to the canopy centroid (part-local). The
  // attach layer converts the part frame world→scene-local (particle_emitter.js
  // _resolveAnchorFrame, the 2026-06-20 fix) — we never touch the worldRoot flip.
  const c = (anchor && anchor.center) || { x: 0, y: 0, z: 0 };
  const parentOffset = {
    position: { x: c.x, y: c.y + (p.centreLiftY || 0), z: c.z },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };

  return { emitterInfo, partIndex: (anchor && anchor.partIndex != null) ? anchor.partIndex : -1, parentOffset };
}

/**
 * The shared emit(ctx) hook. Reads the gate, and if visible enough returns a
 * single-element emitter array; otherwise [] (no emitter synthesized).
 * @param {object} self  the component object (carries defaults + gateFn + spriteName).
 * @param {object} ctx   { config, env, anchor, sprites, seed }
 */
function emitFor(self, ctx) {
  const g = self.gateFn(ctx && ctx.env);
  if (!(g > GATE_MIN)) return [];                       // gated out → byte-free
  const cfg = { ...self.defaults, ...(ctx && ctx.config) };
  // Scale-floor (2026-07-04). The classifier's dist/vfx/visual_descriptors.jsonl
  // bakes a broken `startScale/finalScale: 0.03` into EVERY foliage-pollen entry
  // (16× below the authored 0.5/0.32 → getRandomStartScale clamps to the 0.1
  // mesh-scale floor → ~1 cm motes = invisible; this is why pollen was never
  // seen). The COMPONENT default is the intended mote size, so never let the
  // descriptor config SHRINK a foliage effect below it — a legitimately-LARGER
  // descriptor scale still wins. Fixes the size without regenerating the data.
  cfg.startScale = Math.max(cfg.startScale ?? 0, self.defaults.startScale ?? 0);
  cfg.finalScale = Math.max(cfg.finalScale ?? 0, self.defaults.finalScale ?? 0);
  const sprites = (ctx && ctx.sprites) || {};
  const hwGfxObjId = (sprites[self.spriteName] || cfg.hwGfxObjId || 0) >>> 0;
  if (hwGfxObjId === 0) return [];                      // no sprite resolved → invisible-guard
  const anchor = (ctx && ctx.anchor) || { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: cfg.maxOffset || 1.0 };
  const seed = (ctx && ctx.seed) >>> 0;
  return [buildEmitter(cfg, anchor, hwGfxObjId, seed, g)];
}

// ── particle.foliagePollen ────────────────────────────────────────────────────
export const foliagePollen = {
  id: "particle.foliagePollen",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },        // particles add NO shader program
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled: foliagePollenEnabled,        // per-effect gate (?visual && ?foliagePollen)
  gateFn: pollenGate,
  spriteName: "softDot",
  // Reads: the resolved anchor bbox (geometry) + derived weather/sky env
  // (weather) + the client clock (the emitter's per-particle phase). Writes:
  // ONLY a synthesized emitter. Never wire/physics/collision/replicated.
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    synthId: 0xF0E00001,
    hwGfxObjId: PARTICLE_SPRITES.softGlowDot, // soft daytime mote
    particleType: PT_LOCAL_VELOCITY,
    basePeriodSec: 0.7,                 // ~1.4 motes/sec at g=1, sparser as g↓
    maxParticles: 12,
    initialParticles: 4,
    lifespan: 8.0, lifespanRand: 2.0,   // slow long float
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,   // filled-sphere spawn
    centreLiftY: 0,                      // canopy centroid already supplied by anchor
    // Gentle buoyant drift: tiny upward `a`, small magnitude variance.
    aX: 0, aY: 0.05, aZ: 0, minA: 0.4, maxA: 1.2,
    bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1,
    cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1,
    scaleRand: 0.15, startScale: 0.5, finalScale: 0.32,
    transRand: 0.1, startTrans: 0.25, finalTrans: 1.0,  // fade out at end of life
    drawRadiusM: 90,                     // daytime motes — short range (see _foliageDrawRadiusM)
  },
  emit(ctx) { return emitFor(this, ctx); },
};

// ── particle.fireflies ────────────────────────────────────────────────────────
export const foliageFireflies = {
  id: "particle.foliageFireflies",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled: foliageFirefliesEnabled,
  gateFn: firefliesGate,
  spriteName: "spark",                   // MUST be an additive sprite (Surface 0x10000)
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    synthId: 0xF0E00002,
    hwGfxObjId: PARTICLE_SPRITES.ember,       // ADDITIVE spark (fireflies MUST be additive)
    particleType: PT_SWARM,              // cos(b·t)*C hover (particle.js:231)
    basePeriodSec: 1.1,                  // sparse — fireflies are few
    maxParticles: 8,
    initialParticles: 3,
    lifespan: 4.5, lifespanRand: 1.5,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    centreLiftY: 0,
    // Swarm: `a` slow drift, `b` oscillation frequency, `c` oscillation amplitude.
    aX: 0, aY: 0.02, aZ: 0, minA: 0.3, maxA: 0.9,
    bX: 0.9, bY: 1.3, bZ: 0.7, minB: 0.6, maxB: 1.4,
    cX: 0.25, cY: 0.18, cZ: 0.25, minC: 0.5, maxC: 1.0,
    scaleRand: 0.1, startScale: 0.22, finalScale: 0.22,  // constant tiny dot
    transRand: 0.2, startTrans: 0.15, finalTrans: 1.0,   // blink out
    drawRadiusM: 150,                    // additive night sparks — read further than pollen
  },
  emit(ctx) { return emitFor(this, ctx); },
};

// ── particle.leaves ───────────────────────────────────────────────────────────
export const foliageLeaves = {
  id: "particle.foliageLeaves",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled: foliageLeavesEnabled,
  gateFn: leavesGate,
  spriteName: "leaf",                    // alpha leaf sprite
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    synthId: 0xF0E00003,
    hwGfxObjId: PARTICLE_SPRITES.leafMote,    // alpha leaf
    particleType: PT_PARABOLIC_LVGAGR,   // falling arc with drift + resist
    basePeriodSec: 0.9,
    maxParticles: 16,
    initialParticles: 0,                 // none pre-seeded (they fall, don't hover)
    lifespan: 6.0, lifespanRand: 1.5,    // tuned so finalTrans→1 BEFORE ground
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    centreLiftY: 0,                       // spawn across the canopy volume
    // a = small lateral drift; b = gentle downward gravity; c = flutter resist.
    aX: 0.15, aY: 0, aZ: 0.15, minA: 0.4, maxA: 1.0,
    bX: 0, bY: -0.45, bZ: 0, minB: 0.7, maxB: 1.2,   // fall speed
    cX: 0.2, cY: 0, cZ: 0.2, minC: 0.5, maxC: 1.0,    // sideways flutter
    scaleRand: 0.2, startScale: 0.9, finalScale: 0.9,
    transRand: 0.1, startTrans: 0.0, finalTrans: 1.0, // FADE before reaching ground
    drawRadiusM: 120,                    // falling leaves — mid range
  },
  emit(ctx) { return emitFor(this, ctx); },
};

registerComponent(foliagePollen);
registerComponent(foliageFireflies);
registerComponent(foliageLeaves);

export default { foliagePollen, foliageFireflies, foliageLeaves };
