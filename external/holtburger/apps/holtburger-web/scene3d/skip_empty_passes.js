// scene3d/skip_empty_passes.js — `?skipEmptyPasses` (round 3 R3-2, 2026-10-30,
// DEFAULT OFF, `=on` opt-in; read once through rustFlag).
//
// THE WASTE. Every `renderer.render(scene, camera)` re-runs three's whole-graph
// work whatever it ends up drawing: `scene.updateMatrixWorld()`, then
// `projectObject` over every visible node (a layer test per node; the walk
// recurses through visible parents whether or not they pass), the render-list
// sort and `setupLights` (2.39 ms on the old stack, 1.77 ms projectObject +
// 0.87 ms matrices summed over the walks on today's 1070 profiles;
// docs/2026-10-29-round3-gpu-driven.md R3-2, L6 step 3).
//
// THE ONE PASS THAT IS PROVABLY EMPTY. `?indoorLandscapeGate` (default on since
// 2026-10-19) keeps the world RenderPass on a landscape-skip frame (indoors,
// no outside portal in the walk — every sealed-dungeon frame) but sets the
// camera's layer mask to 0 (atmosphere_pipeline.js CAM_LAYER_MASK_NONE): its
// ClearPass is the frame's colour + depth clear, and the render that follows
// draws nothing, because `Layers.test` against mask 0 is false for every
// object (three r184 `projectObject`). Lights are gated by the same test, so
// it pushes none — and that has a second cost: the main scene's render state
// goes from N lights to 0 and back to N in the cells pass, which bumps the
// light-state version twice a frame and sends every lit material of the cells
// pass back through `getProgram` (the reason atmosphere_lights.js puts the
// lights on layer 1 too).
//
// WHAT THIS DOES. For a render whose camera mask is 0, the pass renders a
// private EMPTY Scene with the same camera into the same target instead of
// the main scene. That keeps every GL side effect of the original call — the
// background step's clear colour (`setClear`, and the clear itself under
// `autoClear`), the end-of-render state resets, the MSAA resolve of the bound
// target (`?msaaWorldOnly`'s world target W) and its mipmaps, the camera's
// matrix update and `info.render.frame` — and drops only the main scene's
// matrix walk, projectObject walk and light-state flip. The next render of
// the main scene (the cells pass, same frame) updates the same matrices;
// nothing between the two passes reads them (depth wipe and seal slots are
// off on a landscape-skip frame).
//
// SKIPS ONLY WHAT IS PROVABLY EMPTY. The predicate is the layer mask alone
// (mask 0 ⇒ zero renderable items, by three's own test), plus refusals for
// anything the empty stand-in would not reproduce: a scene background (a
// Color force-clears, a Texture adds a mesh), a custom scene
// onBeforeRender/onAfterRender (e.g. frame_split's), a pass selection
// or override material, XR presenting, an ArrayCamera. A non-zero mask is
// never skipped: proving it empty would need the walk this exists to avoid.
//
// WHERE. Only the composer's world RenderPass is hooked: it is the one render
// that can carry mask 0. The direct path (index.js: pre-bake window,
// `?wireframe=1`, `?atmosphere=off`) renders masks 1, 2 or 3, the cells pass
// mask 2, and the late particle pass already returns before rendering when it
// has no objects.
//
// FLAG OFF: atmosphere_pipeline.js never calls `installSkipEmptyRenderPass`,
// so the pass keeps the prototype `render` — byte-identical. This module has
// no import side effects (no THREE object is built until a skip happens).
//
// Diag: `window.__skipEmptyPasses.stats()` (installed with the first pass).
// Tests: tests/skip_empty_passes.test.mjs.

import * as THREE from "three";
import { rustFlag } from "./rust/scene_core.js";

/** `?skipEmptyPasses=on` (DEFAULT OFF). */
export function skipEmptyPassesEnabled() {
  return rustFlag("skipEmptyPasses", false);
}

export const SKIP_EMPTY_PASSES_STATS = {
  installed: 0,
  /** Hooked render calls seen. */
  renders: 0,
  /** Of those, swapped for the empty stand-in. */
  skipped: 0,
  /** Refusals with mask 0 (a reason the stand-in would not reproduce). */
  refusedBackground: 0,
  refusedHooks: 0,
  refusedPass: 0,
  refusedOther: 0,
};

const _O3D = THREE.Object3D.prototype;

/**
 * Why `renderer.render(scene, camera)` may NOT be replaced by an empty render,
 * or null when it may (the camera mask is 0 and nothing else differs).
 * Pure, no allocation.
 */
export function emptyRenderRefusal(renderer, scene, camera) {
  if (!camera || camera.isCamera !== true || !camera.layers || camera.layers.mask !== 0) return "layers";
  if (camera.isArrayCamera === true) return "camera";
  if (!scene || scene.isScene !== true) return "scene";
  if (scene.background !== null && scene.background !== undefined) return "background";
  if (scene.onBeforeRender !== _O3D.onBeforeRender || scene.onAfterRender !== _O3D.onAfterRender) return "hooks";
  const xr = renderer ? renderer.xr : null;
  if (xr && xr.enabled === true && xr.isPresenting === true) return "xr";
  return null;
}

let _standIn = null;
/** The private empty scene a provably-empty render draws instead. */
export function skipEmptyStandInScene() {
  if (_standIn === null) {
    _standIn = new THREE.Scene();
    _standIn.name = "skipEmptyPasses.standIn";
  }
  return _standIn;
}

function _noteRefusal(why) {
  const s = SKIP_EMPTY_PASSES_STATS;
  if (why === "background") s.refusedBackground += 1;
  else if (why === "hooks") s.refusedHooks += 1;
  else if (why === "pass") s.refusedPass += 1;
  else s.refusedOther += 1;
}

/**
 * Install the skip on one pmndrs RenderPass (an own `render` that calls the
 * prototype's). Idempotent. Returns true when installed.
 * @param {any} pass a postprocessing RenderPass
 */
export function installSkipEmptyRenderPass(pass) {
  if (!pass || typeof pass.render !== "function") return false;
  if (Object.prototype.hasOwnProperty.call(pass, "__hbSkipEmpty")) return true;
  const base = Object.getPrototypeOf(pass).render;
  if (typeof base !== "function") return false;
  pass.render = function hbSkipEmptyRender(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest) {
    const s = SKIP_EMPTY_PASSES_STATS;
    s.renders += 1;
    const scene = this.scene;
    const camera = this.camera;
    let why;
    if (!camera || !camera.layers || camera.layers.mask !== 0) {
      why = "layers"; // the common case: one compare, nothing counted
    } else if (this.selection !== null && this.selection !== undefined) {
      why = "pass";
    } else if (this.overrideMaterialManager !== null && this.overrideMaterialManager !== undefined) {
      why = "pass";
    } else {
      why = emptyRenderRefusal(renderer, scene, camera);
    }
    if (why !== null) {
      if (why !== "layers") _noteRefusal(why);
      return base.call(this, renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    }
    s.skipped += 1;
    this.scene = skipEmptyStandInScene();
    try {
      return base.call(this, renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    } finally {
      this.scene = scene;
    }
  };
  Object.defineProperty(pass, "__hbSkipEmpty", { value: true, configurable: true });
  SKIP_EMPTY_PASSES_STATS.installed += 1;
  _installDiag();
  return true;
}

function _installDiag() {
  try {
    if (typeof window === "undefined" || !window || window.__skipEmptyPasses) return;
    window.__skipEmptyPasses = {
      enabled: true,
      stats: () => ({ ...SKIP_EMPTY_PASSES_STATS }),
    };
  } catch (_) { /* diag only */ }
}

/** Test seam: zero the counters. */
export function __resetSkipEmptyPassesStatsForTest() {
  for (const k of Object.keys(SKIP_EMPTY_PASSES_STATS)) SKIP_EMPTY_PASSES_STATS[k] = 0;
}
