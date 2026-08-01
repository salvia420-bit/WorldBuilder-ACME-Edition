// scene3d/vfx/components/terrainSwampAmbient.js — the SWAMP/MARSH synthesized
// ambient particle descriptors (Wave 3A; plan `docs/2026-07-31-terrain-vfx-plan.md`
// §3.5 items 1, 2 and 4).
//
// THREE components share this one file for the same reason `foliageAmbient.js`
// holds three: they share the terrain-anchor math but differ in gate, sprite,
// trajectory and per-effect flag, and the registry / cost model / flag router
// are all keyed by a DISTINCT component id.
//   • terrain.swampFireflies — RE-ANCHORED `foliageFireflies`, marsh-green.
//   • terrain.swampMidges    — RE-ANCHORED `foliagePollen`, tighter orbit.
//   • terrain.marshGas       — new: sluggish bubbles + a rare wisp ignition.
//
// ═══ "RE-ANCHOR, NEVER A SECOND SYSTEM" ═══════════════════════════════════
// Plan §3.5 item 1 is emphatic: fireflies ALREADY EXIST, so **do not write a
// second firefly system** — add a terrain ANCHOR SOURCE. This file takes that
// literally. `terrainSwampFireflies.emit()` calls `foliageFireflies.emit()` and
// `terrainSwampMidges.emit()` calls `foliagePollen.emit()`; neither authors a
// single emitterInfo field of its own. Everything they change is enumerated in
// ONE exported constant each (`SWAMP_FIREFLY_OVERRIDES` /
// `SWAMP_MIDGE_OVERRIDES`), and `test_terrain_swamp.mjs` diffs the produced
// spec against the canopy spec and asserts the difference set is EXACTLY those
// keys plus the anchor-derived ones. A future fix to the foliage builders
// therefore lands here for free, and a fork cannot creep in undetected.
//
// The GATES are reused verbatim too: `firefliesGate` and `pollenGate`, the same
// functions the canopy path calls. That is why `particle_env_gates.js` gained
// only ONE new gate this wave (`marshGasGate`) rather than three.
//
// ⚠ THREE TRAPS THIS FILE PAYS SO THE HOST DOES NOT
//
// T-A  `ctx.sprites` MUST NOT BE FORWARDED. `foliageAmbient.js::emitFor`
//      resolves the sprite as `sprites[self.spriteName] || cfg.hwGfxObjId`, and
//      `self` there is the CANOPY component — so a forwarded `sprites.spark`
//      would beat the marsh-green `hwGfxObjId` in our config and the "tint"
//      would silently not happen. We call through with NO sprites bag, which is
//      also how the host actually calls us (`terrain_swamp.js` passes none, the
//      same as `terrain_sand.js`/`terrain_volcano.js`).
//
// T-B  `centreLiftY` LIFTS NORTH HERE, NOT UP. `buildEmitter` writes
//      `position: {x, y: c.y + centreLiftY, z}` because a canopy anchor is a
//      part frame with +Y up. A TERRAIN anchor is AC world space with +Z up, so
//      that field would push the swarm northward. We pin `centreLiftY: 0` and
//      apply the lift ourselves on the returned `parentOffset.position.z` —
//      exactly what `terrainVolcanoEmbers.js` does with its `footLiftM`.
//
// T-C  THE POLLEN SCALE FLOOR IS NOT NEGOTIABLE FROM OUT HERE.
//      `emitFor` clamps `cfg.startScale/finalScale` UP to the canopy
//      component's authored values (the 2026-07-04 fix for the classifier's
//      broken 0.03 descriptor). So midges cannot be made SMALLER than pollen's
//      0.5/0.32 through config. Stated rather than worked around (the
//      `terrainVolcanoEmbers.js` footprint-clamp precedent): the "tighter
//      orbit" the plan asks for is delivered through the ANCHOR RADIUS the host
//      supplies (~1.1 m against a canopy's ~2.5 m), which is the spawn-sphere
//      lever, not by shrinking the sprite. Widening the clamp would mean
//      editing a shipped, tested component to serve a second consumer.
//
// WHAT THESE ARE *NOT*. None of them is a light (§5.2: `lightCountDelta: 0` —
// the wisp glow is an ADDITIVE SPRITE, never a PointLight; plan §3.5 item 2 is
// explicit) and none adds a shader program (`linkVariant() === ""`,
// `cacheKeyScope: "none"`).
//
// THE FIREWALL (plan §5.1). Reads: the resolved anchor (geometry, from static
// terrain), the derived weather/sky env, the client clock. Writes: synthesized
// client-local emitters. No wire, no physics/collision, no replicated field, no
// light count, no `Math.random` (hash01 + the clock only).
//
// Node-safe: imports only the registry, the flag readers, the pure gates, the
// pure sprite table and the two foliage components. No THREE, no window.

import { registerComponent } from "../registry.js";
import {
  terrainSwampEnabled,
  terrainSwampFirefliesEnabled,
  terrainSwampMidgesEnabled,
  terrainMarshGasEnabled,
} from "../../vfx_flags.js";
import { firefliesGate, pollenGate, marshGasGate } from "../particle_env_gates.js";
import { PARTICLE_SPRITES } from "../particle_sprites.js";
import { foliageFireflies, foliagePollen } from "./foliageAmbient.js";

/** `ParticleType` mirror (`particles/particle.js:63-77`), inlined so this leaf
 *  stays free of the THREE-bearing particle graph. */
const PT_LOCAL_VELOCITY = 2;
/** `EmitterType.BirthratePerSec` (the foliageAmbient convention). */
const EMITTER_PER_SEC = 1;

/** Below this gate value NO emitter is synthesized at all — a gated-out swamp
 *  effect costs exactly what flag-off costs (foliageAmbient's GATE_MIN). */
export const SWAMP_GATE_MIN = 0.03;

/** Deterministic 32-bit integer hash → [0,1). Identical to
 *  `foliageAmbient.js::hash01` / `terrainDustDevil.js::devilHash01`. */
export function swampHash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The AC +Z lift (metres) applied to a terrain-anchored parent frame. See
 *  trap T-B — this is why `centreLiftY` is pinned to 0 in both override sets. */
export const SWAMP_ANCHOR_LIFT_M = Object.freeze({
  fireflies: 0.45,   // hovering just over the reeds
  midges: 1.1,       // a column at head height, where a shaft of light catches it
  gas: 0.05,         // right at the water/peat surface
});

// ---------------------------------------------------------------------------
// 1. FIREFLIES — the re-anchor (plan §3.5 item 1).
// ---------------------------------------------------------------------------

/**
 * EVERY field this component changes about the canopy firefly spec. Exported so
 * the reuse proof in `test_terrain_swamp.mjs` is a one-line set comparison
 * rather than a hand-maintained list of expected diffs.
 *
 *   synthId      a distinct emitter id (two ambient sources must not collide)
 *   hwGfxObjId   THE TINT. `moonStarGreen` (0x01001A62) is a green ADDITIVE
 *                glint — additive is mandatory for a firefly (the canopy
 *                component's own comment: "MUST be an additive sprite,
 *                Surface 0x10000"), and it is the only green additive sprite in
 *                the DAT-verified palette. A colour is NOT a field on an
 *                emitterInfo; in this engine the tint IS the sprite (the blend
 *                is decided from the sprite's Surface bitfield by
 *                `particle_manager.js`, not requested here).
 *   aY/minA/maxA THE LOWER DRIFT. `a` is the linear drift term; marsh fireflies
 *                stay down among the reeds instead of climbing out of the
 *                canopy. The `b` (hover frequency) and `c` (hover amplitude)
 *                Swarm terms are DELIBERATELY UNTOUCHED so the trajectory is
 *                still bit-for-bit the retail firefly hover.
 *   centreLiftY  pinned to 0 — trap T-B.
 *
 * `basePeriodSec`, `lifespan`, `maxParticles`, `scale`/`trans` envelopes and
 * `drawRadiusM` are all left alone on purpose: identical inputs then produce an
 * identical `birthrate`, which is the sharpest available proof that this is the
 * canopy emitter with a new anchor rather than a copy.
 */
export const SWAMP_FIREFLY_OVERRIDES = Object.freeze({
  synthId: 0xF0E00020,
  hwGfxObjId: PARTICLE_SPRITES.moonStarGreen,
  aY: 0.008,
  minA: 0.12,
  maxA: 0.40,
  centreLiftY: 0,
});

export const terrainSwampFireflies = {
  id: "terrain.swampFireflies",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled() { return terrainSwampEnabled() && terrainSwampFirefliesEnabled(); },
  // The CANOPY gate, verbatim — night + calm + season, and `?foliageStrictSeason`
  // still relaxes it identically. One firefly system means one firefly gate.
  gateFn: firefliesGate,
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: { ...SWAMP_FIREFLY_OVERRIDES, liftM: SWAMP_ANCHOR_LIFT_M.fireflies },

  /**
   * PURE planner: ctx in, emitter specs out. Never touches the scene graph.
   * @param {{anchor?:object, env?:object, seed?:number, config?:object}} ctx
   */
  emit(ctx) {
    return reAnchor(foliageFireflies, this, ctx);
  },
};

// ---------------------------------------------------------------------------
// 2. MIDGE SWARMS — the pollen re-anchor (plan §3.5 item 4).
// ---------------------------------------------------------------------------

/**
 * EVERY field this component changes about the canopy pollen spec (same
 * contract as `SWAMP_FIREFLY_OVERRIDES`).
 *
 *   hwGfxObjId  THE TINT. `smokeDark` (0x01000FBF) is an ALPHA sprite, and that
 *               is deliberate: a midge column reads as a DARK smudge against a
 *               bright shaft, not as a glow. The alpha-vs-additive choice is
 *               made for us by the sprite's Surface bitfield, so swapping the
 *               id is the whole change.
 *   a-terms     TIGHTER: pollen buoys upward and away; midges hold station.
 *
 * See trap T-C for why the sprite SCALE is not in this list.
 */
export const SWAMP_MIDGE_OVERRIDES = Object.freeze({
  synthId: 0xF0E00021,
  hwGfxObjId: PARTICLE_SPRITES.smokeDark,
  aY: 0.01,
  minA: 0.10,
  maxA: 0.35,
  centreLiftY: 0,
});

export const terrainSwampMidges = {
  id: "terrain.swampMidges",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled() { return terrainSwampEnabled() && terrainSwampMidgesEnabled(); },
  gateFn: pollenGate,          // the CANOPY gate, verbatim
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: { ...SWAMP_MIDGE_OVERRIDES, liftM: SWAMP_ANCHOR_LIFT_M.midges },

  emit(ctx) {
    return reAnchor(foliagePollen, this, ctx);
  },
};

/**
 * THE re-anchor. Call the canopy component with our overrides, then replace the
 * anchor frame with a terrain one (AC +Z lift — trap T-B).
 *
 * The returned specs are the canopy component's OWN `emitterInfo` objects,
 * untouched: only `partIndex` and `parentOffset` are rebuilt. That is what
 * `test_terrain_swamp.mjs` asserts.
 *
 * @param {object} source the canopy component (foliageFireflies / foliagePollen)
 * @param {object} self   the terrain component
 * @param {{anchor?:object, env?:object, seed?:number, config?:object}} ctx
 */
function reAnchor(source, self, ctx) {
  const g = self.gateFn(ctx && ctx.env);
  if (!(g > SWAMP_GATE_MIN)) return [];              // gated out → byte-free
  const cfg = { ...self.defaults, ...((ctx && ctx.config) || {}) };
  const anchor = (ctx && ctx.anchor)
    || { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 1 };
  // ⚠ NO `sprites` bag — trap T-A. The canopy component would resolve its own
  // sprite name out of it and the marsh tint would be silently discarded.
  const specs = source.emit({
    env: ctx && ctx.env,
    anchor,
    seed: (ctx && ctx.seed) >>> 0,
    config: cfg,
  }) || [];
  if (!Array.isArray(specs) || specs.length === 0) return [];
  const c = anchor.center || { x: 0, y: 0, z: 0 };
  const lift = Number.isFinite(cfg.liftM) ? cfg.liftM : 0;
  const parentOffset = {
    position: { x: c.x, y: c.y, z: c.z + lift },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
  };
  // A terrain anchor is always the static/root seam — there is no part frame.
  return specs.map((s) => ({ emitterInfo: s.emitterInfo, partIndex: -1, parentOffset }));
}

// ---------------------------------------------------------------------------
// 3. MARSH GAS — bubbles, and the rare wisp (plan §3.5 item 2).
//
// This one is NOT a re-anchor: nothing in the component catalogue vents gas.
// `brazierEmbers` is a fire plus its smoke (wrong trajectory, wrong lifetime,
// and its builders clamp the spawn ball to a bowl), and `terrainDustDevil` is a
// rotating column. So this is authored, in the `terrainDustDevil.js` shape —
// which is itself the `foliageAmbient.js` shape.
//
// TWO MODES, one entry point (`ctx.config.mode`):
//   "bubbles" (default) — PERSISTENT (`totalSeconds: 0`), a slow, sparse alpha
//                         puff rising a metre or two and dissolving.
//   "wisp"              — FINITE (`totalSeconds` ≈ 2 s): the ignition. The
//                         emitter self-expires in `particle_emitter.js:320`, so
//                         the HOST just creates one and forgets it. An ADDITIVE
//                         halo that swells — never a light (§5.2).
// The host (`terrain_swamp.js`) owns the long timer that decides WHEN to ask
// for a wisp; this file owns what a wisp IS.
// ---------------------------------------------------------------------------

export const terrainMarshGas = {
  id: "terrain.marshGas",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  enabled() { return terrainSwampEnabled() && terrainMarshGasEnabled(); },
  gateFn: marshGasGate,
  spriteName: "smokePuff",
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],
  defaults: {
    mode: "bubbles",
    liftM: SWAMP_ANCHOR_LIFT_M.gas,
    // --- bubbles -----------------------------------------------------------
    bubbleSynthId: 0xF0E00022,
    bubbleGfxObjId: PARTICLE_SPRITES.smokePuff,   // alpha puff (NOT additive)
    bubblePeriodSec: 1.7,          // sluggish: this is a marsh, not a kettle
    bubbleMaxParticles: 10,
    bubbleInitial: 2,
    bubbleLifespan: 3.6, bubbleLifespanRand: 1.2,
    bubbleRadiusM: 0.7,            // spawn ball at the vent mouth
    bubbleRiseMps: 0.55,
    bubbleMinRise: 0.5, bubbleMaxRise: 1.3,
    bubbleStartScale: 0.16, bubbleFinalScale: 0.5, bubbleScaleRand: 0.2,
    bubbleStartTrans: 0.55, bubbleFinalTrans: 1.0, bubbleTransRand: 0.15,
    bubbleDrawRadiusM: 110,        // low, small, alpha — a short read
    // --- the wisp ----------------------------------------------------------
    wispSynthId: 0xF0E00023,
    wispGfxObjId: PARTICLE_SPRITES.glowPlume,     // ADDITIVE halo that swells
    wispSeconds: 2.0,              // plan §3.5: "a ~2 s wisp"
    wispPeriodSec: 0.22,
    wispMaxParticles: 12,
    wispInitial: 3,
    wispLifespan: 1.5, wispLifespanRand: 0.4,
    wispRadiusM: 0.5,
    wispRiseMps: 1.15,
    wispMinRise: 0.6, wispMaxRise: 1.2,
    wispStartScale: 0.35, wispFinalScale: 1.5, wispScaleRand: 0.15,
    wispStartTrans: 0.1, wispFinalTrans: 1.0, wispTransRand: 0.1,
    wispDrawRadiusM: 220,          // additive night flare — reads much further
  },

  /**
   * PURE planner: ctx in, emitter specs out.
   * @param {{anchor?:object, env?:object, seed?:number, config?:object}} ctx
   */
  emit(ctx) {
    const g = this.gateFn(ctx && ctx.env);
    if (!(g > SWAMP_GATE_MIN)) return [];            // gated out → byte-free
    const cfg = { ...this.defaults, ...((ctx && ctx.config) || {}) };
    const wisp = cfg.mode === "wisp";
    const gfx = ((wisp ? cfg.wispGfxObjId : cfg.bubbleGfxObjId) || 0) >>> 0;
    if (gfx === 0) return [];                        // invisible-guard
    const seed = (ctx && ctx.seed) >>> 0;
    // Distinct hash salts so a vent's bubble period and its wisp period are
    // decorrelated even though both derive from the one slot seed.
    const h = swampHash01(seed ^ (wisp ? 0x77157000 : 0x0bb1e000));
    const h2 = swampHash01(seed ^ 0x5bd1e995);
    const anchor = (ctx && ctx.anchor)
      || { partIndex: -1, center: { x: 0, y: 0, z: 0 } };

    // `birthrate` is the inter-spawn PERIOD IN SECONDS, not a rate
    // (`particle_emitter_info.js:266`) — the foliageAmbient convention: divide
    // the authored period by the gate so a stronger gate vents faster.
    const basePeriod = wisp ? cfg.wispPeriodSec : cfg.bubblePeriodSec;
    const period = (basePeriod * (0.85 + 0.3 * h)) / Math.max(g, SWAMP_GATE_MIN);
    const radius = (wisp ? cfg.wispRadiusM : cfg.bubbleRadiusM) * (0.85 + 0.3 * h2);

    const emitterInfo = {
      id: (wisp ? cfg.wispSynthId : cfg.bubbleSynthId) >>> 0,
      emitterType: EMITTER_PER_SEC,
      // Straight local-velocity rise. A bubble does not orbit and a wisp does
      // not spin — Swarm would be wrong for both.
      particleType: PT_LOCAL_VELOCITY,
      hwGfxObjId: gfx,
      birthrate: period,
      maxParticles: wisp ? cfg.wispMaxParticles : cfg.bubbleMaxParticles,
      initialParticles: wisp ? cfg.wispInitial : cfg.bubbleInitial,
      // THE ONE STRUCTURAL DIFFERENCE: a wisp is FINITE and self-expires
      // (`particle_emitter.js:320`); bubbles are ambient and persistent.
      totalParticles: 0,
      totalSeconds: wisp ? cfg.wispSeconds : 0,
      lifespan: wisp ? cfg.wispLifespan : cfg.bubbleLifespan,
      lifespanRand: wisp ? cfg.wispLifespanRand : cfg.bubbleLifespanRand,
      // Spawn volume: a filled sphere of `radius` at the vent mouth.
      offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
      minOffset: 0,
      maxOffset: radius,
      // a = the rise (AC z-up). No lateral term: gas goes straight up and the
      // wind is not modelled here (marshGasGate already thins it in a gust).
      aX: 0, aY: 0, aZ: wisp ? cfg.wispRiseMps : cfg.bubbleRiseMps,
      minA: wisp ? cfg.wispMinRise : cfg.bubbleMinRise,
      maxA: wisp ? cfg.wispMaxRise : cfg.bubbleMaxRise,
      bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1,
      cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1,
      scaleRand: wisp ? cfg.wispScaleRand : cfg.bubbleScaleRand,
      startScale: wisp ? cfg.wispStartScale : cfg.bubbleStartScale,
      finalScale: wisp ? cfg.wispFinalScale : cfg.bubbleFinalScale,
      transRand: wisp ? cfg.wispTransRand : cfg.bubbleTransRand,
      startTrans: wisp ? cfg.wispStartTrans : cfg.bubbleStartTrans,
      finalTrans: wisp ? cfg.wispFinalTrans : cfg.bubbleFinalTrans,
      isParentLocal: false,        // spawn at the anchor, then drift in world
      degradeDistanceMeters: wisp ? cfg.wispDrawRadiusM : cfg.bubbleDrawRadiusM,
    };

    const c = anchor.center || { x: 0, y: 0, z: 0 };
    const lift = Number.isFinite(cfg.liftM) ? cfg.liftM : 0;
    return [{
      emitterInfo,
      partIndex: -1,
      parentOffset: {
        position: { x: c.x, y: c.y, z: c.z + lift },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
      },
    }];
  },
};

registerComponent(terrainSwampFireflies);
registerComponent(terrainSwampMidges);
registerComponent(terrainMarshGas);

export default { terrainSwampFireflies, terrainSwampMidges, terrainMarshGas };
