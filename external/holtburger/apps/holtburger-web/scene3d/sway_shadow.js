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
// THE FIX: a MeshDepthMaterial carrying the SAME windSwayGpu vertex patch (its
// own declareUniforms + inject, bound to the shared VFX clock by reference, so
// the shadow bends on the same frame as the tree), handed to every swaying
// caster as `customDepthMaterial`.
//
// 2026-10-20 (improvement hunt open-frontier-perf-6) — ONE shared depth
// material was wrong for cut-out casters. three r184 uses a custom depth
// material as-is: it skips its own per-source variant cache
// (WebGLShadowMap.getDepthMaterial, `_materialCache[depth.uuid][material.uuid]`
// whenever map/alphaMap + alphaTest > 0) and just writes the caster's `map` /
// `alphaTest` / `side` onto the one object per draw. Two things followed:
//   1. STALE CUT-OUTS — setProgram refreshes material uniforms only when the
//      program or `material.id` changes, so two consecutive alpha-tested
//      casters with different maps (one id, one program) drew the second with
//      the FIRST one's map and alphaTest ref still bound: leaf B alpha-tested
//      its shadow against leaf A's texture (verified with a three r184 probe).
//   2. VERSION CHURN — the alphaTest setter bumps `version` on every 0-crossing,
//      so each trunk <-> leaf alternation re-resolved the program and refreshed
//      every uniform, per cascade (ledger lead 159).
// Now the depth materials mirror three's own rule: an alpha-tested caster
// material (alphaTest > 0, or alphaToCoverage, or an active displacementMap —
// three's per-source triggers, minus clipping planes, which no sway caster
// uses) gets its OWN sway depth material, keyed by that caster material; every
// other sway caster shares one. Each is built fresh (never `.clone()` — that
// drops onBeforeCompile) with the same patch, the same program key and the
// shared clock, so they all link the same programs three would pick; alphaTest
// never crosses 0 on any of them and a cut-out shadow always tests its own map.
// Only csm/shadows paths ever draw these (CSM is off in every preset).
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

// One hook + one key function shared by every sway depth material: same
// shader text, same program key, uniforms bound per compile (uTime by
// reference to the single VFX clock).
function _swayDepthOnBeforeCompile(shader) {
  windSwayGpu.declareUniforms(shader, windSwayGpu.defaults, VFX_GLOBALS);
  windSwayGpu.inject(shader);
}
function _swayDepthProgramKey() {
  return "hb-sway-shadow-depth";
}
// Same construction + property order for each, so all of them keep one hidden
// class (never Object.create / `.clone()` a material).
function _newSwayDepth(name) {
  const m = new THREE.MeshDepthMaterial();
  m.name = name;
  m.onBeforeCompile = _swayDepthOnBeforeCompile;
  m.customProgramCacheKey = _swayDepthProgramKey;
  return m;
}

/**
 * three r184's per-source depth-variant triggers (getDepthMaterial) for the
 * per-material state it writes onto the depth material every draw. alphaTest
 * > 0 counts even without a map / alphaMap: three would put that caster on its
 * shared material, but then its alphaTest would cross 0 there; with no texture
 * the depth shader's alpha is the depth material's own opacity (1), so its
 * own material draws the same depth either way.
 */
function _needsOwnDepth(m) {
  return !!m && (m.alphaTest > 0 || m.alphaToCoverage === true ||
    (!!m.displacementMap && m.displacementScale !== 0));
}

const stats = { assigned: 0, cutLive: 0, cutBuilt: 0 };

let _depth = null;
// caster material -> its own sway depth material. A WeakMap (three keys its
// cache by uuid strings): an evicted caster material that is never disposed
// still lets its depth material go with it (?matBudgetMB relies on GC).
const _cutDepth = new WeakMap();

// Mirrors three's onMaterialDispose for its own variants.
function _onCasterDispose(event) {
  const src = event.target;
  try { src.removeEventListener("dispose", _onCasterDispose); } catch (_) { /* fail-soft */ }
  const d = _cutDepth.get(src);
  if (!d) return;
  _cutDepth.delete(src);
  stats.cutLive -= 1;
  d.dispose();
}

/**
 * The sway-aware shadow depth material for caster material `source` (built on
 * first use): its own one when it alpha-tests (see `_needsOwnDepth`), else the
 * one shared by every non-cut-out sway caster. No argument = the shared one.
 */
export function swayDepthMaterial(source) {
  if (source && _needsOwnDepth(source)) {
    let d = _cutDepth.get(source);
    if (!d) {
      d = _newSwayDepth("sway-shadow-depth-cut");
      _cutDepth.set(source, d);
      stats.cutLive += 1;
      stats.cutBuilt += 1;
      if (typeof source.addEventListener === "function") source.addEventListener("dispose", _onCasterDispose);
    }
    return d;
  }
  if (!_depth) _depth = _newSwayDepth("sway-shadow-depth");
  return _depth;
}

/**
 * Give a swaying shadow caster its sway depth material, once. Cheap enough
 * for the per-pass caster walk: one property read for every non-swaying mesh.
 * The choice follows the caster's material at its first shadow walk (the
 * walk only calls this while `customDepthMaterial` is unset).
 * @returns {boolean} true when assigned on this call
 */
export function applySwayShadow(obj) {
  if (!SWAY_SHADOW_ON || !obj || obj.customDepthMaterial !== undefined) return false;
  if (!isSwayMaterial(obj.material)) return false;
  obj.customDepthMaterial = swayDepthMaterial(obj.material);
  stats.assigned += 1;
  return true;
}

export function swayShadowStats() {
  return {
    enabled: SWAY_SHADOW_ON,
    assigned: stats.assigned,
    built: !!_depth,
    // per-caster-material cut-out depth materials (live / ever built)
    cutLive: stats.cutLive,
    cutBuilt: stats.cutBuilt,
  };
}

if (typeof window !== "undefined") {
  window.__swayShadow = { stats: swayShadowStats };
}
