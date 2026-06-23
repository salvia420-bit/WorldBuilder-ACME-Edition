// weathering.wetness — global rain sheen (Visual-Behavior Suite, Phase 1).
//
// A cheap, GLOBAL fragment effect: up-facing surfaces get darker + glossier the
// wetter the world is. Driven by ONE shared uniform (VFX_GLOBALS.uWetness, set
// once/frame by the weather-inputs tick, slice 12) — no per-instance work and no
// extra texture fetch. Applies BROADLY (buildings, props, terrain scenery —
// anything that carries a frag variant), not just trees.
//
// THE RULE (legacy-safe): reads ONLY the derived client weather state (uWetness)
// + the fragment's geometry (world normal up-facing); writes ONLY cloned-material
// uniforms (diffuseColor / roughnessFactor) the server neither stores nor
// replicates. Deterministic (a global uniform — no hash, no Math.random),
// lightCountDelta 0, cacheKeyScope "set".
//
// GLSL seams (spec 2.3): the diffuse darken lands AFTER #include <map_fragment>,
// i.e. POST-palette/diffuse decode — the weathering compose-order rule (design
// doc:313: weathering MUST follow the palette decode or it washes paletted-
// luminous surfaces). The roughness drop lands after #include <roughnessmap_fragment>
// (where roughnessFactor is first defined); the wetness weight computed at the
// map seam is a main()-scope local, still in scope at the roughness seam.
//
// World normal: three's standard vertex shader produces VIEW-space
// transformedNormal in <defaultnormal_vertex>, already folding BatchedMesh
// batchingMatrix + InstancedMesh instanceMatrix (r184). We turn that into a
// world-space varying with the stock inverseTransformDirection(dir, viewMatrix)
// helper (three <common>), so the up-facing test is per-instance correct with NO
// new geometry attribute. The varying is injected IDEMPOTENTLY under a shared
// name (vVfxWorldNormal) so wetness composes with weathering.tarnish /
// weathering.frost under ONE program (one declaration in the merged shader).
//
// THREE-free by design: the component imports only the registry. The shared
// VFX_GLOBALS object is passed in via declareUniforms(shader, config, globals)
// (bound by the frag-install harness, slice 02) — so this file stays node-
// testable and the legacy-safety harness can import it without a bundler.

import { registerComponent } from "../registry.js";

// Shared world-normal varying name — weathering.{wetness,tarnish,frost} all use
// THIS name + THIS computation so the composed shader declares it exactly ONCE.
// (Slice 16 may promote this helper into a shared frag_seams.js; until then it
// lives here and siblings import it.)
export const VFX_WORLD_NORMAL_VARYING = "vVfxWorldNormal";

/**
 * Idempotently add a world-space normal varying (vVfxWorldNormal) to a shader.
 * Safe to call from every weathering component's inject(): the first to run
 * installs it, the rest see it present and skip — so the composed program has a
 * SINGLE declaration + SINGLE vertex compute. No new geometry attribute.
 * @param {{vertexShader:string, fragmentShader:string}} shader
 */
export function ensureWorldNormalVarying(shader) {
  if (!shader.vertexShader.includes(VFX_WORLD_NORMAL_VARYING)) {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vVfxWorldNormal;",
      )
      .replace(
        // transformedNormal here is VIEW-space and already folds batching+instancing.
        "#include <defaultnormal_vertex>",
        "#include <defaultnormal_vertex>\n  vVfxWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );",
      );
  }
  if (!shader.fragmentShader.includes(VFX_WORLD_NORMAL_VARYING)) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\nvarying vec3 vVfxWorldNormal;",
    );
  }
}

export const wetness = {
  id: "weathering.wetness",
  family: "weathering",
  mech: "frag",
  // §14 conflict unit. wetness + frost SHARE the "precip" channel (handoff §5) so
  // they are mutually exclusive — a surface can be rain-wet OR frosted, never both,
  // avoiding the latent double-darken when uWetness and uFrost are both > 0.
  channel: "precip",
  // No config-driven LINK branch: the GLSL is identical for every wetness
  // material; config varies ONLY uniform values. Set membership (the component
  // id, added by the frag-install set key) gives the program its identity, so a
  // wetness-only set never shares a program with a tarnish-only set.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Reads: derived client weather (uWetness) + geometry (the world normal up
  // component). Writes: cloned-material uniforms only — never the wire/physics.
  reads: ["weather", "geometry"],
  writes: ["materialUniform"],
  defaults: { strength: 1.0, darken: 0.62, roughDrop: 0.25 },

  /**
   * Bind the shared uWetness global BY REFERENCE + the per-config scalars.
   * The once/frame weather tick mutates globals.uWetness.value and every wetness
   * material sees it with ZERO per-material work.
   * @param {{uniforms:object}} shader
   * @param {object} config   per-DID archetype config (overrides defaults)
   * @param {{uWetness:{value:number}}} globals  VFX_GLOBALS (passed by frag_install)
   */
  declareUniforms(shader, config, globals) {
    const cfg = { ...wetness.defaults, ...(config || {}) };
    // BY REFERENCE — dormant {value:0} fallback keeps the effect inert (byte-
    // identical) if globals is ever absent.
    shader.uniforms.uWetness = (globals && globals.uWetness) || { value: 0 };
    // Per-config scalars travel as uniforms, NEVER the program key: same-SET
    // materials share one program; config only de-dups the cloned-material heap.
    shader.uniforms.uWetStrength = { value: cfg.strength };
    shader.uniforms.uWetDarken = { value: cfg.darken };
    shader.uniforms.uWetRoughDrop = { value: cfg.roughDrop };
  },

  /**
   * Inject the GLSL: idempotent world-normal varying, diffuse darken after
   * <map_fragment> (post-palette), roughness drop after <roughnessmap_fragment>.
   * Never touches customProgramCacheKey (the firewall) — the program-set key is
   * owned by getCachedVariant/__vfxSetKey.
   * @param {{vertexShader:string, fragmentShader:string}} shader
   */
  inject(shader) {
    ensureWorldNormalVarying(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWetness;
uniform float uWetStrength;
uniform float uWetDarken;
uniform float uWetRoughDrop;`,
      )
      .replace(
        "#include <map_fragment>",
        // POST-palette decode. _vfxWetAmt is a main()-scope local (NOT block-
        // scoped) so the roughness seam below reads the same weight.
        `#include <map_fragment>
float _vfxWetUp = smoothstep( 0.05, 0.6, vVfxWorldNormal.y );
float _vfxWetAmt = clamp( uWetness * uWetStrength, 0.0, 1.0 ) * _vfxWetUp;
diffuseColor.rgb *= mix( 1.0, uWetDarken, _vfxWetAmt );`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        // Glossier where wet — roughnessFactor is defined by the chunk above.
        `#include <roughnessmap_fragment>
roughnessFactor *= mix( 1.0, uWetRoughDrop, _vfxWetAmt );`,
      );
  },
};

registerComponent(wetness);
export default wetness;
