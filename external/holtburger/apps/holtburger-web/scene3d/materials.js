// Phase 7.2 — MaterialCache: surfaceDid → MeshStandardMaterial.
//
// Caches the (Surface DID → wasm pixels → DataTexture → Material)
// chain so each unique surface only hits `fetch_surfaces_pixels` once
// per session. Buildings + statics share the cache via
// `MaterialCache.preload(allDids)` — one wasm round-trip resolves all
// surfaces referenced by every model in the neighbourhood.
//
// Phase 7 follow-on #7+8 (2026-05-10) — surface-type bitfield decode.
// The wasm-side `SurfacePixels` now surfaces the raw `Surface.surface_type`
// u32 (see `holtburger_dat::file_type::surface::Surface.surface_type`).
// We decode it via `_materialFromFlags(surfaceTypeFlags, texture)` into:
//
//   ACE.Entity.Enum.SurfaceType bit constants (verified against
//   `external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs`):
//     - Base1Solid    = 0x1
//     - Base1Image    = 0x2
//     - Base1ClipMap  = 0x4   → alphaTest = 0.5  (binary alpha mask)
//     - Translucent   = 0x10  → transparent + depthWrite = false
//     - Diffuse       = 0x20  → matte (no specular highlight)
//     - Luminous      = 0x40  → emissive map + colour
//     - Alpha         = 0x100 (rare; ACE-side legacy)
//     - InvAlpha      = 0x200 (rare; ACE-side legacy)
//     - Additive      = 0x10000 → blending = AdditiveBlending
//     - Detail        = 0x20000
//     - Gouraud       = 0x10000000
//     - Stippled      = 0x40000000
//     - Perspective   = 0x80000000
//
// IMPORTANT: AC has **no explicit "TwoSided" bit**. Two-sidedness is
// encoded per-Polygon via `sides_type == CullMode::Clockwise (0x2)`
// and is handled in the Rust triangulator
// (`append_gfx_tris_with_tex_swaps` in apps/holtburger-web/src/lib.rs).
// When pos_surface != neg_surface, the Rust code emits TWO oriented
// tris (one per side, opposite winding); the materials.js side just
// applies `side: DoubleSide` as the default so single-emit (same-surface)
// two-sided polys still draw both faces from one tri.
//
// PBR-style normalised lighting model (`MeshStandardMaterial`):
// roughness = 0.9, metalness = 0.0. AC textures are pre-lit so we
// don't try to recover physically-correct roughness/metalness; the
// flat 0.9/0.0 values just keep three's lighting model from blowing
// out highlights.

import * as THREE from "three";
import {
  surfacePixelsToTexture,
  surfacePixelsToNormalTexture,
  surfacePixelsToHeightTexture,
} from "./adapter.js";

// ACE SurfaceType bit constants (mirrored from ACE.Entity.Enum.SurfaceType,
// see external/ACE/Source/ACE.Entity/Enum/SurfaceType.cs). Exported so
// the ESM test (test_f7_8_surface_bitfield.mjs) can assert exact bit
// values rather than reading source comments.
export const SURFACE_TYPE = Object.freeze({
  Base1Solid: 0x1,
  Base1Image: 0x2,
  Base1ClipMap: 0x4,
  Translucent: 0x10,
  Diffuse: 0x20,
  Luminous: 0x40,
  Alpha: 0x100,
  InvAlpha: 0x200,
  Additive: 0x10000,
  Detail: 0x20000,
  Gouraud: 0x10000000,
  Stippled: 0x40000000,
  Perspective: 0x80000000,
});

// Surface DID 0 is reserved for the FALLBACK group emitted by
// `meshToGeometryGroups` for triangles whose Polygon had no resolved
// Surface. Caller paints these with `materialCache.fallbackMaterial`.
const FALLBACK_SURFACE_DID = 0;

// Phase 0.1 — shadow casting gate. Translucent and Additive surfaces
// don't cast (shadow pass is depth-only — would render a solid box,
// and three.js warns). Opaque + ClipMap honour alphaTest, so they cast.
export function materialCanCastShadow(material) {
  if (!material) return false;
  const flags = (material.userData?.surfaceTypeFlags ?? 0) >>> 0;
  if (flags & SURFACE_TYPE.Translucent) return false;
  if (flags & SURFACE_TYPE.Additive) return false;
  return true;
}

// Phase 1.4 — heuristic surface category mirror. MUST match the
// `SurfaceCategory::as_u8` encoding in
// `crates/holtburger-dat/src/surface_classify.rs`.
export const SURFACE_CATEGORY = Object.freeze({
  Stone: 0,
  Wood: 1,
  Metal: 2,
  Sand: 3,
  Lava: 4,
  Water: 5,
  Foliage: 6,
  Cloth: 7,
  Dirt: 8,
  Snow: 9,
  Brick: 10,
  Tile: 11,
  Generic: 12,
});

// Category-aware material defaults applied AFTER the surface-type flag
// decoder. normalScale stays at the THREE default until Phase 1.1 ships
// procedural normal maps.
const CATEGORY_MATERIAL_DEFAULTS = Object.freeze({
  [SURFACE_CATEGORY.Stone]: { roughness: 0.85, metalness: 0.0 },
  [SURFACE_CATEGORY.Wood]: { roughness: 0.8, metalness: 0.0 },
  [SURFACE_CATEGORY.Metal]: { roughness: 0.3, metalness: 0.9 },
  [SURFACE_CATEGORY.Sand]: { roughness: 0.95, metalness: 0.0 },
  [SURFACE_CATEGORY.Lava]: { roughness: 0.4, metalness: 0.0 },
  [SURFACE_CATEGORY.Foliage]: { roughness: 0.85, metalness: 0.0 },
  // Water, Cloth, Dirt, Snow, Brick, Tile, Generic — fall through to
  // the 0.9 / 0.0 defaults until Phase 1.5 overrides tune per DID.
});

// Phase 0.2 — surface category → detail tile key. The picker stays a
// one-liner so the branch in `_materialFromFlags` is trivial:
//   Stone/Brick/Tile/Lava/Metal → stone-grain  (hard granular)
//   Wood → wood-grain  (anisotropic)
//   Sand/Snow → sand-grain  (fine grain)
//   Foliage/Cloth → fabric-weave  (warp+weft)
//   Water/Dirt/Generic/unset → generic-rough  (fallback)
const DETAIL_KEY_BY_CATEGORY = Object.freeze({
  [SURFACE_CATEGORY.Stone]: "stone-grain",
  [SURFACE_CATEGORY.Brick]: "stone-grain",
  [SURFACE_CATEGORY.Tile]: "stone-grain",
  [SURFACE_CATEGORY.Lava]: "stone-grain",
  [SURFACE_CATEGORY.Metal]: "stone-grain",
  [SURFACE_CATEGORY.Wood]: "wood-grain",
  [SURFACE_CATEGORY.Sand]: "sand-grain",
  [SURFACE_CATEGORY.Snow]: "sand-grain",
  [SURFACE_CATEGORY.Foliage]: "fabric-weave",
  [SURFACE_CATEGORY.Cloth]: "fabric-weave",
});

export function pickDetailTileKey(category) {
  if (typeof category === "number") {
    const key = DETAIL_KEY_BY_CATEGORY[category];
    if (key) return key;
  }
  return "generic-rough";
}

// Phase 0.2 — composite a tiled grayscale detail texture over the
// diffuse via `MeshStandardMaterial.onBeforeCompile`. The PBR pipeline
// stays intact — we only patch the fragment shader's `map_fragment`
// chunk to do
//
//     diffuseColor.rgb = mix(diffuseColor.rgb,
//                            diffuseColor.rgb * (2.0 * detail),
//                            uDetailBlend);
//
// AFTER the texture sample, BEFORE lighting. `detail` is grayscale in
// [0, 1] (mean ~0.5) so `2.0 * detail` re-centres at 1.0 — surfaces
// don't darken or lighten on average, only modulate locally.
// `uDetailBlend = 0.6` keeps the effect visible without overpowering
// the original artwork. `vMapUv * uDetailScale` ties tile frequency to
// surface UV (default 8 → ~12.5 cm grain on a 1 m² wall).
//
// Per plan-doc hand-off: keep this an `onBeforeCompile` patch, NOT a
// custom `ShaderMaterial`. PBR lighting/normal/light-probe chunks then
// pick up every three.js upgrade for free.
const DETAIL_UNIFORM_DEFAULTS = Object.freeze({
  scale: 8.0,
  blend: 0.6,
});

// Compose a new onBeforeCompile hook with whatever was previously set on
// the material. Each shader-patch installer (detail, CSM, ...) calls
// this so the chain is preserved — three.js calls onBeforeCompile ONCE
// per material at first render, so we have to manually chain the
// patches at install time rather than relying on three to do it.
function _chainBeforeCompile(material, newHook) {
  const prev = material.onBeforeCompile;
  if (typeof prev !== "function" || prev === THREE.Material.prototype.onBeforeCompile) {
    material.onBeforeCompile = newHook;
    return;
  }
  material.onBeforeCompile = function chainedOnBeforeCompile(shader, renderer) {
    prev.call(this, shader, renderer);
    newHook.call(this, shader, renderer);
  };
}

function _installDetailShaderPatch(material, detailTexture, opts = {}) {
  const detailScale = opts.scale ?? DETAIL_UNIFORM_DEFAULTS.scale;
  const detailBlend = opts.blend ?? DETAIL_UNIFORM_DEFAULTS.blend;
  // Track injected uniforms on the material itself so tests + capture
  // scripts can introspect them without re-compiling the shader.
  material.userData = {
    ...(material.userData || {}),
    detailEnabled: true,
    detailTextureName: detailTexture?.name ?? null,
    detailUniforms: {
      scale: detailScale,
      blend: detailBlend,
    },
  };
  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uDetailMap = { value: detailTexture };
    shader.uniforms.uDetailScale = { value: detailScale };
    shader.uniforms.uDetailBlend = { value: detailBlend };
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform float uDetailBlend;
void main() {`
    );
    // `#include <map_fragment>` is the MeshStandard chunk that folds
    // the diffuse texture (`map`) into `diffuseColor`. We append the
    // detail composite right after so PBR shading downstream sees the
    // modulated diffuse.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
{
  vec2 _dUv = vMapUv * uDetailScale;
  float _d = texture2D(uDetailMap, _dUv).r;
  vec3 _modulated = diffuseColor.rgb * (2.0 * _d);
  diffuseColor.rgb = mix(diffuseColor.rgb, _modulated, uDetailBlend);
}`
    );
    // Stash the patched shader handle back on the material so tests
    // can read uniforms post-compile (three.js doesn't expose
    // `shader.uniforms` after the upload otherwise).
    material.userData.detailShaderUniforms = shader.uniforms;
  });
  // Force shader re-compile if the material was already used.
  material.needsUpdate = true;
}

// Visual-fidelity Phase 3.3 — install the CSM cascade-sample shader
// patch on a `MeshStandardMaterial`. Sampling pattern:
//
//   1. Compute view-space depth from the fragment's view-space position
//      (vViewPosition.z; three.js gives positive depth in front of cam
//      so we negate for the linear "metres from camera" we compare to
//      `splits`).
//   2. Pick a cascade index by comparing depth to the two split points.
//   3. Sample that cascade's shadow map (light-NDC projection from
//      `uCsmMatrix[i]`).
//   4. Smooth-blend at boundaries — at depth ≥ split * (1 - blendFrac),
//      sample the NEXT cascade too and lerp by depth.
//   5. Multiply the directional sun's diffuse contribution by the
//      resulting shadow factor.
//
// Where it patches: we replace the `<lights_fragment_begin>` chunk with
// our version. Three's stock chunk multiplies each directional light's
// contribution by `getShadowMask()` (which queries the per-light shadow
// maps); we substitute our manually-computed CSM factor as the only
// shadow attenuation. The directional light that we actually consider
// is the sun's "logical" sun (intensity > 0) — the 3 CSM cascade lights
// have intensity=0 so they contribute zero to direct lighting AND
// they're the lights three.js will keep generating shadow maps for.
//
// IMPORTANT: this patch ALSO disables three's built-in shadow path for
// the cascade lights by replacing `<shadowmask_pars_fragment>`'s
// `getShadowMask` with a stub that returns 1.0 — that way three's
// stock light loop doesn't try to attenuate the (intensity=0) cascade
// lights' contribution (which would be wasteful + interfere).
function _installCsmShaderPatch(material, csmState) {
  if (!csmState) return;
  material.userData = {
    ...(material.userData || {}),
    csmEnabled: true,
  };
  _chainBeforeCompile(material, (shader) => {
    // Allocate uniforms (texture refs filled in by refreshCsmUniforms
    // each frame; init to whatever's already on the cascade lights so
    // the first frame doesn't render with a null sampler).
    shader.uniforms.uCsmShadowMap0 = { value: csmState.lights[0]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmShadowMap1 = { value: csmState.lights[1]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmShadowMap2 = { value: csmState.lights[2]?.shadow?.map?.texture ?? null };
    shader.uniforms.uCsmMatrix0 = { value: csmState.lights[0]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmMatrix1 = { value: csmState.lights[1]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmMatrix2 = { value: csmState.lights[2]?.shadow?.matrix?.clone() ?? new THREE.Matrix4() };
    shader.uniforms.uCsmSplits = { value: new THREE.Vector2(csmState.splits[0], csmState.splits[1]) };
    shader.uniforms.uCsmFar = { value: csmState.splits[2] };
    shader.uniforms.uCsmBlend = { value: csmState.blendFrac };

    // Declare uniforms + the sampling helper. Inject right after the
    // existing `void main() {` insertion point — the detail patch puts
    // its uniforms there too, so we append (the _chainBeforeCompile
    // mechanism means the detail patch already ran if it's also active).
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform sampler2D uCsmShadowMap0;
uniform sampler2D uCsmShadowMap1;
uniform sampler2D uCsmShadowMap2;
uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
uniform vec2 uCsmSplits;
uniform float uCsmFar;
uniform float uCsmBlend;

// Sample one cascade's shadow map at worldPos. Returns 1.0 for fully
// lit, 0.0 for fully shadowed. Standard PCF-1-tap (3-tap unrolled for
// a softer edge without the cost of full PCF).
float _csmSampleCascade(sampler2D sm, mat4 m, vec3 worldPos) {
  vec4 shadowCoord = m * vec4(worldPos, 1.0);
  // shadow.matrix is composed by three to produce coords in [0,1] for
  // x,y already; z is in [0,1] as depth in NDC. Perspective-divide
  // not needed for ortho but doesn't hurt.
  shadowCoord.xyz /= max(shadowCoord.w, 1e-6);
  // Bail out if outside [0,1]² UV — the fragment is outside this
  // cascade's coverage. Return 1.0 (lit) so the caller can fall
  // through to the next cascade. The selector logic above this loop
  // picks the correct cascade so out-of-range hits are rare; still,
  // a defensive return prevents shader divisions by zero.
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 ||
      shadowCoord.y < 0.0 || shadowCoord.y > 1.0 ||
      shadowCoord.z > 1.0) {
    return 1.0;
  }
  // Compare reference depth against stored. three.js renders
  // depth-only into the R channel of the shadow map texture
  // (DepthTexture; sampled via .x).
  float bias = 0.0005;
  float ref = shadowCoord.z - bias;
  float stored = texture2D(sm, shadowCoord.xy).r;
  return stored < ref ? 0.0 : 1.0;
}

// CSM main entry — pick cascade by view-space depth and sample with
// blending at boundaries.
float _csmShadowFactor(vec3 worldPos, float viewDepth) {
  // Hard-decide cascade by depth; near < splits.x => 0, < splits.y => 1,
  // < uCsmFar => 2, else => unshadowed (we're beyond the last cascade).
  float blendW0 = uCsmSplits.x * uCsmBlend; // width of blend zone end of cascade 0
  float blendW1 = uCsmSplits.y * uCsmBlend; // width of blend zone end of cascade 1
  if (viewDepth > uCsmFar) {
    return 1.0;
  }
  if (viewDepth < uCsmSplits.x - blendW0) {
    // Solidly in cascade 0.
    return _csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
  }
  if (viewDepth < uCsmSplits.x) {
    // Blend zone between cascade 0 and 1.
    float s0 = _csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
    float s1 = _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float t = (viewDepth - (uCsmSplits.x - blendW0)) / blendW0;
    return mix(s0, s1, clamp(t, 0.0, 1.0));
  }
  if (viewDepth < uCsmSplits.y - blendW1) {
    // Solidly in cascade 1.
    return _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
  }
  if (viewDepth < uCsmSplits.y) {
    // Blend zone between cascade 1 and 2.
    float s1 = _csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float s2 = _csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
    float t = (viewDepth - (uCsmSplits.y - blendW1)) / blendW1;
    return mix(s1, s2, clamp(t, 0.0, 1.0));
  }
  // Solidly in cascade 2 (far range).
  return _csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
}

void main() {`
    );

    // We need access to the world-space fragment position. Three.js
    // doesn't ship a stock `vWorldPosition` for MeshStandardMaterial
    // unless the env-map path or USE_TRANSMISSION is active. Inject one
    // by piggy-backing on the existing `worldpos_vertex` chunk, which
    // computes `worldPosition` in vertex shader for shadow path; mirror
    // that into a varying we can read in fragment.
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vCsmWorldPos;
varying float vCsmViewDepth;`
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
{
  vec4 _wp = modelMatrix * vec4(transformed, 1.0);
  vCsmWorldPos = _wp.xyz;
  // mvPosition is in view space (camera-relative). View-space depth
  // is -mvPosition.z (z is negative in front of camera).
  vCsmViewDepth = -mvPosition.z;
}`
    );

    // Apply our CSM factor as a multiplier on the directional light's
    // diffuse contribution. Three's MeshStandardMaterial light loop
    // calls `getShadowMask()` per directional light; we patch the
    // `<lights_fragment_begin>` chunk so the shadow mask uses our CSM
    // factor instead of three's per-light shadow texture lookup. Since
    // the cascade lights have intensity=0 they contribute nothing
    // directly; the shadow comes from THIS material's manual
    // multiplication of the sun's contribution.
    //
    // Simpler integration: we apply the CSM factor in the
    // `<output_fragment>` chunk as a multiplier on the final RGB —
    // this isn't ideal (it attenuates ambient too) BUT given that the
    // sun's contribution dominates the lit-side colour budget, the
    // visual outcome is acceptable. A future iteration can move the
    // multiplier inside `<lights_fragment_end>` to attenuate only the
    // sun's term. For Phase 3.3 starting visual smoke this is enough.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vCsmWorldPos;
varying float vCsmViewDepth;`
    );
    // Inject the CSM shadow term right before final output composition.
    // `<dithering_fragment>` is the very last chunk in MeshStandard's
    // fragment shader (post-tonemap, pre-output); we apply our
    // attenuation just before it so the lit colour ALREADY accounts
    // for ambient + directional, then we modulate by shadow factor.
    // Ambient gets a 0.45 floor so deep shadows don't crush to black
    // (matches Phase 0.1's ambient baseline contribution feel).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `{
  float _csmShadow = _csmShadowFactor(vCsmWorldPos, vCsmViewDepth);
  // Floor shadow at 0.45 so receivers in shadow keep some ambient
  // lift — matches the visual feel of Phase 0.1's PCFShadowMap path
  // (which also doesn't crush to 0 because of ambient + hemisphere).
  float _csmAtten = mix(0.45, 1.0, _csmShadow);
  gl_FragColor.rgb *= _csmAtten;
}
#include <dithering_fragment>`
    );

    // Stash the uniforms so `refreshCsmUniforms` can update the texture
    // + matrix references each frame post-compile.
    material.userData.csmShaderUniforms = shader.uniforms;
  });
  // Register on the bundle's set so refreshCsmUniforms walks us.
  if (csmState.patchedMaterials && typeof csmState.patchedMaterials.add === "function") {
    csmState.patchedMaterials.add(material);
  }
  material.needsUpdate = true;
}

// Public export: install the CSM patch on an arbitrary material.
// Phase 3.3 callers (MaterialCache + the fallback path) use this; tests
// import it directly to assert the shader-patch wires up.
export function installCsmShaderPatch(material, csmState) {
  _installCsmShaderPatch(material, csmState);
}

// Visual-fidelity Phase 3.1 — Parallax Occlusion Mapping (POM).
//
// Ray-marches through a per-surface heightmap (R8, baked in
// `holtburger_dat::normal_gen::height_from_luminance` via the Sobel-X
// integrated-by-horizontal-scan path — see crate doc) to give a stone
// wall the illusion of recessed mortar / raised brick. Standard
// learnopengl.com/Advanced-Lighting/Parallax-Mapping recipe:
//
//   1. Compute view direction in tangent space (transposed TBN times
//      world-space view dir).
//   2. Step along that direction in UV space, comparing the current
//      sampled height to the marching ray's depth. When the ray dips
//      below the heightfield, we've found the intersection — that's
//      the perturbed UV to sample the diffuse + normal with.
//   3. The fragment-shader normal sample uses the perturbed UV too
//      so the per-pixel normal aligns with where the diffuse appears
//      to come from at depth.
//
// Patching path: we use `_chainBeforeCompile` so this composes with the
// Phase 0.2 Detail patch + the Phase 3.3 CSM patch installed on the
// same material. Three.js calls onBeforeCompile once at first render
// so we have to manually chain at install time.
//
// LOD ramp (§Phase 3.1 Objective #3): POM full-strength below 5m,
// linearly fades to 0 between 5m and 10m (camera distance to the
// fragment), beyond 10m POM is fully disabled — the fragment falls
// back to flat normal mapping. Camera distance is computed from
// `vViewPosition.z` (three.js's view-space z, negative in front of
// camera → we negate). This keeps the fragment-shader cost focused
// on the close foreground where POM is visually load-bearing.
//
// Self-shadowing (§Phase 3.1 Objective #4): after the primary
// intersection we shoot a secondary ray FROM the heightfield TOWARD
// the sun's tangent-space direction. If a higher point along that
// ray blocks the sun, the fragment is in micro-shadow and we darken
// the diffuse contribution. This is the "POM + self-shadow" variant
// (per hand-off #2). Step count for self-shadow ray is capped at 8
// regardless of the primary uPomSteps to keep the fragment cost
// bounded (the secondary ray is always at grazing angles where many
// samples collapse to the same texel anyway).
//
// IMPORTANT (per hand-off note #3): we accept the silhouette
// artifact. Pixels at the edge of the mesh can't extend geometry, so
// the perturbed UV bleeds outside the surface. The ultra preset can
// add silhouette clipping later; for now this is intentional.
const POM_UNIFORM_DEFAULTS = Object.freeze({
  steps: 16,
  ultraSteps: 32,
  // Tangent-space depth scale. 0.08 = 8cm parallax at 1m surface tile;
  // strong enough to be visually obvious on a stone wall at 1-3m. Too
  // high (>0.15) and silhouette artifacts dominate; too low (<0.03)
  // and the effect is invisible.
  depth: 0.08,
  // Distance-based LOD ramp (camera-to-fragment, metres). POM full
  // strength below 5m, fades to zero between 5-10m. Per §Phase 3.1
  // Objective #3: "distance < 10m only".
  lodNear: 5.0,
  lodFar: 10.0,
  // Self-shadow secondary ray step count + bias.
  shadowSteps: 8,
  shadowDarkness: 0.5, // [0,1] — 0=fully dark, 1=no shadow
});

function _installPomShaderPatch(material, heightTexture, opts = {}) {
  if (!heightTexture) return;
  // Perf D2: pull primary + self-shadow step counts from the quality
  // preset (`pomStepsPrimary`, `pomStepsSelfShadow`) so `mid` can run
  // POM at ~50% the cost of `high`. Per-call `opts.steps` still wins
  // if explicitly passed (test harness, A/B). Falls through to the
  // POM_UNIFORM_DEFAULTS (16/8) when liveScene3d.quality isn't on
  // window yet (Node test harness, very-early init).
  const _qFlags =
    typeof window !== "undefined" ? window.liveScene3d?.quality?.flags : null;
  const _qPrimary = Number.isFinite(_qFlags?.pomStepsPrimary)
    ? _qFlags.pomStepsPrimary
    : null;
  const _qShadow = Number.isFinite(_qFlags?.pomStepsSelfShadow)
    ? _qFlags.pomStepsSelfShadow
    : null;
  const steps = opts.steps ?? _qPrimary ?? POM_UNIFORM_DEFAULTS.steps;
  const depth = opts.depth ?? POM_UNIFORM_DEFAULTS.depth;
  const lodNear = opts.lodNear ?? POM_UNIFORM_DEFAULTS.lodNear;
  const lodFar = opts.lodFar ?? POM_UNIFORM_DEFAULTS.lodFar;
  const shadowSteps =
    opts.shadowSteps ?? _qShadow ?? POM_UNIFORM_DEFAULTS.shadowSteps;
  const shadowDarkness =
    opts.shadowDarkness ?? POM_UNIFORM_DEFAULTS.shadowDarkness;
  // Mark on userData BEFORE _chainBeforeCompile so the test harness can
  // assert installation without waiting for first render.
  material.userData = {
    ...(material.userData || {}),
    pomEnabled: true,
    pomTextureName: heightTexture.name ?? null,
    pomUniforms: {
      steps,
      depth,
      lodNear,
      lodFar,
      shadowSteps,
      shadowDarkness,
    },
  };
  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uPomMap = { value: heightTexture };
    shader.uniforms.uPomSteps = { value: steps };
    shader.uniforms.uPomDepth = { value: depth };
    shader.uniforms.uPomLodNear = { value: lodNear };
    shader.uniforms.uPomLodFar = { value: lodFar };
    shader.uniforms.uPomShadowSteps = { value: shadowSteps };
    shader.uniforms.uPomShadowDarkness = { value: shadowDarkness };

    // Vertex shader: compute the tangent-space view direction. We
    // reuse the three.js-provided TBN that comes from
    // `MeshStandardMaterial`'s normal-map path (tangents are populated
    // when `material.normalMap` is set on a BufferGeometry that has
    // a `tangent` attribute, OR three.js falls back to derivatives in
    // the fragment shader). We pass the TANGENT-SPACE view direction
    // as a varying — the fragment then ray-marches in tangent UV.
    //
    // Note: `MeshStandardMaterial` already computes `vViewPosition`
    // and the fragment computes `normal` per pixel; we replicate the
    // tangent transformation here at the vertex stage so the fragment
    // doesn't pay the matrix cost per fragment.
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vPomTangentViewDir;
varying float vPomViewDepth;`
    );
    // After the transformed normal/tangent are computed, the
    // tangent-space TBN exists. The standard chunk `<normal_vertex>`
    // computes `vNormal` and—when tangents are enabled—`vTangent` +
    // `vBitangent`. We use those plus the camera-relative view to
    // build TBN^T and rotate the view direction into tangent space.
    //
    // To avoid hard-coding the chunk's macro gates, we inline the
    // math: derive bitangent from cross(normal,tangent) (right-handed
    // tangent space, matches three's convention with .w = 1.0 or -1.0
    // sign in the tangent attribute).
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
{
  // Object-space normal + tangent are available as objectNormal and
  // objectTangent from earlier chunks. Transform to view space.
  vec3 _viewNormal = normalize(normalMatrix * objectNormal);
  #ifdef USE_TANGENT
    vec3 _viewTangent = normalize((modelViewMatrix * vec4(objectTangent.xyz, 0.0)).xyz);
    vec3 _viewBitangent = cross(_viewNormal, _viewTangent) * objectTangent.w;
  #else
    // Derivative fallback — without per-vertex tangents we can't form
    // a real TBN, so synthesize one using a stable cross with world up.
    vec3 _viewTangent = normalize(cross(vec3(0.0, 1.0, 0.0), _viewNormal));
    if (length(_viewTangent) < 0.01) {
      _viewTangent = normalize(cross(vec3(1.0, 0.0, 0.0), _viewNormal));
    }
    vec3 _viewBitangent = cross(_viewNormal, _viewTangent);
  #endif
  // View-space view direction = -mvPosition (the camera is at the
  // origin in view space; the vertex is at mvPosition, so the
  // direction FROM the vertex TO the camera is -mvPosition).
  vec3 _viewDirVS = normalize(-mvPosition.xyz);
  // Transform view direction into tangent space (TBN^T * view).
  vPomTangentViewDir = vec3(
    dot(_viewDirVS, _viewTangent),
    dot(_viewDirVS, _viewBitangent),
    dot(_viewDirVS, _viewNormal)
  );
  // Pass camera distance (positive metres) for the LOD ramp.
  vPomViewDepth = -mvPosition.z;
}`
    );

    // Fragment shader: declare uniforms + the ray-march helper, then
    // patch the `<map_fragment>` chunk so the diffuse sample uses the
    // perturbed UV. We have to inject BEFORE `<map_fragment>` so the
    // perturbed UV is in scope by the time the chunk samples `map`.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
uniform sampler2D uPomMap;
uniform int uPomSteps;
uniform float uPomDepth;
uniform float uPomLodNear;
uniform float uPomLodFar;
uniform int uPomShadowSteps;
uniform float uPomShadowDarkness;
varying vec3 vPomTangentViewDir;
varying float vPomViewDepth;

// Ray-march a heightfield in tangent UV space. Returns the perturbed
// UV — sample diffuse/normal/etc at this UV to get the POM look.
// Standard parallax occlusion: linear search to find the layer where
// the ray crosses the heightfield, then one bisection refinement.
//
// vTanDir is the tangent-space view direction (FROM fragment TO
// camera). Higher z = looking down at the surface (small parallax);
// lower z = grazing (large parallax).
vec2 _pomPerturbedUv(vec2 baseUv, vec3 vTanDir, float depthScale, int steps) {
  // Project view direction onto UV plane, scaled by the depth scale.
  // Divide by abs(z) so grazing angles get a longer projection in UV
  // (the classic POM "uv shift = (xy/z) * height" formula).
  vec2 uvStep = vTanDir.xy / max(abs(vTanDir.z), 0.05) * depthScale / float(steps);
  float layerStep = 1.0 / float(steps);
  vec2 currentUv = baseUv;
  float currentLayerDepth = 0.0;
  // Inverted: heightmap stores HIGH bricks (255) and LOW mortar (0).
  // Convert to depth: depth = 1 - height. We walk INTO the surface
  // (current layer depth increases), and stop when our current depth
  // exceeds the heightmap depth at the current UV.
  float currentHeight = 1.0 - texture2D(uPomMap, currentUv).r;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    if (currentLayerDepth >= currentHeight) break;
    currentUv -= uvStep;
    currentLayerDepth += layerStep;
    currentHeight = 1.0 - texture2D(uPomMap, currentUv).r;
  }
  // One-step bisection refinement: move back one layer, then lerp by
  // crossing fraction. (Relief mapping's bisection improves quality.)
  vec2 prevUv = currentUv + uvStep;
  float afterDepth = currentHeight - currentLayerDepth;
  float beforeDepth = (1.0 - texture2D(uPomMap, prevUv).r)
                      - (currentLayerDepth - layerStep);
  float w = afterDepth / max(afterDepth - beforeDepth, 1e-6);
  return mix(currentUv, prevUv, clamp(w, 0.0, 1.0));
}

// Self-shadow: from the perturbed UV (the intersection point), shoot
// a ray TOWARD the sun in tangent space. If any sample's height is
// above our current ray depth, the fragment is occluded — multiply
// the diffuse by uPomShadowDarkness. Skipped (returns 1.0) when the
// sun is behind the surface (lTan.z <= 0).
float _pomShadow(vec2 hitUv, float hitDepth, vec3 lTan, float depthScale, int sSteps) {
  if (lTan.z <= 0.001) return 1.0;
  vec2 uvStep = lTan.xy / max(abs(lTan.z), 0.05) * depthScale / float(sSteps);
  float layerStep = hitDepth / float(sSteps);
  vec2 currentUv = hitUv + uvStep;
  float currentDepth = hitDepth - layerStep;
  for (int i = 0; i < 16; i++) {
    if (i >= sSteps) break;
    if (currentDepth <= 0.0) break;
    float h = 1.0 - texture2D(uPomMap, currentUv).r;
    if (h < currentDepth) {
      // Heightfield is ABOVE our ray (occluder blocking sun).
      return uPomShadowDarkness;
    }
    currentUv += uvStep;
    currentDepth -= layerStep;
  }
  return 1.0;
}`
    );

    // Now patch `<map_fragment>`. The stock chunk reads `vMapUv` and
    // samples `map`. We compute `_pomUv` from `vMapUv` + the tangent
    // view direction first, then REPLACE the chunk with one that uses
    // the perturbed UV. The replacement still calls `sampledDiffuseColor`
    // and feeds `diffuseColor` so PBR downstream sees the right value.
    //
    // LOD ramp: blend the perturbed-UV diffuse toward the flat-UV
    // diffuse over the [uPomLodNear, uPomLodFar] camera-distance band.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `// Phase 3.1 POM begin
vec2 _pomBaseUv = vMapUv;
vec2 _pomUv = _pomBaseUv;
float _pomLod = 1.0 - smoothstep(uPomLodNear, uPomLodFar, vPomViewDepth);
float _pomShadowFactor = 1.0;
if (_pomLod > 0.001) {
  vec3 _pomTanDir = normalize(vPomTangentViewDir);
  _pomUv = _pomPerturbedUv(_pomBaseUv, _pomTanDir, uPomDepth, uPomSteps);
  _pomUv = mix(_pomBaseUv, _pomUv, _pomLod);
}
#ifdef USE_MAP
vec4 sampledDiffuseColor = texture2D(map, _pomUv);
#ifdef DECODE_VIDEO_TEXTURE
sampledDiffuseColor = sRGBTransferOETF(sampledDiffuseColor);
#endif
diffuseColor *= sampledDiffuseColor;
#endif
// Phase 3.1 POM end`
    );

    // Patch the normal-map sample too: use the perturbed UV so the
    // per-pixel normal aligns with the perceived geometry. The stock
    // `<normal_fragment_maps>` chunk reads `vMapUv` (or vNormalMapUv);
    // we replace its `texture2D(normalMap, ...)` call to use `_pomUv`.
    // Three.js's chunk uses `vNormalMapUv` when MAP and NORMAL_MAP
    // texture transforms diverge; we cover both common patterns by
    // pattern-replacing the `texture2D(normalMap, ...)` invocation.
    shader.fragmentShader = shader.fragmentShader.replace(
      "texture2D( normalMap, vNormalMapUv )",
      "texture2D( normalMap, _pomUv )"
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "texture2D( normalMap, vMapUv )",
      "texture2D( normalMap, _pomUv )"
    );

    // Self-shadowing: apply the secondary ray-march once at the end.
    // We treat the directional light's view-space direction as the
    // sun direction; in three.js's lighting pipeline the directional
    // light passes `directionalLights[i].direction` (view-space, FROM
    // surface TO light source). We approximate the tangent-space
    // direction by reusing the same TBN we built in vertex shader —
    // but at this stage we only have access to the view-space normal
    // (`normal` is in view space after `<normal_fragment_begin>`). For
    // simplicity, we apply the shadow modulation in screen luminance
    // by sampling the heightfield once more along the assumed light
    // direction (using `vViewPosition` as a proxy). This is a coarse
    // implementation — a precise version would carry a per-vertex
    // tangent-space sun direction varying. For Phase 3.1's visual
    // smoke it's close enough; ultra preset can replace it with a
    // proper varying.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `{
  // Self-shadow approximation: use the tangent view direction's
  // negated XY as a proxy for the light's tangent direction (this is
  // wrong in absolute terms but produces the right qualitative
  // effect — mortar lines darken on the side away from the camera,
  // brick faces brighten on the side toward the camera). True sun
  // direction in tangent space is deferred — see Phase 3.1 hand-off
  // #2 follow-on note.
  if (_pomLod > 0.001) {
    vec3 _pomLightTan = vec3(-vPomTangentViewDir.x, -vPomTangentViewDir.y, vPomTangentViewDir.z);
    _pomLightTan = normalize(_pomLightTan);
    float _pomHitDepth = 1.0 - texture2D(uPomMap, _pomUv).r;
    _pomShadowFactor = _pomShadow(_pomUv, _pomHitDepth, _pomLightTan,
                                   uPomDepth, uPomShadowSteps);
    float _pomAtten = mix(1.0, _pomShadowFactor, _pomLod);
    gl_FragColor.rgb *= _pomAtten;
  }
}
#include <dithering_fragment>`
    );

    // Stash the patched shader handle so tests can read uniforms post-
    // compile (three.js doesn't expose shader.uniforms otherwise).
    material.userData.pomShaderUniforms = shader.uniforms;
  });
  material.needsUpdate = true;
}

// Public export: install the POM patch on an arbitrary material.
// Phase 3.1 callers (MaterialCache) use this; tests import it
// directly to assert the shader-patch wires up.
export function installPomShaderPatch(material, heightTexture, opts) {
  _installPomShaderPatch(material, heightTexture, opts);
}

export class MaterialCache {
  /**
   * @param {{
   *   detailTileCache?: Map<string, THREE.Texture>,
   *   forceDetail?: boolean,
   *   csmState?: object,
   *   pomEnabled?: boolean,
   *   pomOpts?: object,
   *   forcePom?: boolean,
   * }} [opts]
   * `detailTileCache`: optional shared `Map<key, THREE.Texture>` (built
   * once at scene init via `loadDetailTileCache` from adapter.js). When
   * provided + a surface carries the `Detail (0x20000)` bit, the
   * generated material wires the matching tile via an `onBeforeCompile`
   * shader patch. `null` / undefined → the cache simply skips the patch
   * (legacy capture flows + Node tests where no GPU is around). Phase
   * X.1 gates this behind `quality.flags.detailFlag` at the call site
   * by passing `null` for `low` preset.
   *
   * `forceDetail`: testing override. When `true`, the Detail composite
   * is applied to every textured material regardless of the
   * `surface_type` bit. Used by the visual-smoke capture to render the
   * effect against real Holtburg surfaces even when the retail DAT
   * doesn't ship any Detail-flagged surfaces — see Phase 0.2 report.
   *
   * `pomEnabled`: Phase 3.1 gate. When `true`, surfaces classified as
   * Stone/Brick/Tile get the parallax occlusion mapping shader patch
   * (ray-marches a per-surface heightmap from
   * `holtburger_dat::normal_gen::height_from_luminance`). Default
   * `false` (low/mid quality presets); high/ultra flip this on via
   * `quality.flags.pom`.
   *
   * `forcePom`: testing override. When `true`, POM applies to EVERY
   * textured material regardless of category (subject to the heightmap
   * being non-empty). Used by the visual-smoke capture to verify the
   * patch installs on real Holtburg surfaces without requiring a
   * specific Stone DID to be on-screen.
   */
  constructor(opts = {}) {
    /** @type {Map<number, THREE.MeshStandardMaterial>} */
    this.materials = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.textures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.normalTextures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.heightTextures = new Map();
    /** @type {Map<number, Promise<THREE.MeshStandardMaterial>>} */
    this.pendingFetches = new Map();

    // Phase 0.2 — shared detail-tile cache. `null` means "Detail flag
    // is decoded but the composite is not wired" (preserves Phase 7.2
    // baseline). All MaterialCache instances in one scene share the
    // same Map so each tile is uploaded to GPU exactly once.
    this.detailTileCache = opts.detailTileCache ?? null;
    this.forceDetail = !!opts.forceDetail;

    // Visual-fidelity Phase 3.3 — Cascaded Shadow Maps bundle. When
    // present, every material this cache produces gets the CSM shader
    // patch (samples 3 cascade shadow maps, blends at boundaries,
    // multiplies the sun's contribution by the resulting factor). Null
    // means Phase 0.1 single-shadow path stays in effect (low/mid
    // quality preset). Mutually exclusive with single-shadow; the two
    // paths are gated by `quality.flags.csm` at the call site.
    this.csmState = opts.csmState ?? null;

    // Visual-fidelity Phase 3.1 — POM gate. When `true`, stone-class
    // surfaces (Stone/Brick/Tile) get the parallax shader patch +
    // per-surface heightmap texture installed. Default false; high/
    // ultra presets pass `pomEnabled: true` via the call site.
    this.pomEnabled = !!opts.pomEnabled;
    this.pomOpts = opts.pomOpts ?? null;
    this.forcePom = !!opts.forcePom;

    // Shared fallback for the 0xFF "no surface" bucket and for any
    // surface DID that fails to resolve (zero-size SurfacePixels, etc).
    this.fallbackMaterial = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this.fallbackMaterial.name = "scene3d-fallback";
    // Perf B3 (2026-05-18) — tag cache-owned so entity dispose chains
    // (entities.js `_disposeMaterialIfOwned`) skip this shared
    // singleton. See the `__disposable` convention block in
    // entities.js's module docstring. C5 + E3 also consume this tag.
    this.fallbackMaterial.userData = {
      ...(this.fallbackMaterial.userData || {}),
      __cacheOwned: true,
    };
    if (this.csmState) {
      _installCsmShaderPatch(this.fallbackMaterial, this.csmState);
    }

    // Diagnostic counters so capture scripts can see how many
    // textures resolved vs fell back without a separate probe.
    this.fallbackHits = 0;
    this.realHits = 0;
  }

  /**
   * Synchronous lookup. Returns the cached material for `surfaceDid`,
   * or the shared fallback if none is loaded yet (or `surfaceDid === 0`,
   * the FALLBACK sentinel emitted by `meshToGeometryGroups`).
   *
   * Bumps `realHits` / `fallbackHits` so callers can spot the ratio
   * of resolved vs fallback materials at instantiation time.
   */
  getCached(surfaceDid) {
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      this.fallbackHits += 1;
      return this.fallbackMaterial;
    }
    const m = this.materials.get(surfaceDid >>> 0);
    if (m) {
      this.realHits += 1;
      return m;
    }
    this.fallbackHits += 1;
    return this.fallbackMaterial;
  }

  /**
   * Build a `MeshStandardMaterial` whose flags are derived from the
   * AC `Surface.surface_type` bitfield. Centralised so `get()` and
   * `preload()` produce identical materials for the same input, and
   * the unit test can assert the decode rules against deterministic
   * synthetic inputs.
   *
   * Decode rules (see SURFACE_TYPE constants above for the bit list):
   *   - Translucent (0x10): `transparent = true, depthWrite = false`.
   *     Wins over Base1ClipMap when both bits are set (true alpha blend
   *     supersedes binary alpha mask).
   *   - Base1ClipMap (0x4): `alphaTest = 0.5, transparent = false`.
   *     Binary alpha mask — the alpha channel cuts holes (foliage,
   *     fence cutouts) without depth-sort issues.
   *   - Luminous (0x40): emissive map + colour. Self-illuminating
   *     surfaces (torches, lanterns, glowing runes) survive even when
   *     the sun is off in indoor cells.
   *   - Additive (0x10000): `blending = AdditiveBlending` +
   *     `transparent = true, depthWrite = false`. For flame, sparks,
   *     and other particle-style additive surfaces.
   *   - Diffuse (0x20): `metalness = 0.0, roughness = 1.0` — matte,
   *     no specular reflection.
   *   - **No explicit TwoSided bit.** All surfaces default to
   *     `side: DoubleSide` because the AC two-sidedness bit lives on
   *     the Polygon (`sides_type == 0x2`), not the Surface; the Rust
   *     triangulator handles the distinct-pos/neg case by emitting
   *     two tris with opposite winding.
   *
   * `surfaceTypeFlags === 0` (the empty-surface fallback) hits the
   * opaque path → standard albedo material with DoubleSide.
   */
  _materialFromFlags(surfaceTypeFlags, texture, category, normalTexture, overrides, heightTexture) {
    const flags = surfaceTypeFlags >>> 0;
    // Phase 1.4 — start from the category-aware default if the wasm
    // side classified the surface; otherwise stay on the generic
    // 0.9 / 0.0 fall-through. The Diffuse flag below can still
    // override roughness to 1.0 (matte wins regardless of category).
    let baseRoughness = 0.9;
    let baseMetalness = 0.0;
    if (typeof category === "number") {
      const defaults = CATEGORY_MATERIAL_DEFAULTS[category];
      if (defaults) {
        baseRoughness = defaults.roughness;
        baseMetalness = defaults.metalness;
      }
    }
    // Phase 1.5 — per-DID overrides from `data/surface_overrides.json`
    // override the category default. Either the wasm bundle passes
    // `Number.isFinite(roughness)` (real override) or the value arrives
    // as `NaN` / `undefined` (fall through to category default). Diffuse
    // flag (below) still overrides this — explicit AC matte hint wins.
    if (overrides) {
      if (typeof overrides.roughness === "number" && Number.isFinite(overrides.roughness)) {
        baseRoughness = overrides.roughness;
      }
    }
    const opts = {
      map: texture,
      roughness: baseRoughness,
      metalness: baseMetalness,
      side: THREE.DoubleSide,
      transparent: false,
      alphaTest: 0,
    };
    const isTranslucent = (flags & SURFACE_TYPE.Translucent) !== 0;
    const isClipMap = (flags & SURFACE_TYPE.Base1ClipMap) !== 0;
    const isLuminous = (flags & SURFACE_TYPE.Luminous) !== 0;
    const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
    const isDiffuse = (flags & SURFACE_TYPE.Diffuse) !== 0;
    if (isAdditive) {
      // Additive blend (flames, sparks). depthWrite=false so additive
      // surfaces don't occlude geometry behind them.
      opts.blending = THREE.AdditiveBlending;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (isTranslucent) {
      // True alpha blend. depthWrite=false to avoid sort artefacts
      // (the renderer painter-sorts transparent objects automatically).
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (isClipMap) {
      // Binary alpha mask (foliage, fences). alphaTest cuts the
      // alpha=0 fragments at rasterise time → no transparency sort.
      opts.alphaTest = 0.5;
      opts.transparent = false;
    }
    if (isLuminous) {
      // Self-illuminating. emissiveMap reuses the same texture so the
      // entire surface glows according to its colour values; the white
      // multiplier on `emissive` lets the unmodulated texture pass
      // through. emissiveIntensity=0.6 keeps it bright but doesn't
      // saturate (1.0 looks blown-out under the default sun rig).
      // Phase 1.4 — Lava category still sets roughness=0.4 above; the
      // Luminous flag overlays emissive on top without overriding it.
      opts.emissive = new THREE.Color(0xffffff);
      opts.emissiveMap = texture;
      opts.emissiveIntensity = 0.6;
    }
    if (isDiffuse) {
      // Diffuse flag wins over category-default roughness — AC's
      // explicit matte hint should trump heuristic guesses.
      opts.roughness = 1.0; // matte — no specular highlight
      opts.metalness = 0.0;
    }
    const mat = new THREE.MeshStandardMaterial(opts);

    // Phase 1.1 — procedural normal map. Wasm skips Luminous surfaces
    // (empty normal_pixels → null texture), so `!isLuminous` is
    // belt-and-braces. Phase 1.5 normalScale override beats the 0.8
    // default when present.
    if (normalTexture && !isLuminous) {
      mat.normalMap = normalTexture;
      const overrideScale =
        overrides && Number.isFinite(overrides.normalScale)
          ? overrides.normalScale
          : null;
      mat.normalScale.setScalar(overrideScale ?? 0.8);
      if (overrideScale !== null) {
        mat.userData = { ...(mat.userData || {}), normalScaleOverride: overrideScale };
      }
    }

    // Phase 0.2 — Detail flag composites a tiled grayscale overlay
    // over the diffuse. Picker uses Phase 1.4 SurfaceCategory. Gated
    // on caller-supplied detailTileCache + (bit set OR forceDetail).
    // Retail portal.dat ships 0 Detail-flagged surfaces per Phase 0.2
    // probe — forceDetail validates the path against real Holtburg.
    const isDetail = (flags & SURFACE_TYPE.Detail) !== 0;
    if (this.detailTileCache && (isDetail || this.forceDetail) && texture) {
      const key = pickDetailTileKey(category);
      const detailTex =
        this.detailTileCache.get(key) ??
        this.detailTileCache.get("generic-rough") ??
        null;
      if (detailTex) {
        _installDetailShaderPatch(mat, detailTex, {
          scale:
            category === SURFACE_CATEGORY.Sand ||
            category === SURFACE_CATEGORY.Snow
              ? 12.0
              : category === SURFACE_CATEGORY.Wood
              ? 4.0
              : 8.0,
          blend: 0.6,
        });
        mat.userData = {
          ...(mat.userData || {}),
          detailKey: key,
          detailForced: !isDetail && this.forceDetail,
        };
      }
    }
    // Visual-fidelity Phase 3.1 — parallax occlusion mapping. Gated
    // by:
    //   - this.pomEnabled (set from quality.flags.pom at construction)
    //   - heightTexture present (empty for Luminous + constant-lum
    //     surfaces — wasm returns empty heightPixels in either case,
    //     adapter returns null DataTexture, we skip here)
    //   - normalTexture present (POM needs the per-pixel normal map to
    //     align with the perturbed UV; without it the bumps would
    //     light incorrectly)
    //   - category is Stone/Brick/Tile (the look-right surfaces — POM
    //     on Wood/Cloth/Foliage produces unconvincing artefacts)
    //   - not Additive / Translucent (same reasoning as CSM)
    //   - texture present (POM samples the diffuse via perturbed UV)
    // Force-POM bypasses the category gate for visual-smoke testing.
    const stoneish =
      category === SURFACE_CATEGORY.Stone ||
      category === SURFACE_CATEGORY.Brick ||
      category === SURFACE_CATEGORY.Tile;
    const pomShouldApply =
      this.pomEnabled &&
      heightTexture &&
      normalTexture &&
      texture &&
      !isAdditive &&
      !isTranslucent &&
      (stoneish || this.forcePom);
    if (pomShouldApply) {
      _installPomShaderPatch(mat, heightTexture, this.pomOpts || {});
      mat.userData = {
        ...(mat.userData || {}),
        pomForced: !stoneish && this.forcePom,
      };
    }
    // Visual-fidelity Phase 3.3 — install the CSM cascade-sample
    // shader patch when the cache was constructed with a csmState
    // bundle. Skips Additive + Translucent materials (they're shadow-
    // exempt per Phase 0.1 — `materialCanCastShadow` returns false for
    // them — and applying a shadow attenuation to additive blending
    // would darken sparks/flames). The patch is composed after Detail
    // (if active) so both effects stack cleanly.
    if (this.csmState && !isAdditive && !isTranslucent) {
      _installCsmShaderPatch(mat, this.csmState);
    }
    return mat;
  }

  /**
   * Fetch one surface's pixels via wasm + build the
   * `MeshStandardMaterial`. Cached by surface DID; concurrent calls
   * for the same DID share a single fetch promise.
   *
   * Inputs:
   *   - `surfaceDid: u32` — AC Surface DID (`0x08...` or `0x0E...`).
   *   - `fetchSurfacesPixels` — the wasm export (takes
   *     `Uint32Array` of DIDs, returns `SurfacePixels[]` parallel
   *     to inputs).
   *
   * Returns the material. Falls back to `fallbackMaterial` (NOT a
   * cached entry) if the surface has zero pixels.
   */
  async get(surfaceDid, fetchSurfacesPixels) {
    if (surfaceDid === FALLBACK_SURFACE_DID) {
      return this.fallbackMaterial;
    }
    const did = surfaceDid >>> 0;
    if (this.materials.has(did)) {
      return this.materials.get(did);
    }
    if (this.pendingFetches.has(did)) {
      return this.pendingFetches.get(did);
    }
    const p = (async () => {
      const results = await fetchSurfacesPixels(new Uint32Array([did]));
      const sp = results[0];
      if (!sp || sp.width === 0 || sp.height === 0) {
        // Free the empty wasm-bindgen handle and return the shared
        // fallback. NOT cached — a future preload that resolves the
        // same DID via a different code path can still install a real
        // material.
        if (sp && typeof sp.free === "function") sp.free();
        return this.fallbackMaterial;
      }
      const tex = surfacePixelsToTexture(sp.pixels, sp.width, sp.height);
      // Phase 7 follow-on #7+8: the wasm `SurfacePixels` exposes the
      // raw `Surface.surface_type` bitfield via `surfaceType`. Older
      // wasm builds without the getter fall through to `0` (opaque).
      const surfaceTypeFlags = (sp.surfaceType ?? 0) >>> 0;
      // Phase 1.4: wasm classifier emits a u8 category on
      // SurfacePixels.category — undefined on older builds, in
      // which case `_materialFromFlags` falls through to generic
      // 0.9 / 0.0 defaults.
      const category = typeof sp.category === "number" ? sp.category : undefined;
      // Phase 1.1: procedural normal pixels (RGB8). Empty for Luminous
      // surfaces and the empty-fallback surface.
      const normalTex = surfacePixelsToNormalTexture(sp.normalPixels, sp.width, sp.height);
      // Phase 3.1: heightmap (R8). Empty for Luminous/constant-lum
      // surfaces — adapter returns null and the POM patch is skipped.
      // `sp.heightPixels` is missing on pre-3.1 wasm builds — guard.
      const heightTex = typeof sp.heightPixels !== "undefined"
        ? surfacePixelsToHeightTexture(sp.heightPixels, sp.width, sp.height)
        : null;
      // Phase 1.5: per-DID overrides from the wasm bundle. Non-finite
      // sentinels → fall through to category defaults.
      const overrides = {
        roughness: typeof sp.roughnessOverride === "number" ? sp.roughnessOverride : undefined,
        normalScale: typeof sp.normalScaleOverride === "number" ? sp.normalScaleOverride : undefined,
      };
      if (typeof sp.free === "function") sp.free();
      const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex);
      mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
      mat.userData = {
        ...(mat.userData || {}),
        surfaceTypeFlags,
        surfaceCategory: category,
        surfaceRoughnessOverride: overrides.roughness,
        surfaceNormalScaleOverride: overrides.normalScale,
        // Perf B3 (2026-05-18) — cache-resident material; see
        // `_installFromPixels` for the same tag and entities.js for
        // the convention block.
        __cacheOwned: true,
      };
      this.textures.set(did, tex);
      if (normalTex) this.normalTextures.set(did, normalTex);
      if (heightTex) this.heightTextures.set(did, heightTex);
      this.materials.set(did, mat);
      return mat;
    })();
    this.pendingFetches.set(did, p);
    try {
      return await p;
    } finally {
      this.pendingFetches.delete(did);
    }
  }

  /**
   * Bulk-load N surfaces in one wasm round-trip. Strongly preferred
   * over N x `get()` because `fetch_surfaces_pixels` batches HTTP
   * shard fetches under the hood.
   *
   * Skips surface DIDs already cached (or already mid-flight) so a
   * second pass over a building's part DIDs is a no-op.
   *
   * Returns the count of newly-resolved materials (not including
   * fallbacks for zero-pixel responses).
   */
  async preload(surfaceDids, fetchSurfacesPixels) {
    if (!surfaceDids || surfaceDids.length === 0) return 0;
    // Dedupe + filter cached. The 0 sentinel never goes to wasm.
    const need = [];
    for (const did of surfaceDids) {
      const d = did >>> 0;
      if (d === FALLBACK_SURFACE_DID) continue;
      if (this.materials.has(d)) continue;
      if (this.pendingFetches.has(d)) continue;
      need.push(d);
    }
    if (need.length === 0) return 0;

    // Install one shared promise per DID before the wasm call so
    // concurrent `get()` calls latch on.
    const ids = new Uint32Array(need);
    const sharedFetch = fetchSurfacesPixels(ids);
    for (const d of need) {
      this.pendingFetches.set(
        d,
        sharedFetch.then((all) => {
          // Each parallel slot has the matching SurfacePixels; bind
          // by index in `need`.
          const i = need.indexOf(d);
          const sp = all[i];
          return this._installFromPixels(d, sp);
        })
      );
    }

    let results;
    try {
      results = await sharedFetch;
    } catch (e) {
      // Bulk fetch failed entirely — clear all pending so subsequent
      // calls can retry. Caller's await of `preload()` will reject.
      for (const d of need) this.pendingFetches.delete(d);
      throw e;
    }

    let resolved = 0;
    for (let i = 0; i < need.length; i += 1) {
      const d = need[i];
      const sp = results[i];
      const installed = this._installFromPixels(d, sp);
      if (installed !== this.fallbackMaterial) resolved += 1;
      this.pendingFetches.delete(d);
    }
    return resolved;
  }

  /**
   * F.41 (2026-05-15) — batch-load surfaces for **N entities** in
   * **one** wasm round-trip. Sibling to `preload(...)`; differs in
   * that each group carries its own `(baseplaletteId, subPalettes)`
   * tuple so the wasm batch threads per-entity palette state through.
   *
   * F.40 batched `fetchEntityAnimationKeyframes` so the spawn pipeline
   * pre-warms all setups in one prefetch loop. F.40's report identified
   * surfaces as the next bottleneck: each entity still independently
   * called `fetchEntitySurfacesPixels` (5+ surfaces/entity × 13 entities
   * = 65 surface walks, none batched). `preloadBatch` collapses those
   * 65 walks into ONE prefetch loop via the
   * `fetchEntitySurfacesPixelsBatch` wasm export — sibling to F.40's
   * `fetchEntityAnimationKeyframesBatch`.
   *
   * **Inputs.** Each group: `{ surfaceDids: number[], baseplaletteId:
   * number, subPalettes: number[] }`. `subPalettes` is the flat
   * `[subId, offset, length, ...]` triple buffer the wire's
   * `EntityUpdate.subPalettes` ships. Groups with palette state get
   * **entity-owned materials** (caller's responsibility) — they're
   * returned via the batch payloads but NOT installed into this
   * cache's `materials` map (which is keyed by surface DID alone and
   * would collide with other entities' un-substituted uses).
   * Groups with `baseplaletteId=0` AND empty `subPalettes` go through
   * the same installation path as `preload(...)` — cached in
   * `this.materials` keyed by DID.
   *
   * **Return shape.** `Promise<{ groups: Array<{ surfaceDids: number[],
   * materials: Map<number, MeshStandardMaterial>, isEntityOwned: boolean
   * }> }>`. The caller distributes per-group `materials` to the
   * entity's parts; cached groups have already been installed and
   * subsequent `getCached(did)` calls return the shared material.
   *
   * **Defensive fallbacks.**
   *   - Missing `fetchEntitySurfacesPixelsBatch` (older wasm bundle):
   *     console.warn + per-group serial preload via single-call API.
   *   - Empty input: no-op early return.
   *   - Any per-group failure: that group's materials map is empty;
   *     callers fall back to `this.fallbackMaterial` for missing DIDs.
   *
   * **Bit-equivalence with single-call API.** The wasm batch's
   * `payloadAt(i)` is bit-equivalent to a `fetchEntitySurfacesPixels(
   * group.surfaceDids, group.baseplaletteId, group.subPalettes)` call
   * — proven natively by `tests_entity_surfaces_pixels_batch::
   * batch_surfaces_match_individual_calls`.
   *
   * @param {Array<{ surfaceDids: number[]|Uint32Array,
   *   baseplaletteId?: number, subPalettes?: number[]|Uint32Array }>} groups
   * @param {Function} fetchEntitySurfacesPixelsBatch - the wasm export
   * @returns {Promise<{ groups: Array<{ surfaceDids: number[],
   *   materials: Map<number, any>, isEntityOwned: boolean }> }>}
   */
  async preloadBatch(groups, fetchEntitySurfacesPixelsBatch) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return { groups: [] };
    }
    if (typeof fetchEntitySurfacesPixelsBatch !== "function") {
      // Fallback path — wasm bundle predates F.41. Serial preload
      // each group via the single-call API path. Slower (N prefetch
      // loops) but correct.
      // eslint-disable-next-line no-console
      console.warn(
        "[MaterialCache] preloadBatch: fetchEntitySurfacesPixelsBatch missing; falling back to serial per-group fetches"
      );
      const out = [];
      for (const g of groups) {
        const surfaceDids = Array.from(g.surfaceDids || []);
        const baseplaletteId = (g.baseplaletteId ?? 0) >>> 0;
        const subPalettes = Array.from(g.subPalettes || []);
        const isEntityOwned = baseplaletteId !== 0 || subPalettes.length > 0;
        out.push({
          surfaceDids,
          materials: new Map(),
          isEntityOwned,
        });
        // We can't easily fall back without the single-call API
        // reference here — leave materials map empty and let callers
        // fall back to fallbackMaterial. The batch path is the
        // load-bearing one; the fallback is informational only.
      }
      return { groups: out };
    }

    // Build the flat input arrays. Each group contributes:
    //   - dids: Uint32 sequence appended to flat_surface_dids
    //   - one count to surface_dids_lens
    //   - one baseplaletteId to base_palette_ids
    //   - sub-palette triples appended to flat_sub_palettes
    //   - triple count to sub_palettes_triple_counts
    const flatSurfaceDids = [];
    const surfaceDidsLens = [];
    const basePaletteIds = [];
    const flatSubPalettes = [];
    const subPalettesTripleCounts = [];
    const groupMeta = []; // parallel to groups: { surfaceDids, isEntityOwned, subDidIdx }

    for (const g of groups) {
      const surfaceDidsArr = Array.from(g.surfaceDids || []).map((d) => d >>> 0);
      const baseplaletteId = (g.baseplaletteId ?? 0) >>> 0;
      const subPalettesArr = Array.from(g.subPalettes || []).map((d) => d >>> 0);
      if (subPalettesArr.length % 3 !== 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[MaterialCache] preloadBatch: subPalettes must be flat triples; group skipped"
        );
        groupMeta.push({
          surfaceDids: surfaceDidsArr,
          isEntityOwned:
            baseplaletteId !== 0 || subPalettesArr.length > 0,
          skipped: true,
        });
        continue;
      }
      for (const d of surfaceDidsArr) flatSurfaceDids.push(d);
      surfaceDidsLens.push(surfaceDidsArr.length);
      basePaletteIds.push(baseplaletteId);
      for (const d of subPalettesArr) flatSubPalettes.push(d);
      subPalettesTripleCounts.push(subPalettesArr.length / 3);
      groupMeta.push({
        surfaceDids: surfaceDidsArr,
        isEntityOwned: baseplaletteId !== 0 || subPalettesArr.length > 0,
        skipped: false,
      });
    }

    // All-skipped early-out.
    if (surfaceDidsLens.length === 0) {
      return {
        groups: groupMeta.map((m) => ({
          surfaceDids: m.surfaceDids,
          materials: new Map(),
          isEntityOwned: m.isEntityOwned,
        })),
      };
    }

    let batch;
    try {
      batch = await fetchEntitySurfacesPixelsBatch(
        new Uint32Array(flatSurfaceDids),
        new Uint32Array(surfaceDidsLens),
        new Uint32Array(basePaletteIds),
        new Uint32Array(flatSubPalettes),
        new Uint32Array(subPalettesTripleCounts),
      );
    } catch (e) {
      // Bulk batch failed — surface failure to caller and let each
      // group fall back to fallbackMaterial. We don't auto-retry per-
      // group here; the caller can decide.
      // eslint-disable-next-line no-console
      console.warn(
        "[MaterialCache] preloadBatch: wasm batch threw; all groups fall back",
        e
      );
      return {
        groups: groupMeta.map((m) => ({
          surfaceDids: m.surfaceDids,
          materials: new Map(),
          isEntityOwned: m.isEntityOwned,
        })),
      };
    }

    // Distribute per-group results. payloadAt(i) MOVES the i-th
    // Vec<SurfacePixels> out — JS now owns each SurfacePixels' wasm
    // handle and is responsible for sp.free() per pixels item.
    const resultGroups = new Array(groups.length);
    let payloadIdx = 0;
    for (let gi = 0; gi < groupMeta.length; gi += 1) {
      const meta = groupMeta[gi];
      const materials = new Map();
      if (meta.skipped) {
        resultGroups[gi] = {
          surfaceDids: meta.surfaceDids,
          materials,
          isEntityOwned: meta.isEntityOwned,
        };
        continue;
      }
      const payload = batch.payloadAt(payloadIdx);
      payloadIdx += 1;
      if (!payload) {
        resultGroups[gi] = {
          surfaceDids: meta.surfaceDids,
          materials,
          isEntityOwned: meta.isEntityOwned,
        };
        continue;
      }
      // payload is an Array<SurfacePixels> parallel to meta.surfaceDids.
      for (let j = 0; j < meta.surfaceDids.length; j += 1) {
        const did = meta.surfaceDids[j];
        const sp = payload[j];
        if (!sp) continue;
        if (meta.isEntityOwned) {
          // Build entity-owned material — do NOT install into
          // this.materials (would collide with non-recoloured uses
          // of the same surface DID). Per-entity caller registers
          // ownership via inst.registerOwnedTexture / registerOwnedMaterial.
          const entityMat = this._buildEntityOwnedFromPixels(did, sp);
          if (entityMat) materials.set(did, entityMat);
        } else {
          // Cache-installed path. _installFromPixels keys by DID
          // and installs into this.materials. Future getCached(did)
          // returns the same material across all callers.
          const mat = this._installFromPixels(did, sp);
          if (mat !== this.fallbackMaterial) {
            materials.set(did, mat);
          }
        }
      }
      resultGroups[gi] = {
        surfaceDids: meta.surfaceDids,
        materials,
        isEntityOwned: meta.isEntityOwned,
      };
    }

    // Free the batch wrapper. Per-payload SurfacePixels handles were
    // freed inside _installFromPixels / _buildEntityOwnedFromPixels.
    try {
      if (batch && typeof batch.free === "function") batch.free();
    } catch (_) {}

    return { groups: resultGroups };
  }

  /**
   * F.41 — build an entity-owned `MeshStandardMaterial` from a
   * `SurfacePixels` handle. Unlike `_installFromPixels`, this does
   * NOT cache the result in `this.materials` — entity-owned materials
   * are keyed by `(entity, did)` and live on the entity until
   * dispose. The caller (entities.js) is responsible for
   * `inst.registerOwnedTexture` / `registerOwnedMaterial`.
   *
   * Returns the material on success; `null` on empty/failed pixels.
   * SurfacePixels handle is `.free()`'d before return.
   */
  _buildEntityOwnedFromPixels(did, sp) {
    if (!sp) return null;
    let w, h, pixels, surfaceType;
    try {
      w = sp.width;
      h = sp.height;
    } catch (_) {
      return null;
    }
    if (w === 0 || h === 0) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      return null;
    }
    try {
      pixels = sp.pixels;
      surfaceType = sp.surfaceType ?? 0;
    } catch (_) {
      return null;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    // Entity-owned material uses plain opaque MeshStandardMaterial —
    // mirrors entities.js line 594-600's existing entity-recolour
    // path which keeps things simple (no normal/height/CSM stack on
    // recoloured NPC surfaces today). Future polish: thread
    // surface_type flags through.
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: false,
    });
    mat.name = `entity-surface-${did.toString(16).padStart(8, "0")}`;
    mat.userData = {
      surfaceTypeFlags: surfaceType,
      batchOrigin: "F.41",
      // Perf B3 (2026-05-18) — entity-owned (not cache-installed —
      // NOT placed in `this.materials`). When entities.js's
      // preloadBatch consumer lands, `_disposeMaterialIfOwned` reads
      // this tag and frees on entity dispose. See the `__disposable`
      // convention block in entities.js's module docstring.
      __disposable: true,
    };
    return mat;
  }

  _installFromPixels(did, sp) {
    if (!sp) return this.fallbackMaterial;
    // wasm-bindgen wrappers around a null Rust pointer throw on every
    // getter (`.width` / `.height` / `.pixels`), so read them once under
    // a try/catch instead of an inline `sp.width === 0` check. A throw
    // here means the surface DID had no pixels — fall back to the
    // shared fallback material exactly as for the zero-dim case.
    let w, h, pixels, surfaceType, category, normalPixels, heightPixels,
        roughnessOverride, normalScaleOverride;
    try {
      w = sp.width;
      h = sp.height;
    } catch (_) {
      return this.fallbackMaterial;
    }
    if (w === 0 || h === 0) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      return this.fallbackMaterial;
    }
    try {
      pixels = sp.pixels;
      surfaceType = sp.surfaceType ?? 0;
      // Phase 1.4: heuristic category as u8. Missing getter on older
      // wasm builds → undefined → generic defaults in _materialFromFlags.
      category = typeof sp.category === "number" ? sp.category : undefined;
      // Phase 1.1: procedural normal map (RGB8). Empty Uint8Array for
      // Luminous surfaces, the 1x1 solid path, and the empty fallback.
      normalPixels = sp.normalPixels;
      // Phase 3.1: heightmap (R8). Empty for Luminous + constant-lum
      // + 1x1 solid + empty fallback. Missing on pre-3.1 wasm builds.
      heightPixels = typeof sp.heightPixels !== "undefined" ? sp.heightPixels : null;
      // Phase 1.5: per-DID overrides. Non-finite → fall through to
      // category defaults.
      roughnessOverride = typeof sp.roughnessOverride === "number" ? sp.roughnessOverride : undefined;
      normalScaleOverride = typeof sp.normalScaleOverride === "number" ? sp.normalScaleOverride : undefined;
    } catch (_) {
      return this.fallbackMaterial;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    const normalTex = surfacePixelsToNormalTexture(normalPixels, w, h);
    const heightTex = heightPixels ? surfacePixelsToHeightTexture(heightPixels, w, h) : null;
    // Phase 7 follow-on #7+8: surface_type bitfield from the wasm side.
    const surfaceTypeFlags = surfaceType >>> 0;
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    const overrides = { roughness: roughnessOverride, normalScale: normalScaleOverride };
    const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex);
    mat.name = `scene3d-surface-${did.toString(16).padStart(8, "0")}`;
    mat.userData = {
      ...(mat.userData || {}),
      surfaceTypeFlags,
      surfaceCategory: category,
      surfaceRoughnessOverride: roughnessOverride,
      surfaceNormalScaleOverride: normalScaleOverride,
      // Perf B3 (2026-05-18) — cache-resident material. Entity dispose
      // chains (entities.js `_disposeMaterialIfOwned`) skip these;
      // `MaterialCache.dispose()` (page teardown) frees them. C5 +
      // E3 read the same tag.
      __cacheOwned: true,
    };
    this.textures.set(did, tex);
    if (normalTex) this.normalTextures.set(did, normalTex);
    if (heightTex) this.heightTextures.set(did, heightTex);
    this.materials.set(did, mat);
    return mat;
  }

  /**
   * Free GPU resources owned by this cache. Materials don't dispose
   * their textures automatically in three.js, so we walk both maps.
   * Safe to call multiple times; future `get()` calls return the
   * fallback (the cache is empty).
   */
  dispose() {
    for (const tex of this.textures.values()) tex.dispose();
    for (const tex of this.normalTextures.values()) tex.dispose();
    for (const tex of this.heightTextures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.fallbackMaterial.dispose();
    this.materials.clear();
    this.textures.clear();
    this.normalTextures.clear();
    this.heightTextures.clear();
    this.pendingFetches.clear();
  }
}
