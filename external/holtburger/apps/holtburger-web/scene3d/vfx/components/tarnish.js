// weathering.tarnish — metal tarnish / patina + crevice darkening (Phase 1, 2026-06-23).
//
// A CHEAP FRAGMENT weathering component (build-spec §8 / archetype "rigid-glint",
// visual_archetype_rules.jsonl). Tints exposed metal toward a desaturated patina
// colour and pushes roughness up, weighted by a per-fragment "crevice" term so
// recesses (the darker, palette-decoded texels of the artwork) tarnish most. The
// amount per object is a DETERMINISTIC per-instance hash (hash01(setupDid ^
// instanceHash), provided as the vVfxHash varying by the per-instance-age infra)
// scaled by a global age. The age is the shine-restore knob: lerp uTarnishAge
// -> 0 restores the polished look (a pure cloned-material uniform tween — THE
// RULE compliant; never touches server wear state).
//
// COMPOSITION (build-spec §2.3): the GLSL runs after #include <map_fragment> —
// i.e. POST-palette decode (see chorizite render semantics: luminosity is a FLAT
// emissive add and the SubPalette shift is folded into the diffuse sample, so
// weathering MUST modify the RESOLVED diffuseColor.rgb, never the pre-decode
// texel). roughnessFactor is bumped at the later #include <roughnessmap_fragment>
// seam (where it first exists) via a function-scoped float computed at the map
// seam. Both seams compose under the SINGLE __vfxSetKey by FAMILY_ORDER.
//
// FIREWALL: config scalars + the tint flow through cloned-material UNIFORMS; the
// per-instance variation rides the vVfxHash varying (procedural / instanced
// attribute, slice 03) — NEVER customProgramCacheKey. One program per component
// SET. linkVariant() is "" for the default (uniform-only) look; the optional
// textured blotch variant returns a stable per-SET bit, never a per-instance one.

import { registerComponent } from "../registry.js";

// --- GLSL seam strings (kept as exported constants so the unit test can assert
// the exact tokens). NO backticks inside these template literals' comments. ---

// Fragment uniform block + the function-scoped accumulator, prepended at main().
const TARNISH_UNIFORMS_GLSL = `uniform vec3 uTarnishTint;
uniform float uTarnishAmount;     // <0 => per-instance hash; >=0 => constant amount
uniform float uTarnishAge;        // [0,1] global age; the shine-restore knob (->0 polishes)
uniform float uTarnishVarLo;
uniform float uTarnishVarHi;
uniform float uTarnishRoughTarget;
uniform float uTarnishCrevFloor;  // crevice weight on bright/flat texels (recesses get 1.0)
uniform float uTarnishTopWeight;  // up-facing extra patina (inert until a world normal exists)
uniform float uTarnishHashFallback;
`;

// Computed + applied right after #include <map_fragment> (POST-palette decode).
const TARNISH_DIFFUSE_GLSL = `{
  // per-instance amount: hash01(setupDid ^ instanceHash) via vVfxHash (slice 03),
  // or the uTarnishHashFallback constant when the instance-hash infra is absent.
  #ifdef VFX_INSTANCE_HASH
    float _tInst = vVfxHash;
  #else
    float _tInst = uTarnishHashFallback;
  #endif
  float _tAmt = (uTarnishAmount < 0.0)
      ? mix(uTarnishVarLo, uTarnishVarHi, _tInst)
      : uTarnishAmount;
  // crevice weight: patina collects in recesses, so darker base texels tarnish
  // more. Uses the RESOLVED (palette-decoded) diffuseColor — post #include <map_fragment>.
  float _tLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  float _tCrev = mix(1.0, uTarnishCrevFloor, _tLum);
  // up-facing weight (top surfaces collect more); inert (==1.0) until a world-normal
  // varying is present (composes with the wetness world normal, slice 09).
  float _tTop = 1.0;
  #ifdef VFX_WORLD_NORMAL
    _tTop = mix(1.0 - uTarnishTopWeight, 1.0, clamp(vVfxWorldNormal.y * 0.5 + 0.5, 0.0, 1.0));
  #endif
  _vfxTarnishT = clamp(uTarnishAge * _tAmt, 0.0, 1.0) * _tCrev * _tTop;
  diffuseColor.rgb = mix(diffuseColor.rgb, uTarnishTint, _vfxTarnishT);
}`;

// Roughness bump, injected at the later #include <roughnessmap_fragment> seam
// where roughnessFactor first exists; reads the function-scoped _vfxTarnishT.
const TARNISH_ROUGH_GLSL = `roughnessFactor = mix(roughnessFactor, uTarnishRoughTarget, _vfxTarnishT);`;

// Per-seam tail sentinels (GLSL line comments). The FIRST frag component to
// touch a seam emits `chunk + code + sentinel`; every later component inserts
// its code BEFORE the sentinel, so injected blocks preserve the call order
// (== FAMILY_ORDER, the order frag_install runs declareUniforms/inject). This
// makes same-seam weathering/texture/emissive components compose deterministically
// regardless of onBeforeCompile chaining. (Recommended for the shared
// frag_install seam helper — slice 02/16.)
const DIFFUSE_TAIL = "// VFX_DIFFUSE_TAIL";
const ROUGH_TAIL = "// VFX_ROUGH_TAIL";

/** Insert `code` after a chunk seam, preserving FAMILY_ORDER via a tail sentinel. */
function _injectAfterSeam(shader, seam, sentinel, code) {
  const src = shader.fragmentShader;
  if (src.includes(sentinel)) {
    shader.fragmentShader = src.replace(sentinel, code + "\n" + sentinel);
  } else if (src.includes(seam)) {
    shader.fragmentShader = src.replace(seam, seam + "\n" + code + "\n" + sentinel);
  }
}

function _num(v, d) { return Number.isFinite(+v) ? +v : d; }
function _clamp01(v, d) { const n = _num(v, d); return n < 0 ? 0 : n > 1 ? 1 : n; }

export const tarnish = {
  id: "weathering.tarnish",
  family: "weathering",
  mech: "frag",
  channel: "tarnish", // §14 conflict unit: the diffuse/roughness weathering slot
  // LINK-affecting bits only. The default uniform-only look has no program-level
  // branch (variation is all uniforms/varying) -> "" -> shares one program with
  // every other tarnish SET. The optional textured blotch map forks the program
  // per-SET (never per-instance), so it gets a stable bit.
  linkVariant(config) { return config && config.blotchMap ? "blotch" : ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (build-spec §1.2): reads the setup id + the per-instance
  // hash (the two inputs to hash01(setupDid ^ instanceHash)); writes ONLY cloned-
  // material uniforms (the tint + roughness target on the getCachedVariant clone).
  // Reads no clock (static patina), no weather, no server wear state. Writes never
  // touch the wire, physics/collision, light count, or any replicated field.
  reads: ["setup", "instanceHash"],
  writes: ["materialUniform"],
  // Mirrors visual_archetype_rules.jsonl "rigid-glint" defaults for weathering.tarnish
  // (amount:"hash01", roughTarget:1.0, topWeight:0.6) plus the look knobs.
  defaults: {
    amount: "hash01",     // "hash01" => per-instance; or a number in [0,1] for a constant
    tint: [0.30, 0.27, 0.20], // desaturated dark patina (verdigris alt: [0.22, 0.36, 0.30])
    age: 1.0,             // shine-restore knob; 0 == fully polished, 1 == fully aged
    roughTarget: 1.0,     // roughnessFactor target at full tarnish
    varLo: 0.25,          // per-instance hash remap floor (every metal at least lightly aged)
    varHi: 1.0,           // per-instance hash remap ceil
    crevFloor: 0.35,      // crevice weight on the brightest texels
    topWeight: 0.6,       // up-facing extra patina (applied once a world normal exists)
  },

  /**
   * Bind the cloned-material uniforms (build-spec §2.6). Plain-array vec3 value so
   * the component stays THREE-free + node-testable; three accepts number[] for vec3.
   * Live age may be mutated in place for the shine-restore tween WITHOUT changing
   * configKey (age is deliberately excluded from the link/config key).
   */
  declareUniforms(shader, config, _globals) {
    const c = config || {};
    const u = shader.uniforms || (shader.uniforms = {});
    const tint = Array.isArray(c.tint) && c.tint.length === 3 ? c.tint.slice() : this.defaults.tint.slice();
    const amt = (c.amount == null || c.amount === "hash01")
      ? -1.0                                   // sentinel: use the per-instance hash
      : _clamp01(c.amount, 0);
    u.uTarnishTint = { value: tint };
    u.uTarnishAmount = { value: amt };
    u.uTarnishAge = { value: _clamp01(c.age, this.defaults.age) };
    u.uTarnishVarLo = { value: _clamp01(c.varLo, this.defaults.varLo) };
    u.uTarnishVarHi = { value: _clamp01(c.varHi, this.defaults.varHi) };
    u.uTarnishRoughTarget = { value: _clamp01(c.roughTarget, this.defaults.roughTarget) };
    u.uTarnishCrevFloor = { value: _clamp01(c.crevFloor, this.defaults.crevFloor) };
    u.uTarnishTopWeight = { value: _clamp01(c.topWeight, this.defaults.topWeight) };
    u.uTarnishHashFallback = { value: 0.5 };
    return u;
  },

  /**
   * Patch the fragment shader: diffuse tint after <map_fragment> (post-palette),
   * roughness bump at <roughnessmap_fragment>. Idempotent.
   */
  inject(shader, _ctx) {
    if (!shader || typeof shader.fragmentShader !== "string") return;
    if (shader.fragmentShader.includes("uTarnishTint")) return; // already patched
    // Uniform block + the function-scoped accumulator as main()'s first statement.
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      TARNISH_UNIFORMS_GLSL + "void main() {\n  float _vfxTarnishT = 0.0;",
    );
    // Diffuse tint — POST-palette decode (after the resolved diffuse sample).
    _injectAfterSeam(shader, "#include <map_fragment>", DIFFUSE_TAIL, TARNISH_DIFFUSE_GLSL);
    // Roughness up — at the seam where roughnessFactor first exists.
    _injectAfterSeam(shader, "#include <roughnessmap_fragment>", ROUGH_TAIL, TARNISH_ROUGH_GLSL);
  },
};

// Exported for the unit test / shared seam helper reuse.
export const _glsl = { TARNISH_UNIFORMS_GLSL, TARNISH_DIFFUSE_GLSL, TARNISH_ROUGH_GLSL, DIFFUSE_TAIL, ROUGH_TAIL };

registerComponent(tarnish);
export default tarnish;
