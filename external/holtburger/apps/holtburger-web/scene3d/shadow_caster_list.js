// scene3d/shadow_caster_list.js — walk the scene ONCE per shadow raster, not once
// per shadow-casting light (`?shadowCasterList`, DEFAULT ON, `=off` escape).
// Perf 2026-10-07.
//
// WHY. three r184's `WebGLShadowMap.render` calls its private `renderObject(scene,
// …)` once PER LIGHT, and that recursion visits every visible node of the whole
// scene graph (three.module.js :9543 — it recurses `children` unconditionally,
// testing `castShadow` only at mesh leaves). csm.js runs THREE cascade lights, so
// a rastering frame walks the graph three times on top of updateMatrixWorld and
// projectObject. MEASURED (prof3.json, 1070 quality ultra, fighting/running,
// 222 frames — the RP5 static-shadow gate re-rastered on 222/222 of them because
// the player and camera moved): `renderObject` self 605 ms = 2.7 ms/frame, at
// ~12k visible nodes x 3 cascades ≈ 36k visits/frame. Most of those nodes can
// never draw into a shadow map: rig/part Groups, sprites, terrain (castShadow
// false), particles, nameplates.
//
// WHAT. A wrapper on the renderer's `shadowMap.render` (an own property three
// assigns in the WebGLShadowMap constructor). On a frame that rasters, it walks
// the scene once with three's own rules — skip `visible === false` subtrees;
// a node is a CANDIDATE when it is a Mesh/Line/Points, `castShadow` (or
// `receiveShadow` under VSM), and passes `layers.test(camera.layers)` — and
// stops descending at each candidate. Then it hands three a stand-in root whose
// `children` is that candidate list. three's per-light `renderObject` then
// visits only the candidates (and recurses into THEIR subtrees itself, exactly as
// before), doing its own frustum test and draw.
//
// OUTPUT-IDENTICAL. The candidates are pushed in depth-first pre-order and the
// walk stops at the first candidate on every path, so three's recursion from
// each candidate reproduces the original visit order of every drawable node
// below it: same objects, same order, same per-light frustum tests, same
// onBeforeShadow / renderBufferDirect calls. (Depth-only draws are order-free
// anyway; identity of order is a stronger property than the output needs.) The
// stand-in root itself is never drawn — it is a plain Object3D, not a Mesh.
//
// WHEN IT STEPS ASIDE (three's own call with the real scene):
//   * `?shadowCasterList=off`, or the live seam `window.__shadowCasterList.off`;
//   * every early-out three takes before walking (disabled, no update pending,
//     no lights) — so a gated-off frame (RP5) pays nothing for the walk;
//   * the frame `shadowMap.type` changes: three traverses the scene it is given
//     to flag every material for recompilation, and must see the real one.

import * as THREE from "three";
// ?swayShadow (2026-10-07): swaying trees cast swaying shadows.
import { applySwayShadow } from "./sway_shadow.js";

const FLAG = (() => {
  try {
    const v = (new URLSearchParams(globalThis.location?.search || "").get("shadowCasterList") || "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
})();

export function shadowCasterListEnabled() {
  return FLAG;
}

const ctl = { off: false };
const stats = {
  walks: 0,        // rasters served from the candidate list
  passthrough: 0,  // rasters handed to three unchanged (off / type change)
  lastVisited: 0,  // nodes the last walk visited (three visited ~this x lights)
  lastListed: 0,   // candidates handed to three by the last walk
  visited: 0,      // cumulative
  listed: 0,       // cumulative
};

/**
 * three's shadow-visit rules, collecting the first candidate on each path.
 * Returns the number of nodes visited (for the stats only).
 */
function collect(o, camLayers, vsm, out) {
  if (o.visible === false) return 1;
  if ((o.isMesh || o.isLine || o.isPoints) && (o.castShadow || (vsm && o.receiveShadow)) && o.layers.test(camLayers)) {
    out.push(o);
    // The walk already touches every caster each shadow pass: hand a
    // wind-swaying one its sway-aware depth material (once; sway_shadow.js).
    if (o.customDepthMaterial === undefined) applySwayShadow(o);
    return 1;
  }
  let n = 1;
  const ch = o.children;
  for (let i = 0, l = ch.length; i < l; i++) n += collect(ch[i], camLayers, vsm, out);
  return n;
}

/**
 * Wrap `renderer.shadowMap.render`. Returns true when installed (or already).
 * @param {THREE.WebGLRenderer|{shadowMap: object}} renderer
 */
export function installShadowCasterList(renderer, { force = false } = {}) {
  if ((!FLAG && !force) || !renderer || !renderer.shadowMap) return false;
  const sm = renderer.shadowMap;
  if (sm.__hbCasterList) return true;
  const orig = sm.render;
  if (typeof orig !== "function") return false;
  const list = [];
  // The stand-in root: never added to a scene, never updated, never drawn.
  const root = new THREE.Object3D();
  root.name = "shadow-caster-list-root";
  root.matrixAutoUpdate = false;
  root.matrixWorldAutoUpdate = false;
  root.children = list;
  let lastType = sm.type;
  sm.render = function (lights, scene, camera) {
    // three's own early-outs first: a frame that does not raster must not pay
    // for the walk.
    if (sm.enabled === false || (sm.autoUpdate === false && sm.needsUpdate === false)
      || !lights || lights.length === 0) {
      return orig.call(this, lights, scene, camera);
    }
    if (ctl.off || !scene || !camera || !camera.layers || sm.type !== lastType) {
      lastType = sm.type;
      stats.passthrough += 1;
      return orig.call(this, lights, scene, camera);
    }
    list.length = 0;
    let visited = 0;
    try {
      visited = collect(scene, camera.layers, sm.type === THREE.VSMShadowMap, list);
    } catch (_) {
      list.length = 0;
      stats.passthrough += 1;
      return orig.call(this, lights, scene, camera);
    }
    stats.walks += 1;
    stats.lastVisited = visited;
    stats.lastListed = list.length;
    stats.visited += visited;
    stats.listed += list.length;
    try {
      return orig.call(this, lights, root, camera);
    } finally {
      list.length = 0; // hold no scene references between frames
    }
  };
  Object.defineProperty(sm, "__hbCasterList", { value: { orig, root }, configurable: true });
  if (typeof window !== "undefined") {
    try {
      window.__shadowCasterList = {
        enabled: true,
        stats,
        get off() { return ctl.off; },
        set off(v) { ctl.off = !!v; },
      };
    } catch (_) {}
  }
  return true;
}

/** Test hook: restore three's method. */
export function uninstallShadowCasterList(renderer) {
  const sm = renderer?.shadowMap;
  const saved = sm && sm.__hbCasterList;
  if (!saved) return;
  sm.render = saved.orig;
  delete sm.__hbCasterList;
  ctl.off = false;
}

export function getShadowCasterListStats() {
  return { ...stats };
}

/** Test seam. */
export function __setShadowCasterListOffForTest(v) { ctl.off = !!v; }
