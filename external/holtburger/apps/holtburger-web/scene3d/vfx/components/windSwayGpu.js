// deformation.windSwayGpu — GPU instanced tree/foliage wind sway (MECH-B vertex,
// 2026-06-29). The cheap default-on replacement for the MECH-A windBend peel.
//
// THE POINT: make the ~4100 frozen-instanced Holtburg trees sway WITHOUT
// de-instancing. The MECH-A windBend path (animated_scenery keyframe player)
// peeled each tree out of the InstancedMesh into ~17k individual per-part meshes
// -> 1 fps / 968 ms CPU on a real GTX 1070 (commit 968139a4, which flipped that
// peel to default-OFF for exactly this reason). This component instead applies a
// height-weighted horizontal shear in the VERTEX shader on the SHARED instanced
// material clone — one draw call, one program, ~free — so the trees keep their
// frozen InstancedMesh batching AND sway. It rides the SAME getCachedVariant
// install path as tipFlex (frag_install PATCH_MECHS includes "B"); frag_attach
// injects it for every windResponds() DID (the exact selector the old default-on
// peel used, so the swaying set matches).
//
// OBJECT SPACE, Z-up: static geometry vertices are AC object space — the Z-up ->
// THREE Y-up conversion is the `worldRoot` parent transform (statics.js:263),
// NOT baked into the vertices — so `transformed.z` is height and the bend lives
// in the object XY plane. This matches wind_rig.js, which does all its math in
// Z-up model space too.
//
// MODEL-INVARIANT (the central constraint): the frag material is keyed by SURFACE
// DID and SHARED across tree models of different heights. A base-anchored shear
// needs NO per-model height uniform — the per-vertex z supplies the gradient — so
// ONE shared clone is correct for a 1.25 m fern AND a 22 m tree. The pivot is the
// model base (z = uWindBaseZ ~ 0): max(0, z - base) plants the trunk base and
// grows the displacement linearly with height (a small-angle hinge == a shear:
// for the few degrees of sway here the height drop from a true rotation is
// sub-centimetre, invisible). All knobs (amp/freq/dir/base/flutter) are GLOBAL
// uniforms -> config-INVARIANT GLSL -> ONE program per SET (linkVariant "").
//
// THE FIREWALL (spec §1.2, mirrors tipFlex): reads uTime (the shared VFX clock,
// bound by-ref from VFX_GLOBALS) + vVfxHash (the slice-03 per-instance phase
// varying) + the geometry; writes ONLY a cloned material's vertex `transformed`.
// Touches no wire value, no physics/collision (the BSP is untouched; entities
// setPose copy() can't be desynced — statics don't move), no replicated field;
// deterministic (uTime + hash, no Math.random); no light-count change.
//
// PER-INSTANCE DIRECTION NOTE (v1): uWindDir2 is an OBJECT-space base direction.
// Each placement bakes a yaw into its instanceMatrix, so a fixed object-space
// direction yields VARIED world-space lean directions across a stand of trees —
// which reads naturally for a forest (and avoids the "every tree leans like a
// flag" look). A true world-uniform wind would need the per-instance inverse yaw
// in-shader; deferred. Per-instance PHASE is already decorrelated via vVfxHash.
//
// JS-ONLY (no wasm rebuild): pure JS + GLSL string surgery, node-testable. No
// backticks anywhere in the GLSL (a backtick would close a JS string literal).

import { registerComponent } from "../registry.js";
import { ensureVfxHashVarying, VFX_HASH_ASSIGN_VERTEX } from "../per_instance.js";
// components/ -> vfx/ -> scene3d/tree_wind.js. tree_wind imports nothing from the
// scene graph, so this leaf stays import-cycle-safe + node-testable.
import { windSwayGpuEnabled, treeWindStrength, treeWindDir } from "../../tree_wind.js";

// Markers (idempotency guard + readable shader dumps).
const WINDSWAY_MARKER = "VFX_WINDSWAY_BEGIN";
const WINDSWAY_END = "VFX_WINDSWAY_END";

// Insert a `uniform ...;` declaration into the VERTEX shader once (idempotent +
// collision-safe: uTime is the shared VFX clock, so a second declaration would be
// a GLSL redeclaration error). Mirrors tipFlex._ensureVertexDecl.
function _ensureVertexDecl(vertexShader, decl) {
  return vertexShader.indexOf(decl) === -1
    ? vertexShader.replace("void main() {", decl + "\nvoid main() {")
    : vertexShader;
}

// The vertex displacement snippet. Config-INVARIANT GLSL (amp/freq/dir/base/
// flutter all ride uniforms) so every config compiles to ONE program. Spliced
// AFTER the per-instance-hash assignment so `vVfxHash` is written before read.
function _windSwaySnippet() {
  return [
    "  // ---- " + WINDSWAY_MARKER + " (deformation.windSwayGpu, MECH-B vertex) ----",
    "  // Height-weighted horizontal shear of tree/foliage geometry. OBJECT SPACE,",
    "  // AC Z-up (transformed.z = height; bend in the XY plane). Base-anchored ->",
    "  // model-invariant: no per-model height uniform, so ONE shared clone is",
    "  // correct for foliage of any height. Config-INVARIANT (all knobs ride",
    "  // uniforms) -> ONE program.",
    "  {",
    "    // Height above the model base; clamped so anything at/below the pivot",
    "    // plane stays planted (trunk base never drifts).",
    "    float _wsHeight = max(0.0, transformed.z - uWindBaseZ);",
    "    // Per-instance phase from the per-object hash VARYING (decorrelates a",
    "    // stand of trees). vVfxHash is slice-03 infra (procedural, rides the",
    "    // per-instance matrix) — NO per-instance program key.",
    "    float _wsPhase = vVfxHash * 6.2831853;",
    "    // uTime is the single shared VFX clock (bound by-ref from VFX_GLOBALS,",
    "    // advanced once/frame by the oscillator tick). Two bands: a slow primary",
    "    // sway + a faster, lower-amplitude flutter (decorrelated phase) for life.",
    "    float _wsT = uTime * 6.2831853 * uWindFreq;",
    "    float _wsOsc = sin(_wsT + _wsPhase)",
    "                 + uWindFlutter * sin(_wsT * 3.7 + _wsPhase * 1.7 + 1.3);",
    "    // Displacement grows linearly with height -> the canopy leans, the base",
    "    // is planted. uWindAmp already folds in ?treeWindStrength.",
    "    vec2 _wsDisp = uWindDir2 * (uWindAmp * _wsHeight * _wsOsc);",
    "    // PURELY ADDITIVE to transformed; weight 0 at the base means zero drift",
    "    // there regardless of pivot precision. Normal left untouched: the sway is",
    "    // a few degrees, so lighting drift on (often alpha-tested, double-sided)",
    "    // foliage is imperceptible — keeps the snippet branchless + one program.",
    "    transformed.x += _wsDisp.x;",
    "    transformed.y += _wsDisp.y;",
    "  }",
    "  // ---- " + WINDSWAY_END + " ----",
  ].join("\n");
}

export const windSwayGpu = {
  id: "deformation.windSwayGpu",
  family: "deformation",
  mech: "B",
  channel: "transform",
  // Config-invariant GLSL (amp/freq/dir/base/flutter ride uniforms) -> adds no
  // LINK-affecting bits -> ONE program per SET.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // LIVE per-effect gate. windSwayGpuEnabled() is DEFAULT-ON but stands down when
  // the user opts into the MECH-A peel (?treeWind/?windGeo own the sway then) or
  // ?treeWindGpu=off / ?visual=off. Off => the entry is dropped at the frag seam
  // => no vertex patch => byte-identical frozen instanced render.
  enabled: windSwayGpuEnabled,
  // Legacy-safety manifest (spec §1.2): geometry + the client clock + a derived
  // per-instance hash in; a cloned-material vertex output out. Nothing replicated.
  reads: ["geometry", "clock", "instanceHash"],
  writes: ["materialUniform"],
  // baseAmp is the shear coefficient (displacement-per-metre-of-height at unit
  // oscillation, before ?treeWindStrength); freqHz the primary sway rate; flutter
  // the secondary-band weight; baseZ the object-space pivot plane.
  defaults: { baseAmp: 0.03, freqHz: 0.15, flutter: 0.3, baseZ: 0.0 },

  /**
   * Bind this component's uniforms onto the compiling shader. Called by
   * installVfxComponentPatch inside onBeforeCompile. uTime is bound BY REFERENCE
   * from the shared VFX_GLOBALS so the single per-frame oscillator tick drives
   * it; the wind frame (amp/freq/dir/base/flutter) are per-variant scalars
   * (config + the live ?treeWindStrength/?treeWindDir flags — never a program key).
   * @param {{uniforms:object}} shader
   * @param {{baseAmp?:number, freqHz?:number, flutter?:number, baseZ?:number}} [config]
   * @param {{uTime:{value:number}}} [globals]  VFX_GLOBALS (by reference)
   */
  declareUniforms(shader, config, globals) {
    const cfg = { ...windSwayGpu.defaults, ...(config || {}) };
    const g = globals || {};
    shader.uniforms = shader.uniforms || {};
    // Shared clock, by reference (dormant {value:0} fallback if a caller omits
    // globals — keeps the component inert rather than crashing, never forks the clock).
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    const strength = treeWindStrength();             // ?treeWindStrength (0..4, default 1)
    const dirRad = treeWindDir() * Math.PI / 180;    // ?treeWindDir (deg, default 135/SE)
    shader.uniforms.uWindAmp = { value: (Number(cfg.baseAmp) || 0) * strength };
    shader.uniforms.uWindFreq = { value: Number(cfg.freqHz) || 0 };
    // Plain {x,y} is a valid vec2 uniform: three's setValueV2f reads v.x/v.y
    // directly (no THREE import needed — keeps this leaf node-testable, like tipFlex).
    shader.uniforms.uWindDir2 = { value: { x: Math.cos(dirRad), y: Math.sin(dirRad) } };
    shader.uniforms.uWindBaseZ = { value: Number(cfg.baseZ) || 0 };
    shader.uniforms.uWindFlutter = { value: Number(cfg.flutter) || 0 };
  },

  /**
   * Patch the COLOR vertex shader: declare uniforms, guarantee the per-instance
   * hash varying is present + assigned, then splice the height-weighted shear at
   * the begin_vertex seam (after the hash assignment, so vVfxHash is written
   * before it is read). No-op (byte-identical) if the seam is absent (a
   * non-standard material) or the patch is already present (recompile-safe). Only
   * the color shader is edited — the shadow/depth pass uses a separate, unpatched
   * material, so casters keep rest-pose geometry (acceptable sub-degree shadow
   * drift for a gentle sway).
   * @param {{vertexShader:string}} shader
   */
  inject(shader) {
    let vs = shader.vertexShader || "";
    if (vs.indexOf(WINDSWAY_MARKER) !== -1) return;           // already patched (recompile)
    if (vs.indexOf("#include <begin_vertex>") === -1) return; // non-standard material — inert

    // 1) Declare uniforms (uTime shared; the rest windSway-private).
    vs = _ensureVertexDecl(vs, "uniform float uTime;");
    vs = _ensureVertexDecl(vs, "uniform float uWindAmp;");
    vs = _ensureVertexDecl(vs, "uniform float uWindFreq;");
    vs = _ensureVertexDecl(vs, "uniform vec2 uWindDir2;");
    vs = _ensureVertexDecl(vs, "uniform float uWindBaseZ;");
    vs = _ensureVertexDecl(vs, "uniform float uWindFlutter;");
    shader.vertexShader = vs;

    // 2) Guarantee the per-instance hash varying + its derivation are present AND
    //    ASSIGNED before we read vVfxHash. Idempotent if the SET's sharedPrelude
    //    already did it (statics supplies the VFX_HASH_PRELUDE first in the chain).
    ensureVfxHashVarying(shader);

    // 3) Splice the displacement immediately AFTER the hash-assign block (itself
    //    right after begin_vertex) so vVfxHash is written before we read it.
    //    Anchor on the EXPORTED VFX_HASH_ASSIGN_VERTEX constant (never hardcoded
    //    text -> stays in lockstep with per_instance.js). Fallback to begin_vertex.
    const cur = shader.vertexShader;
    if (cur.indexOf(VFX_HASH_ASSIGN_VERTEX) !== -1) {
      shader.vertexShader = cur.replace(
        VFX_HASH_ASSIGN_VERTEX,
        VFX_HASH_ASSIGN_VERTEX + "\n" + _windSwaySnippet(),
      );
    } else {
      shader.vertexShader = cur.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" + _windSwaySnippet(),
      );
    }
  },
};

registerComponent(windSwayGpu);
export default windSwayGpu;
