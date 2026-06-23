// emissive.magicGlow — ambient self-glow on magic items (Phase 1, 2026-06-23).
//
// FRAG family. A constant (un-animated) ambient glow that pushes the object's
// own decoded albedo into the emissive accumulator, so a magic item reads as
// faintly self-lit (and, if the bloom pass is on, throws a free halo). This is
// the "magic-glow ambient" row of the design doc (cheap; emissiveMap=diffuse,
// emissiveIntensity floor <=2.0).
//
// Reuse of the applyFloatLumDiffuse path (materials.js:1256): that decoder feeds
// the SAME emissive accumulator (totalEmissiveRadiance) by attaching the diffuse
// texture as emissiveMap. We feed that same accumulator, but source it from the
// live `diffuseColor` (the post-map, POST-palette-decode albedo) instead of
// uploading a second sampler — visually identical to emissiveMap=diffuse, but
// 0 VRAM, 0 new sampler, and palette-correct by construction (our add lands
// AFTER #include <map_fragment>, i.e. after the SubPalette shift). uGlow carries
// the per-descriptor intensity, clamped to (0, 2.0] to match the luminosity
// clamp the float decoder uses (materials.js:1264).
//
// Firewall: uGlow is a per-material CLONED uniform (config scalar -> uniform,
// NEVER into customProgramCacheKey). The GLSL is identical for every instance,
// so this component contributes only its presence to the component-SET key
// (linkVariant() === "") -> at most ONE extra program per material-SET, never
// per-DID. No clock read (ambient = constant); animation is enchantShimmer's job.

import { registerComponent } from "../registry.js";

// Single source of the default + clamp ceiling, referenced by both the manifest
// `defaults` metadata and declareUniforms (avoids a detached-`this` foot-gun).
const MAX_GLOW = 2.0; // emissiveIntensity floor cap (materials.js:1264 parity)
const DEFAULTS = { glow: 0.6 };

function clampGlow(g) {
  const n = Number.isFinite(g) ? g : DEFAULTS.glow;
  return Math.min(MAX_GLOW, Math.max(0, n));
}

export const magicGlow = {
  id: "emissive.magicGlow",
  family: "emissive",
  mech: "frag",
  channel: "glow", // distinct emissive channel (accumulates alongside glint/shimmer)
  // Frag GLSL is config-INVARIANT (uGlow is a uniform, not a #define), so this
  // component forks no program by config -> only its presence is in the SET key.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads ONLY the surface diffuse (in-shader
  // diffuseColor); writes ONLY a cloned-material uniform + the render-time
  // emissive accumulator. Never the wire, physics/collision, or a replicated field.
  reads: ["surface"],
  writes: ["materialUniform"],
  defaults: DEFAULTS,

  /**
   * Add the per-material uGlow uniform to the cloned variant's shader.
   * Runs inside the variant's onBeforeCompile (frag_install chains it).
   * @param {{uniforms: object}} shader  the three.js shader being compiled
   * @param {{glow?: number}} [config]   per-descriptor config (intensity)
   */
  declareUniforms(shader, config) {
    shader.uniforms.uGlow = { value: clampGlow(config?.glow) };
  },

  /**
   * Inject the ambient-glow accumulate after the emissive map chunk.
   * Adds `totalEmissiveRadiance += diffuseColor.rgb * uGlow;` so the object's
   * own (palette-decoded) albedo becomes a faint self-illumination term.
   * No-op on a shader without the seam (e.g. a MeshBasic wire material) so the
   * patch can never orphan a uniform on the wrong program.
   * @param {{fragmentShader: string}} shader
   */
  inject(shader) {
    if (!shader || typeof shader.fragmentShader !== "string") return;
    if (!shader.fragmentShader.includes("#include <emissivemap_fragment>")) return;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uGlow;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        // POST-decode: diffuseColor is the resolved albedo (after map_fragment +
        // palette shift); totalEmissiveRadiance is the SAME accumulator the
        // luminous float-decode path feeds. Add, never replace.
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uGlow;",
      );
  },
};

registerComponent(magicGlow);
export default magicGlow;
