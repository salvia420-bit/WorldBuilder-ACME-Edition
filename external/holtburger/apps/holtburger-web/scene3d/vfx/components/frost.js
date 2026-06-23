// weathering.frost — winter-zone frost/ice wash (Phase 1, 2026-06-23).
//
// A CHEAP fragment weathering component (family "weathering", mech "frag"). It
// lightens + desaturates the decoded diffuse toward an icy white-blue and adds a
// sparse, time-twinkled micro-sparkle, driven entirely by the shared global
// VFX_GLOBALS.uFrost (a season/temperature drive produced by weather_inputs.js,
// slice 12) — so the whole world rimes up in a winter zone with ONE uniform.
//
// THE RULE: reads only the client clock + derived weather state + a geometry UV;
// writes ONLY the cloned material's diffuseColor (a render-time material uniform
// path). No wire, no physics/collision, no replicated field; deterministic (a
// GLSL hash, never Math.random); no light-count change; the program key varies by
// component-SET, never per-instance (the firewall).
//
// COMPOSITION (spec §2.3): injected after `#include <map_fragment>` — i.e. POST
// palette/diffuse decode (see [[reference_chorizite_render_semantics]]: palette =
// SubPalette shift folded into the diffuse sample, so a weathering tint MUST land
// after it or it would wash the pre-decode texels). Same seam the shipped detail
// patch uses (materials.js:445). Family order weathering(2) runs after
// deformation/texture and before emissive on the single _chainBeforeCompile chain.
//
// MUTUAL EXCLUSION with rain wetness (design doc line 157): a surface is never
// both rained-on AND rimed. Primary enforcement is weather_inputs (slice 12),
// which only ever drives ONE of uFrost / uWetness above zero. This component adds
// a belt-and-suspenders in-shader gate `uFrost * (1.0 - uWetness)`, so even a
// transitional frame where both are momentarily nonzero degrades gracefully
// (wetness wins) rather than double-applying.

import { registerComponent } from "../registry.js";

// The fragment block appended right after `#include <map_fragment>`. Operates on
// `diffuseColor.rgb` (already palette-decoded). The whole effect is scaled by
// `_frost` at the end, so at uFrost==0 it is an exact no-op -> byte-identical to
// the unfrosted variant (and ?frost OFF never builds this variant at all). No
// backticks anywhere in here (they would close the JS template literal).
const FROST_FS = `
{
  // uFrost: global winter drive (weather_inputs, slice 12). Mutually exclusive
  // with rain wetness -> any active uWetness suppresses frost.
  float _frost = clamp(uFrost, 0.0, 1.0) * (1.0 - clamp(uWetness, 0.0, 1.0));
  if (_frost > 0.0001) {
    vec3 _base = diffuseColor.rgb;
    float _lum = dot(_base, vec3(0.2126, 0.7152, 0.0722));
    vec3 _icy = vec3(0.82, 0.90, 1.0);            // cold white-blue rime tint
    vec3 _f = mix(_base, vec3(_lum), uFrostDesat); // desaturate toward luma
    _f = mix(_f, _icy, uFrostLighten);             // lighten/tint toward ice
    #ifdef USE_UV
      // micro-sparkle: a sparse high-frequency hash over the surface UV,
      // twinkled by the shared clock so a few specks glint each frame
      // (deterministic value hash; no Math.random).
      vec2 _cell = floor(vMapUv * uFrostSparkleScale);
      float _h = fract(sin(dot(_cell, vec2(127.1, 311.7))) * 43758.5453123);
      float _tw = 0.5 + 0.5 * sin(uTime * uFrostSparkleSpeed + _h * 6.2831853);
      float _spark = smoothstep(0.90, 1.0, _h) * _tw;
      _f += _spark * uFrostSparkle;
    #endif
    diffuseColor.rgb = mix(_base, _f, _frost);
  }
}`;

export const frost = {
  id: "weathering.frost",
  family: "weathering",
  mech: "frag",
  // §14 conflict unit. SHARED with weathering.wetness so the resolver lets at
  // most ONE of {wetness, frost} into a component-SET (the "single diffuse-wash
  // owner" the cost-model row asserts). Distinct from tarnish's channel, so a
  // tarnished blade can still frost over. Belt-and-suspenders: the shader also
  // gates frost by (1 - uWetness) (see FROST_FS) — correctness holds even before
  // the resolver is wired. RECONCILED (handoff §5): wetness + frost both declare
  // channel "precip" (the reference shipped "surfaceWeather" here / "wetness"
  // there — unified to "precip" so the pair is one mutually-exclusive unit).
  channel: "precip",
  // The GLSL is identical for every config (all knobs flow as uniforms), so this
  // component contributes the SAME link bits regardless of placement/config ->
  // the program count stays O(component-sets), never per-DID (the firewall).
  linkVariant() { return ""; },
  cacheKeyScope: "set", // a frag patch changes the program; keyed by the SET, never per-instance
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads the client clock + derived weather
  // (season/temp) + a geometry UV for the sparkle; writes ONLY the cloned
  // material's diffuse uniform path. Never the wire/physics/collision/replicated.
  reads: ["clock", "weather", "geometry"],
  writes: ["materialUniform"],
  defaults: {
    lighten: 0.6,        // mix toward icy white-blue at uFrost=1
    desat: 0.5,          // desaturate strength
    sparkle: 0.25,       // micro-sparkle brightness add
    sparkleScale: 48.0,  // UV multiplier -> speck density
    sparkleSpeed: 2.5,   // twinkle rate (× uTime)
  },

  /**
   * Bind uniforms onto a compiling shader. Shared globals (uTime/uFrost/uWetness)
   * are assigned BY REFERENCE from VFX_GLOBALS so the single per-frame VFX tick
   * (oscillator + weather_inputs) drives every frosted material at once. Per-config
   * scalars become their own {value} objects — config flows through uniforms,
   * NEVER the program cache key.
   * @param {{uniforms:object}} shader  the three.js onBeforeCompile shader
   * @param {object} config             per-DID config (merged over defaults)
   * @param {object} globals            VFX_GLOBALS (shared {value} objects)
   */
  declareUniforms(shader, config, globals) {
    const c = { ...frost.defaults, ...(config || {}) };
    const g = globals || {};
    // shared globals — bound by reference (one {value} per global, driven once/frame)
    if (g.uTime) shader.uniforms.uTime = g.uTime;
    if (g.uFrost) shader.uniforms.uFrost = g.uFrost;
    if (g.uWetness) shader.uniforms.uWetness = g.uWetness;
    // per-config scalars — uniforms only (never cache-key)
    shader.uniforms.uFrostLighten = { value: c.lighten };
    shader.uniforms.uFrostDesat = { value: c.desat };
    shader.uniforms.uFrostSparkle = { value: c.sparkle };
    shader.uniforms.uFrostSparkleScale = { value: c.sparkleScale };
    shader.uniforms.uFrostSparkleSpeed = { value: c.sparkleSpeed };
  },

  /**
   * Inject the frost GLSL into the fragment shader. Declares the uniforms (shared
   * globals guarded against a sibling weathering component having already declared
   * them) and appends FROST_FS right after `#include <map_fragment>`. Idempotent
   * within one shader compile. Only ever runs on the COLOR material clone — the
   * shadow/depth material is separate and unpatched (slice 04).
   * @param {{fragmentShader:string, __frostInjected?:boolean}} shader
   */
  inject(shader) {
    if (shader.__frostInjected) return;
    shader.__frostInjected = true;
    const fs = shader.fragmentShader;
    const decls =
      (fs.includes("uniform float uTime;") ? "" : "uniform float uTime;\n") +
      (fs.includes("uniform float uFrost;") ? "" : "uniform float uFrost;\n") +
      (fs.includes("uniform float uWetness;") ? "" : "uniform float uWetness;\n") +
      "uniform float uFrostLighten;\n" +
      "uniform float uFrostDesat;\n" +
      "uniform float uFrostSparkle;\n" +
      "uniform float uFrostSparkleScale;\n" +
      "uniform float uFrostSparkleSpeed;\n";
    shader.fragmentShader = fs
      .replace("void main() {", decls + "void main() {")
      .replace("#include <map_fragment>", "#include <map_fragment>" + FROST_FS);
  },
};

registerComponent(frost);
export default frost;
