// VFX per-instance variation — Visual-Behavior Suite, Phase 1, slice 03 (2026-06-23).
//
// SHARED INFRA (build spec §8). Gives every frag effect a stable, per-object
// pseudo-random float `vVfxHash` in [0,1) WITHOUT a per-instance shader program
// and WITHOUT any geometry/instance attribute. The value is derived in the
// VERTEX shader from the per-instance transform three already uploads for the
// mesh type, then passed to the fragment shader as a varying. Weathering reads it
// as a per-object "age"; emissive reads it as a per-object glint/shimmer phase.
//
// ATTRIBUTE vs PROCEDURAL — we choose PROCEDURAL. Rationale:
//   1. BatchedMesh (statics.js ?staticBatch path, three r184) has no first-class
//      per-instance custom float attribute — an InstancedBufferAttribute aVfxHash
//      would not even reach a BatchedMesh. Procedural is the ONLY mechanism that
//      covers plain Mesh + InstancedMesh + BatchedMesh uniformly.
//   2. Zero CPU: no per-instance buffer write, no allocation, no attribute upload.
//   3. Firewall-safe BY CONSTRUCTION: the variation rides the per-instance matrix
//      DATA three already uploads (instanceMatrix / batchingMatrix / modelMatrix),
//      never the program. This module NEVER references customProgramCacheKey, so
//      program count stays O(component-SETs), never O(instances) (spec §2.4).
//   4. USE_INSTANCING and USE_BATCHING are already distinct three program layers
//      (WebGLPrograms layers 0 / 18), so the #ifdef ladder adds ZERO new programs
//      beyond the ones three already compiles for instanced vs batched draws.
//
// MESH-TYPE COVERAGE (statics.js build sites, all verified to carry the shared
// variant material):
//   - singleton THREE.Mesh        -> modelMatrix[3].xy   (node at placement)
//   - THREE.InstancedMesh         -> instanceMatrix[3].xy (setMatrixAt placement)
//   - THREE.BatchedMesh           -> batchingMatrix[3].xy (setMatrixAt placement)
// All three place world XY in the matrix translation, so the hash input is
// distinct per object and frame-stable (the placement never moves at render time).
//
// USAGE: a frag component calls ensureVfxHashVarying(shader) FIRST inside its
// inject(shader, ctx), then reads `vVfxHash` in its fragment GLSL. The helper is
// idempotent — the first component in a SET injects the varying; later components
// in the same SET (same shader object on the _chainBeforeCompile chain) reuse it.
// Components that read vVfxHash MUST declare "instanceHash" in their manifest
// reads[] (the per-instance hash is what THE RULE calls instanceHash).

// The varying name downstream frag components read (export so they don't hardcode).
export const VFX_HASH_VARYING = "vVfxHash";

// Marker substring present once the vertex side is patched (idempotency guard).
const VERT_GUARD = "vfxHash01";
// The exact fragment varying declaration (idempotency guard for the frag side).
const FRAG_DECL = "varying float vVfxHash;";

// --- Vertex: declare the varying + a GPU-stable 2D value hash (Dave Hoskins
// "hash without sine" hash12 — no sin() precision blow-up at large world coords).
// Injected after #include <common> (global scope, before main()). No backticks.
export const VFX_HASH_PARS_VERTEX = [
  "// vfx:perInstanceHash (slice 03) — procedural per-object variety, no attribute, no per-instance program.",
  "varying float vVfxHash;",
  "float vfxHash01(vec2 p){",
  "  vec3 p3 = fract(vec3(p.xyx) * 0.1031);",
  "  p3 += dot(p3, p3.yzx + 33.33);",
  "  return fract((p3.x + p3.y) * p3.z);",
  "}",
].join("\n");

// --- Vertex: assign the hash from the per-instance transform. Injected AFTER
// #include <begin_vertex> so batchingMatrix (declared by <batching_vertex>) is in
// scope; instanceMatrix is a USE_INSTANCING attribute; modelMatrix is a uniform.
export const VFX_HASH_ASSIGN_VERTEX = [
  "#ifdef USE_BATCHING",
  "  vVfxHash = vfxHash01(batchingMatrix[3].xy);",
  "#elif defined( USE_INSTANCING )",
  "  vVfxHash = vfxHash01(instanceMatrix[3].xy);",
  "#else",
  "  vVfxHash = vfxHash01(modelMatrix[3].xy);",
  "#endif",
].join("\n");

// --- Fragment: just receive the varying. Injected after #include <common>.
export const VFX_HASH_PARS_FRAGMENT = [
  "// vfx:perInstanceHash (slice 03) — per-object hash read by weathering/emissive.",
  "varying float vVfxHash;",
].join("\n");

/**
 * Idempotently inject the `vVfxHash` varying + its per-instance derivation into a
 * three onBeforeCompile `shader` object (the COLOR-pass material only — the depth/
 * shadow material is a separate, unpatched object; see slice 04). Safe to call
 * from every frag component's inject(); only the first call per shader patches.
 *
 * Pure string surgery — no three import, no uniforms, no program-cache-key touch.
 *
 * @param {{vertexShader:string, fragmentShader:string}} shader
 * @returns {object} the same shader (for chaining)
 */
export function ensureVfxHashVarying(shader) {
  if (!shader || typeof shader.vertexShader !== "string" || typeof shader.fragmentShader !== "string") {
    return shader;
  }
  if (!shader.vertexShader.includes(VERT_GUARD)) {
    if (shader.vertexShader.includes("#include <common>")) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\n" + VFX_HASH_PARS_VERTEX,
      );
    }
    if (shader.vertexShader.includes("#include <begin_vertex>")) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" + VFX_HASH_ASSIGN_VERTEX,
      );
    }
  }
  if (!shader.fragmentShader.includes(FRAG_DECL)) {
    if (shader.fragmentShader.includes("#include <common>")) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        "#include <common>\n" + VFX_HASH_PARS_FRAGMENT,
      );
    }
  }
  return shader;
}

/** True if `shader` already carries the per-instance hash patch (both stages). */
export function hasVfxHashVarying(shader) {
  return !!shader && typeof shader.vertexShader === "string" &&
    shader.vertexShader.includes(VERT_GUARD) &&
    typeof shader.fragmentShader === "string" &&
    shader.fragmentShader.includes(FRAG_DECL);
}

/**
 * JS reference port of the GLSL vfxHash01 — for tests / offline preview ONLY
 * (e.g. the classifier eye-test). NOT used at render time. Mirrors the float math
 * approximately; GPU mediump may differ in the low bits, which is fine for variety.
 * @param {number} x @param {number} y @returns {number} in [0,1)
 */
export function vfxHash01Ref(x, y) {
  const fract = (v) => v - Math.floor(v);
  let p3x = fract(x * 0.1031), p3y = fract(y * 0.1031), p3z = fract(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d; p3y += d; p3z += d;
  return fract((p3x + p3y) * p3z);
}
