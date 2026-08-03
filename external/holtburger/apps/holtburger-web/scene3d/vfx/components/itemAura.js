// emissive.itemAura — UiEffects magic-effect aura (#16, 2026-06-24, NON-RETAIL).
//
// FRAG family. Mirrors `emissive.magicGlow`, but EFFECT-COLOURED: instead of the
// item's own albedo, it adds a per-effect TINT (Fire=orange, Frost=blue, …) to
// the emissive accumulator, so a UiEffects item glows in its effect colour. This
// is the OPT-IN (`?itemFx`) enhancement for UiEffects items whose flame is NOT a
// retail `default_script` particle effect (the katar's flame is — see Track B).
//
// Firewall: the tint + glow are config-INVARIANT UNIFORMS (3 scalar channels +
// uAuraGlow), NEVER `#define`s, so the GLSL is identical for every instance →
// this component contributes only its PRESENCE to the component-SET key
// (linkVariant() === "") → at most ONE extra program per material-SET, never
// per-item. `lightCountDelta:0` (no scene light → no relink). No clock read
// (constant ambient glow). Mirrors magicGlow's accumulate-after-emissivemap seam.

import { registerComponent } from "../registry.js";

const MAX_GLOW = 2.0; // emissiveIntensity floor cap (materials.js luminosity parity)
const DEFAULTS = { glow: 0.5, tint: [0.6, 0.6, 1.0] };

function clampGlow(g) {
  const n = Number.isFinite(g) ? g : DEFAULTS.glow;
  return Math.min(MAX_GLOW, Math.max(0, n));
}
function tintChannel(t, i) {
  const arr = (Array.isArray(t) && t.length === 3) ? t : DEFAULTS.tint;
  const v = +arr[i];
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}

export const itemAura = {
  id: "emissive.itemAura",
  family: "emissive",
  mech: "frag",
  channel: "aura", // distinct emissive channel (accumulates alongside glow/glint/shimmer)
  // GLSL is config-INVARIANT (tint/glow are uniforms, not #defines) → forks no
  // program by config; only its presence is in the SET key.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): writes ONLY cloned-material uniforms +
  // the render-time emissive accumulator; never the wire/physics/replicated state.
  reads: ["surface"],
  writes: ["materialUniform"],
  defaults: DEFAULTS,

  /**
   * Per-material uniforms: the effect tint (3 scalar channels, to avoid a THREE
   * import for a vec3) + the glow intensity. Cloned per variant (config → uniform
   * VALUE, never customProgramCacheKey).
   * @param {{uniforms: object}} shader
   * @param {{glow?: number, tint?: number[]}} [config]
   */
  declareUniforms(shader, config) {
    shader.uniforms.uAuraGlow = { value: clampGlow(config?.glow) };
    shader.uniforms.uAuraR = { value: tintChannel(config?.tint, 0) };
    shader.uniforms.uAuraG = { value: tintChannel(config?.tint, 1) };
    shader.uniforms.uAuraB = { value: tintChannel(config?.tint, 2) };
  },

  /**
   * Add the tinted aura to the emissive accumulator after the emissive-map chunk
   * (the SAME accumulator the luminous float-decode + magicGlow feed). Add, never
   * replace. No-op on a shader without the seam (e.g. a MeshBasic wire material).
   * @param {{fragmentShader: string}} shader
   */
  inject(shader) {
    if (!shader || typeof shader.fragmentShader !== "string") return;
    if (!shader.fragmentShader.includes("#include <emissivemap_fragment>")) return;
    // Already-patched guard (2026-08-03) — see the twin note in magicGlow.js. A
    // double install emitted the four aura uniform declarations twice = a GLSL
    // redeclaration error = a material that does not compile.
    if (shader.fragmentShader.includes("uniform float uAuraGlow;")) return;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uAuraGlow;\nuniform float uAuraR;\nuniform float uAuraG;\nuniform float uAuraB;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vec3(uAuraR, uAuraG, uAuraB) * uAuraGlow;",
      );
  },
};

registerComponent(itemAura);
export default itemAura;
