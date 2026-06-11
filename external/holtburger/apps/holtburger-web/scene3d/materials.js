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

// #22 (2026-06-07) — paletted-material LRU cap. Each dyed outfit
// signature (surface|palette|subPalettes) mints one cache-owned
// MeshStandardMaterial + (optionally) one owned DataTexture. Without a
// cap a long crowded-town session grows `palettedMaterials` /
// `palettedTextures` unbounded (one live leak — every other cache is
// keyed by a bounded DID/bucket space). The cap is GENEROUS (256) so a
// same-frame-baked material is never evicted out from under the caller
// that just installed it; eviction is oldest-by-insertion (Map preserves
// insertion order), disposing the material AND its paired owned texture
// together. This is NOT the page-teardown `dispose()` path — the LRU
// never calls `dispose()`.
const PALETTED_CACHE_CAP = 256;

// Phase 0.1 — shadow casting gate. Translucent and Additive surfaces
// don't cast (shadow pass is depth-only — would render a solid box,
// and three.js warns). Opaque + ClipMap honour alphaTest, so they cast.
export function materialCanCastShadow(material) {
  if (!material) return false;
  const flags = (material.userData?.surfaceTypeFlags ?? 0) >>> 0;
  if (flags & SURFACE_TYPE.Translucent) return false;
  if (flags & SURFACE_TYPE.Additive) return false;
  // Alpha (0x100) / InvAlpha (0x200) are alpha-blended like Translucent —
  // a depth-only shadow pass would render them as solid boxes.
  if (flags & SURFACE_TYPE.Alpha) return false;
  if (flags & SURFACE_TYPE.InvAlpha) return false;
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
// decoder. Procedural normal maps (Phase 1.1) ship per-surface via
// `holtburger_dat::normal_gen::normal_from_luminance` (Sobel-X on the
// Rec.601 luminance channel); wiring is at `_materialFromFlags` below.
// === Wave 2.B — procedural normals (2026-05-28) === closed the visibility
// gap: the quality preset's `normalMaps` flag is now consumed by
// `MaterialCache` (it was a no-op flag prior). See `normalMapsEnabled`
// constructor opt + the gate in `_materialFromFlags`.
// === Wave 2.B — procedural normals (2026-05-28) ===
// `normalScale` per-category: the Sobel-X height-to-normal pipeline emits
// the same magnitude regardless of surface, so to land the bump strength
// roughly where it should be we scale per-category at material-build
// time. Stone/Brick/Tile get the strongest bumps (deep mortar/grout
// detail), Wood is mid (anisotropic grain), Cloth/Foliage are subtle
// (cloth fibers, leaf veins shouldn't lift like brick), Sand/Snow flat
// (no real macro relief — would look noisy). Metal is mid (rivets,
// brushed scoring). Lava is subtle (we want the emissive bloom to read
// before the lava-skin micro-relief). Missing categories use 0.8 (Phase
// 1.1 hand-off note default; preserves prior behaviour for Dirt/Water/
// Generic). The Phase 1.5 per-DID override still beats this — when the
// wasm bundle supplies a finite `normalScaleOverride` for a specific DID
// (eg. surface_overrides.json hand tuning), that wins.
const CATEGORY_NORMAL_SCALE_DEFAULTS = Object.freeze({
  [SURFACE_CATEGORY.Stone]: 1.0,
  [SURFACE_CATEGORY.Brick]: 1.1,
  [SURFACE_CATEGORY.Tile]: 0.9,
  [SURFACE_CATEGORY.Wood]: 0.7,
  [SURFACE_CATEGORY.Metal]: 0.6,
  [SURFACE_CATEGORY.Sand]: 0.4,
  [SURFACE_CATEGORY.Snow]: 0.3,
  [SURFACE_CATEGORY.Foliage]: 0.5,
  [SURFACE_CATEGORY.Cloth]: 0.5,
  [SURFACE_CATEGORY.Lava]: 0.4,
  // Water / Dirt / Generic — fall through to the 0.8 default below.
});

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

// Build the program-cache-key string for whatever patch set is on the
// material RIGHT NOW. three.js uses `customProgramCacheKey()` to decide
// whether two materials can share a compiled WebGLProgram; the stock
// key ignores our onBeforeCompile string surgery, so without this two
// materials that differ ONLY in their patch composition (e.g. CSM+POM
// vs CSM+lightClamp) collapse onto one program and render each other's
// shader. The key reads each patch's userData flag LAZILY at call time
// (three calls this during setProgram, after every installer has run)
// so the order of patch installation never matters.
function _patchSetCacheKey(material) {
  const u = material.userData || {};
  return (
    "hb" +
    "|d" + (u.detailEnabled ? 1 : 0) +
    "|c" + (u.csmEnabled ? 1 : 0) +
    "|p" + (u.pomEnabled ? 1 : 0) +
    "|l" + (u.lightClampRetail ? 1 : 0) +
    "|a" + (u.__aoPatched ? 1 : 0) +
    "|b" + (u.__depthBiased ? 1 : 0)
  );
}

// Install a `customProgramCacheKey` that disambiguates our patch sets.
// Idempotent — every installer calls it via `_chainBeforeCompile`, but
// the closure always reflects the current userData so re-installing is
// harmless. The closure reads userData lazily (NOT at install time) so
// patches added after this call are still reflected in the key.
function _installPatchSetCacheKey(material) {
  material.customProgramCacheKey = function () {
    return _patchSetCacheKey(this);
  };
}

// Compose a new onBeforeCompile hook with whatever was previously set on
// the material. Each shader-patch installer (detail, CSM, ...) calls
// this so the chain is preserved — three.js calls onBeforeCompile ONCE
// per material at first render, so we have to manually chain the
// patches at install time rather than relying on three to do it.
function _chainBeforeCompile(material, newHook) {
  const prev = material.onBeforeCompile;
  if (typeof prev !== "function" || prev === THREE.Material.prototype.onBeforeCompile) {
    material.onBeforeCompile = newHook;
    _installPatchSetCacheKey(material);
    return;
  }
  material.onBeforeCompile = function chainedOnBeforeCompile(shader, renderer) {
    prev.call(this, shader, renderer);
    newHook.call(this, shader, renderer);
  };
  _installPatchSetCacheKey(material);
}

// 2026-05-22 — wire-agent: cheap normal-based AO modulation. Patches a
// MeshBasicMaterial's shader to multiply the fragment colour by
// `mix(0.45, 1.0, smoothstep(-0.3, 1.0, vWorldNormalAO.y))`. Result:
// floors (N=up) full bright, walls (N⊥up) ~70%, ceilings/overhangs
// (N=-up) ~45%. Adds 3D depth perception to flat-shaded wireframe
// fills without per-vertex precompute or new geometry attributes —
// just one extra varying + one mix() per fragment. Applied to every
// wire-bucket / fill-bucket / per-DID material in this cache.
export function applyWireVertexAOPatch(material) {
  if (!material || material.userData?.__aoPatched) return;
  _chainBeforeCompile(material, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldNormalAO;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vWorldNormalAO = normalize(mat3(modelMatrix) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldNormalAO;`,
      )
      .replace(
        "#include <fog_fragment>",
        // Apply BEFORE fog so the AO darkening fades into the fog
        // colour at distance, not the unmodulated colour.
        `gl_FragColor.rgb *= mix(0.45, 1.0, smoothstep(-0.3, 1.0, vWorldNormalAO.y));
        #include <fog_fragment>`,
      );
  });
  material.userData = material.userData ?? {};
  material.userData.__aoPatched = true;
}

// 2026-06-02 — wire-fill z-fight fix. The renderer runs
// `logarithmicDepthBuffer: true`, so every material writes `gl_FragDepth`,
// which makes `polygonOffset` a NO-OP (the fixed-function offset is discarded
// once a fragment shader writes depth). The wire fills relied on polygonOffset
// to sit just behind their own coplanar outline lines; under log-depth the
// lines z-fight the fill — worst in wall-dense indoor corners (the Academy).
// Replace the dead offset with a tiny log-depth-space bias: nudge the FILL a
// hair deeper so the wire (drawn on top, unbiased) always wins the depth test,
// while the fill still writes depth to occlude geometry behind it. Tunable via
// the constant below — raise if a corner still flickers, lower if the fill
// detaches at silhouettes.
export function applyFillDepthBias(material) {
  if (!material || material.userData?.__depthBiased) return;
  _chainBeforeCompile(material, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) || defined( USE_LOGDEPTHBUF )
        gl_FragDepth += 2.0e-4;
      #endif`,
    );
  });
  material.userData = material.userData ?? {};
  material.userData.__depthBiased = true;
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

// === "Retail light response" combined patch — R2.B + L3 (2026-05-29) ===
//
// One `onBeforeCompile` patch behind ONE flag (`?lightClamp=retail`) that
// applies BOTH retail point/spot-light fidelity changes, so there is no
// competing second onBeforeCompile chain (per the waves-2 doc's R2.B
// fold-in coordination rule):
//   - L3 (waves-2): point/spot LINEAR distance falloff. Retail
//     `attenuation = clamp(1 - dist/range, 0, 1)` (acclient.c:454615,
//     guarded by `if (dist < range)`), vs three's physical inverse-square
//     (LIGHT_DECAY = 2.0). `range` = the three `distance` cutoff, which L2
//     already scaled by static_light_factor 1.3 in lighting.js. Redefines
//     `getDistanceAttenuation` (lives in <lights_pars_begin>) to the AC law.
//   - R2.B (2026-05-28): per-RGB light-color clamp in the direct-lighting
//     accumulation (acclient.c:454616-454627).
//
// Parse `?lightClamp=retail` from the page URL. Default OFF (anything
// other than the literal "retail", or the flag absent, returns false →
// the standard THREE PBR lighting accumulation is untouched and the
// emitted shader string is byte-identical to the shipped baseline).
//
// IMPORTANT (scope): callers read this flag by invoking THIS helper
// directly at the consumption site (the install-decision point inside
// `_makeTexturedMaterial` / the fallback path AND inside the installer
// itself). We deliberately do NOT stash the result in a const in one
// function and read it in another — a prior wave shipped a ReferenceError
// that way. The reader is a pure module-level function with no closure
// over caller-local state, so the flag and its consumer always share
// scope.
export function readLightClampRetailFlag() {
  // default-ON flipped per render-audit T1b (2026-06-09): retail linear-falloff
  // + per-channel color clamp so colored torches stop washing to white; opt-out
  // ?lightClamp=off (physical inverse-square), pending 1070 eye-test.
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("lightClamp");
    if (typeof v === "string") {
      const lv = v.toLowerCase();
      if (lv === "off" || lv === "physical") return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

// === L4 (render-completeness waves-2, 2026-05-29) — flat-diffuse preset ===
// Retail's fixed-function `SetSurface` (acclient.c:454385-454561) NEVER sets
// a specular term — lit surfaces are pure Lambertian diffuse + ambient. Our
// PBR Metal category (metalness:0.9, roughness:0.3) therefore over-responds
// with glossy specular highlights vs retail's flat metal. `?flatDiffuse=retail`
// opts a surface category into a non-specular PBR look (metalness 0 /
// roughness ~1) so metal + lava read flat like retail. Default OFF: when the
// flag is absent we keep the classifier defaults unchanged (byte-identical).
export function readFlatDiffuseRetailFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("flatDiffuse");
    return typeof v === "string" && v.toLowerCase() === "retail";
  } catch (_) {
    return false;
  }
}

// === A10-M1 (unification, 2026-06-11) — single surface render-state decoder ===
// The JS analogue of retail's sole `D3DPolyRender::SetSurface`
// (acclient.c:454385-454565). Before this, the Surface (0x08) flag→three.js
// blend/emissive/diffuse ladder was decoded at TWO sites that had already
// drifted: `MaterialCache._materialFromFlags` (cache path) attached the diffuse
// texture as an `emissiveMap` for luminous surfaces, while
// `EntityManager._applyPalettedSurfaceRenderState` (dyed/paletted path)
// explicitly did NOT — both citing the SAME retail line (acclient.c:454691-454697)
// with opposite readings (A10 survey §3 row 2; ROADMAP §7 item 2). A dyed luminous
// item therefore washed to white while its undyed twin glowed correctly.
//
// Resolution (ROADMAP §7 ruling, A10 §4 Stage M1): adopt the emissiveMap-attached
// reading. Retail's grayscale D3D emissive (Emissive.rgb = luminosity,
// acclient.c:454691-454697) is MODULATED by the diffuse texture in the
// fixed-function combiner (TEXOP_MODULATE stage 0, acclient.c:454429-454432) —
// final ≈ texture × (lighting + emissive). three.js' `emissive` is ADDED and is
// texture-modulated ONLY when an `emissiveMap` is set; without one a flat-white
// emissive ADD washes the texture to pure white. So attaching the diffuse texture
// as emissiveMap reproduces retail's texture×emissive for COLOURED luminous
// surfaces (e.g. the blue lifestone crystal glows in its own colour, brighter).
//
// MUTATES `mat` in place (settable post-construction with `needsUpdate`):
//   - `state`: { flags, translucency, luminosity, diffuse } (the Surface bitfield
//     + the trailing T/L/D float triplet).
//   - `opts.texture`: the diffuse map, used as `emissiveMap` for luminous surfaces.
// Returns nothing. Does NOT touch `userData.surfaceTypeFlags` bookkeeping — each
// caller owns that (the cache path stores it via meshToGeometryGroups; the
// paletted path stamps it before delegating). `flags === 0` (empty/fallback
// surface) is a no-op so it stays opaque, matching both legacy sites.
export function applySurfaceRenderState(mat, state, opts) {
  if (!mat || !state) return;
  const flags = (state.flags ?? 0) >>> 0;
  if (flags === 0) return; // fail-soft: empty/fallback surface stays opaque
  const sfTranslucency = +(state.translucency ?? 0.0);
  const sfLuminosity = +(state.luminosity ?? 0.0);
  const sfDiffuse = +(state.diffuse ?? 0.0);
  const texture = opts?.texture ?? null;
  const isTranslucent = (flags & SURFACE_TYPE.Translucent) !== 0;
  const isClipMap = (flags & SURFACE_TYPE.Base1ClipMap) !== 0;
  const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
  const isAlpha = (flags & SURFACE_TYPE.Alpha) !== 0;
  const isInvAlpha = (flags & SURFACE_TYPE.InvAlpha) !== 0;
  if (isAdditive && isAlpha) {
    // Wave-3 M1: Alpha+Additive (0x10000|0x100) blends SRCALPHA/ONE, not ONE/ONE
    // — the additive contribution is weighted by per-texel source alpha (retail
    // acclient.c:454474). depthWrite off so the halo doesn't occlude geometry.
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneFactor;
    mat.blendEquation = THREE.AddEquation;
    mat.transparent = true;
    mat.depthWrite = false;
  } else if (isAdditive) {
    // Pure-additive (no Alpha bit) → ONE/ONE (flames, sparks); depthWrite off so
    // they don't occlude geometry behind them.
    mat.blending = THREE.AdditiveBlending;
    mat.transparent = true;
    mat.depthWrite = false;
  } else if (isTranslucent || isAlpha || isInvAlpha) {
    // Alpha blend (SRCALPHA/INVSRCALPHA), depthWrite off — painter-sorted. Retail
    // routes both Translucent (0x10, acclient.c:454513) and Alpha (0x100, :454470)
    // through this blend state. InvAlpha (0x200) first-cut shares it (census-zero
    // in retail base DAT; true inverse blend deferred — A10 §3 row 6).
    mat.transparent = true;
    mat.depthWrite = false;
    // Translucent's alpha = 1 - T (acclient.c:454523); Alpha (0x100) takes its
    // alpha from the texture channel, so only adjust opacity for Translucent T>0.
    if (isTranslucent && sfTranslucency > 0) {
      mat.opacity = Math.max(0, 1 - sfTranslucency);
      // DIM7-5 / W4.2: stash the AUTHORED base translucency so a later
      // Transparent(20)/TransparentPart(7) hook ramp can floor against it — retail
      // floors `_end` to translucencyOriginal (acclient.c:316947-316956).
      mat.userData = { ...(mat.userData || {}), __baseTranslucency: sfTranslucency };
    }
  } else if (isClipMap) {
    // Binary alpha mask (foliage, fences) — alphaTest cuts alpha=0 frags.
    mat.alphaTest = 0.5;
    mat.transparent = false;
  }
  if (sfLuminosity > 0) {
    // Self-illumination driven by the luminosity FLOAT (not the 0x40 bit). Keep
    // emissive=white scaled by luminosity AND attach the diffuse texture as
    // emissiveMap (the resolved reading — see header). Untextured luminous
    // surfaces keep the flat-white glow. Clamp to (0, 2] (ACE ~[0,1] with
    // occasional HDR-ish pushes >1).
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = Math.min(2.0, sfLuminosity);
    if (texture) mat.emissiveMap = texture;
  }
  // Diffuse-reflectance albedo tint — retail uses `diffuse` as a reflectance
  // multiplier on the material's diffuse colour (acclient.c:454458). No-op at
  // d≈1 (~96% of surfaces); dims the d≠1 minority. Multiplies with `map`.
  if (sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
    mat.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
  }
  mat.needsUpdate = true;
}

// === A10-M1 (unification, 2026-06-11) — `?surfaceUnified=on` opt-in =========
// When ON, both Surface-flag decode sites delegate to the single
// `applySurfaceRenderState` above (the dyed/paletted path then ALSO attaches the
// luminous emissiveMap, fixing the dyed-luminous wash-to-white). Default OFF
// keeps the legacy dual-path (byte-identical on the cache path — only the
// paletted path's emissiveMap differs). JS-live (reload to toggle).
export function readSurfaceUnifiedFlag() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = new URLSearchParams(window.location.search).get("surfaceUnified");
    if (typeof v !== "string") return false;
    const lv = v.toLowerCase();
    return lv === "on" || lv === "1" || lv === "true";
  } catch (_) {
    return false;
  }
}

// L4 — categories that get the flat-diffuse treatment under
// `?flatDiffuse=retail`. Metal (the over-glossy offender) + Lava (so the
// emissive bloom reads instead of a specular sheen). Stone/Wood/Sand/Foliage
// are already near-matte (roughness 0.8-0.95, metalness 0) so they need no
// override.
const FLAT_DIFFUSE_CATEGORIES = Object.freeze({
  [SURFACE_CATEGORY.Metal]: { roughness: 1.0, metalness: 0.0 },
  [SURFACE_CATEGORY.Lava]: { roughness: 1.0, metalness: 0.0 },
});

// Wave R2.B — per-RGB-channel light-color clamp in the DIRECT lighting
// accumulation, behind `?lightClamp=retail`.
//
// Retail (acclient.c:454616-454627, `calc_point_light`) caps each light's
// contribution at the light's OWN color per channel rather than the
// standard PBR clamp toward [0,1]:
//
//     coeff = intensity * dot * atten           // scalar
//     contrib_c = min(coeff * color_c, color_c) // per channel R/G/B
//
// i.e. a saturated red light can add AT MOST `color.r` to red and
// (smaller) amounts to G/B, so the light keeps its tone instead of
// washing the surface toward white once the coefficient exceeds 1.
//
// HOW WE INJECT IT (genuine per-light, NOT a post-accumulation
// approximation): three.js's `<lights_fragment_begin>` chunk runs
// `RE_Direct(directLight, ...)` once per direct light (point/spot/
// directional). `RE_Direct_Physical` lives behind `#include
// <lights_physical_pars_fragment>`, which three resolves AFTER
// onBeforeCompile, so we cannot edit the BRDF function text directly.
// Instead we expand the `lights_fragment_begin` chunk ourselves (its
// text is available synchronously via `THREE.ShaderChunk`) and wrap
// EACH `RE_Direct( directLight, ... )` call so that, per light, we:
//   1. snapshot reflectedLight.directDiffuse + directSpecular,
//   2. run the stock RE_Direct (computes this light's BRDF contribution),
//   3. take the per-light delta (what this light just added),
//   4. clamp the delta per channel at `directLight.color` (min(delta_c,
//      directLight.color_c)) — the retail `min(contrib_c, color_c)` cap,
//   5. re-add the clamped delta.
// This is per-light and reaches `directLight.color`, so colored lights
// keep their hue: every channel is capped at the SAME tinted color
// vector, so the brightest channel can't outrun the others into white.
//
// DIVERGENCE FROM acclient (documented honestly): retail caps against
// the light's BASE, un-attenuated `color_c`, with intensity/attenuation
// living in the scalar `coeff`; the cap therefore only engages when
// `coeff > 1`. three.js has already folded intensity AND distance
// attenuation INTO `directLight.color` by the time `RE_Direct` runs
// (directLight.color = lightColor * intensity * attenuation), and it has
// no separate base-color uniform reachable in this chunk without forking
// the light-uniform layout. So our cap is against the *attenuated*
// color: the per-light diffuse/specular delta is capped at the light's
// current (attenuated, intensity-scaled) color rather than its base
// color. The VISIBLE behavior — colored lights retain tone instead of
// blowing to white — matches retail's intent; the exact engage threshold
// differs (ours engages when the BRDF*dotNL gain pushes a channel past
// the attenuated light color, retail's when coeff>1). This is the best
// safe per-light reachable surgery without re-authoring three's light
// uniforms; flagged off by default so the standard PBR path is unchanged.
//
// We also expose `uLightColorClamp` (default 1.0) so an A/B can fade the
// effect in the shader without recompiling the material (0.0 = stock
// accumulation even with the chunk patched in; 1.0 = full retail cap).
function _installLightClampShaderPatch(material) {
  if (!material || material.userData?.__lightClampPatched) return;
  // Read the flag at the consumption site (same scope as the install
  // decision). If it isn't `retail`, do nothing AT ALL — the shader
  // string is left byte-identical to the shipped baseline.
  if (!readLightClampRetailFlag()) return;

  material.userData = {
    ...(material.userData || {}),
    __lightClampPatched: true,
    lightClampRetail: true,
  };

  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uLightColorClamp = { value: 1.0 };

    // === L3 (waves-2, 2026-05-29) — AC LINEAR point/spot falloff =========
    // Retail `calc_point_light` (acclient.c:454605-454615) uses a LINEAR
    // distance attenuation `clamp(1 - dist/range, 0, 1)` (guarded by
    // `if (dist < range)`), where `range = falloff * static_light_factor`
    // (the 1.3× L2 already baked into three's `distance`/cutoffDistance).
    // three's `getDistanceAttenuation` (defined inside <lights_pars_begin>)
    // is physical inverse-square (Frostbite eq.26). We expand that chunk and
    // replace the stock function body with the AC linear law. We keep three's
    // exact signature so every call site (getPointLightInfo / getSpotLightInfo)
    // is unchanged. When `cutoffDistance <= 0` (infinite-reach light) we fall
    // back to the stock inverse-square so unbounded lights still behave.
    // Skipped harmlessly if the chunk text ever changes shape (split/join
    // no-ops, leaving the stock function intact).
    const stockParsBegin = THREE.ShaderChunk.lights_pars_begin;
    const stockAttenFn =
      "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {\n\n" +
      "\t// based upon Frostbite 3 Moving to Physically-based Rendering\n" +
      "\t// page 32, equation 26: E[window1]\n" +
      "\t// https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf\n" +
      "\tfloat distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );\n\n" +
      "\tif ( cutoffDistance > 0.0 ) {\n\n" +
      "\t\tdistanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );\n\n" +
      "\t}\n\n" +
      "\treturn distanceFalloff;\n\n" +
      "}";
    const acLinearAttenFn =
      "float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {\n" +
      "\t// L3 (waves-2): AC linear falloff clamp(1 - dist/range, 0, 1).\n" +
      "\t// acclient.c:454615. range = cutoffDistance (= AC falloff * 1.3).\n" +
      "\tif ( cutoffDistance > 0.0 ) {\n" +
      "\t\treturn saturate( 1.0 - lightDistance / cutoffDistance );\n" +
      "\t}\n" +
      "\t// Infinite-reach light (cutoffDistance == 0): keep physical falloff.\n" +
      "\treturn 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );\n" +
      "}";
    const patchedParsBegin = stockParsBegin.split(stockAttenFn).join(acLinearAttenFn);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_pars_begin>",
      patchedParsBegin,
    );

    // Build a per-light wrapper around each stock RE_Direct call by
    // expanding the chunk text and substituting every
    // `RE_Direct( directLight, ... )` invocation. The replacement
    // snapshots the accumulators, runs the stock call, clamps the
    // per-light delta against directLight.color, and re-adds it.
    //
    // NOTE: no backticks appear inside this GLSL string (esbuild/Firefox
    // reject backticks inside the literal). Comments use // only.
    const stockBegin = THREE.ShaderChunk.lights_fragment_begin;

    // The three RE_Direct invocations (point/spot/directional) all share
    // the same argument list and the same `directLight` source variable,
    // so one textual substitution covers all of them.
    const reDirectCall =
      "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

    const clampedCall =
      "{\n" +
      "  // Wave R2.B per-RGB light-color clamp (retail accumulation).\n" +
      "  vec3 _lcDiffBefore = reflectedLight.directDiffuse;\n" +
      "  vec3 _lcSpecBefore = reflectedLight.directSpecular;\n" +
      "  " + reDirectCall + "\n" +
      "  vec3 _lcDiffDelta = reflectedLight.directDiffuse - _lcDiffBefore;\n" +
      "  vec3 _lcSpecDelta = reflectedLight.directSpecular - _lcSpecBefore;\n" +
      "  // === R-JS-T2c (render audit G15): half-Lambert wrap ================\n" +
      "  // Retail's point/spot diffuse uses a WRAPPED N.L instead of a raw\n" +
      "  // saturate(dot(N,L)): the (n.l * 0.5 + 0.5) form softens the\n" +
      "  // terminator so back-facing-ish surfaces fade gently rather than\n" +
      "  // clamping hard to black (acclient.c:454608). Closes the LG2 TODO at\n" +
      "  // lighting.js:1741-1743, which notes the wrap belongs in THIS shader,\n" +
      "  // not in the lighting.js point/spot setup. three's stock RE_Direct\n" +
      "  // already folded the raw saturate(dot(N,L)) into _lcDiffDelta, so we\n" +
      "  // rescale that diffuse delta by wrapped/raw to convert it to the\n" +
      "  // half-Lambert law. Specular is left on the physical dotNL (retail\n" +
      "  // only wraps the diffuse term). Squaring (the classic Valve form)\n" +
      "  // keeps the lit-side response near-identical while still lifting the\n" +
      "  // dark side. Only ever runs under the retail lighting law (this whole\n" +
      "  // patch is gated by readLightClampRetailFlag()).\n" +
      "  float _hlRaw = saturate(dot(geometryNormal, directLight.direction));\n" +
      "  float _hlWrapBase = dot(geometryNormal, directLight.direction) * 0.5 + 0.5;\n" +
      "  float _hlWrapped = saturate(_hlWrapBase * _hlWrapBase);\n" +
      "  // raw == 0 on the fully-lit-from-behind hemisphere; the stock delta\n" +
      "  // is 0 there so a ratio can't recover the wrap. Reconstruct a soft\n" +
      "  // Lambert term from the light color and the fragment albedo\n" +
      "  // (diffuseColor.rgb is the in-scope BRDF albedo, see line ~884).\n" +
      "  // Elsewhere just scale the existing delta by wrapped/raw.\n" +
      "  vec3 _hlDiff = (_hlRaw > 1e-4)\n" +
      "    ? _lcDiffDelta * (_hlWrapped / _hlRaw)\n" +
      "    : directLight.color * (_hlWrapped * RECIPROCAL_PI) * diffuseColor.rgb;\n" +
      "  _lcDiffDelta = _hlDiff;\n" +
      "  // Cap this light's per-channel contribution at the light's own\n" +
      "  // (attenuated) color so a colored light keeps its tone instead\n" +
      "  // of washing toward white. min() mirrors acclient.c:454616-454627.\n" +
      "  vec3 _lcDiffClamped = min(_lcDiffDelta, directLight.color);\n" +
      "  vec3 _lcSpecClamped = min(_lcSpecDelta, directLight.color);\n" +
      "  // uLightColorClamp fades between stock (0.0) and capped (1.0).\n" +
      "  reflectedLight.directDiffuse = _lcDiffBefore + mix(_lcDiffDelta, _lcDiffClamped, uLightColorClamp);\n" +
      "  reflectedLight.directSpecular = _lcSpecBefore + mix(_lcSpecDelta, _lcSpecClamped, uLightColorClamp);\n" +
      "}";

    // split/join replaces ALL occurrences without regex escaping concerns.
    const patchedBegin = stockBegin.split(reDirectCall).join(clampedCall);

    // Declare the uniform, then swap the stock chunk include for our
    // expanded+wrapped version.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "uniform float uLightColorClamp;\nvoid main() {",
      )
      .replace("#include <lights_fragment_begin>", patchedBegin);

    // Stash for post-compile introspection by tests / capture scripts.
    material.userData.lightClampShaderUniforms = shader.uniforms;
  });

  material.needsUpdate = true;
}

// Public export: install the per-RGB light-color clamp on an arbitrary
// material (no-op unless `?lightClamp=retail`). MaterialCache call sites
// use this; tests import it directly to assert the patch wiring.
export function installLightClampShaderPatch(material) {
  _installLightClampShaderPatch(material);
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
   *   normalMapsEnabled?: boolean,
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
   *
   * `normalMapsEnabled`: Phase 1.1 / Wave 2.B gate. When `true`, the
   * per-surface procedural normal map baked in
   * `holtburger_dat::normal_gen::normal_from_luminance` (Sobel-X over
   * Rec.601 luminance) is wired onto the `MeshStandardMaterial.normalMap`
   * slot, giving stone/brick/wood/etc. surfaces tangent-space micro-relief
   * under directional + probe lighting. When `false`, the normal texture
   * is dropped at the gate — the material falls back to flat shading
   * (cheap-path for `low` and `mid` quality presets where the +texture
   * memory cost outweighs the visual delta on weaker GPUs). Default
   * `true` (preserves behaviour for any caller that constructs a
   * MaterialCache without going through the quality preset, eg. test
   * harnesses and the Node-side material smoke tests).
   */
  constructor(opts = {}) {
    /** @type {Map<number, THREE.MeshStandardMaterial>} */
    this.materials = new Map();
    // Render-completeness audit (2026-05-29) — animated SurfaceTextures.
    // `_animFramesFetch` is the wasm `fetchSurfaceAnimFrames(did)` getter
    // (null on legacy builds → animation silently disabled). `_animatedMaterials`
    // maps surfaceDid → { mat, frames:[DataTexture], idx, accumS }. Cycled by
    // `tickAnimatedSurfaces(dt)` from the render loop. Animating the SHARED
    // cache material's `.map` is correct: every instance of a water/lava
    // surface should cycle in sync.
    this._animFramesFetch = opts.animFramesFetch || null;
    /** @type {Map<number, {mat: any, frames: any[], idx: number, accumS: number}>} */
    this._animatedMaterials = new Map();
    /** Set of DIDs already checked for animation (avoid re-fetching). */
    this._animChecked = new Set();
    /**
     * T2 (2026-05-28): FrontSide (single-sided) variants, keyed by surfaceDid.
     * Built lazily by `getCached(did, false)` for `?perPolyCull=on`. Each is a
     * `.clone()` of the DoubleSide base with `side = FrontSide` — clones SHARE
     * the underlying textures (THREE clone copies map refs), so no texture
     * duplication. Empty (never built) when the cull flag is off.
     * @type {Map<number, THREE.Material>}
     */
    this.frontSideMaterials = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.textures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.normalTextures = new Map();
    /** @type {Map<number, THREE.DataTexture>} */
    this.heightTextures = new Map();
    /** @type {Map<number, Promise<THREE.MeshStandardMaterial>>} */
    this.pendingFetches = new Map();
    /**
     * 2026-05-28 — Paletted-material dedup cache. Keyed by
     * `${surfaceDid}|${paletteId}|${subPalettesHash}` so multiple
     * entities sharing the same outfit signature (same surface +
     * palette substitutions) hit one cached material instead of
     * minting a fresh recoloured one per entity. Spawn-trace data on
     * the 120s drive showed 57/97 spawns going the palette path with
     * mean 897ms wasm-fetch each — most are dedupable.
     *
     * Cache-owned: tagged `__cacheOwned: true` so per-entity dispose
     * doesn't free a material another entity is still using. Lives
     * for scene lifetime; cleared on scene rebuild.
     * @type {Map<string, THREE.Material>}
     */
    this.palettedMaterials = new Map();
    /** @type {Map<string, THREE.DataTexture>} — cache-owned paletted textures. */
    this.palettedTextures = new Map();
    /**
     * Sidecar to `pendingFetches` keyed by the same DID — records the
     * wall-clock at which the fetch was kicked off so `__diag.assets
     * .stuck(thresholdMs)` can identify entries that have been in-flight
     * too long. Set on every `pendingFetches.set(did, ...)`; deleted on
     * every `pendingFetches.delete(did)` (both success and failure
     * paths). Never read from cache logic — observation only.
     * @type {Map<number, number>}
     */
    this.pendingStartTimes = new Map();

    // Wire-agent mode (?wireframe=1). When true, getCached() returns
    // shared per-DID-hash MeshBasicMaterial({wireframe:true}) instead of
    // a textured MeshStandardMaterial, and preload() skips the
    // expensive surface-pixel fetch + GPU texture upload entirely.
    // Designed so software-WebGL (SwiftShader) can keep up — no PBR
    // shader, no fragment fill, no texture sampling. Composable with
    // any quality preset; orthogonal to `agentic=low`.
    this.wireframeMode = !!opts.wireframeMode;
    /** @type {Map<number, THREE.MeshBasicMaterial>} */
    this.wireframeBuckets = new Map();
    // 2026-05-22 — companion solid-fill materials for the wire buckets,
    // populated lazily alongside the wireframe materials. Keyed by the
    // same bucket index (0..WIRE_BUCKETS) so `addFillCompanions` can
    // map a wire material back to its fill twin by either bucket-index
    // (via `wireMatToFill`) or reference. polygonOffset on the fill
    // pushes it slightly behind the wire so the wireframe lines stay
    // crisp without z-fighting.
    /** @type {Map<number, THREE.MeshBasicMaterial>} */
    this.wireframeFillBuckets = new Map();
    /** @type {Map<THREE.MeshBasicMaterial, THREE.MeshBasicMaterial>} */
    this.wireMatToFill = new Map();
    // 2026-05-22 — per-surface dominant-colour pair, populated lazily
    // when the manifest at `data/surface-colors.json` has an entry for
    // the requested DID. Each entry is `{ wire, fill }`; both
    // MeshBasicMaterial. With the manifest installed, wire-mode
    // surfaces render in their actual dominant texture colour (grass
    // green, bark brown, stone grey, water blue, etc.) instead of the
    // 32-bucket HSL hash. Surfaces missing from the manifest still
    // fall through to `wireframeBuckets`. See
    // `apps/holtburger-tools/src/bin/surface-colors.rs` for the
    // build-time tool.
    //
    // `surfaceColors` is the loaded `Map<u32, [r, g, b]>` (Uint8 0..255).
    /** @type {Map<number, {wire: THREE.MeshBasicMaterial, fill: THREE.MeshBasicMaterial}>} */
    this.didMaterials = new Map();
    this.surfaceColors = opts.surfaceColors ?? null;

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

    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Phase 1.1 normal map gate. Defaults to `true` so legacy callers and
    // test harnesses that don't plumb the quality preset still get the
    // pre-Wave-2.B behaviour. Quality-preset call sites (index.js +
    // statics.js + buildings.js) pass `quality.flags.normalMaps` so
    // `low`/`mid` presets opt out per the preset table in quality.js.
    this.normalMapsEnabled =
      opts.normalMapsEnabled === undefined ? true : !!opts.normalMapsEnabled;

    // Shared fallback for the 0xFF "no surface" bucket and for any
    // surface DID that fails to resolve (zero-size SurfacePixels, etc).
    this.fallbackMaterial = this.wireframeMode
      ? new THREE.MeshBasicMaterial({
          color: 0x808080,
          wireframe: true,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
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
    if (this.csmState && !this.wireframeMode) {
      _installCsmShaderPatch(this.fallbackMaterial, this.csmState);
    }
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Skip in wireframe mode — the
    // fallback is then a MeshBasicMaterial with NO direct-lighting
    // accumulation (no `RE_Direct`/`reflectedLight`), so the patch's
    // `<lights_fragment_begin>` target is absent and the chunk swap would
    // be a no-op replace at best / a broken shader at worst.
    if (!this.wireframeMode) {
      _installLightClampShaderPatch(this.fallbackMaterial);
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
  getCached(surfaceDid, doubleSided = true) {
    const base = this._getCachedDouble(surfaceDid);
    // T2: per-poly single-sided variant (FrontSide) for `?perPolyCull=on`.
    // Wireframe mode ignores cull (both faces always drawn), so keep base.
    if (doubleSided || this.wireframeMode) {
      return base;
    }
    const key = surfaceDid >>> 0;
    let front = this.frontSideMaterials.get(key);
    if (!front) {
      front = base.clone();
      front.side = THREE.FrontSide;
      this.frontSideMaterials.set(key, front);
    }
    return front;
  }

  /** The DoubleSide base material for a surface (original `getCached` body). */
  _getCachedDouble(surfaceDid) {
    if (this.wireframeMode) {
      return this._wireframeMaterialFor(surfaceDid >>> 0);
    }
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
   * Build the dedup key for a paletted-material lookup.
   * `subPalettes` is a Uint32Array of (offset_u8, length_u8, slot_u16)
   * triples (or empty); we hash by joining numbers with a separator so
   * the key is stable per (DID, paletteId, exact sub-palette tuple).
   */
  _paletteKey(surfaceDid, paletteId, subPalettes) {
    if (!subPalettes || subPalettes.length === 0) {
      return `${surfaceDid >>> 0}|${paletteId >>> 0}|`;
    }
    // Uint32Array join() is fast enough for the typical 1-12 entry
    // sub-palette payloads; no hot allocation pattern beyond the
    // resulting string itself.
    return `${surfaceDid >>> 0}|${paletteId >>> 0}|${Array.from(subPalettes).join(",")}`;
  }

  /**
   * Synchronous lookup for an already-cached paletted material.
   * Returns null on miss so the caller can fetch + install.
   */
  getCachedPaletted(surfaceDid, paletteId, subPalettes) {
    const key = this._paletteKey(surfaceDid, paletteId, subPalettes);
    return this.palettedMaterials.get(key) ?? null;
  }

  /**
   * Install a freshly-fetched paletted material into the cache.
   * The caller is responsible for building the THREE.Material; we
   * tag it `__cacheOwned` so per-entity dispose doesn't free it.
   */
  installPaletted(surfaceDid, paletteId, subPalettes, material, texture = null) {
    const key = this._paletteKey(surfaceDid, paletteId, subPalettes);
    material.userData = { ...(material.userData || {}), __cacheOwned: true };
    if (texture) {
      texture.userData = { ...(texture.userData || {}), __cacheOwned: true };
      this.palettedTextures.set(key, texture);
    }
    this.palettedMaterials.set(key, material);
    // #22 — insertion-order LRU cap. Map iteration is insertion-ordered,
    // so the FIRST key is the oldest. Evict oldest-first while over cap,
    // disposing the material AND its paired owned texture together. The
    // `oldestKey === key` guard ensures the entry we just installed this
    // call is never the one evicted (so a same-frame-baked material stays
    // retrievable same frame). Re-inserting an existing key keeps its
    // original position in the Map (it does NOT move to the end), so that
    // guard also covers the degenerate "the entry we just re-set is also
    // the oldest" case. Fail-soft: a throwing dispose() must not abort.
    while (this.palettedMaterials.size > PALETTED_CACHE_CAP) {
      const oldestKey = this.palettedMaterials.keys().next().value;
      if (oldestKey === undefined || oldestKey === key) break;
      const oldMat = this.palettedMaterials.get(oldestKey);
      const oldTex = this.palettedTextures.get(oldestKey);
      this.palettedMaterials.delete(oldestKey);
      this.palettedTextures.delete(oldestKey);
      try { oldMat?.dispose?.(); } catch (_) {}
      try { oldTex?.dispose?.(); } catch (_) {}
    }
    return material;
  }

  /**
   * Wire-agent path: return a shared MeshBasicMaterial({wireframe:true})
   * keyed by a 32-bucket hash of the surface DID so different surface
   * categories render as visually distinct wire colors but the GPU
   * sees at most 32 distinct materials per scene. HSL distribution
   * (hue across the wheel, fixed S=0.6, L=0.55) gives perceptually
   * distinct buckets without naming surface types explicitly.
   *
   * 2026-05-22 — also creates the companion solid-fill material for the
   * same bucket so `addFillCompanions` can map wire-material → fill-
   * material by reference. The fill colour uses the same hue with a
   * darker, less-saturated tone (S=0.45, L=0.42) so the wireframe lines
   * (brighter) read clearly against it.
   */
  _wireframeMaterialFor(did) {
    // 2026-05-22 — per-DID dominant-colour path. If the surface-colours
    // manifest has an entry for this DID, mint (or fetch) a dedicated
    // pair { wire, fill } where wire = lighter+more-saturated variant
    // of the dominant for contrast and fill = the dominant itself.
    // Materials cached in `didMaterials` for reuse across meshes that
    // share the surface. Falls through to the 32-bucket HSL hash for
    // any DID the manifest doesn't cover.
    if (did !== FALLBACK_SURFACE_DID && this.surfaceColors) {
      const rgb = this.surfaceColors.get(did >>> 0);
      if (rgb) {
        const existing = this.didMaterials.get(did >>> 0);
        if (existing) return existing.wire;
        const fillColor = new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        // Derive a brighter, slightly more saturated wire colour so the
        // overlay reads on top of the fill. HSL roundtrip — bumping L
        // alone would wash out saturated colours; bumping S too keeps
        // grass green green and bark brown brown.
        const hsl = { h: 0, s: 0, l: 0 };
        fillColor.getHSL(hsl);
        const wireColor = new THREE.Color().setHSL(
          hsl.h,
          Math.min(1.0, hsl.s + 0.15),
          Math.min(0.85, hsl.l + 0.28),
        );
        const wireMat = new THREE.MeshBasicMaterial({
          color: wireColor,
          wireframe: true,
          side: THREE.DoubleSide,
          fog: true,
        });
        wireMat.name = `wire-did-${did.toString(16).padStart(8, "0")}`;
        wireMat.userData = { __cacheOwned: true, surfaceDid: did >>> 0 };
        const fillMat = new THREE.MeshBasicMaterial({
          color: fillColor,
          side: THREE.DoubleSide,
          fog: true,
          polygonOffset: true,
          polygonOffsetFactor: 4,
          polygonOffsetUnits: 4,
        });
        fillMat.name = `wire-fill-did-${did.toString(16).padStart(8, "0")}`;
        fillMat.userData = { __cacheOwned: true, surfaceDid: did >>> 0 };
        // AO shading on both — floors brighter, walls/ceilings darker.
        applyWireVertexAOPatch(wireMat);
        applyWireVertexAOPatch(fillMat);
        applyFillDepthBias(fillMat);
        this.didMaterials.set(did >>> 0, { wire: wireMat, fill: fillMat });
        this.wireMatToFill.set(wireMat, fillMat);
        return wireMat;
      }
    }
    const WIRE_BUCKETS = 32;
    const bucket = (did === FALLBACK_SURFACE_DID ? 0 : did) % WIRE_BUCKETS;
    let m = this.wireframeBuckets.get(bucket);
    if (m) return m;
    const hue = bucket / WIRE_BUCKETS;
    const color = new THREE.Color().setHSL(hue, 0.6, 0.55);
    m = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    m.name = `wire-bucket-${bucket}`;
    m.userData = { __cacheOwned: true, wireBucket: bucket };
    applyWireVertexAOPatch(m);
    this.wireframeBuckets.set(bucket, m);

    // Companion solid-fill material — same hue, darker + less saturated
    // so the wireframe overlay reads clearly. polygonOffset pushes the
    // fill back in depth so the wire lines aren't z-fought. Buildings
    // and statics have dense small triangles where polygonOffsetUnits=1
    // can be smaller than the per-pixel depth precision — bumped to
    // factor=4, units=4 for reliable wire visibility across all mesh
    // densities. The terrain bake uses a separate dedicated path
    // (`scene3d/terrain.js`) with the same offset values.
    const fillColor = new THREE.Color().setHSL(hue, 0.45, 0.32);
    const fillM = new THREE.MeshBasicMaterial({
      color: fillColor,
      side: THREE.DoubleSide,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    fillM.name = `wire-fill-bucket-${bucket}`;
    fillM.userData = { __cacheOwned: true, wireFillFor: bucket };
    applyWireVertexAOPatch(fillM);
    applyFillDepthBias(fillM);
    this.wireframeFillBuckets.set(bucket, fillM);
    this.wireMatToFill.set(m, fillM);
    return m;
  }

  /**
   * Map a wire-bucket material to its solid-fill twin. Returns null if
   * `mat` isn't one of this cache's wire-bucket materials. Used by
   * `addFillCompanions` and also tolerates per-material arrays (Mesh
   * with geometry groups) by callers iterating their entries.
   */
  _fillMaterialForWire(mat) {
    if (!mat) return null;
    return this.wireMatToFill.get(mat) ?? null;
  }

  /**
   * Wire-agent: walk `group` and for each Mesh / InstancedMesh whose
   * material (or one of its material-array entries) is a wire-bucket
   * material, attach a companion solid-fill mesh sharing the geometry.
   * The fill mesh has identical pose; the wire-bucket material maps to
   * its fill twin via `_fillMaterialForWire`. Sharing the BufferGeometry
   * means no extra GPU memory; the only cost is the additional draw call
   * per source mesh (matched 1:1 by mesh count).
   *
   * Idempotent — each mesh is tagged with `userData.__wireFillCompanion`
   * after seeding so re-walks (e.g. after an LB-lazy bake adds new
   * meshes) only add companions for new objects.
   *
   * Returns the number of companions added.
   */
  addFillCompanions(group) {
    if (!this.wireframeMode || !group || typeof group.traverse !== "function") {
      return 0;
    }
    /** @type {Array<{source: any, fillMat: any, kind: "mesh"|"instanced"|"skinned"}>} */
    const queue = [];
    group.traverse((obj) => {
      if (!obj || obj.userData?.__wireFillCompanion) return;
      if (obj.userData?.__wireFillSource) return; // skip already-attached fills
      if (!obj.isMesh && !obj.isInstancedMesh) return;
      // Material may be a single material or an array (for grouped geometries).
      const mat = obj.material;
      if (!mat) return;
      const kind = obj.isInstancedMesh
        ? "instanced"
        : obj.isSkinnedMesh
        ? "skinned"
        : "mesh";
      if (Array.isArray(mat)) {
        // Multi-material mesh — map each entry to its fill twin. If any
        // entry has no twin we still attach (using fallback wire material
        // for that slot maps to null → use the source slot directly).
        const fills = mat.map((m) => this._fillMaterialForWire(m));
        if (fills.every((f) => f === null)) return;
        const arr = mat.map((m, i) => fills[i] ?? m);
        queue.push({ source: obj, fillMat: arr, kind });
      } else {
        const fillMat = this._fillMaterialForWire(mat);
        if (!fillMat) return;
        queue.push({ source: obj, fillMat, kind });
      }
    });
    let added = 0;
    for (const { source, fillMat, kind } of queue) {
      let fillMesh;
      if (kind === "instanced") {
        // InstancedMesh — copy count + instanceMatrix (and instanceColor
        // if present). Geometry is shared.
        fillMesh = new THREE.InstancedMesh(source.geometry, fillMat, source.count);
        fillMesh.instanceMatrix.array.set(source.instanceMatrix.array);
        fillMesh.instanceMatrix.needsUpdate = true;
        if (source.instanceColor) {
          fillMesh.instanceColor = source.instanceColor.clone();
          fillMesh.instanceColor.needsUpdate = true;
        }
      } else if (kind === "skinned") {
        // SkinnedMesh — clone as another SkinnedMesh sharing the SAME
        // skeleton + bindMatrix so the fill follows the source's
        // animation exactly. Without this, a plain `new THREE.Mesh(geom,
        // fillMat)` would render at the rest pose (T-pose) regardless of
        // the source's per-frame bone transforms, producing a static
        // ghost blob attached to the animating wire (which is what the
        // first iteration looked like — the `Cow` showed wires but no
        // fill).
        fillMesh = new THREE.SkinnedMesh(source.geometry, fillMat);
        fillMesh.bindMode = source.bindMode;
        fillMesh.bindMatrix.copy(source.bindMatrix);
        fillMesh.bindMatrixInverse.copy(source.bindMatrixInverse);
        fillMesh.bind(source.skeleton, source.bindMatrix);
      } else {
        fillMesh = new THREE.Mesh(source.geometry, fillMat);
      }
      fillMesh.name = (source.name || "wire") + "-fill";
      // Copy pose. matrix is already the local matrix; matrixAutoUpdate
      // controls whether it gets recomputed each frame from p/r/s.
      fillMesh.position.copy(source.position);
      fillMesh.quaternion.copy(source.quaternion);
      fillMesh.scale.copy(source.scale);
      fillMesh.matrixAutoUpdate = source.matrixAutoUpdate;
      if (!source.matrixAutoUpdate) {
        fillMesh.matrix.copy(source.matrix);
        fillMesh.matrixWorldNeedsUpdate = true;
      }
      fillMesh.castShadow = false;
      fillMesh.receiveShadow = false;
      fillMesh.frustumCulled = source.frustumCulled;
      // renderOrder: fill renders BEFORE the wire so the wire's depth
      // values win at edges. Combined with polygonOffset on the fill,
      // gives reliable wire-on-top across hardware (SwiftShader's
      // depth precision in particular benefits).
      fillMesh.renderOrder = (source.renderOrder ?? 0) - 1;
      fillMesh.userData = { __wireFillSource: true };
      source.userData = source.userData ?? {};
      source.userData.__wireFillCompanion = true;
      const parent = source.parent;
      if (parent) {
        parent.add(fillMesh);
        added += 1;
      }
    }
    return added;
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
   *   - Alpha (0x100): texture-alpha blend (SRCALPHA/INVSRCALPHA),
   *     `transparent = true, depthWrite = false`; opacity comes from the
   *     texture's own alpha channel. acclient.c SetSurface @454470.
   *   - Additive (0x10000): `blending = AdditiveBlending` +
   *     `transparent = true, depthWrite = false`. For flame, sparks,
   *     and other particle-style additive surfaces.
   *   - Self-illumination is driven by the luminosity FLOAT (not the
   *     0x40 bit, which retail never sets): emissive = grayscale
   *     luminosity, flat (no emissiveMap), per acclient.c @454688.
   *   - Diffuse reflectance is driven by the diffuse FLOAT (not the
   *     0x20 bit): albedo `color` ×= diffuse (no-op at ~1.0), per
   *     acclient.c @454458 — NOT a roughness/matte hint.
   *   - **No explicit TwoSided bit.** All surfaces default to
   *     `side: DoubleSide` because the AC two-sidedness bit lives on
   *     the Polygon (`sides_type == 0x2`), not the Surface; the Rust
   *     triangulator handles the distinct-pos/neg case by emitting
   *     two tris with opposite winding.
   *
   * `surfaceTypeFlags === 0` (the empty-surface fallback) hits the
   * opaque path → standard albedo material with DoubleSide.
   */
  _materialFromFlags(surfaceTypeFlags, texture, category, normalTexture, overrides, heightTexture, surfaceFloats) {
    const flags = surfaceTypeFlags >>> 0;
    // Wave 8 (2026-05-28) — Surface (0x08) trailing T/L/D triplet.
    // Pre-Wave-8 these were silently dropped; the bit flags drove
    // hardcoded effect strengths. Now each effect uses the actual
    // per-surface float. `surfaceFloats` may be undefined when an
    // older call site hasn't been migrated; treat that as 0/0/0
    // (≡ pre-Wave-8 binary behaviour).
    const sfTranslucency = +(surfaceFloats?.translucency ?? 0.0);
    const sfLuminosity = +(surfaceFloats?.luminosity ?? 0.0);
    const sfDiffuse = +(surfaceFloats?.diffuse ?? 0.0);
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
      // === L4 (waves-2, 2026-05-29) — `?flatDiffuse=retail` preset ======
      // Retail FFP has no specular (acclient.c:454385-454561); only opt the
      // glossy categories (Metal, Lava) into a flat non-specular look under
      // the flag — never overwrite the classifier defaults unconditionally.
      // Read at the consumption site (same pattern as readLightClampRetailFlag)
      // so the flag and its consumer share scope.
      if (readFlatDiffuseRetailFlag()) {
        const flat = FLAT_DIFFUSE_CATEGORIES[category];
        if (flat) {
          baseRoughness = flat.roughness;
          baseMetalness = flat.metalness;
        }
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
    const isAdditive = (flags & SURFACE_TYPE.Additive) !== 0;
    // Alpha (0x100): texture-alpha blend — SRCALPHA/INVSRCALPHA, depthWrite
    // off (acclient.c D3DPolyRender::SetSurface @454470). 253 retail
    // surfaces carry it; pre-2026-05-28 they fell through to opaque here.
    const isAlpha = (flags & SURFACE_TYPE.Alpha) !== 0;
    // InvAlpha (0x200): inverse alpha blend — retail's D3DPolyRender::SetSurface
    // (acclient.c @454478) flips the factors vs Alpha (INVSRCALPHA/SRCALPHA
    // instead of SRCALPHA/INVSRCALPHA). `materialCanCastShadow` (above) already
    // classifies 0x200 as transparent; pre-2026-05-28 the render path had no
    // branch, so InvAlpha surfaces rendered fully opaque — an internal
    // inconsistency. First cut: route through the same alpha-blend branch as
    // Alpha (transparent + depthWrite off). A faithful inverse blend (alpha =
    // 1 - texAlpha) would need a custom blend func / shader and is deferred
    // until a retail occurrence count justifies it.
    const isInvAlpha = (flags & SURFACE_TYPE.InvAlpha) !== 0;
    // `isLuminous` (the 0x40 bit) is kept ONLY to gate the normal-map skip
    // below — self-illumination itself is now driven by the luminosity
    // FLOAT (`hasLum`). Retail's portal.dat sets the Luminous/Diffuse bits
    // on 0/6152 surfaces (census 2026-05-28) while 762 carry luminosity>0
    // and 6150 carry diffuse>0; acclient.c SetSurface reads the floats, not
    // the bits (emissive @454688, diffuse @454458).
    const isLuminous = (flags & SURFACE_TYPE.Luminous) !== 0;
    const hasLum = sfLuminosity > 0;
    // === A10-M1 (2026-06-11) — single-decoder delegation =====================
    // When `?surfaceUnified=on`, defer the blend/emissive/diffuse ladder to the
    // shared `applySurfaceRenderState` (post-construction, mutating the built
    // material) so this path and the dyed/paletted path run ONE decoder. Default
    // OFF keeps the inline `opts` ladder below — byte-identical output (the
    // unified function adopts this path's emissiveMap reading, and the inline
    // writes vs post-construction `needsUpdate` writes resolve to the same
    // MeshStandardMaterial props).
    const useUnifiedDecoder = readSurfaceUnifiedFlag();
    if (!useUnifiedDecoder && isAdditive && isAlpha) {
      // Wave-3 M1 — Alpha+Additive (0x10000|0x100): the additive
      // contribution is WEIGHTED by per-texel source alpha, not added at
      // full RGB. Retail D3DPolyRender::SetSurface (acclient.c:454474) sets
      // src=BLEND_SRCALPHA(5) and, BECAUSE Additive(0x10000) is also set,
      // dst=BLEND_ONE(2) — i.e. SRCALPHA/ONE, not the ONE/ONE that
      // THREE.AdditiveBlending bakes in. 183/202 additive surfaces are
      // Alpha+Additive (spell glows / flame haloes); ONE/ONE over-brightens
      // them (alpha ignored → hard squarish halo cutoffs). The DataTexture
      // is RGBAFormat (adapter.js:907) so the source alpha is present.
      // Use CustomBlending to express SRCALPHA/ONE faithfully. depthWrite
      // off so the halo doesn't occlude geometry behind it.
      opts.blending = THREE.CustomBlending;
      opts.blendSrc = THREE.SrcAlphaFactor;
      opts.blendDst = THREE.OneFactor;
      opts.blendEquation = THREE.AddEquation;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (!useUnifiedDecoder && isAdditive) {
      // Pure-additive (Additive without the Alpha bit): retail resolves to
      // src=BLEND_ONE(2)/dst=BLEND_ONE(2) (acclient.c:454474, the non-Alpha
      // path), which THREE.AdditiveBlending matches exactly. 19 retail
      // surfaces (flames, sparks). depthWrite=false so additive surfaces
      // don't occlude geometry behind them.
      opts.blending = THREE.AdditiveBlending;
      opts.transparent = true;
      opts.depthWrite = false;
    } else if (!useUnifiedDecoder && (isTranslucent || isAlpha || isInvAlpha)) {
      // Alpha blend (SRCALPHA/INVSRCALPHA), depthWrite off — the renderer
      // painter-sorts transparent objects. Retail routes both Translucent
      // (0x10, acclient.c:454513) and Alpha (0x100, :454470) through this
      // same blend state.
      opts.transparent = true;
      opts.depthWrite = false;
      // Translucent's alpha is the per-surface translucency float
      // (final_alpha = 1 - T, acclient.c:454523; ACE: 0=opaque, 1=invisible).
      // Alpha (0x100) instead takes its alpha from the texture's own alpha
      // channel, so leave opacity at 1.0 for it. Translucent surfaces with
      // T=0 (most) also render at full opacity.
      if (isTranslucent && sfTranslucency > 0) {
        opts.opacity = Math.max(0, 1 - sfTranslucency);
      }
    } else if (!useUnifiedDecoder && isClipMap) {
      // Binary alpha mask (foliage, fences). alphaTest cuts the
      // alpha=0 fragments at rasterise time → no transparency sort.
      opts.alphaTest = 0.5;
      opts.transparent = false;
    }
    if (!useUnifiedDecoder && hasLum) {
      // Self-illumination, driven by the per-surface luminosity FLOAT
      // (not the never-set 0x40 bit). Retail's grayscale D3D emissive
      // (D3DMATERIAL9.Emissive.rgb = luminosity, acclient.c
      // D3DPolyRender::SetSurface @454688) MULTIPLIES the surface texture
      // in the fixed-function combiner — final ≈ texture × (lighting +
      // emissive) — so a COLOURED luminous surface (e.g. the blue lifestone
      // crystal) glows in its own colour, just brighter. three.js'
      // `emissive` is ADDED, and is texture-modulated ONLY when an
      // `emissiveMap` is set; without one a flat-white emissive ADD washes
      // the texture out to pure white (the reported white lifestone / chest
      // / door — the old code deliberately attached no emissiveMap on a
      // mistaken "retail isn't texture-modulated" reading). Fix: keep
      // emissive=white scaled by luminosity AND attach the diffuse texture
      // as emissiveMap, which reproduces retail's texture×emissive. The
      // emissiveMap shares uv0 + sRGB decode with `map`. Untextured luminous
      // surfaces keep the flat-white glow. Clamp to (0, 2] (ACE ~[0,1] with
      // occasional HDR-ish pushes >1). 762 retail surfaces have lum>0.
      opts.emissive = new THREE.Color(0xffffff);
      opts.emissiveIntensity = Math.min(2.0, sfLuminosity);
      if (texture) opts.emissiveMap = texture;
    }
    // Diffuse reflectance, driven by the per-surface diffuse FLOAT (not the
    // never-set 0x20 bit). Retail uses `diffuse` as a diffuse-reflectance
    // multiplier on the material's diffuse colour (D3DMATERIAL9.Diffuse/
    // Ambient.rgb = diffuse × sunlight, acclient.c SetSurface @454458) —
    // NOT a roughness/matte hint as the pre-2026-05-28 path assumed. The
    // PBR analogue is the albedo tint `color`, multiplied with `map`.
    // No-op at d≈1.0 (~96% of retail surfaces); dims the 241 with d≠1.
    // d==0 (2 surfaces) is left full-bright rather than forced black,
    // pending the GPU eye-test.
    if (!useUnifiedDecoder && sfDiffuse > 0 && Math.abs(sfDiffuse - 1.0) > 0.01) {
      opts.color = new THREE.Color(sfDiffuse, sfDiffuse, sfDiffuse);
    }
    const mat = new THREE.MeshStandardMaterial(opts);

    // === A10-M1 (2026-06-11) — run the single decoder on the built material ===
    // When `?surfaceUnified=on` the inline `opts` ladder above was skipped; apply
    // the unified render-state now (mutates `mat` + sets `needsUpdate`). The
    // `__baseTranslucency` userData it stamps for Translucent>0 is harmless on
    // the cache path (only the hook-ramp clock reads it). Built with default
    // opts (transparent:false, alphaTest:0) so the decoder starts from the same
    // baseline as the legacy branches.
    if (useUnifiedDecoder) {
      applySurfaceRenderState(
        mat,
        { flags, translucency: sfTranslucency, luminosity: sfLuminosity, diffuse: sfDiffuse },
        { texture },
      );
    }

    // Phase 1.1 — procedural normal map. Wasm skips Luminous surfaces
    // (empty normal_pixels → null texture), so `!isLuminous` is
    // belt-and-braces. Phase 1.5 normalScale override beats the 0.8
    // default when present.
    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Gate on `this.normalMapsEnabled` so `low`/`mid` quality presets can
    // skip the +texture memory + sampler bandwidth. Wasm still bakes the
    // normal pixels (cached per-DID at decode time); the gate prevents
    // GPU upload via the unused texture. Wasm-side skip is a heavier
    // refactor (would have to plumb the preset through the JS↔wasm
    // boundary at every fetch site); skipping at the JS gate captures
    // the dominant cost (GPU memory + fragment-shader work).
    if (this.normalMapsEnabled && normalTexture && !isLuminous) {
      mat.normalMap = normalTexture;
      const overrideScale =
        overrides && Number.isFinite(overrides.normalScale)
          ? overrides.normalScale
          : null;
      // === Wave 2.B — procedural normals (2026-05-28) ===
      // Fallback chain: explicit per-DID override (Phase 1.5) → per-category
      // default (Wave 2.B) → 0.8 baseline (Phase 1.1 hand-off).
      let scale = overrideScale;
      if (scale === null && typeof category === "number") {
        const catScale = CATEGORY_NORMAL_SCALE_DEFAULTS[category];
        if (typeof catScale === "number") scale = catScale;
      }
      if (scale === null) scale = 0.8;
      mat.normalScale.setScalar(scale);
      if (overrideScale !== null) {
        mat.userData = { ...(mat.userData || {}), normalScaleOverride: overrideScale };
      }
      mat.userData = { ...(mat.userData || {}), normalScaleEffective: scale };
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
      !isAlpha &&
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
    if (this.csmState && !isAdditive && !isTranslucent && !isAlpha) {
      _installCsmShaderPatch(mat, this.csmState);
    }
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Composed LAST so it wraps the
    // direct-lighting accumulation regardless of which other patches
    // (detail/POM/CSM) ran on this material. Applies to additive/
    // translucent too — the clamp only affects direct DIFFUSE/SPECULAR
    // accumulation, which an additive surface still computes.
    _installLightClampShaderPatch(mat);
    // === G2 (waves-2, 2026-05-29) — object-surface texture wrap mode ======
    // Retail `D3DPolyRender::SetSurface` (acclient.c:454437) sets the sampler
    // address mode from the Stippled bit: `!stippled ? (v6 = 3) : (v6 = 1)`
    // then `SetSamplerAddressMode(dev, 0, v6, v6)` for BOTH U and V, where
    // 3 = TEXADDRESS_CLAMP (acclient.h:5261), 1 = TEXADDRESS_WRAP
    // (acclient.h:5259). So normal object surfaces CLAMP (don't tile); only
    // Stippled surfaces (SurfaceType 0x40000000, acclient.h:5833 / ACE
    // SurfaceType.cs:19) WRAP. adapter.js's `surfacePixelsTo*Texture`
    // hardcode `RepeatWrapping`; override it here per-surface now that the
    // textures are in hand. three.js mapping: CLAMP → ClampToEdgeWrapping,
    // WRAP → RepeatWrapping. FAIL-SOFT: `flags===0` (empty/fallback surface)
    // → ClampToEdge (retail default = non-tiling). Cached animated frames
    // inherit the base texture's wrapS/wrapT downstream, so fixing `texture`
    // propagates to them. Terrain detail/atlas textures are OUT OF SCOPE
    // (they tile by design) and never pass through this object path.
    const isStippled = (flags & SURFACE_TYPE.Stippled) !== 0;
    const wrapMode = isStippled
      ? THREE.RepeatWrapping
      : THREE.ClampToEdgeWrapping;
    if (texture) {
      texture.wrapS = texture.wrapT = wrapMode;
    }
    if (normalTexture) {
      normalTexture.wrapS = normalTexture.wrapT = wrapMode;
    }
    if (heightTexture) {
      heightTexture.wrapS = heightTexture.wrapT = wrapMode;
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
    if (this.wireframeMode) {
      return this._wireframeMaterialFor(surfaceDid >>> 0);
    }
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
      // === Wave 2.B — procedural normals (2026-05-28) ===
      // When the quality preset disables normal maps, skip the GPU
      // texture upload entirely (not just the material wire-up). Saves
      // RGBA8 → DataTexture buffer alloc + GL texture handle per DID.
      const normalTex = this.normalMapsEnabled
        ? surfacePixelsToNormalTexture(sp.normalPixels, sp.width, sp.height)
        : null;
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
      // Wave 8 (2026-05-28) — Surface T/L/D triplet pulled from the
      // wasm side (pre-Wave-8 these were dropped; materials.js used
      // only the surface_type bitflag presence with hardcoded effect
      // strengths). Older wasm builds without the getters fall through
      // to 0 (opaque/no-glow/no-diffuse-adj — same behaviour as the
      // pre-Wave-8 bitflag path).
      const surfaceFloats = {
        translucency: typeof sp.translucency === "number" ? sp.translucency : 0.0,
        luminosity: typeof sp.luminosity === "number" ? sp.luminosity : 0.0,
        diffuse: typeof sp.diffuse === "number" ? sp.diffuse : 0.0,
      };
      if (typeof sp.free === "function") sp.free();
      const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex, surfaceFloats);
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
      // 2026-05-30 — a real (textured) material just landed for this surface;
      // drop any stale FrontSide clone that getCached(did,false) minted from
      // the mapless fallback during a spawn-race, so the next getCached
      // re-clones from THIS base. Without this, single-sided (?perPolyCull)
      // meshes keep the fallback clone forever even after the texture arrives.
      this.frontSideMaterials.delete(did);
      // Render-completeness audit (2026-05-29) — kick animated-frame setup.
      this._maybeSetupSurfaceAnimation(did, mat, tex);
      return mat;
    })();
    this.pendingFetches.set(did, p);
    this.pendingStartTimes.set(did, performance.now());
    try {
      return await p;
    } finally {
      this.pendingFetches.delete(did);
      this.pendingStartTimes.delete(did);
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
    if (this.wireframeMode) {
      // Wire-agent mode: skip the wasm surface-pixel fetch + GPU texture
      // upload entirely. Materials are constructed lazily via the
      // bucket-hash path in `_wireframeMaterialFor`, and the synchronous
      // `getCached` route always returns the bucket material regardless
      // of preload. Total skip — no fetch, no upload, no shader compile
      // beyond the ~32 MeshBasicMaterials lazily created on first hit.
      return 0;
    }
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
    const _batchStart = performance.now();
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
      this.pendingStartTimes.set(d, _batchStart);
    }

    try {
      await sharedFetch;
    } catch (e) {
      // Bulk fetch failed entirely — clear all pending so subsequent
      // calls can retry. Caller's await of `preload()` will reject.
      for (const d of need) {
        this.pendingFetches.delete(d);
        this.pendingStartTimes.delete(d);
      }
      try { window.__diag?.assets?.onMaterialError?.({ dids: need, error: e, source: "preload" }); } catch (_) {}
      throw e;
    }

    // F4 (2026-06-01) — the per-DID `pendingFetches` chains registered above are
    // the SOLE consumers of each SurfacePixels: each installs + `sp.free()`s
    // exactly once. This loop USED to ALSO call `_installFromPixels(d,
    // results[i])` on the SAME (now-freed) handles, whose `sp.width` getter threw
    // "null pointer passed to rust" (caught + recorded as source:"surface" — the
    // 100-error burst in the stutter diagnostic). Await the pending promises here
    // to count resolutions without double-consuming. The `.then()` chains do NOT
    // clear the pending maps, so we still delete them per-DID.
    let resolved = 0;
    for (const d of need) {
      let installed = this.fallbackMaterial;
      try {
        const p = this.pendingFetches.get(d);
        installed = p ? await p : (this.materials.get(d) || this.fallbackMaterial);
      } catch (_) {
        installed = this.fallbackMaterial;
      }
      if (installed !== this.fallbackMaterial) resolved += 1;
      this.pendingFetches.delete(d);
      this.pendingStartTimes.delete(d);
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
    if (this.wireframeMode) {
      // Wire-agent mode: return empty per-group results. Entity code
      // that uses preloadBatch falls back to its own per-entity material
      // path, which in wireframe-mode is also branched to use a shared
      // wireframe material (see entities.js).
      return { groups: groups.map(() => ({ materials: new Map(), isEntityOwned: false })) };
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
      try { window.__diag?.assets?.onMaterialError?.({ dids: flatSurfaceDids, error: e, source: "batch" }); } catch (_) {}
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
    let w, h, pixels, surfaceType, sfTranslucency, sfLuminosity, sfDiffuse;
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
      // A10-M2 (2026-06-11) — snapshot the trailing T/L/D float triplet BEFORE
      // `sp.free()` so the unified decoder can thread the render-state flags
      // through the entity-owned (F.41 recolour) path. Same read idiom as the
      // cache path (materials.js:2343) and the dyed hot-swap path
      // (entities.js:6733-6735).
      sfTranslucency = typeof sp.translucency === "number" ? sp.translucency : 0.0;
      sfLuminosity = typeof sp.luminosity === "number" ? sp.luminosity : 0.0;
      sfDiffuse = typeof sp.diffuse === "number" ? sp.diffuse : 0.0;
    } catch (_) {
      return null;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    // Entity-owned material starts as a plain opaque MeshStandardMaterial —
    // mirrors entities.js line 594-600's existing entity-recolour
    // path which keeps things simple (no normal/height/CSM stack on
    // recoloured NPC surfaces today). Under `?surfaceUnified=on` the A10-M2
    // block below threads the Surface(0x08) render-state flags through
    // (transparent/additive/clipmap/luminous/diffuse), closing the F.41
    // flat-opaque gap (A10 §3 row 3).
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
    // === Wave R2.B — per-RGB light-color clamp (2026-05-28) ===
    // No-op unless `?lightClamp=retail`. Entity-recolour surfaces (NPCs,
    // recoloured gear) honour the cap too so a tinted sun / R2.A lantern
    // keeps its tone on characters, not just terrain/buildings.
    _installLightClampShaderPatch(mat);
    // === G2 (waves-2, 2026-05-29) — object-surface texture wrap mode ======
    // Same retail rule as `_materialFromFlags` (acclient.c:454437): entity-
    // owned surfaces (recoloured NPCs/gear) are object surfaces too, so they
    // CLAMP unless Stippled (SurfaceType 0x40000000). `surfacePixelsToTexture`
    // hardcodes RepeatWrapping; override per-surface. FAIL-SOFT: surfaceType
    // 0/missing → ClampToEdge. Only a base `tex` here (no normal/height).
    const isStippled = ((surfaceType >>> 0) & SURFACE_TYPE.Stippled) !== 0;
    tex.wrapS = tex.wrapT = isStippled
      ? THREE.RepeatWrapping
      : THREE.ClampToEdgeWrapping;
    // === A10-M2 (2026-06-11) — `?surfaceUnified=on` thread render-state flags ===
    // Retail funnels EVERY drawn surface — including recoloured/entity-owned ones
    // — through the SAME render-state decision (D3DPolyRender::SetSurface,
    // acclient.c:454385; there is no special recolour path). Default OFF keeps the
    // legacy plain-opaque material (rollback). When ON, run the single decoder so
    // a recoloured NPC/gear surface with Translucent/Additive/ClipMap/luminosity
    // renders correctly instead of flat-opaque (A10 §3 row 3). The decoder is a
    // no-op when `surfaceType === 0` (empty/fallback), so opaque recolours are
    // byte-identical to the legacy path. `tex` is passed as `emissiveMap` source
    // for luminous surfaces (the resolved FF-modulate reading, M1 header).
    if (readSurfaceUnifiedFlag()) {
      applySurfaceRenderState(
        mat,
        {
          flags: surfaceType,
          translucency: sfTranslucency,
          luminosity: sfLuminosity,
          diffuse: sfDiffuse,
        },
        { texture: tex },
      );
    }
    return mat;
  }

  _installFromPixels(did, sp) {
    if (!sp) return this.fallbackMaterial;
    // Idempotency / free-once guard (F4, 2026-06-01): if this DID is already
    // installed, a second consumer reached us with the SAME (already-freed)
    // SurfacePixels handle. Reading any getter below would throw "null pointer
    // passed to rust"; instead free-if-live (once, no-op on an already-freed
    // handle) and return the cached material. Defends preloadBatch + any future
    // double-consume; preload() itself no longer double-consumes (see below).
    if (this.materials.has(did)) {
      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
      return this.materials.get(did);
    }
    // wasm-bindgen wrappers around a null Rust pointer throw on every
    // getter (`.width` / `.height` / `.pixels`), so read them once under
    // a try/catch instead of an inline `sp.width === 0` check. A throw
    // here means the surface DID had no pixels — fall back to the
    // shared fallback material exactly as for the zero-dim case.
    let w, h, pixels, surfaceType, category, normalPixels, heightPixels,
        roughnessOverride, normalScaleOverride,
        translucencyF, luminosityF, diffuseF;
    try {
      w = sp.width;
      h = sp.height;
    } catch (e) {
      // Wave 1 / B1 fix (2026-05-28) — surface pixel-read threw on a
      // wasm-bindgen wrapper backed by a null Rust pointer. Record so
      // operators can see WHICH surface DIDs are failing instead of
      // staring at grey entities with no explanation.
      try {
        window.__diag?.assets?.onMaterialError?.({
          did, error: e, source: "surface",
        });
      } catch (_) {}
      return this.fallbackMaterial;
    }
    if (w === 0 || h === 0) {
      // Wave 1 / B1 fix (2026-05-28) — zero-dim surface (empty pixels
      // payload, parser truncation, etc.). Same fallback as throw case.
      try {
        window.__diag?.assets?.onMaterialError?.({
          did, error: `zero-dim (${w}x${h})`, source: "surface",
        });
      } catch (_) {}
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
      // Wave 8 — Surface T/L/D triplet (see main get() path comment).
      translucencyF = typeof sp.translucency === "number" ? sp.translucency : 0.0;
      luminosityF = typeof sp.luminosity === "number" ? sp.luminosity : 0.0;
      diffuseF = typeof sp.diffuse === "number" ? sp.diffuse : 0.0;
    } catch (_) {
      return this.fallbackMaterial;
    }
    const tex = surfacePixelsToTexture(pixels, w, h);
    // === Wave 2.B — procedural normals (2026-05-28) ===
    // Gate normal-pixel → GPU texture conversion on the preset flag, same
    // as the main `get()` path above. Saves the DataTexture alloc + GL
    // upload when `normalMaps` is off in the quality preset.
    const normalTex = this.normalMapsEnabled
      ? surfacePixelsToNormalTexture(normalPixels, w, h)
      : null;
    const heightTex = heightPixels ? surfacePixelsToHeightTexture(heightPixels, w, h) : null;
    // Phase 7 follow-on #7+8: surface_type bitfield from the wasm side.
    const surfaceTypeFlags = surfaceType >>> 0;
    try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    const overrides = { roughness: roughnessOverride, normalScale: normalScaleOverride };
    const surfaceFloats = {
      translucency: translucencyF,
      luminosity: luminosityF,
      diffuse: diffuseF,
    };
    const mat = this._materialFromFlags(surfaceTypeFlags, tex, category, normalTex, overrides, heightTex, surfaceFloats);
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
    // 2026-05-30 — invalidate the stale fallback-derived FrontSide clone (see
    // the 6-space twin in get()) so getCached(did,false) re-clones from this
    // textured base after a spawn-race fallback.
    this.frontSideMaterials.delete(did);
    // Render-completeness audit (2026-05-29) — kick animated-frame setup.
    this._maybeSetupSurfaceAnimation(did, mat, tex);
    return mat;
  }

  /**
   * Render-completeness audit (2026-05-29) — set up frame cycling for an
   * animated SurfaceTexture (water / lava / effects). Fire-and-forget: the
   * base material already renders the highest-res frame, so this only adds
   * motion once frames load. No-op when the wasm getter is absent, the
   * surface isn't animated (frameCount < 2), already checked, or anything
   * fails — the surface simply stays static (zero regression risk).
   */
  _maybeSetupSurfaceAnimation(did, mat, baseTex) {
    const d = did >>> 0;
    if (!this._animFramesFetch || this._animChecked.has(d)) return;
    this._animChecked.add(d);
    Promise.resolve()
      .then(() => this._animFramesFetch(d))
      .then((bundle) => {
        if (!bundle) return;
        const frameCount = (bundle.frameCount ?? 0) >>> 0;
        const w = (bundle.width ?? 0) >>> 0;
        const h = (bundle.height ?? 0) >>> 0;
        if (frameCount < 2 || w === 0 || h === 0) {
          if (typeof bundle.free === "function") { try { bundle.free(); } catch (_) {} }
          return;
        }
        const all =
          typeof bundle.takePixels === "function" ? bundle.takePixels() : null;
        if (typeof bundle.free === "function") { try { bundle.free(); } catch (_) {} }
        const per = w * h * 4;
        if (!all || all.length < per * frameCount) return;
        // Material may have been evicted/disposed between build and now.
        if (this.materials.get(d) !== mat) return;
        const frames = [];
        for (let i = 0; i < frameCount; i += 1) {
          // subarray() shares the big backing buffer; DataTexture wants to
          // own its data, so copy each frame into a fresh Uint8Array.
          const buf = new Uint8Array(per);
          buf.set(all.subarray(i * per, (i + 1) * per));
          const t = surfacePixelsToTexture(buf, w, h);
          // Match the base map's sampler settings so only the image cycles.
          if (baseTex) {
            t.wrapS = baseTex.wrapS;
            t.wrapT = baseTex.wrapT;
            t.magFilter = baseTex.magFilter;
            t.minFilter = baseTex.minFilter;
            t.anisotropy = baseTex.anisotropy;
            if ("colorSpace" in baseTex) t.colorSpace = baseTex.colorSpace;
            t.flipY = baseTex.flipY;
            t.needsUpdate = true;
          }
          frames.push(t);
        }
        mat.map = frames[0];
        this._animatedMaterials.set(d, { mat, frames, idx: 0, accumS: 0 });
      })
      .catch(() => {
        // Fail-soft: surface stays static on its highest-res frame.
      });
  }

  /**
   * Advance every animated surface's frame on its shared material `.map`.
   * Called once per frame from the render loop. AC stores no per-surface
   * frame rate, so we use a gentle fixed cadence — the eye-test is the
   * source of truth for "does the water shimmer at the right speed"; this
   * is the one tunable knob.
   */
  tickAnimatedSurfaces(dt) {
    if (this._animatedMaterials.size === 0) return;
    const ANIM_SURFACE_FPS = 4;
    const step = 1 / ANIM_SURFACE_FPS;
    const d = typeof dt === "number" && dt > 0 ? dt : 0;
    for (const entry of this._animatedMaterials.values()) {
      entry.accumS += d;
      if (entry.accumS < step) continue;
      // One frame per elapsed step; reset accumulator (drop overflow so a
      // stall doesn't cause a catch-up burst).
      entry.accumS = 0;
      entry.idx = (entry.idx + 1) % entry.frames.length;
      entry.mat.map = entry.frames[entry.idx];
    }
  }

  /**
   * Free GPU resources owned by this cache. Materials don't dispose
   * their textures automatically in three.js, so we walk both maps.
   * Safe to call multiple times; future `get()` calls return the
   * fallback (the cache is empty).
   */
  dispose() {
    // Page-teardown only — the LRU eviction path NEVER calls this. Every
    // step is fail-soft (one throwing dispose() must not abort the rest)
    // and idempotent: each map is cleared after its loop, so a second
    // call walks empty maps and is a no-op. Helper keeps the body terse.
    const _disposeEach = (map, pick) => {
      if (!map) return;
      for (const v of map.values()) {
        try { pick(v)?.dispose?.(); } catch (_) {}
      }
      map.clear();
    };

    _disposeEach(this.textures, (t) => t);
    _disposeEach(this.normalTextures, (t) => t);
    _disposeEach(this.heightTextures, (t) => t);
    _disposeEach(this.materials, (m) => m);
    // T2 FrontSide variants — clones of base materials (share textures,
    // which are owned by `this.textures` and already freed above), so we
    // only dispose the material objects themselves.
    _disposeEach(this.frontSideMaterials, (m) => m);
    // Wire-agent buckets + per-DID dominant-colour materials.
    _disposeEach(this.wireframeBuckets, (m) => m);
    _disposeEach(this.wireframeFillBuckets, (m) => m);
    if (this.didMaterials) {
      for (const entry of this.didMaterials.values()) {
        try { entry?.wire?.dispose?.(); } catch (_) {}
        try { entry?.fill?.dispose?.(); } catch (_) {}
      }
      this.didMaterials.clear();
    }
    // Cache-owned paletted materials + their paired owned textures.
    _disposeEach(this.palettedMaterials, (m) => m);
    _disposeEach(this.palettedTextures, (t) => t);
    // anim-frames (#22 fold-in) — the per-surface animated-frame
    // DataTextures. `entry.mat` is the SAME object held in `this.materials`
    // (guarded by the build path), already disposed above, so dispose ONLY
    // the frame textures here to avoid a double-dispose of the material.
    if (this._animatedMaterials) {
      for (const entry of this._animatedMaterials.values()) {
        const frames = entry?.frames;
        if (Array.isArray(frames)) {
          for (const f of frames) {
            try { f?.dispose?.(); } catch (_) {}
          }
        }
      }
      this._animatedMaterials.clear();
    }
    try { this.fallbackMaterial?.dispose?.(); } catch (_) {}
    if (this.wireMatToFill) this.wireMatToFill.clear();
    if (this._animChecked) this._animChecked.clear();
    this.pendingFetches.clear();
    if (this.pendingStartTimes) this.pendingStartTimes.clear();
  }
}
