// scene3d/sway_shadow.js — `?swayShadow` (2026-10-07, DEFAULT ON; `=off`
// escape). Shadows of wind-swaying trees sway with them.
//
// deformation.windSwayGpu bends tree/foliage geometry in the VERTEX shader of
// the colour material only; three renders shadow maps with its own unpatched
// depth material, so every caster threw its REST-POSE shadow. windSwayGpu.js
// called that "acceptable sub-degree shadow drift" — which held only while the
// CSM receivers were broken (no shadows were visible at all). With shadows
// working the owner saw it at once on the 1070: "can we get the shadows of the
// swaying trees working, the shadows are still" (a 22 m canopy's tip travels
// ~0.6 m at default strength).
//
// THE FIX: one shared MeshDepthMaterial carrying the SAME windSwayGpu vertex
// patch (its own declareUniforms + inject, bound to the shared VFX clock by
// reference, so the shadow bends on the same frame as the tree), handed to
// every swaying caster as `customDepthMaterial`. three r184 uses a custom
// depth material as-is and copies the caster's `map` / `alphaTest` onto it per
// draw (WebGLShadowMap.getDepthMaterial), so cut-out leaves keep their cut-out
// shadow. One extra program, no per-object state beyond the reference.
//
// Swaying casters are recognised by the frag variant's set key
// (`userData.__vfxSetKey` contains "deformation.windSwayGpu" — the key
// frag_install stamps on every material that got the patch).

import * as THREE from "three";
import { windSwayGpu } from "./vfx/components/windSwayGpu.js";
import { VFX_GLOBALS } from "./materials.js";

const SWAY_ID = "deformation.windSwayGpu";

/** `?swayShadow` — default ON; `off`/`0`/`false`/`no` disables. */
export function swayShadowEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("swayShadow");
    if (v == null) return true;
    const lv = String(v).toLowerCase();
    return !(lv === "off" || lv === "0" || lv === "false" || lv === "no");
  } catch (_) {
    return true;
  }
}
const SWAY_SHADOW_ON = swayShadowEnabled();

/** True when `material` carries the GPU wind-sway vertex patch. */
export function isSwayMaterial(material) {
  const k = material?.userData?.__vfxSetKey;
  return typeof k === "string" && k.indexOf(SWAY_ID) !== -1;
}

let _depth = null;
/** The shared sway-aware shadow depth material (built on first use). */
export function swayDepthMaterial() {
  if (_depth) return _depth;
  const m = new THREE.MeshDepthMaterial();
  m.name = "sway-shadow-depth";
  m.onBeforeCompile = (shader) => {
    windSwayGpu.declareUniforms(shader, windSwayGpu.defaults, VFX_GLOBALS);
    windSwayGpu.inject(shader);
  };
  m.customProgramCacheKey = () => "hb-sway-shadow-depth";
  _depth = m;
  return m;
}

const stats = { assigned: 0 };

/**
 * Give a swaying shadow caster the sway depth material, once. Cheap enough
 * for the per-pass caster walk: one property read for every non-swaying mesh.
 * @returns {boolean} true when assigned on this call
 */
export function applySwayShadow(obj) {
  if (!SWAY_SHADOW_ON || !obj || obj.customDepthMaterial !== undefined) return false;
  if (!isSwayMaterial(obj.material)) return false;
  obj.customDepthMaterial = swayDepthMaterial();
  stats.assigned += 1;
  return true;
}

export function swayShadowStats() {
  return { enabled: SWAY_SHADOW_ON, assigned: stats.assigned, built: !!_depth };
}

if (typeof window !== "undefined") {
  window.__swayShadow = { stats: swayShadowStats };
}
