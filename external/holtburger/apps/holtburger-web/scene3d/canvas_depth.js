// scene3d/canvas_depth.js — `?canvasDepth` (fps review 2026-10-19; DEFAULT ON =
// the canvas keeps three's default depth buffer; `=off`/`0`/`false`/`no` drops it).
//
// pmndrs postprocessing recommends `depth: false` on the WebGLRenderer: world
// draws land in the EffectComposer's own targets, which carry their own depth,
// and the canvas only receives fullscreen quads (the composer's last pass, the
// cloud overlay, the portal fade) — the same reasoning that took the canvas off
// MSAA (index.js `_canvasMsaa`). The canvas depth buffer is allocated (~8-16 MB
// at 1080p-1440p) and cleared every frame for nothing. Two things DO draw 3D
// straight to the canvas: the direct path (the ~8 s atmosphere-bake window on
// the 1070, and the fallback when the pipeline fails) and the portal tunnel.
// Without a canvas depth buffer they draw into `screenTarget()` — an offscreen
// target with a float depth attachment, sized to the drawing buffer — and
// `presentScreenTarget()` copies it to the canvas with the output colour-space
// encode, as the composer's last pass does (so those frames are linear-blended,
// like every composer frame, instead of blended in sRGB). `?wireframe=1` draws
// the world to the canvas every frame and `?canvasMsaa=on` exists to antialias
// direct-to-canvas geometry, so both keep the depth buffer (the flag is
// refused, logged once).
// Expected gain: memory and one fast clear per frame — an A/B arm, not a default.

import * as THREE from "three";

/** `?canvasDepth` reader (pure): true when the off-form asks to drop the canvas depth buffer. */
export function canvasDepthOffRequested(search) {
  try {
    const v = (new URLSearchParams(search || "").get("canvasDepth") || "").toLowerCase();
    return v === "off" || v === "0" || v === "false" || v === "no";
  } catch (_) {
    return false;
  }
}

/**
 * The canvas-depth decision (pure). `depth` is the context attribute to request.
 * @returns {{depth: boolean, requestedOff: boolean, reason: string}}
 */
export function resolveCanvasDepth({ search = "", wireframe = false, canvasMsaa = false } = {}) {
  const requestedOff = canvasDepthOffRequested(search);
  if (!requestedOff) return { depth: true, requestedOff, reason: "default" };
  if (wireframe) return { depth: true, requestedOff, reason: "refused: ?wireframe=1 draws the world to the canvas" };
  if (canvasMsaa) return { depth: true, requestedOff, reason: "refused: ?canvasMsaa=on keeps direct-to-canvas geometry" };
  return { depth: false, requestedOff, reason: "canvasDepth=off" };
}

const _byRenderer = new WeakMap();
const _stats = { redirects: 0, presents: 0, resizes: 0 };
const _size = new THREE.Vector2();

function _state(renderer) {
  let st = _byRenderer.get(renderer);
  if (!st) {
    st = { gl: null, depth: true, rt: null, quad: null };
    _byRenderer.set(renderer, st);
  }
  const gl = typeof renderer.getContext === "function" ? renderer.getContext() : null;
  if (gl !== st.gl) {
    // (re)read per context: a restored context keeps its attributes, a new one may not
    st.gl = gl;
    let attrs = null;
    try { attrs = gl && typeof gl.getContextAttributes === "function" ? gl.getContextAttributes() : null; } catch (_) { attrs = null; }
    st.depth = !attrs || attrs.depth !== false;
  }
  return st;
}

/**
 * The target a frame that draws 3D "to the canvas" must use: null when the
 * canvas has a depth buffer (the default), otherwise the offscreen stand-in,
 * (re)sized to the drawing buffer.
 */
export function screenTarget(renderer) {
  if (!renderer) return null;
  const st = _state(renderer);
  if (st.depth) return null;
  renderer.getDrawingBufferSize(_size);
  const w = Math.max(1, _size.x | 0), h = Math.max(1, _size.y | 0);
  if (!st.rt) {
    st.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
    st.rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    st.rt.texture.name = "canvas-depth-screen";
  } else if (st.rt.width !== w || st.rt.height !== h) {
    st.rt.setSize(w, h);
    _stats.resizes += 1;
  }
  _stats.redirects += 1;
  return st.rt;
}

/** Copy `target` (from screenTarget) to the canvas: colour-space encode, no blend, no depth. */
export function presentScreenTarget(renderer, target) {
  if (!renderer || !target) return false;
  const st = _state(renderer);
  if (!st.quad) {
    const mat = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      fog: false,
      blending: THREE.NoBlending,
    });
    mat.name = "canvas-depth-present";
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    st.quad = { scene, mesh, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  try {
    st.quad.mesh.material.map = target.texture;
    renderer.setRenderTarget(null);
    renderer.autoClear = false;
    renderer.render(st.quad.scene, st.quad.cam);
    _stats.presents += 1;
    return true;
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget === target ? null : prevTarget);
  }
}

export function getCanvasDepthStats() {
  return { ..._stats };
}

/** `window.__canvasDepth`: the decision and the redirect counters. */
export function installCanvasDepthSeam(renderer, decision) {
  if (typeof window === "undefined" || !renderer) return false;
  try {
    const st = _state(renderer);
    window.__canvasDepth = {
      requestedOff: !!decision?.requestedOff,
      reason: decision?.reason || "default",
      get depth() { return _state(renderer).depth; },
      stats: () => ({ depth: st.depth, ..._stats }),
    };
    return true;
  } catch (_) {
    return false;
  }
}
