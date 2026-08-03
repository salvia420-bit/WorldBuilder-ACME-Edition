// scene3d/portal_stencil.js — retail-faithful portal-stencil cell render pass.
//
// The GPU realization of retail acclient's interior renderer (see
// docs/RETAIL-PORTAL-RENDERER-AND-CELL-TERRAIN-WATER-RELATIONSHIPS.md):
//   PView::GetClip (screen-space portal clip)  → a STENCIL mask of the aperture
//   D3DPolyRender::DrawPortalPolyInternal       → punch depth to FAR in the mask
//   then draw the interior cell, clipped to the aperture.
//
// This fixes, without the see-through regression the old global depth-clear
// caused, the "acviewer-style renderer" bugs: terrain covering building
// interiors / dungeon entrances, floor↔terrain z-fight, and water covering
// ocean env cells — because interiors are drawn ONLY within a portal aperture,
// where depth has been reset so terrain/water can't win, and NOTHING is drawn
// outside the aperture.
//
// Milestone 1 (2026-07-05): OUTDOOR player, single stencil ref, flat-shaded
// interior via `scene.overrideMaterial`. Feed = wasm `getVisiblePortalApertures`
// (validated: 100 real Holtburg door/window quads). Per-aperture refs, nested
// portals, and textured interiors are follow-ups. Gated by `?portalStencil`
// (default OFF); un-eye-tested until the GTX-1070 pass (SwiftShader can't judge
// stencil/depth fidelity).
//
// UNVALIDATED pending 1070 eye-test.

import * as THREE from "three";
import { Pass } from "postprocessing";

// Dedicated layer for portal-visible interior cells so the world RenderPass
// (mask = layers 0|1) does NOT draw them (avoids the terrain-occluded double
// draw); this pass renders them alone, stencil-masked. Mirrors the
// RENDER_LAYER_WORLD=0 / RENDER_LAYER_INDOOR=1 scheme in index.js.
export const RENDER_LAYER_PORTAL_CELL = 2;

// Single stencil ref for milestone 1. 8-bit stencil → 255 refs available for
// the future per-aperture / per-BFS-depth generalization.
const STENCIL_REF = 1;

// Retail's DrawPortalPolyInternal writes 0.99999899 (just shy of the far
// plane). Under `logarithmicDepthBuffer` the depth encoding preserves the
// endpoints (near→0, far→1), so this literal is a valid "far" regardless of
// the log encoding — we write it straight to gl_FragDepth.
const FAR_DEPTH = 0.9999999;

// (a) MARK — stamp the aperture into stencil, but ONLY where the doorway is
// actually visible (depth-tested), so a door behind a hill never marks → no
// see-through. MeshBasicMaterial inherits three's logdepthbuf chunk when the
// renderer has logarithmicDepthBuffer, so its gl_FragDepth matches terrain's.
function makeMarkMaterial() {
  const m = new THREE.MeshBasicMaterial();
  m.name = "portal-stencil-mark";
  m.colorWrite = false;
  m.depthWrite = false; // don't perturb depth; only stencil
  m.depthTest = true; // LessEqualDepth default → occluded doorway won't mark
  m.side = THREE.DoubleSide; // doorway seen from either face
  m.stencilWrite = true;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilRef = STENCIL_REF;
  m.stencilFuncMask = 0xff;
  m.stencilWriteMask = 0xff;
  m.stencilFail = THREE.KeepStencilOp; // stencil test always passes; n/a
  m.stencilZFail = THREE.KeepStencilOp; // DEPTH fail (occluded) → do NOT mark
  m.stencilZPass = THREE.ReplaceStencilOp; // depth pass (visible) → mark REF
  return m;
}

// (b) RESET — punch depth to FAR inside the marked region. depthFunc=Always so
// it writes unconditionally (retail DEPTHTEST_ALWAYS); depthTest stays enabled
// because WebGL does NOT write depth when the depth test is disabled. Stencil
// EQUAL REF (test only, writeMask 0) confines the punch to the marked doorway.
function makeResetMaterial() {
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
        gl_FragDepth = ${FAR_DEPTH.toFixed(7)};
        _c = vec4(0.0);
      }`,
  });
  m.name = "portal-stencil-reset";
  m.colorWrite = false;
  m.depthTest = true;
  m.depthFunc = THREE.AlwaysDepth; // write regardless of what's there
  m.depthWrite = true;
  m.side = THREE.DoubleSide;
  m.stencilWrite = true; // enables the stencil TEST
  m.stencilFunc = THREE.EqualStencilFunc;
  m.stencilRef = STENCIL_REF;
  m.stencilFuncMask = 0xff;
  m.stencilWriteMask = 0x00; // test only — never modify stencil
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.KeepStencilOp;
  return m;
}

// (c) CELL DRAW override — flat, lit, drawn only where stencil==REF. Milestone
// uses a neutral MeshStandardMaterial via scene.overrideMaterial so we don't
// need per-cell material clones yet; the interior appears lit-but-untextured
// through the doorway, which is enough to judge "interior shows, terrain does
// not occlude, and nothing leaks outside the doorway".
function makeCellOverrideMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0x9aa4b0,
    roughness: 0.9,
    metalness: 0.0,
  });
  m.name = "portal-stencil-cell";
  m.side = THREE.DoubleSide; // interiors viewed from outside; keep back faces
  m.stencilWrite = true;
  m.stencilFunc = THREE.EqualStencilFunc;
  m.stencilRef = STENCIL_REF;
  m.stencilFuncMask = 0xff;
  m.stencilWriteMask = 0x00; // test only
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.KeepStencilOp;
  // depthTest LessEqual (default) + depthWrite true: cells write their own
  // depth vs the just-reset FAR, so they win inside the aperture and sort
  // correctly among themselves.
  return m;
}

export class PortalStencilPass extends Pass {
  /**
   * @param {THREE.Scene} scene   the main world scene (holds the cell meshes)
   * @param {THREE.Camera} camera the main camera
   */
  constructor(scene, camera) {
    super("PortalStencilPass");
    // We render into the composer's input buffer ourselves and do not consume
    // a full-screen input; keep the same buffers across the pass.
    this.needsSwap = false;

    this.mainScene = scene;
    // `this.camera`, not `this.mainCamera` — the pmndrs base Pass `set mainCamera`
    // is an empty no-op (same bug that made PortalPunchPass never execute).
    this.camera = camera;

    // Aperture geometry lives in its own tiny scene, transformed to match
    // worldRoot (AC Z-up → three Y-up is the -pi/2 X rotation at index.js).
    this.apertureScene = new THREE.Scene();
    this.apertureGroup = new THREE.Group();
    this.apertureGroup.rotation.x = -Math.PI / 2;
    this.apertureScene.add(this.apertureGroup);

    this._markMat = makeMarkMaterial();
    this._resetMat = makeResetMaterial();
    this._cellOverrideMat = makeCellOverrideMaterial();

    this._apertureMesh = null; // rebuilt by setApertures
    this._apertureCount = 0;
    this._cells = []; // portal-visible interior cell containers to draw
    // Set true if render() ever throws (e.g. a driver-specific shader/GL
    // failure). Once errored, the pass permanently no-ops and tickPortalStencil
    // un-parks the cells back to the world pass — so a bug here can NEVER
    // freeze the frame; interiors just fall back to the default render.
    this._errored = false;
  }

  get hasApertures() {
    return this._apertureCount > 0 && this._apertureMesh != null;
  }

  get hasWork() {
    return this.hasApertures && this._cells.length > 0;
  }

  /**
   * The portal-visible interior cell containers active this frame. tickPortalStencil
   * has already moved them to RENDER_LAYER_PORTAL_CELL (persistently, until they
   * leave the set or the player goes indoors), so the world pass (mask 0|1) does
   * NOT draw them — this pass draws them alone, masked to the apertures. Used here
   * only for the hasWork gate (draw nothing if no cells → no depth-punched holes).
   * @param {THREE.Object3D[]} containers
   */
  setCells(containers) {
    this._cells = Array.isArray(containers) ? containers : [];
  }

  /**
   * Rebuild the aperture geometry from the flat float array returned by
   * wasm `getVisiblePortalApertures`:
   *   [ count, (nverts, x0,y0,z0, x1,y1,z1, …) × count ]   (AC world coords)
   * Convex polygons are fan-triangulated into one merged BufferGeometry.
   */
  setApertures(flat) {
    this._detachApertureMesh();
    this._apertureCount = 0;
    if (!flat || flat.length < 1) return;

    let k = 0;
    const count = flat[k++] | 0;
    if (count <= 0) return;

    // Reused scratch (2026-08-03 review): this runs EVERY frame from
    // cells.js's tickPortalStencil, and used to allocate a fresh array, a
    // fresh BufferGeometry, a fresh Float32BufferAttribute and a fresh Mesh
    // per frame — then destroy last frame's GL buffer. ~600 fan vertices at
    // 60 Hz of pure churn. The array is reused in place and the geometry is
    // only reallocated when it needs to GROW.
    const positions = this._posScratch || (this._posScratch = []);
    positions.length = 0;
    for (let a = 0; a < count; a++) {
      const nv = flat[k++] | 0;
      if (nv < 3) {
        k += nv * 3;
        continue;
      }
      const base = k;
      // fan: (0,1,2),(0,2,3),…
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
    // Grow-only buffer reuse. `_detachApertureMesh()` at the top of this
    // method has already detached last frame's mesh; re-adopt its geometry
    // when the new fan fits, so the common steady-state frame does zero
    // allocation and one buffer sub-upload.
    const needed = positions.length;
    let geom = this._apertureGeom;
    let attr = geom ? geom.getAttribute("position") : null;
    if (!geom || !attr || attr.array.length < needed) {
      if (geom) geom.dispose();
      geom = new THREE.BufferGeometry();
      // Round up so a slowly-growing aperture set stops reallocating.
      const cap = Math.max(needed, 256 * 3);
      attr = new THREE.BufferAttribute(new Float32Array(cap), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute("position", attr);
      this._apertureGeom = geom;
    }
    attr.array.set(positions);
    attr.addUpdateRange ? attr.addUpdateRange(0, needed) : (attr.updateRange = { offset: 0, count: needed });
    attr.needsUpdate = true;
    geom.setDrawRange(0, needed / 3);
    let mesh = this._apertureMeshObj;
    if (!mesh || mesh.geometry !== geom) {
      mesh = new THREE.Mesh(geom, this._markMat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this._apertureMeshObj = mesh;
    }
    this._apertureMesh = mesh;
    this.apertureGroup.add(mesh);
  }

  /** Per-frame: unparent, but KEEP the geometry for reuse (see setApertures). */
  _detachApertureMesh() {
    if (this._apertureMesh) {
      this.apertureGroup.remove(this._apertureMesh);
      this._apertureMesh = null;
    }
  }

  /** Teardown: unparent AND release the reused buffer. */
  _disposeApertureMesh() {
    this._detachApertureMesh();
    if (this._apertureGeom) {
      this._apertureGeom.dispose();
      this._apertureGeom = null;
    }
    this._apertureMeshObj = null;
  }

  render(renderer, inputBuffer /*, outputBuffer, dt, maskActive */) {
    // Skip if a prior frame errored (permanent no-op), or unless we have BOTH
    // apertures AND cells. If we marked+punched depth with no cells to fill the
    // doorway, the far-depth hole would let atmosphere/cloud haze through it.
    if (this._errored || !this.hasWork) return;

    const cam = this.camera;
    // Camera not wired for this frame yet (tickPortalStencil sets it) → skip,
    // NEVER crash. `hasWork` can be true from a prior tick before mainCamera is
    // current; touching `cam.layers` on an undefined cam froze the frame.
    if (!cam || !cam.layers) return;
    const prevAutoClear = renderer.autoClear;
    const prevCamMask = cam.layers.mask;
    const prevOverride = this.mainScene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();

    // try/catch/finally: a throw inside renderer.render (driver-specific shader
    // compile, context loss, GL error) must NOT propagate — it would abort the
    // composer frame and freeze on the last good frame every time the pass has
    // work (i.e. whenever you look through a door). Catch → disable the pass
    // for good; finally → restore all mutated state so fxPass/next frame are
    // clean. tickPortalStencil sees `_errored` and un-parks the cells.
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(inputBuffer);

      // Stencil starts undefined for this frame's buffer — clear stencil only
      // (keep the world pass color + depth).
      renderer.clear(false, false, true);

      // (a) MARK the visible doorway apertures into stencil.
      this._apertureMesh.material = this._markMat;
      renderer.render(this.apertureScene, cam);

      // (b) RESET depth to FAR inside the marked region.
      this._apertureMesh.material = this._resetMat;
      renderer.render(this.apertureScene, cam);

      // (c) DRAW the portal-visible interior cells, masked to the aperture.
      // The cells were already moved to RENDER_LAYER_PORTAL_CELL by
      // tickPortalStencil (so the world pass, mask=0|1, skipped them and did
      // NOT draw them terrain-occluded). Restrict the camera to that layer so
      // only those cells draw (not terrain/buildings/entities).
      cam.layers.set(RENDER_LAYER_PORTAL_CELL);
      this.mainScene.overrideMaterial = this._cellOverrideMat;
      renderer.render(this.mainScene, cam);
    } catch (e) {
      this._errored = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[portal_stencil] render error — pass DISABLED (interiors fall back to the world pass). Please report this line:",
        e,
      );
    } finally {
      this.mainScene.overrideMaterial = prevOverride;
      cam.layers.mask = prevCamMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this._disposeApertureMesh();
    this._markMat?.dispose();
    this._resetMat?.dispose();
    this._cellOverrideMat?.dispose();
    super.dispose?.();
  }
}
