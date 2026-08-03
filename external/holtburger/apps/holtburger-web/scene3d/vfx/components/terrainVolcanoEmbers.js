// terrain.volcanoEmbers — VOLCANO/OBSIDIAN ember vents (Wave 2B; design plan
// `docs/2026-07-31-terrain-vfx-plan.md` §3.6 item 2).
//
// "RE-ANCHOR, DON'T REWRITE" — that is the plan's whole instruction for this
// effect, and this file takes it literally: it does not author a single
// emitterInfo field of its own. `brazierEmbers.js` already owns two builders
// (`buildEmberInfo` = rising ADDITIVE embers, `buildSmokeInfo` = a slower ALPHA
// plume), both DAT-confirmed against real sprite Surfaces and both covered by
// `test_brazier_emit.mjs`. This descriptor calls `brazierEmbers.emit()` with a
// VOLCANO config and then replaces the anchor. The emitter spec it returns is
// therefore byte-identical to the brazier path modulo the anchor — which is the
// property `test_terrain_volcano.mjs` asserts, and the reason a future fix to
// the brazier builders lands here for free.
//
// THE ANCHOR IS THE NEW PART (the same observation wave 1B's dust devil makes):
// brazier anchors resolve a flame-bowl part frame at BAKE time from a scenery
// GfxObj. A terrain vent has no GfxObj, so the HOST (`scene3d/terrain_volcano.js`)
// resolves the anchor at LANDBLOCK-READY time from the oracle and passes
// `ctx.anchor = {partIndex: -1, center}`; the emitter is PARENTED AT the vent,
// so the returned `parentOffset` is that frame's origin plus the foot lift.
//
// ⚠ THE FOOTPRINT CLAMP, stated rather than worked around. `buildEmberInfo`
// clamps `maxOffset` (the spawn-ball radius) to `_clamp(bowlRadius, 0.01, 1)` —
// a brazier authoring guard. So the "wider terrain footprint" the plan asks for
// is delivered at the LANDBLOCK scale (up to `terrainVolcanoEmberCount` vents
// per LB, each on a distinct FAM_VOLCANO vertex with ±7 m of hash-stable
// jitter), not by widening one emitter past its clamp. Widening the clamp would
// mean editing a shipped, tested component to serve a second consumer — a fork
// by another name. Noted as a known gap in the wave-2B handoff.
//
// WHAT IT IS *NOT*. A vent is NOT a light (§5.2: `lightCountDelta: 0` — glowing
// things are additive sprites, never a PointLight; the brazier ember sprite
// 0x01000FF4 is an additive Surface) and it adds no shader program
// (`linkVariant() === ""`, `cacheKeyScope: "none"`).
//
// THE FIREWALL (plan §5.1). Reads: the resolved anchor (geometry, from static
// terrain), the derived weather/sky env, the client clock. Writes: synthesized
// client-local emitters. No wire, no physics/collision, no replicated field, no
// light count, no `Math.random` (hash01 + the clock only).
//
// Node-safe: imports only the registry, the flag readers and the brazier
// builders. No THREE, no window.

import { registerComponent } from "../registry.js";
import { terrainVolcanoEnabled, terrainEmbersEnabled } from "../../vfx_flags.js";
import { brazierEmbers } from "./brazierEmbers.js";

/** Below this gate value NO emitter is synthesized at all — a gated-out vent
 *  costs exactly what flag-off costs (the foliageAmbient GATE_MIN contract). */
export const VENT_GATE_MIN = 0.05;

/** Deterministic 32-bit integer hash → [0,1). Identical to
 *  `terrainDustDevil.js::devilHash01` / `foliageAmbient.js::hash01`. */
export function ventHash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Environmental gate for an ember vent, in the `particle_env_gates.js` shape
 * (env → 0..1). PURE and total: it never throws.
 *
 * NULL ENV ⇒ 0 (2026-08-03), which is what "exactly like the foliage gates"
 * always claimed and never did — pollenGate/firefliesGate/leavesGate/
 * breathFogGate all return 0 for a null env; this returned 1. A null env is a
 * WIRING FAULT, not a weather state (`readParticleEnv` always returns a filled
 * scratch), so full-strength vents with zero environmental response was the worst
 * of the three options. See the marshGasGate note in `particle_env_gates.js` for
 * the full rationale.
 *
 * Volcanic vents are a persistent geological feature, not weather — so unlike
 * the dust devil this does NOT go to zero in a storm. Rain DAMPS it (steam and
 * quenched embers), and it reads slightly STRONGER at night, which is when a
 * dull ember actually registers against the ground.
 *  • wetness (0..1)               ⇒ down to 0.45 in the wet.
 *  • night   (`nightFactor` 0..1) ⇒ up to 1.25, clamped at 1.
 * @param {object|null} env `readParticleEnv` snapshot.
 * @returns {number} 0..1
 */
export function volcanoEmberGate(env) {
  if (!env) return 0;
  const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const wet = clamp01(env.wetness);
  const night = clamp01(env.nightFactor);
  const g = (1 - 0.55 * wet) * (1 + 0.25 * night);
  return Math.min(1, Math.max(0, g));
}

/**
 * Apply the environmental gate to a vent config.
 *
 * `birthrate` on these emitters is the inter-spawn PERIOD IN SECONDS, not a rate
 * (`particle_emitter_info.js:266`) — the foliageAmbient convention — so a
 * STRONGER gate means a SHORTER period. Exported because it is the exact config
 * the brazier builders are called with, which is what makes the "same spec
 * modulo anchor" assertion checkable from a test.
 *
 * @param {object} cfg
 * @param {number} g gate, 0..1
 */
export function gatedVentConfig(cfg, g) {
  const gate = Number.isFinite(g) && g > 0 ? g : 1;
  if (gate === 1) return cfg;
  return {
    ...cfg,
    emberBirthrate: cfg.emberBirthrate / gate,
    smokeBirthrate: cfg.smokeBirthrate / gate,
  };
}

export const terrainVolcanoEmbers = {
  id: "terrain.volcanoEmbers",
  family: "particle",
  mech: "particle",
  channel: "emitter",
  linkVariant() { return ""; },     // particles add NO shader program
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0,
  // Composed: the family master AND the per-effect flag (plan §2.4 firewall).
  enabled() { return terrainVolcanoEnabled() && terrainEmbersEnabled(); },
  gateFn: volcanoEmberGate,
  reads: ["geometry", "weather", "clock"],
  writes: ["emitter"],

  // VOLCANO overrides on top of `brazierEmbers.defaults`. Everything not named
  // here is inherited from the brazier, deliberately: the sprite ids, the
  // additive/alpha split, the clamps and the persistence flags are all
  // DAT-confirmed there and must not drift.
  //   • bigger, longer-lived, faster-rising embers than a torch bowl
  //   • a fatter, slower smoke plume — this is ground venting, not a candle
  //   • `offset` is the STATIC (root-anchor) model-space offset the brazier path
  //     applies; the host parents the emitter AT the vent, so it is zero here
  //     and the foot lift is applied to the anchor instead.
  defaults: {
    ...brazierEmbers.defaults,
    partIndex: -1,
    offset: [0, 0, 0],
    localOffset: [0, 0, 0],
    bowlRadius: 1.0,               // the brazier builder clamps this at 1 m
    emberMaxParticles: 36,
    emberInitial: 10,
    emberBirthrate: 0.09,
    emberLifespan: 2.4,
    emberLifespanRand: 0.9,
    emberRiseSpeed: 1.6,
    emberStartScale: 0.22,
    emberFinalScale: 0.04,
    emberScaleRand: 0.06,
    smokeMaxParticles: 14,
    smokeInitial: 3,
    smokeBirthrate: 0.7,
    smokeLifespan: 5.0,
    smokeLifespanRand: 1.6,
    smokeRiseSpeed: 0.7,
    smokeStartScale: 0.4,
    smokeFinalScale: 2.2,
    smokeScaleRand: 0.08,
    // Host-side only (never reaches an emitterInfo): the height above the
    // sampled ground the vent's parent frame sits at.
    footLiftM: 0.15,
  },

  /**
   * PURE planner: ctx in, emitter specs out. Never touches the scene graph
   * (runtime anchoring is `particle_emitter._resolveAnchorFrame`'s job).
   *
   * Returns the brazier's OWN two specs with the anchor replaced — see the
   * header. `ctx.rig` is deliberately NOT forwarded: a terrain vent is always
   * the static/root-anchor seam.
   *
   * @param {{anchor?:object, env?:object, seed?:number, config?:object}} ctx
   */
  emit(ctx) {
    const g = this.gateFn(ctx && ctx.env);
    if (!(g > VENT_GATE_MIN)) return [];          // gated out → no emitter at all
    const cfg = gatedVentConfig({ ...this.defaults, ...((ctx && ctx.config) || {}) }, g);
    const specs = brazierEmbers.emit({ config: cfg }) || [];
    const anchor = (ctx && ctx.anchor) || { partIndex: -1, center: { x: 0, y: 0, z: 0 } };
    const c = anchor.center || { x: 0, y: 0, z: 0 };
    const lift = Number.isFinite(cfg.footLiftM) ? cfg.footLiftM : 0;
    const parentOffset = {
      position: { x: c.x, y: c.y, z: c.z + lift },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
    const partIndex = Number.isFinite(anchor.partIndex) ? anchor.partIndex : -1;
    return specs.map((s) => ({ emitterInfo: s.emitterInfo, partIndex, parentOffset }));
  },
};

registerComponent(terrainVolcanoEmbers);
export default terrainVolcanoEmbers;
