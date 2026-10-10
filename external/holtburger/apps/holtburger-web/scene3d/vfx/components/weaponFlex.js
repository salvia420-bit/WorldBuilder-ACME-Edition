// deformation.weaponFlex — the inertial shaft bend of a held pole weapon
// (2026-10-10, replaces deformation.tipFlex on ENTITIES; tipFlex itself is
// unchanged and still serves the static-placement path).
//
// WHY A NEW COMPONENT. tipFlex swayed every catalog "tip-flex" weapon (daggers,
// swords and maces included) on a constant 0.6 Hz sine whose phase came from
// the per-instance hash — and that hash is `vfxHash01(modelMatrix[3].xy)`, the
// mesh's WORLD position. A held weapon moves every frame, so the phase was
// re-rolled every frame: the "gyrating / shaking" weapons. Its shaft frame
// (axis / grip / length) was never fed either, so it pivoted about the model
// origin with a 1 m placeholder length.
//
// This one is driven by MOTION. scene3d/vfx/weapon_fx.js runs one small spring
// per shaft end each frame (a virtual tip chasing the real one, damped against
// the end's own velocity), and hands the result in as two rotation vectors in
// the weapon's object space. At rest nothing moves; at a run the tip sways a
// few tenths of a degree; at the end of a swing the shaft whips and settles.
// Only poles flex (spears, staffs, polearms — weapon_class.flexClassFor).
//
// MECH-B: a vertex patch at the #include <begin_vertex> seam, on a per-weapon
// material (MaterialCache.makeOwnedVariant) whose uniforms are bound BY
// REFERENCE from that weapon's uniform bundle (`globals.wfx`). The GLSL is
// config-invariant: ONE program per component SET. The shadow/depth pass draws
// the rest pose (three's internal depth material; a <= 7 degree drift).
//
// THE RULE: reads the weapon's mesh bounds (geometry), its rendered pose
// (serverPose — the held item's frame under its wielder's animated hand) and
// the clock; writes only cloned-material uniforms. No wire, no physics, no
// light-count change, deterministic.

import { registerComponent } from "../registry.js";
import {
  WFX_FLEX_MARKER,
  WFX_FLEX_VERTEX,
  WFX_VERT_FRAME_DECLS,
  WFX_VERT_FLEX_DECLS,
  ensureDecls,
} from "../weapon_fx_glsl.js";
import { weaponFlexEnabled } from "../../vfx_flags.js";

// Inert stand-ins when a caller installs the component without a weapon bundle
// (frame 0 ⇒ the snippet is a no-op). Plain {x,y,z} objects are valid vec3
// uniform values (three's setValueV3f reads .x/.y/.z).
function _inert() {
  return {
    uWfxOrigin: { value: { x: 0, y: 0, z: 0 } },
    uWfxAxis: { value: { x: 0, y: 0, z: 1 } },
    uWfxLen: { value: { x: 1, y: 1 } },
    uWfxFrame: { value: 0 },
    uWfxBendPos: { value: { x: 0, y: 0, z: 0 } },
    uWfxBendNeg: { value: { x: 0, y: 0, z: 0 } },
  };
}

export const weaponFlex = {
  id: "deformation.weaponFlex",
  family: "deformation",
  mech: "B",
  channel: "transform",
  // Config-invariant GLSL (everything rides the per-weapon uniforms).
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  enabled: weaponFlexEnabled,
  reads: ["geometry", "serverPose", "clock"],
  writes: ["materialUniform"],
  defaults: {},

  /**
   * Bind the per-weapon uniforms BY REFERENCE from `globals.wfx` (the bundle
   * weapon_fx.js owns and writes each frame). Without a bundle the inert
   * stand-ins keep the patch a no-op.
   * @param {{uniforms:object}} shader
   * @param {object} [_config]
   * @param {{wfx?:object}} [globals]
   */
  declareUniforms(shader, _config, globals) {
    const w = (globals && globals.wfx) || _inert();
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uWfxOrigin = w.uWfxOrigin;
    shader.uniforms.uWfxAxis = w.uWfxAxis;
    shader.uniforms.uWfxLen = w.uWfxLen;
    shader.uniforms.uWfxFrame = w.uWfxFrame;
    shader.uniforms.uWfxBendPos = w.uWfxBendPos;
    shader.uniforms.uWfxBendNeg = w.uWfxBendNeg;
  },

  /**
   * Splice the bend after #include <begin_vertex>. Idempotent (marker guard);
   * inert on a material without the seam.
   * @param {{vertexShader:string}} shader
   */
  inject(shader) {
    let vs = shader.vertexShader || "";
    if (vs.indexOf(WFX_FLEX_MARKER) !== -1) return;
    if (vs.indexOf("#include <begin_vertex>") === -1) return;
    vs = ensureDecls(vs, WFX_VERT_FRAME_DECLS);
    vs = ensureDecls(vs, WFX_VERT_FLEX_DECLS);
    shader.vertexShader = vs.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + WFX_FLEX_VERTEX);
  },
};

registerComponent(weaponFlex);
export default weaponFlex;
