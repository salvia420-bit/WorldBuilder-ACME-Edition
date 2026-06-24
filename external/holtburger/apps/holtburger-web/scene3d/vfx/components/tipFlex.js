// deformation.tipFlex — the FIRST GPU vertex-displacement (MECH-B) component
// (Visual-Behavior Suite, Phase 2, 2026-06-24). The tip-flex archetype's
// signature effect: a thin weapon shaft (spear / staff) that sways/whips,
// weighted 0 at the grip -> 1 at the distal tip (design doc §2.2 mech-B, §4.1
// deform catalog; classifier rule "tip-flex").
//
// MECH-B: a VERTEX patch on a CLONED, cache-owned material (materials.js
// getCachedVariant), composed onto the single _chainBeforeCompile chain in
// FAMILY_ORDER (deformation = 0, so tipFlex runs BEFORE the SET's frag entries).
// The snippet lands in the VERTEX shader at the `#include <begin_vertex>` seam —
// it modifies the `transformed` vec3 (the object-space vertex position three
// later feeds to project_vertex) by an axial-weighted rotation about the grip
// pivot. No new attribute, no draw call, no light slot, no relink.
//
// THE COMBINED-SET DESIGN (kit central constraint): the tip-flex SET is
// [deformation.tipFlex (vertex/mech B), emissive.glint (frag)] — ONE material
// variant carries BOTH, via ONE getCachedVariant call whose setKey spans the
// whole set. Each entry dispatches to its OWN seam: tipFlex -> vertexShader
// begin_vertex; glint -> fragmentShader emissivemap_fragment. tipFlex is
// installed via the SAME installVfxComponentPatch path as the frag entries (it
// just patches vertexShader instead of fragmentShader), so there is ONE
// compiled program per SET and ONE __vfxSetKey. (P2.1 generalizes the install
// path to admit this mech-B entry — see frag_install.PATCH_MECHS.)
//
// THE FIREWALL: ampDeg / freqHz / the shaft frame (axis/gripBase/shaftLen) flow
// ONLY through uniforms; per-instance phase rides the `vVfxHash` varying
// (slice-03 per-instance infra) — NEVER a per-instance customProgramCacheKey.
// One program per component-SET (linkVariant "" — tipFlex's GLSL string is
// config-independent), never one per DID.
//
// THE RULE (§1.2): reads the client clock (uTime), a derived per-instance hash
// (vVfxHash), and the weapon's GfxObj vertex bbox (the shaft frame uniforms);
// writes ONLY a cloned-material's vertex output (`transformed`). Touches no wire
// value, no physics/collision (the BSP is untouched; entities.js setPose copy()
// stomps render-frame writes every server tick — desync-proof), no replicated
// field; deterministic (uTime + hash, no Math.random); no light-count change.
//
// JS-ONLY (no wasm rebuild): pure JS + GLSL string surgery, node-testable.

import { registerComponent } from "../registry.js";
import { ensureVfxHashVarying, VFX_HASH_ASSIGN_VERTEX } from "../per_instance.js";
import { tipFlexEnabled } from "../../vfx_flags.js"; // components/ -> vfx/ -> scene3d/vfx_flags.js

// Markers (idempotency guard + readable shader dumps). No backticks anywhere in
// the GLSL — a backtick would close a JS literal.
const TIPFLEX_MARKER = "VFX_TIPFLEX_BEGIN";
const TIPFLEX_END = "VFX_TIPFLEX_END";

// Coerce a config axis (array [x,y,z] | object {x,y,z} | absent) to a plain
// {x,y,z} value object. three's setValueV3f reads v.x/v.y/v.z directly
// (three.module.js setValueV3f), so a plain object is a valid vec3 uniform — no
// THREE import needed (keeps this leaf node-testable, like glint).
function _vec3(v, dx, dy, dz) {
  if (Array.isArray(v) && v.length >= 3) return { x: +v[0], y: +v[1], z: +v[2] };
  if (v && typeof v === "object" && v.x !== undefined) return { x: +v.x, y: +v.y, z: +v.z };
  return { x: dx, y: dy, z: dz };
}

// Insert a `uniform ...;` declaration into the VERTEX shader once (idempotent +
// collision-safe: uTime is the shared VFX clock, so a second declaration would
// be a GLSL redeclaration error). Mirrors glint._ensureUniformDecl but for the
// vertex stage (glint only ever touches the fragment shader).
function _ensureVertexDecl(vertexShader, decl) {
  return vertexShader.indexOf(decl) === -1
    ? vertexShader.replace("void main() {", decl + "\nvoid main() {")
    : vertexShader;
}

// Build the vertex displacement snippet. Config-INVARIANT GLSL (amplitude,
// frequency, and the shaft frame all ride uniforms) so every config compiles to
// ONE program. Spliced AFTER the per-instance-hash assignment so `vVfxHash` is
// written before it is read in the vertex stage.
function _tipFlexSnippet() {
  return [
    "  // ---- " + TIPFLEX_MARKER + " (deformation.tipFlex, MECH-B vertex) ----",
    "  // Axial-weighted whip of a thin shaft about its grip pivot. OBJECT SPACE,",
    "  // config-INVARIANT GLSL (amp/len/freq/axis all ride uniforms) -> ONE program.",
    "  {",
    "    vec3 _tfAxis = normalize(uShaftAxis);",
    "    // Axial coordinate measured from the grip end, normalized to [0,1] across",
    "    // the shaft (uGripBase = proximal Zmin, uShaftLen = Zmax-Zmin along axis).",
    "    float _tfS = (dot(transformed, _tfAxis) - uGripBase) / max(uShaftLen, 1e-4);",
    "    _tfS = clamp(_tfS, 0.0, 1.0);",
    "    // Tip weight: 0 at the grip -> 1 at the distal tip. The 'weightCurve:",
    "    // smoothstep' default is BAKED here for v1, keeping the GLSL config-invariant",
    "    // (a different curve would need a linkVariant() token -> deferred).",
    "    float _tfW = smoothstep(0.0, 1.0, _tfS);",
    "    // Per-instance phase from the per-object hash VARYING (decorrelates spears).",
    "    // vVfxHash is slice-03 infra (procedural, rides the per-instance matrix) —",
    "    // NO per-instance program key.",
    "    float _tfPhase = vVfxHash * 6.2831853;",
    "    // Sway angle (radians). uTime is the single shared VFX clock (bound by-ref",
    "    // from VFX_GLOBALS, driven once/frame by the oscillator tick).",
    "    float _tfAng = uTipAmpRad * _tfW * sin(uTime * 6.2831853 * uTipFreq + _tfPhase);",
    "    // Stable perpendicular to the shaft (the whip plane). The fallback ref",
    "    // avoids a degenerate cross() when the axis ~parallels the primary ref.",
    "    vec3 _tfRef = (abs(_tfAxis.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);",
    "    vec3 _tfPerp = normalize(cross(_tfAxis, _tfRef));",
    "    // Grip pivot: the point at uGripBase along the shaft axis (object space).",
    "    vec3 _tfPivot = _tfAxis * uGripBase;",
    "    vec3 _tfRel = transformed - _tfPivot;",
    "    // Rodrigues rotation of the grip-relative position about _tfPerp by _tfAng.",
    "    float _tfC = cos(_tfAng);",
    "    float _tfSn = sin(_tfAng);",
    "    vec3 _tfRot = _tfRel * _tfC",
    "                + cross(_tfPerp, _tfRel) * _tfSn",
    "                + _tfPerp * dot(_tfPerp, _tfRel) * (1.0 - _tfC);",
    "    // PURELY ADDITIVE to transformed. Weight 0 at the grip -> zero displacement",
    "    // there, so the grip stays anchored regardless of pivot precision; touches",
    "    // nothing else (normal/uv/position untouched).",
    "    transformed += (_tfRot - _tfRel);",
    "    // ---- P2.4 NORMAL-RECOMPUTE (analytic, EXACT for a rigid rotation; NOT a finite diff) ----",
    "    // The position underwent the rigid Rodrigues rotation R(_tfAng) about _tfPerp, so the",
    "    // OBJECT-space normal is carried by the SAME R. Reuse _tfPerp/_tfC/_tfSn (no extra trig).",
    "    // Gated by uTipNormalFix (1=recompute B / 0=keep baked normal A) so the A/B choice is a",
    "    // UNIFORM FLIP -> ONE program, no relink (?tipFlexNormals=on|off). When 0, vNormal is",
    "    // left untouched -> the exact <normal_vertex> value (true accept-drift).",
    "    if (uTipNormalFix > 0.5) {",
    "      vec3 _tfNobj = objectNormal * _tfC",
    "                   + cross(_tfPerp, objectNormal) * _tfSn",
    "                   + _tfPerp * dot(_tfPerp, objectNormal) * (1.0 - _tfC);",
    "      // normalMatrix matches <defaultnormal_vertex> in DIRECTION for rotation+uniform-scale",
    "      // placements (the skipped USE_INSTANCING/USE_BATCHING inverse-scale cancels under",
    "      // normalize). Our seam runs AFTER <normal_vertex>, so this vNormal write wins.",
    "      vNormal = normalize(normalMatrix * _tfNobj);",
    "    }",
    "  }",
    "  // ---- " + TIPFLEX_END + " ----",
  ].join("\n");
}

export const tipFlex = {
  id: "deformation.tipFlex",
  family: "deformation",
  mech: "B",
  channel: "transform",
  // tipFlex's GLSL is identical for every config (amp/freq/shaft-frame ride
  // uniforms; the smoothstep weight curve is baked), so it adds no LINK-affecting
  // bits — ONE program per SET.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // LIVE per-effect default-OFF gate consulted at frag_attach.js:88. Off ?tipFlex
  // => the MECH-B entry is dropped from the plan at BOTH the statics and entity
  // seams => no vertex patch => byte-identical. (Without this, EDIT-3's widened
  // mech filter would render tipFlex on statics whenever ?visual is on.)
  enabled: tipFlexEnabled,
  // Legacy-safety manifest (spec §1.2): the weapon's GfxObj vertex bbox (geometry)
  // + the client clock + a derived per-instance hash in; a cloned-material vertex
  // output out. Nothing replicated. (reads ⊆ ALLOWED_READS, writes ⊆ ALLOWED_WRITES.)
  reads: ["geometry", "clock", "instanceHash"],
  writes: ["materialUniform"],
  // ampDeg/axis/weightCurve/gripAnchor mirror the classifier rule "tip-flex"
  // (visual_archetype_rules.jsonl); freqHz is the sway rate. axis/weightCurve/
  // gripAnchor are STRING tokens for the classifier/config layer; the NUMERIC
  // shaft frame (shaftAxis/gripBase/shaftLen) is fed at runtime (see below).
  defaults: { ampDeg: 1.5, axis: "shaftLong", weightCurve: "smoothstep", gripAnchor: "holdingLoc", freqHz: 0.6 },

  /**
   * Bind this component's uniforms onto the compiling shader. Called by
   * installVfxComponentPatch inside onBeforeCompile. uTime is bound BY REFERENCE
   * from the shared VFX_GLOBALS (passed as `globals`) so the single per-frame
   * oscillator tick drives it; ampDeg/freqHz + the shaft frame are per-variant
   * scalars (config-driven, uniform-only — never a program-key input).
   *
   * UNIFORM-FEED CONTRACT (coordinate with parts 07 wield-seam / 11 geometry):
   *   uShaftAxis (vec3) — unit long axis of the shaft in OBJECT space. The token
   *                       `axis:"shaftLong"` resolves to this numeric vector from
   *                       the GfxObj vertex bbox's longest extent. Default +Z.
   *   uGripBase  (float)— axial coord (dot(vtx, axis)) of the PROXIMAL/grip end
   *                       = the bbox Zmin along the axis. The grip frame anchor
   *                       (token `gripAnchor:"holdingLoc"`) comes from the wield
   *                       holding_locations frame (entities.js _holdingLocCache).
   *   uShaftLen  (float)— Zmax - Zmin along the axis (>0).
   * Parts 07/11 compute these from the atlan spear GfxObj (SetupModel 0x02000724)
   * and pass them in descriptor.config as { shaftAxis:[x,y,z], gripBase, shaftLen }.
   * The defaults below are inert-safe placeholders (subtle, grip-anchored) so the
   * effect never crashes or detaches before the real frame is wired.
   *
   * @param {{uniforms:object, vertexShader?:string}} shader
   * @param {{ampDeg?:number, freqHz?:number, shaftAxis?:number[], gripBase?:number, shaftLen?:number}} [config]
   * @param {{uTime:{value:number}}} [globals]  VFX_GLOBALS (by reference)
   */
  declareUniforms(shader, config, globals) {
    const cfg = { ...tipFlex.defaults, ...(config || {}) };
    const g = globals || {};
    shader.uniforms = shader.uniforms || {};
    // Shared clock, by reference (dormant {value:0} fallback if a caller omits
    // globals — keeps tipFlex inert rather than crashing, never forks the clock).
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    // ampDeg is DEGREES (the classifier-facing unit); the shader wants radians.
    shader.uniforms.uTipAmpRad = { value: (Number(cfg.ampDeg) || 0) * Math.PI / 180 };
    shader.uniforms.uTipFreq = { value: Number(cfg.freqHz) || 0 };
    // Numeric shaft frame (object space) — runtime-fed; inert-safe defaults.
    shader.uniforms.uShaftAxis = { value: _vec3(cfg.shaftAxis, 0, 0, 1) };
    shader.uniforms.uGripBase = { value: Number(cfg.gripBase) || 0 };
    shader.uniforms.uShaftLen = { value: Number(cfg.shaftLen) > 0 ? Number(cfg.shaftLen) : 1 };
    // P2.4 normal-recompute A/B toggle (?tipFlexNormals). 1 = exact analytic normal-rotate
    // (recommended default), 0 = accept baked-normal drift. Uniform-only -> never a program
    // key; flipping it rebinds a value, never relinks. Default ON (exact, ~free).
    shader.uniforms.uTipNormalFix = { value: (cfg.normalFix === false || cfg.normalFix === 0) ? 0 : 1 };
  },

  /**
   * Patch the COLOR vertex shader: declare tipFlex's uniforms, guarantee the
   * per-instance hash varying is present + assigned, then splice the axial-weighted
   * displacement at the begin_vertex seam (after the hash assignment, so vVfxHash
   * is written before it is read). No-op (byte-identical) if the seam is absent (a
   * non-standard material) or the patch is already present (recompile-safe). Only
   * the standard color shader is edited — the shadow/depth pass uses a separate,
   * unpatched depth material (getCachedVariant tags this clone __vfxColorPassOnly),
   * so casters keep rest-pose geometry: an acceptable sub-degree shadow drift for
   * v1 (revisit if amplitude grows).
   * @param {{vertexShader:string, fragmentShader?:string}} shader
   */
  inject(shader) {
    let vs = shader.vertexShader || "";
    if (vs.indexOf(TIPFLEX_MARKER) !== -1) return;            // already patched (recompile)
    if (vs.indexOf("#include <begin_vertex>") === -1) return; // non-standard material — inert

    // 1) Declare tipFlex's vertex uniforms (uTime shared; the rest tipFlex-private).
    vs = _ensureVertexDecl(vs, "uniform float uTime;");
    vs = _ensureVertexDecl(vs, "uniform float uTipAmpRad;");
    vs = _ensureVertexDecl(vs, "uniform float uTipFreq;");
    vs = _ensureVertexDecl(vs, "uniform vec3 uShaftAxis;");
    vs = _ensureVertexDecl(vs, "uniform float uGripBase;");
    vs = _ensureVertexDecl(vs, "uniform float uShaftLen;");
    vs = _ensureVertexDecl(vs, "uniform float uTipNormalFix;");
    shader.vertexShader = vs;

    // 2) Guarantee the per-instance hash varying + its derivation are present AND
    //    ASSIGNED before we read vVfxHash. ensureVfxHashVarying injects the assign
    //    right after begin_vertex; idempotent if the SET's sharedPrelude already
    //    did it (the [tipFlex, glint] SET always supplies it — glint reads the
    //    varying in the fragment stage).
    ensureVfxHashVarying(shader);

    // 3) Splice the displacement immediately AFTER the hash-assign block (itself
    //    right after begin_vertex) so vVfxHash is written before we read it in the
    //    vertex stage. _chainBeforeCompile runs prev-then-new, so a naive
    //    begin_vertex replace would land BEFORE the assign — hence anchoring on the
    //    EXPORTED VFX_HASH_ASSIGN_VERTEX constant (never hardcoded text -> stays in
    //    lockstep with per_instance.js). Defensive fallback to the begin_vertex seam.
    const cur = shader.vertexShader;
    if (cur.indexOf(VFX_HASH_ASSIGN_VERTEX) !== -1) {
      shader.vertexShader = cur.replace(
        VFX_HASH_ASSIGN_VERTEX,
        VFX_HASH_ASSIGN_VERTEX + "\n" + _tipFlexSnippet(),
      );
    } else {
      shader.vertexShader = cur.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" + _tipFlexSnippet(),
      );
    }
  },
};

registerComponent(tipFlex);
export default tipFlex;
