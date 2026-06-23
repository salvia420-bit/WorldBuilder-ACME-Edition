// VFX shadow-pass guard (Visual-Behavior Suite, spec §8) — 2026-06-23.
//
// Phase-1 frag effects (emissive.* / weathering.*) patch a CLONED color
// material via materials.js getCachedVariant -> _chainBeforeCompile. THE
// INVARIANT this module protects:
//
//   the VFX patch touches the COLOR pass ONLY — never the shadow/depth WRITE.
//
// WHY that already holds in three.js r184, BY CONSTRUCTION:
//   WebGLShadowMap.getDepthMaterial (three.module.js:9454-9541) renders shadow
//   casters with the SHARED internal _depthMaterial (a MeshDepthMaterial,
//   :9080) / _distanceMaterial (a MeshDistanceMaterial, :9081) — UNLESS the
//   object sets object.customDepthMaterial / object.customDistanceMaterial.
//   From the source color material it copies ONLY a fixed property allowlist
//   (:9504-9530, mirrored in DEPTH_PASS_COPY_KEYS below): visible, wireframe,
//   side, alphaMap, alphaTest, map, clip*, displacement*, wireframeLinewidth,
//   linewidth. It NEVER copies onBeforeCompile, customProgramCacheKey,
//   userData, emissive*, roughness/metalness or uniforms — i.e. NEVER our
//   patch. The internal depth material compiles its OWN default program. (The
//   _materialCache branch :9477-9498 clones the INTERNAL depth material, not
//   our color material, so still no patch.) Precedent: getCachedFloorBias's
//   gl_FragDepth nudge (materials.js applyFloorDepthBias) is likewise a color-
//   pass-only onBeforeCompile patch that has shipped without touching shadows.
//
//   => The ONLY way to leak a VFX patch into the depth pass is to assign a VFX
//      color variant as object.customDepthMaterial / customDistanceMaterial.
//      This module makes that the single guarded invariant: frag_install
//      (slice 02) leaves both unset (three uses the internal _depthMaterial)
//      and calls assertNoVfxDepthLeak(); the CI test asserts the same.
//
// Receiving shadows is UNAFFECTED (spec §18 R11): shadow RECEPTION lives in the
// lit color program's standard shadowmap_* chunks, which the clone keeps
// verbatim — the patch only ADDS to diffuse/emissive. So frag surfaces still
// RECEIVE and CAST shadows; only the depth-WRITE stays unpatched.
//
// Three-free on purpose (duck-typed, like lint_caps.js): runs under plain
// `node`, imports no three, emits no GLSL. Lives in scene3d/vfx/ (infra), NOT
// scene3d/vfx/components/, so the legacy-safety component scan does not treat
// it as a component.

// The exact set three.js copies (color material -> internal depth material),
// from WebGLShadowMap.getDepthMaterial (three.module.js:9504-9530). This is
// both documentation and the basis for the executable spec below. If a future
// three upgrade widens this set to include a patch-bearing key, the test fails.
export const DEPTH_PASS_COPY_KEYS = Object.freeze([
  "visible", "wireframe", "side",
  "alphaMap", "alphaTest", "map",
  "clipShadows", "clippingPlanes", "clipIntersection",
  "displacementMap", "displacementScale", "displacementBias",
  "wireframeLinewidth", "linewidth",
]);

// The userData tag materials.js getCachedVariant stamps on every VFX color
// variant. Truthy => this material carries a color-pass-only patch that must
// NEVER be routed into a depth/distance pass.
export const VFX_COLOR_PASS_TAG = "__vfxColorPassOnly";

/** True if `material` is a VFX-patched color variant (must stay color-pass-only). */
export function isVfxColorVariant(material) {
  const u = material && material.userData;
  return !!(u && (u[VFX_COLOR_PASS_TAG] || u.__vfxSetKey));
}

/**
 * Assert a shadow-casting object never routes a VFX color variant into the
 * depth/distance pass. Returns errors[] ([] = clean), lint_caps.js style.
 * frag_install MUST leave customDepthMaterial / customDistanceMaterial unset
 * (so three uses its shared internal depth material) — this catches the one
 * regression that would corrupt the shadow write. O(1); safe to call per node.
 * @param {{name?:string, customDepthMaterial?:object, customDistanceMaterial?:object}} object
 */
export function assertNoVfxDepthLeak(object) {
  const errs = [];
  if (!object) return errs;
  if (isVfxColorVariant(object.customDepthMaterial)) {
    errs.push(`${object.name || "<obj>"}: customDepthMaterial is a VFX color variant ` +
      `(would leak the patch into the directional/spot shadow write)`);
  }
  if (isVfxColorVariant(object.customDistanceMaterial)) {
    errs.push(`${object.name || "<obj>"}: customDistanceMaterial is a VFX color variant ` +
      `(would leak the patch into the point-light shadow write)`);
  }
  return errs;
}

/**
 * Pure, three-free reproduction of getDepthMaterial's no-custom-material copy
 * step (three.module.js:9460-9530): start from a BARE internal depth material
 * and copy ONLY the allowlist. The returned object demonstrably carries NONE of
 * the VFX patch (onBeforeCompile / customProgramCacheKey / userData.__vfx*).
 * @param {object} colorMaterial  the (possibly VFX-patched) color material
 * @param {object} internalDepth  stand-in for the shared _depthMaterial (bare)
 */
export function projectDepthMaterial(colorMaterial, internalDepth = {}) {
  const depth = internalDepth;
  for (const k of DEPTH_PASS_COPY_KEYS) {
    if (colorMaterial && k in colorMaterial) depth[k] = colorMaterial[k];
  }
  return depth;
}

/**
 * Structural proof that the patch is color-pass-only even when `colorMaterial`
 * IS VFX-patched: project it onto a bare depth material and assert none of the
 * patch-bearing keys transferred. Returns errors[] ([] = clean).
 */
export function assertDepthMaterialUnpatched(colorMaterial) {
  const errs = [];
  const depth = projectDepthMaterial(colorMaterial, {});
  if ("onBeforeCompile" in depth) errs.push("depth material received onBeforeCompile (patch leaked)");
  if ("customProgramCacheKey" in depth) errs.push("depth material received customProgramCacheKey (patch leaked)");
  if ("userData" in depth) errs.push("depth material received userData (patch markers leaked)");
  return errs;
}
