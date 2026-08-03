// emissive.glint — view + time-varying specular sparkle on metal (Visual-
// Behavior Suite, Phase 1, 2026-06-23). The rigid-glint archetype's signature
// effect (swords / daggers / axes / maces, design doc §2.3 row "Sword").
//
// MECH-frag: a fragment patch on a CLONED, cache-owned material (materials.js
// getCachedVariant), composed onto the single _chainBeforeCompile chain in
// FAMILY_ORDER (emissive = 3, so glint runs AFTER any weathering diffuse edit).
// The snippet lands right after `#include <emissivemap_fragment>` — the first
// seam where metalnessFactor (metalnessmap_fragment), the shading `normal`
// (normal_fragment_begin) AND totalEmissiveRadiance are all resolved — and folds
// a metal-gated, view-swept, per-instance-phased sparkle into
// totalEmissiveRadiance. No new sampler, no light slot, no draw call.
//
// THE FIREWALL: strength / metalBias flow ONLY through uniforms; per-instance
// phase rides the `vVfxHash` varying (per-instance-age infra) — NEVER a per-
// instance customProgramCacheKey. One program per component-SET (linkVariant
// "" — glint's GLSL string is config-independent), never one per DID.
//
// THE RULE: reads the client clock (uTime), a derived per-instance hash, and the
// surface's metalness; writes ONLY a cloned-material shader output. Touches no
// wire value, no physics/collision, no replicated field; deterministic (uTime +
// hash, no Math.random); no light-count change.

import { registerComponent } from "../registry.js";
import { fragDeclaresVfxHash } from "../per_instance.js";

// The MeshStandard fragment seam glint folds into. metalnessFactor / roughness-
// Factor / normal / vViewPosition / totalEmissiveRadiance are ALL in main()
// scope here (verified against the bundled three physical fragment shader).
const GLINT_SEAM = "#include <emissivemap_fragment>";
const GLINT_MARKER = "VFX_GLINT_BEGIN";

// Build the fragment snippet. `hashExpr` is the per-instance phase source:
// `vVfxHash` when the per-instance-age infra declared that varying, else "0.0"
// (a graceful, in-sync fallback so glint still compiles standalone). NB: keep
// this GLSL free of backticks — a backtick here would close the JS literal.
function _glintSnippet(hashExpr) {
  return [
    GLINT_SEAM,
    "  // ---- " + GLINT_MARKER + " (emissive.glint) ----",
    "  // Metal-gated, view + time specular sparkle -> totalEmissiveRadiance.",
    "  {",
    "    float _gMetal = clamp(mix(metalnessFactor, 1.0, uGlintMetalBias), 0.0, 1.0);",
    "    if (_gMetal > 0.001 && uGlintStrength > 0.0) {",
    "      vec3 _Vg = normalize(vViewPosition);",
    "      vec3 _Ng = normalize(normal);",
    "      float _ndv = clamp(dot(_Ng, _Vg), 0.0, 1.0);",
    "      float _ph = uTime * 0.6 + (" + hashExpr + ") * 6.2831853;",
    "      vec3 _Lg = normalize(vec3(sin(_ph) * 0.75, 0.6, cos(_ph) * 0.75));",
    "      float _ndh = clamp(dot(_Ng, normalize(_Lg + _Vg)), 0.0, 1.0);",
    "      float _lobe = pow(_ndh, 48.0);",
    "      float _spark = 0.5 + 0.5 * sin(_ph * 3.7 + _ndv * 12.0 + (" + hashExpr + ") * 17.0);",
    "      totalEmissiveRadiance += vec3(_gMetal * uGlintStrength * _lobe * _spark);",
    "    }",
    "  }",
    "  // ---- VFX_GLINT_END ----",
  ].join("\n");
}

// Insert a `uniform float X;` declaration once (idempotent + collision-safe:
// uTime is shared across emissive/weathering components in the same SET, so a
// second declaration would be a GLSL redeclaration error).
function _ensureUniformDecl(fragmentShader, decl) {
  return fragmentShader.indexOf(decl) === -1
    ? fragmentShader.replace("void main() {", decl + "\nvoid main() {")
    : fragmentShader;
}

export const glint = {
  id: "emissive.glint",
  family: "emissive",
  mech: "frag",
  channel: "glint",
  // glint's GLSL is identical for every config (strength/metalBias ride
  // uniforms), so it adds no LINK-affecting bits — one program per SET.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): clock + per-instance hash + surface
  // metalness in; a cloned-material shader output out. Nothing replicated.
  reads: ["clock", "instanceHash", "surface"],
  writes: ["materialUniform"],
  defaults: { strength: 0.4, metalBias: 0.9 },

  /**
   * Bind this component's uniforms onto the compiling shader. Called by the
   * frag-install builder inside onBeforeCompile. uTime is bound BY REFERENCE
   * from the shared VFX_GLOBALS (passed as `globals`) so the single per-frame
   * oscillator tick drives it; strength/metalBias are per-variant scalars
   * (config-driven, uniform-only — never a program-key input).
   * @param {{uniforms:object, fragmentShader?:string}} shader
   * @param {{strength?:number, metalBias?:number}} [config]
   * @param {{uTime:{value:number}}} [globals]  VFX_GLOBALS (by reference)
   */
  declareUniforms(shader, config, globals) {
    const cfg = { ...glint.defaults, ...(config || {}) };
    const g = globals || {};
    shader.uniforms = shader.uniforms || {};
    // Shared clock, by reference (dormant {value:0} fallback if a caller omits
    // globals — keeps glint inert rather than crashing, never forks the clock).
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uGlintStrength = { value: cfg.strength };
    shader.uniforms.uGlintMetalBias = { value: cfg.metalBias };
  },

  /**
   * Patch the COLOR fragment shader: declare glint's uniforms and fold the
   * sparkle into totalEmissiveRadiance at the emissivemap_fragment seam. No-op
   * (byte-identical) if the seam is absent (a non-standard material) or the
   * patch is already present (recompile-safe). Only the standard color shader
   * is edited — the shadow/depth pass uses a separate, unpatched depth material.
   * @param {{fragmentShader:string}} shader
   */
  inject(shader) {
    let fs = shader.fragmentShader || "";
    if (fs.indexOf(GLINT_MARKER) !== -1) return;   // already patched (recompile)
    if (fs.indexOf(GLINT_SEAM) === -1) return;     // non-standard material — inert
    fs = _ensureUniformDecl(fs, "uniform float uTime;");
    fs = _ensureUniformDecl(fs, "uniform float uGlintStrength;");
    fs = _ensureUniformDecl(fs, "uniform float uGlintMetalBias;");
    // Per-instance phase rides the per-instance-age varying when present.
    //
    // ⚠ 2026-08-03 — PROBE THE DECLARATION, NOT THE TOKEN. This used to be
    // `/\bvVfxHash\b/.test(fs)`, which is satisfied by any other component's USE
    // of the name. `emissive.enchantShimmer` sorts before us and patches the SAME
    // seam; when no shared prelude had installed the varying it declared a LOCAL
    // `float vVfxHash = 0.0;` inside main(). That local made this probe true, and
    // our snippet — which re-emits the seam line and therefore lands ABOVE that
    // local — then read an identifier that was not yet declared: a hard GLSL
    // compile failure for the [enchantShimmer, glint] SET. fragDeclaresVfxHash
    // asks the real question (is it declared at GLOBAL scope, as the varying or as
    // the agreed constant fallback), which is order-independent.
    const hashExpr = fragDeclaresVfxHash(fs) ? "vVfxHash" : "0.0";
    shader.fragmentShader = fs.replace(GLINT_SEAM, _glintSnippet(hashExpr));
  },
};

registerComponent(glint);
export default glint;
