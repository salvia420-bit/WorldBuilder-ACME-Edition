// scene3d/portal_punch.js — retail-faithful per-aperture DEPTH PUNCH (no stencil).
//
// The minimal WebGL realization of retail acclient's
// `D3DPolyRender::DrawPortalPolyInternal` (verified in the decomp): draw each
// visible door/window portal polygon with DEPTHTEST_ALWAYS and write
// gl_FragDepth = 0.99999899 (≈ far plane) into every aperture pixel, so the
// building interior — drawn AFTER, in the cells pass — wins the depth test
// inside the doorway and terrain/facade can no longer occlude it there.
//
// This is the "bounded punch, no stencil" approach (chosen 2026-07-05 over the
// stencil scaffold in portal_stencil.js): retail itself uses a screen-space
// polygon clip, NOT hardware stencil, and the building FACADE's own depth
// naturally masks the interior OUTSIDE the aperture (facade is in front from an
// outdoor camera → interior loses there → hidden), so we don't need an explicit
// clip for a first pass. The one accepted tradeoff vs. a true clip: interior
// geometry that projects BEYOND the facade silhouette (over open terrain / sky)
// can "see-through". That is the follow-up (add a clip) IF it's visibly a
// problem — judged on the real GPU, since SwiftShader can't render this.
//
// Pipeline role (atmosphere_pipeline.js, only when ?portalPunch=on AND outdoor
// AND there are visible apertures):
//   1. world pass  → WORLD_ONLY  (terrain + facade + outdoor statics)
//   2. THIS pass   → punch depth to FAR inside each visible aperture
//   3. cells pass  → INDOOR_ONLY (interior cells + entities), depth unchanged,
//                    so they win in the punched apertures, lose behind facade.
// Interior cells stay on RENDER_LAYER_INDOOR (layer 1) the whole time — unlike
// the stencil scaffold, this pass does NOT re-layer them.
//
// Gated by `?portalPunch` (default OFF). UNVALIDATED pending an R9 290 eye-test.

import * as THREE from "three";
import { Pass } from "postprocessing";

// Retail's DrawPortalPolyInternal writes 0.99999899 (just shy of the far plane).
// Under logarithmicDepthBuffer the depth encoding preserves the endpoints
// (near→0, far→1), so this literal is a valid "far" written straight to
// gl_FragDepth — any real interior geometry has a smaller gl_FragDepth and wins.
const FAR_DEPTH = 0.99999899;

// PUNCH material — reset depth to FAR inside the aperture. depthFunc=Always so it
// writes unconditionally (retail DEPTHTEST_ALWAYS); depthTest stays ENABLED
// because WebGL does not write depth when the test is disabled. colorWrite off
// (never touch the world pass's colour — the cells pass fills the doorway).
// DoubleSide: the doorway is viewed from either face. No stencil.
// SEAL material (2026-08-04 round 6) — retail `DrawPortalPolyInternal(p,
// zClear=FALSE)`, acclient.c:461536 as called from the INDOOR `PView::DrawCells`
// loop. Writes the polygon's TRUE interpolated depth rather than far Z: it is a
// depth WALL at the doorway plane, not a hole.
//
// Why the indoor split needs it. `PView::DrawCells` wipes Z (:461484) and then
// re-stamps every outdoor-facing portal plane at true depth BEFORE drawing the
// cells (:461536). Without that re-stamp, the wipe leaves the world pass's
// colour — terrain AND the outdoor particles drawn with it — protected by no
// depth at all, so ANY interior geometry drawn afterwards overpaints it even
// when it is genuinely FARTHER away than what is visible through the doorway.
// That is the reported "doorway filled with outdoor fountain blobs / interior
// particles gone" ordering: both are layer-0 world-pass content whose depth the
// wipe destroyed. The seal restores exactly the depth retail restores.
function makeSealMaterial() {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    // NO gl_FragDepth write — the rasterizer's interpolated depth IS the
    // polygon's true depth, which is what retail's maxZ2 path writes.
    fragmentShader: /* glsl */ `
      precision highp float;
      out vec4 _c;
      void main() {
        _c = vec4(0.0);
      }`,
  });
  m.name = "portal-seal";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth; // retail DEPTHTEST_ALWAYS
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  return m;
}

function makePunchMaterial() {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      out vec4 _c;
      void main() {
        gl_FragDepth = ${FAR_DEPTH.toFixed(8)};
        _c = vec4(0.0);
      }`,
  });
  m.name = "portal-punch";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth; // write regardless of what's already there
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  return m;
}

export class PortalPunchPass extends Pass {
  /**
   * @param {THREE.Scene} _scene  unused (interiors are drawn by the cells pass)
   * @param {THREE.Camera} camera the main render camera
   */
  constructor(_scene, camera, mode = "punch") {
    super(mode === "seal" ? "PortalSealPass" : "PortalPunchPass");
    this.mode = mode;
    // We render the aperture mesh into the composer's input buffer ourselves and
    // do not consume/produce a full-screen quad → keep buffers across the pass.
    this.needsSwap = false;
    // Store on `this.camera` (the real pmndrs Pass field), NOT `this.mainCamera`
    // — the base Pass in this postprocessing version exposes `set mainCamera`
    // as an EMPTY no-op with no getter, so assigning `this.mainCamera` silently
    // drops the camera and `render()` would read `undefined` and bail forever
    // (the reason this punch never executed / shipped UNVALIDATED).
    this.camera = camera;

    // Aperture geometry lives in its own tiny scene, rotated to match worldRoot
    // (AC Z-up → three Y-up is the -pi/2 X rotation applied in index.js).
    this.apertureScene = new THREE.Scene();
    this.apertureGroup = new THREE.Group();
    this.apertureGroup.rotation.x = -Math.PI / 2;
    this.apertureScene.add(this.apertureGroup);

    this._punchMat = mode === "seal" ? makeSealMaterial() : makePunchMaterial();
    // PERSISTENT aperture mesh (2026-08-04 perf). `setApertures` runs EVERY
    // frame the punch is armed; the original implementation disposed the
    // BufferGeometry and built a fresh one + a fresh THREE.Mesh each call,
    // which on a real driver is a VBO delete + VBO create + full upload per
    // frame (SwiftShader hides this — it has no driver allocator to thrash).
    // Now the geometry, its Float32Array and the Mesh are allocated ONCE and
    // grown by doubling; a frame update is a memcpy into the existing array,
    // one `needsUpdate` (bufferSubData) and a `setDrawRange`.
    this._apertureMesh = null;   // created lazily by _ensureApertureBuffer
    this._posAttr = null;        // its position BufferAttribute
    this._positions = null;      // the attribute's backing Float32Array
    this._posCapacity = 0;       // capacity in VERTICES (not floats)
    this._apertureCount = 0;
    // 2026-08-04 over-punch containment: the union screen rect of the
    // apertures that survived scene3d/portal_clip.js `clipAperturesForPunch`,
    // in the GL convention ([0,1], y up). `null` = no bound (legacy call
    // shape; the punch then covers the whole target as it always did).
    // Applied as a RENDER-TARGET scissor in `render()`, so even a polygon
    // that somehow rasterizes wrong is physically incapable of writing depth
    // outside the doorway rects — the structural fix for the 2026-07-06
    // whole-world blackout.
    this._scissorRect = null;
    // Permanent no-op after any render throw (driver-specific GL failure) so a
    // bug here can never freeze the frame — interiors just fall back to the
    // default (occluded) world-pass draw, and preFrameSkySync stops splitting.
    this._errored = false;
  }

  get hasApertures() {
    return !this._errored && this._apertureCount > 0 && this._apertureMesh != null;
  }

  /**
   * Rebuild the aperture geometry from the flat float array wasm
   * `getVisiblePortalApertures` returns:
   *   [ count, (nverts, x0,y0,z0, …) × count ]   (AC world coords, Z-up)
   * Convex polygons are fan-triangulated into one merged BufferGeometry.
   *
   * @param {ArrayLike<number>|null} flat
   * @param {{x0:number,y0:number,x1:number,y1:number}|null} [rect]
   *        Union screen-space bound of these apertures (GL convention: [0,1],
   *        y up), from `clipAperturesForPunch`. Omitted/null → unbounded.
   */
  setApertures(flat, rect = null) {
    this._apertureCount = 0;
    if (this._apertureMesh) this._apertureMesh.visible = false;
    this._scissorRect =
      rect &&
      Number.isFinite(rect.x0) && Number.isFinite(rect.y0) &&
      Number.isFinite(rect.x1) && Number.isFinite(rect.y1) &&
      rect.x1 > rect.x0 && rect.y1 > rect.y0
        ? rect
        : null;
    if (!flat || flat.length < 1) return;

    let k = 0;
    const count = flat[k++] | 0;
    if (count <= 0) return;

    // PASS 1 — vertex budget. Fan triangulation of an nv-gon emits (nv-2)*3
    // vertices. `flat` is a few hundred floats, so the extra walk is free
    // next to the allocation it removes.
    let need = 0;
    let scan = k;
    for (let a = 0; a < count && scan < flat.length; a++) {
      const nv = flat[scan++] | 0;
      if (nv >= 3) need += (nv - 2) * 3;
      scan += nv * 3;
    }
    if (need <= 0) return;
    this._ensureApertureBuffer(need);
    const pos = this._positions;
    if (!pos) return;

    // PASS 2 — write straight into the persistent buffer.
    let w = 0;
    for (let a = 0; a < count; a++) {
      const nv = flat[k++] | 0;
      if (nv < 3) {
        k += nv * 3;
        continue;
      }
      const base = k;
      for (let t = 1; t < nv - 1; t++) {
        const i0 = base;
        const i1 = base + t * 3;
        const i2 = base + (t + 1) * 3;
        pos[w++] = flat[i0]; pos[w++] = flat[i0 + 1]; pos[w++] = flat[i0 + 2];
        pos[w++] = flat[i1]; pos[w++] = flat[i1 + 1]; pos[w++] = flat[i1 + 2];
        pos[w++] = flat[i2]; pos[w++] = flat[i2 + 1]; pos[w++] = flat[i2 + 2];
      }
      k += nv * 3;
      this._apertureCount++;
    }

    if (w === 0) {
      this._apertureCount = 0;
      return;
    }
    const attr = this._posAttr;
    // Sub-upload only the bytes actually written (mirrors portal_stencil.js).
    if (attr.addUpdateRange) attr.addUpdateRange(0, w);
    else attr.updateRange = { offset: 0, count: w };
    attr.needsUpdate = true;
    this._apertureMesh.geometry.setDrawRange(0, (w / 3) | 0);
    this._apertureMesh.visible = true;
  }

  /**
   * Allocate (or grow, by doubling) the persistent aperture buffer so it holds
   * at least `vertCount` vertices. Growth is rare — the aperture count in view
   * is bounded by the loaded portal set and settles after the first few
   * landblocks — so the dispose here is not a per-frame cost.
   *
   * @param {number} vertCount vertices required this frame
   */
  _ensureApertureBuffer(vertCount) {
    if (this._apertureMesh && this._posCapacity >= vertCount) return;
    let cap = this._posCapacity > 0 ? this._posCapacity : 192;
    while (cap < vertCount) cap *= 2;
    this._disposeApertureMesh();
    const positions = new Float32Array(cap * 3);
    const attr = new THREE.BufferAttribute(positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", attr);
    geom.setDrawRange(0, 0);
    // `frustumCulled = false` (retail punches whatever the walk offers), which
    // also means three never asks for a bounding sphere — so the stale bounds
    // of a partially-filled buffer can never cull the mesh.
    const mesh = new THREE.Mesh(geom, this._punchMat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; // fixed at identity under apertureGroup
    mesh.visible = false;
    this._positions = positions;
    this._posAttr = attr;
    this._posCapacity = cap;
    this._apertureMesh = mesh;
    this.apertureGroup.add(mesh);
  }

  _disposeApertureMesh() {
    if (this._apertureMesh) {
      this.apertureGroup.remove(this._apertureMesh);
      this._apertureMesh.geometry?.dispose();
      this._apertureMesh = null;
    }
    this._posAttr = null;
    this._positions = null;
    this._posCapacity = 0;
  }

  render(renderer, inputBuffer /*, outputBuffer, dt, maskActive */) {
    if (this._errored || !this.hasApertures) return;
    const cam = this.camera;
    if (!cam || !cam.layers) return; // camera not wired yet → skip, never crash

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    // Render-target scissor bound (2026-08-04). three.js reads viewport/scissor
    // OFF THE RENDER TARGET when one is bound (WebGLRenderer.setRenderTarget
    // copies `renderTarget.scissor` / `.scissorTest` into GL state), so the
    // bound must be written on `inputBuffer` — `renderer.setScissor` would be
    // ignored here. Values are RENDER-TARGET pixels (no pixelRatio multiply on
    // the RT path). Saved and restored unconditionally so the composer's next
    // pass sees the buffer exactly as it found it.
    const rect = this._scissorRect;
    const prevScissorTest = inputBuffer ? inputBuffer.scissorTest : false;
    const prevScissorX = inputBuffer ? inputBuffer.scissor.x : 0;
    const prevScissorY = inputBuffer ? inputBuffer.scissor.y : 0;
    const prevScissorZ = inputBuffer ? inputBuffer.scissor.z : 0;
    const prevScissorW = inputBuffer ? inputBuffer.scissor.w : 0;
    try {
      if (rect && inputBuffer) {
        const bw = inputBuffer.width | 0;
        const bh = inputBuffer.height | 0;
        // Round OUTWARD by a pixel so a doorway edge is never sliced off by
        // rounding — over-including one pixel of the doorway is harmless,
        // under-including leaves a hairline of un-punched terrain.
        const sx = Math.max(0, Math.floor(rect.x0 * bw) - 1);
        const sy = Math.max(0, Math.floor(rect.y0 * bh) - 1);
        const sw = Math.min(bw - sx, Math.ceil((rect.x1 - rect.x0) * bw) + 2);
        const sh = Math.min(bh - sy, Math.ceil((rect.y1 - rect.y0) * bh) + 2);
        if (sw > 0 && sh > 0) {
          inputBuffer.scissor.set(sx, sy, sw, sh);
          inputBuffer.scissorTest = true;
        }
      }
      renderer.autoClear = false;
      renderer.setRenderTarget(inputBuffer);
      // Draw the aperture polygons: colorWrite off, depthFunc Always, write FAR.
      // Punches the doorway depth to far in the shared buffer the cells pass then
      // draws into. No color/depth/stencil CLEAR — we only stamp depth.
      renderer.render(this.apertureScene, cam);
    } catch (e) {
      this._errored = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[portal_punch] render error — pass DISABLED (interiors fall back to the world pass). Report:",
        e,
      );
    } finally {
      if (inputBuffer) {
        inputBuffer.scissor.set(prevScissorX, prevScissorY, prevScissorZ, prevScissorW);
        inputBuffer.scissorTest = prevScissorTest;
      }
      renderer.autoClear = prevAutoClear;
      // Re-binding the previous target re-applies GL viewport/scissor state
      // from that target (or the renderer, for the canvas) — so the restore
      // above is what the composer's next pass actually observes.
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this._disposeApertureMesh();
    this._punchMat?.dispose();
    super.dispose?.();
  }
}
