// emissive.enchantShimmer — pulsing emissive shimmer on enchanted gear
// (Visual-Behavior Suite, Phase 1 / emissive bundle, 2026-06-23).
//
// Archetype #16 (enchant-shimmer/pulse). A CHEAP fragment-family component: it
// scales the emissive accumulator by a slow sine, so enchanted/luminous gear
// "breathes". The pulse is per-instance-phased so a rack of identical items does
// not blink in lockstep.
//
//   totalEmissiveRadiance *= (1.0 + amp * sin(uTime * freq + phase))
//   phase = vVfxHash * 2*PI          // per-instance, from slice 03's varying
//
// This is a MULTIPLY on the emissive accumulator, applied AFTER
// `#include <emissivemap_fragment>` (the canonical emissive seam, spec §2.3) — so
// it modulates whatever emissive base the material already has: the luminosity
// emissiveMap (materials.js applyFloatLumDiffuse) and/or an additive glow from
// emissive.magicGlow. On a material with NO emissive (totalEmissiveRadiance==0)
// it is a visible no-op — safe by construction; the classifier pairs this
// archetype with a glow base.
//
// THE RULE (legacy-safe): reads only the client clock (uTime, shared VFX global
// driven once/frame by the oscillator registry, slice 01) and a per-instance
// hash (vVfxHash varying, slice 03) — never the wire, physics, or a server-
// replicated field. Writes only CLONED-material uniforms (getCachedVariant
// clone). Deterministic (phase from a hash, never Math.random). No light-count
// change. Config scalars (amp/freq) flow through UNIFORMS, never the program-
// cache key — linkVariant() is "" so program count stays O(component-sets).
//
// Composition note (spec §2.3 / §14): every emissive seam edit inserts itself
// IMMEDIATELY after `#include <emissivemap_fragment>`. Because _chainBeforeCompile
// runs hooks in (FAMILY_ORDER, id) order and each prepends after the include, an
// id that sorts EARLIER ends up OUTERMOST in execution. "emissive.enchantShimmer"
// sorts before "emissive.magicGlow", so the shimmer multiply runs AFTER the glow
// add — the whole emissive output pulses, which is the intent.

import { registerComponent } from "../registry.js";

// 2*PI as a GLSL literal (per-instance phase spreads vVfxHash in [0,1) over a
// full cycle). Kept as a string constant so the GLSL below stays a pure literal.
const TAU = "6.2831853";

// Declare a fragment-shader line once (guards against a sibling emissive
// component, e.g. glint/magicGlow, having already declared the same uniform —
// a duplicate `uniform float uTime;` is a GLSL compile error). Idempotent.
function _declareFragOnce(shader, token, decl) {
  if (!shader.fragmentShader.includes(token)) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\n" + decl,
    );
  }
}

export const enchantShimmer = {
  id: "emissive.enchantShimmer",
  family: "emissive",
  mech: "frag",
  channel: "emissive", // §14 conflict unit — stacks with other emissive writers
  // Config (amp/freq) is link-IRRELEVANT — it flows through uniforms, never the
  // program-cache key. So the SET key is unaffected by config → one program per
  // distinct component SET, never per-DID. (spec §2.4 firewall)
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads the client clock (uTime) + the
  // per-instance hash (vVfxHash); writes only cloned-material uniforms.
  reads: ["clock", "instanceHash"],
  writes: ["materialUniform"],
  // Classifier/config metadata. amp clamped to [0,0.95] at bind time so the
  // factor (1 + amp*sin) stays strictly positive (never a negative emissive).
  defaults: { amp: 0.35, freq: 2.2 },

  /**
   * Bind this component's uniforms onto a shader (called inside onBeforeCompile
   * by frag_install, slice 02). uTime is SHARED BY REFERENCE from VFX_GLOBALS so
   * the single per-frame oscillator tick drives every shimmering material at
   * once (O(1) — no per-instance work). amp/freq are per-SET config scalars.
   * @param {{uniforms:object}} shader  the three.js shader (onBeforeCompile arg)
   * @param {object} config             per-DID config from the descriptor
   * @param {{uTime:{value:number}}} globals  VFX_GLOBALS (shared {value} objects)
   */
  declareUniforms(shader, config, globals) {
    const cfg = config || {};
    // Accept the classifier's generic "strength"/"speed" aliases too.
    const amp = Number(cfg.amp ?? cfg.strength ?? this.defaults.amp);
    const freq = Number(cfg.freq ?? cfg.speed ?? this.defaults.freq);
    shader.uniforms = shader.uniforms || {};
    // SHARED clock — assigned by reference (NOT a copy) so the oscillator tick
    // mutating VFX_GLOBALS.uTime.value reaches this material with zero per-frame
    // work here. Falls back to a private {value} only if globals is absent.
    shader.uniforms.uTime = (globals && globals.uTime) || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uEnchantAmp = { value: Math.max(0, Math.min(0.95, isFinite(amp) ? amp : this.defaults.amp)) };
    shader.uniforms.uEnchantFreq = { value: isFinite(freq) ? freq : this.defaults.freq };
  },

  /**
   * Inject the emissive-pulse GLSL. Declares its uniforms (guarded) and the
   * multiply at the canonical emissive seam. If the shader carries no emissive
   * seam (e.g. a depth/shadow material — which slice 04 keeps unpatched anyway),
   * the seam replace is a no-op and nothing is emitted.
   * @param {{fragmentShader:string,vertexShader:string}} shader
   */
  inject(shader) {
    // uTime may already be declared by a sibling emissive component (glint /
    // magicGlow) on the same SET — declare each uniform at most once.
    _declareFragOnce(shader, "uniform float uTime;", "uniform float uTime;");
    _declareFragOnce(shader, "uniform float uEnchantAmp;", "uniform float uEnchantAmp;\nuniform float uEnchantFreq;");

    // Per-instance phase source: the shared varying from slice 03 (per-instance
    // -age) — declared by frag_install once for the whole SET. If it is absent
    // (component used standalone / in a unit test), fall back to a constant 0.0
    // so the patch still compiles (degrades to a synchronized global pulse).
    const phaseSrc = shader.fragmentShader.includes("vVfxHash")
      ? ""
      : "    float vVfxHash = 0.0;\n";

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n" +
        phaseSrc +
        "    totalEmissiveRadiance *= (1.0 + uEnchantAmp * sin(uTime * uEnchantFreq + vVfxHash * " + TAU + "));",
    );
  },
};

registerComponent(enchantShimmer);
export default enchantShimmer;
