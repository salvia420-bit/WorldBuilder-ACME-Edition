// Per-effect VFX flag readers — Visual-Behavior Suite, Phase 1 (2026-06-23).
//
// The ?visual master gate (vfx_catalog.js visualEnabled()) turns the
// descriptor-catalog VFX path ON; these per-effect flags pick WHICH cheap-
// fragment effects within that path are live. Every per-effect flag is a
// NON-RETAIL enhancement and defaults to visualAllEffects() — DEFAULT-ON
// since the 2026-06-24 suite validation (`?visualAll=off` drops them all,
// a per-effect `=off` drops one; `?visual=off` kills the whole suite).
//
// THE FIREWALL AT THE FLAG LAYER: an effect is active iff
//   visualEnabled()  AND  <its per-effect flag>
// — gating on BOTH means a per-effect flag alone (e.g. ?glint=on without
// ?visual) NEVER builds a VFX material variant. vfxEffectEnabled(id) is the one
// gate the frag-install path + each component installer consult.
//
// `?visual=all` (or `?visualAll=on`) is the one-URL "light everything" switch:
// it flips the master gate on AND defaults every per-effect flag on, so the 1070
// eye-test can A/B the whole suite in one URL; opt out per effect with
// `?glint=off` etc.
//
// `?visualBudget` is a governor STUB — parsed + memoized now so the future
// bloom/light governor (build spec §10/§11) can read a cap without a later
// flag-plumbing change; nothing consumes it yet (queued-for-1070).
//
// Import-cycle-safe: imports ONLY visualEnabled from vfx_catalog.js, which
// imports nothing from the scene3d graph. No back-edges → no static cycle.
// Lint-clean by construction (no Math.random / argless Date.now / .visible= /
// wire / per-instance cache key); this module lives outside scene3d/vfx/
// components/ so the legacy-safety component sweep does not scan it, but it is
// kept clean regardless.

import { visualEnabled } from "./vfx_catalog.js";

function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}

function _boolFlag(name, def) {
  const v = _strFlag(name);
  if (v == null) return def;
  const s = v.toLowerCase();
  if (s === "on" || s === "1" || s === "true" || s === "yes") return true;
  if (s === "off" || s === "0" || s === "false" || s === "no" || s === "") return false;
  return def;
}

function _numFlag(name, def, min, max) {
  const v = _strFlag(name);
  const n = v == null ? NaN : parseFloat(v);
  if (Number.isFinite(n) && (min == null || n >= min) && (max == null || n <= max)) return n;
  return def;
}

let _materialBake;
/** Phase-5 — `?material=off` escapes the baked roughness detail maps. DEFAULT-ON
 *  (the conservative remap cannot chrome; look-polish owed to a 1070 eye-test).
 *  `?material=off` ⇒ exact pre-Phase-5 material (no roughnessMap from the bake). */
export function materialBakeEnabled() {
  if (_materialBake !== undefined) return _materialBake;
  let on = true; // default-on; ?material=off is the escape
  const v = _strFlag("material");
  if (v != null) { const s = v.toLowerCase(); on = s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== ""; }
  return (_materialBake = on);
}

let _all;
/** Per-effect default. DEFAULT-ON (2026-06-24: validated suite ships on). Every
 *  per-effect flag defaults to this, so absent any URL flag all effects are on
 *  (still composed with the ?visual master gate by vfxEffectEnabled()). Escapes:
 *  `?visualAll=off` drops ALL per-effects (master stays on); `?<effect>=off` opts
 *  one out; `?visual=off` kills the whole suite. `?visual=all` still forces on. */
export function visualAllEffects() {
  if (_all !== undefined) return _all;
  let on = _boolFlag("visualAll", true); // default-on; ?visualAll=off drops per-effects
  if (!on) {
    const v = _strFlag("visual");
    if (v != null && v.toLowerCase() === "all") on = true;
  }
  return (_all = on);
}

let _glint;
/** `?glint=on` — emissive.glint specular sparkle on metal. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function glintEnabled() {
  if (_glint === undefined) _glint = _boolFlag("glint", visualAllEffects());
  return _glint;
}

let _magicGlow;
/** `?magicGlow=on` — emissive.magicGlow ambient glow on magic items. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function magicGlowEnabled() {
  if (_magicGlow === undefined) _magicGlow = _boolFlag("magicGlow", visualAllEffects());
  return _magicGlow;
}

let _enchantShimmer;
/** `?enchantShimmer=on` — emissive.enchantShimmer pulse on enchanted gear. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function enchantShimmerEnabled() {
  if (_enchantShimmer === undefined) _enchantShimmer = _boolFlag("enchantShimmer", visualAllEffects());
  return _enchantShimmer;
}

let _tarnish;
/** `?tarnish=on` — weathering.tarnish metal patina + crevice darkening. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function tarnishEnabled() {
  if (_tarnish === undefined) _tarnish = _boolFlag("tarnish", visualAllEffects());
  return _tarnish;
}

let _wetness;
/** `?wetness=on` — weathering.wetness global rain sheen. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function wetnessEnabled() {
  if (_wetness === undefined) _wetness = _boolFlag("wetness", visualAllEffects());
  return _wetness;
}

let _frost;
/** `?frost=on` — weathering.frost winter-zone frost/ice. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function frostEnabled() {
  if (_frost === undefined) _frost = _boolFlag("frost", visualAllEffects());
  return _frost;
}

let _flameFlicker;
/** `?flameFlicker=on` — light.flameFlicker torch/brazier intensity jitter. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function flameFlickerEnabled() {
  if (_flameFlicker === undefined) _flameFlicker = _boolFlag("flameFlicker", visualAllEffects());
  return _flameFlicker;
}

let _tipFlex;
/** `?tipFlex=on` — deformation.tipFlex GPU (MECH-B) spear/staff/wand tip-sway: the
 *  FIRST vertex-displacement effect. Default-OFF, composed under the ?visual master
 *  gate (and lit by ?visual=all for the 1070 batch). Consumed in TWO places:
 *  (a) as the tipFlex component's `enabled` gate — frag_attach.fragEntriesForDescriptor
 *  drops the MECH-B entry when off, so statics/entities stay byte-identical without a
 *  seam change; (b) at the entities.js catalog-plan seam (whether to resolve the plan
 *  at all). DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function tipFlexEnabled() {
  if (_tipFlex === undefined) _tipFlex = _boolFlag("tipFlex", visualAllEffects());
  return _tipFlex;
}

let _gemSparkle;
/** `?gemSparkle=on` — particle.gemSparkle synthesized additive twinkle on magic
 *  gems/crystals: the FIRST synthesized-emitter (MECH "particle") effect, the Phase-3
 *  minimal vertical slice (like tipFlex was for Phase 2). Default-OFF, composed under
 *  the ?visual master gate (and lit by ?visual=all for the 1070 batch). Consumed as the
 *  gemSparkle component's `enabled` gate — particle_attach.particleEntriesForDescriptor
 *  drops the emitter entry when off, so statics/entities stay byte-identical (no emitter
 *  synthesized, no addEmitter call) without a seam change. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function gemSparkleEnabled() {
  if (_gemSparkle === undefined) _gemSparkle = _boolFlag("gemSparkle", visualAllEffects());
  return _gemSparkle;
}

let _brazier;
/** `?brazier=on` — particle.brazierEmbers synthesized embers+smoke on flame-bowl
 *  braziers/torches (P3.6). TWO persistent emitters (additive embers + alpha smoke)
 *  anchored to the bowl part. Default-OFF, composed under ?visual (lit by ?visual=all).
 *  Consumed as the brazierEmbers component's `enabled` gate — off ⇒ no emitter ⇒
 *  byte-identical. The classifier gates this OUT for default_script-bearing DIDs
 *  (Track-B coexistence). DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function brazierEnabled() {
  if (_brazier === undefined) _brazier = _boolFlag("brazier", visualAllEffects());
  return _brazier;
}

let _foliagePollen, _foliageFireflies, _foliageLeaves, _breathFog;
/** `?foliagePollen=on` — particle.foliagePollen daytime soft motes. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliagePollenEnabled() {
  if (_foliagePollen === undefined) _foliagePollen = _boolFlag("foliagePollen", visualAllEffects());
  return _foliagePollen;
}
/** `?foliageFireflies=on` — particle.foliageFireflies dusk/night additive swarm. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliageFirefliesEnabled() {
  if (_foliageFireflies === undefined) _foliageFireflies = _boolFlag("foliageFireflies", visualAllEffects());
  return _foliageFireflies;
}
/** `?foliageLeaves=on` — particle.foliageLeaves canopy falling leaves. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function foliageLeavesEnabled() {
  if (_foliageLeaves === undefined) _foliageLeaves = _boolFlag("foliageLeaves", visualAllEffects());
  return _foliageLeaves;
}
/** `?breathFog=on` — particle.breathFog creature head cold-breath puff. DEFAULT-ON via visualAllEffects(); `=off` opts out. */
export function breathFogEnabled() {
  if (_breathFog === undefined) _breathFog = _boolFlag("breathFog", visualAllEffects());
  return _breathFog;
}

let _budget;
/** `?visualBudget` — governor STUB (Phase 1). A soft cap on concurrently-active
 *  VFX component-SETs / per-frame VFX cost units the future bloom/light governor
 *  (build spec §10/§11) will enforce. DEFAULT ∞ (uncapped). Parsed + memoized
 *  now; nothing consumes it yet (queued-for-1070). Clamp 0..4096. */
export function visualBudget() {
  if (_budget === undefined) _budget = _numFlag("visualBudget", Infinity, 0, 4096);
  return _budget;
}

// Component-id → per-effect flag reader (the gate router). Extend per effect.
// flameFlicker is a light-tick (not a frag component) but rides the same gate.
export const VFX_EFFECT_FLAGS = Object.freeze({
  "deformation.tipFlex": tipFlexEnabled,
  "emissive.glint": glintEnabled,
  "emissive.magicGlow": magicGlowEnabled,
  "emissive.enchantShimmer": enchantShimmerEnabled,
  "weathering.tarnish": tarnishEnabled,
  "weathering.wetness": wetnessEnabled,
  "weathering.frost": frostEnabled,
  "light.flameFlicker": flameFlickerEnabled,
  "particle.gemSparkle": gemSparkleEnabled,
  "particle.brazierEmbers": brazierEnabled,
  "particle.foliagePollen": foliagePollenEnabled,
  "particle.foliageFireflies": foliageFirefliesEnabled,
  "particle.foliageLeaves": foliageLeavesEnabled,
  "particle.breathFog": breathFogEnabled,
});

/**
 * Is this VFX component's effect live? Requires the ?visual master gate AND the
 * component's per-effect flag — the single gate the frag-install path + each
 * per-component installer consult. Unknown ids fall back to visualAllEffects()
 * (so `?visual=all` lights up a not-yet-flagged component, otherwise off).
 * Fail-safe: master off ⇒ always false ⇒ byte-identical frozen render.
 */
export function vfxEffectEnabled(componentId) {
  if (!visualEnabled()) return false;
  const reader = VFX_EFFECT_FLAGS[componentId];
  return reader ? reader() : visualAllEffects();
}

/** The component ids whose effect is currently active (diag / gauge / slice 15). */
export function vfxActiveEffectIds() {
  if (!visualEnabled()) return [];
  return Object.keys(VFX_EFFECT_FLAGS).filter((id) => VFX_EFFECT_FLAGS[id]());
}

/** Reset memoized flag readers (tests only). */
export function _resetVfxFlags() {
  _all = _glint = _magicGlow = _enchantShimmer = _tarnish = _wetness = _frost = _flameFlicker = _tipFlex = _gemSparkle = _brazier = _foliagePollen = _foliageFireflies = _foliageLeaves = _breathFog = _budget = undefined;
}
