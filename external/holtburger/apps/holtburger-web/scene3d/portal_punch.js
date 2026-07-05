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
  constructor(_scene, camera) {
    super("PortalPunchPass");
    // We render the aperture mesh into the composer's input buffer ourselves and
    // do not consume/produce a full-screen quad → keep buffers across the pass.
    this.needsSwap = false;
    this.mainCamera = camera;

    // Aperture geometry lives in its own tiny scene, rotated to match worldRoot
    // (AC Z-up → three Y-up is the -pi/2 X rotation applied in index.js).
    this.apertureScene = new THREE.Scene();
    this.apertureGroup = new THREE.Group();
    this.apertureGroup.rotation.x = -Math.PI / 2;
    this.apertureScene.add(this.apertureGroup);

    this._punchMat = makePunchMaterial();
    this._apertureMesh = null; // rebuilt by setApertures
    this._apertureCount = 0;
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
   */
  setApertures(flat) {
    this._disposeApertureMesh();
    this._apertureCount = 0;
    if (!flat || flat.length < 1) return;

    let k = 0;
    const count = flat[k++] | 0;
    if (count <= 0) return;

    const positions = [];
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
        positions.push(flat[i0], flat[i0 + 1], flat[i0 + 2]);
        positions.push(flat[i1], flat[i1 + 1], flat[i1 + 2]);
        positions.push(flat[i2], flat[i2 + 1], flat[i2 + 2]);
      }
      k += nv * 3;
      this._apertureCount++;
    }

    if (!positions.length) {
      this._apertureCount = 0;
      return;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geom, this._punchMat);
    mesh.frustumCulled = false;
    this._apertureMesh = mesh;
    this.apertureGroup.add(mesh);
  }

  _disposeApertureMesh() {
    if (this._apertureMesh) {
      this.apertureGroup.remove(this._apertureMesh);
      this._apertureMesh.geometry?.dispose();
      this._apertureMesh = null;
    }
  }

  render(renderer, inputBuffer /*, outputBuffer, dt, maskActive */) {
    if (this._errored || !this.hasApertures) return;
    const cam = this.mainCamera;
    if (!cam || !cam.layers) return; // camera not wired yet → skip, never crash

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    try {
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
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this._disposeApertureMesh();
    this._punchMat?.dispose();
    super.dispose?.();
  }
}
