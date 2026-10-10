// emissive.weaponAura — the element glow and the blade-shine sweep of a held or
// dropped item (2026-10-10). On ENTITIES it replaces emissive.itemAura,
// emissive.glint and weathering.tarnish; those three are unchanged and still
// serve the static-placement path and `?weaponFx=off`.
//
// WHY. itemAura added a FLAT `tint * 0.5` to totalEmissiveRadiance over the
// whole item. The composer applies a 5x exposure before AgX, so that flat
// 0.25-0.5 became 1.2-2.5 at the tone mapper: every Magical weapon (most loot)
// washed out to a pale lavender-white silhouette, and the physical damage types
// (Slash / Pierce / Bludgeon) to plain white. glint's 0.4 sparkle saturated the
// same way, and with its phase re-rolled every frame on a moving weapon (the
// world-position hash) it flickered over random facets. tarnish's per-object
// patina amount came from the same hash and strobed.
//
// THIS COMPONENT. All intensities are in tone-mapper input units and pass
// through uWfxCal = K / exposure, so they land where they are meant to. Per
// element (weapon_class.AURA_BY_BIT):
//   magic      a soft rim pulse with a faint drifting shimmer (Magical items,
//              poison and the vital boosts in their own colours)
//   fire       flames licking toward the tip, flickering, a hot core
//   frost      a cold breathing rim and ice glitter twinkling on the steel
//   lightning  thin arcs crawling over the blade, re-struck ~15 times a second
//   acid       green blobs creeping down toward the grip
//   nether     the steel darkens under drifting smoke, a violet rim
// Held, the glow sits on the blade (the long side of the grip) and fades at the
// grip. A sweep of light runs up the steel every few seconds and on every swing
// (`uWfxShine`, scheduled by weapon_fx.js), masked to bright desaturated texels
// so leather and wood stay dark. A swing also flares the glow (`uWfxLevel`).
//
// FIREWALL: config-invariant GLSL, everything rides the per-weapon uniforms
// (bound by reference from `globals.wfx`) and the shared clock (uTime). ONE
// program per component SET. No light, no draw call, no per-instance key.

import { registerComponent } from "../registry.js";
import {
  WFX_AURA_MARKER,
  WFX_AXIAL_MARKER,
  WFX_AXIAL_VERTEX,
  WFX_AURA_FRAGMENT,
  WFX_FRAG_NOISE,
  WFX_NOISE_GUARD,
  WFX_VERT_FRAME_DECLS,
  WFX_VARYING_DECLS,
  WFX_FRAG_DECLS,
  ensureDecls,
} from "../weapon_fx_glsl.js";
import { weaponAuraEnabled, weaponShineEnabled } from "../../vfx_flags.js";

const EMISSIVE_SEAM = "#include <emissivemap_fragment>";
// Only physically-based materials carry metalnessFactor at the seam.
const PBR_SEAM = "#include <metalnessmap_fragment>";

function _inert() {
  return {
    uWfxOrigin: { value: { x: 0, y: 0, z: 0 } },
    uWfxAxis: { value: { x: 0, y: 0, z: 1 } },
    uWfxLen: { value: { x: 1, y: 1 } },
    uWfxFrame: { value: 0 },
    uWfxGrip: { value: 0 },
    uWfxAuraColor: { value: { x: 0, y: 0, z: 0 } },
    uWfxAuraKind: { value: 0 },
    uWfxLevel: { value: 1 },
    uWfxShine: { value: { x: -1e4, y: 0.5, z: 0, w: 0 } },
    uWfxSeed: { value: 0 },
    uWfxCal: { value: 0 },
  };
}

export const weaponAura = {
  id: "emissive.weaponAura",
  family: "emissive",
  mech: "frag",
  channel: "aura",
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // The component hosts two effects; it is live while either is.
  enabled: () => weaponAuraEnabled() || weaponShineEnabled(),
  reads: ["weenieProps", "surface", "geometry", "clock"],
  writes: ["materialUniform"],
  defaults: {},

  /**
   * Bind the per-weapon uniforms BY REFERENCE (weapon_fx.js writes them) and
   * the shared clock.
   * @param {{uniforms:object}} shader
   * @param {object} [_config]
   * @param {{uTime?:{value:number}, wfx?:object}} [globals]
   */
  declareUniforms(shader, _config, globals) {
    const g = globals || {};
    const w = g.wfx || _inert();
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    for (const k of [
      "uWfxOrigin", "uWfxAxis", "uWfxLen", "uWfxFrame", "uWfxGrip",
      "uWfxAuraColor", "uWfxAuraKind", "uWfxLevel", "uWfxShine", "uWfxSeed", "uWfxCal",
    ]) {
      shader.uniforms[k] = w[k];
    }
  },

  /**
   * Vertex: the axial varying (after begin_vertex). Fragment: the noise
   * helpers + the glow/shine block after the emissivemap seam. Idempotent;
   * inert on a non-PBR material (no metalnessFactor) or one without the seams.
   * @param {{vertexShader:string, fragmentShader:string}} shader
   */
  inject(shader) {
    let fs = shader.fragmentShader || "";
    let vs = shader.vertexShader || "";
    if (fs.indexOf(WFX_AURA_MARKER) !== -1) return;
    if (fs.indexOf(EMISSIVE_SEAM) === -1 || fs.indexOf(PBR_SEAM) === -1) return;
    if (vs.indexOf("#include <begin_vertex>") === -1) return;
    if (vs.indexOf(WFX_AXIAL_MARKER) === -1) {
      vs = ensureDecls(vs, WFX_VERT_FRAME_DECLS);
      vs = ensureDecls(vs, WFX_VARYING_DECLS);
      vs = vs.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + WFX_AXIAL_VERTEX);
    }
    fs = ensureDecls(fs, WFX_FRAG_DECLS);
    fs = ensureDecls(fs, WFX_VARYING_DECLS);
    if (fs.indexOf(WFX_NOISE_GUARD) === -1) {
      fs = fs.replace("void main() {", WFX_FRAG_NOISE + "\nvoid main() {");
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs.replace(EMISSIVE_SEAM, EMISSIVE_SEAM + "\n" + WFX_AURA_FRAGMENT);
  },
};

registerComponent(weaponAura);
export default weaponAura;
