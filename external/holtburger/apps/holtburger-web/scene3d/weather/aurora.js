// scene3d/weather/aurora.js — vertical "curtain ribbon" aurora around the camera.
//
// InstancedMesh of MAX_RIBBONS thin tall quads laid out in a horizontal ring
// around the camera, with a top-to-bottom alpha gradient baked into the
// geometry's vertex colors. Per-ribbon vec3 azimuth/phase state lives CPU-side;
// each tick we wobble vertically + cycle hue (green↔magenta) and push matrices
// + color tints to the GPU. setIntensity(t) scales visible ribbon count and a
// global alpha multiplier, mirroring rain.js's free-fade pattern.
//
// Companion to atmosphere overlay `scene3d/aurora.js` (shader sphere shell);
// this one is geometry-based and tied to the weather-system intensity gate.

import * as THREE from "three";

const MAX_RIBBONS = 120;
const RING_RADIUS = 400.0;
const RIBBON_HEIGHT = 80.0;
const RIBBON_WIDTH = 6.0;
const BASE_Y_OFFSET = 80.0;          // ribbon BASE above camera height
const WOBBLE_AMPLITUDE = 2.0;        // meters
const WOBBLE_PERIOD = 5.0;           // seconds
const COLOR_CYCLE_PERIOD = 30.0;     // seconds — green↔magenta swing
const COLOR_GREEN = new THREE.Color(0x40ff80);
const COLOR_MAGENTA = new THREE.Color(0xc060ff);

const _tmpObj = new THREE.Object3D();
const _tmpColor = new THREE.Color();

export class AuroraSystem {
  constructor({ scene, camera }) {
    if (!scene || !camera) {
      throw new Error("AuroraSystem: scene + camera required");
    }
    this._scene = scene;
    this._camera = camera;
    this._intensity = 0.0;
    this._elapsed = 0.0;

    // Vertical plane: 1m wide × 1m tall. Origin at the BASE (anchor at bottom
    // so .position is the ribbon's ground-projection point). Bake a top-to-
    // bottom alpha into vertex colors: alpha=1 at top (y=1), ~0 at bottom.
    const geom = new THREE.PlaneGeometry(RIBBON_WIDTH, RIBBON_HEIGHT, 1, 1);
    geom.translate(0, RIBBON_HEIGHT * 0.5, 0);
    const colors = new Float32Array(4 * 4);
    // PlaneGeometry verts: [bl, br, tl, tr] after translate. Top verts get
    // alpha 1.0, bottom verts get alpha ~0.02 (faint base-glow, not pure 0).
    const ALPHA_TOP = 1.0;
    const ALPHA_BOT = 0.02;
    // bottom-left, bottom-right, top-left, top-right
    const aBL = ALPHA_BOT, aBR = ALPHA_BOT, aTL = ALPHA_TOP, aTR = ALPHA_TOP;
    colors.set([1, 1, 1, aBL, 1, 1, 1, aBR, 1, 1, 1, aTL, 1, 1, 1, aTR]);
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 4));

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexColors: true,
    });

    this._geom = geom;
    this._mat = mat;

    const mesh = new THREE.InstancedMesh(geom, mat, MAX_RIBBONS);
    mesh.name = "aurora-curtains";
    mesh.frustumCulled = false;
    mesh.renderOrder = 940;          // between rain (950) and atmosphere sky overlays
    mesh.count = 0;
    mesh.visible = false;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_RIBBONS * 3),
      3
    );
    this._mesh = mesh;

    // Per-ribbon state. azimuth = stable angle in the ring; phase offsets
    // shift wobble and color cycle so each ribbon shimmers independently.
    this._azimuth = new Float32Array(MAX_RIBBONS);
    this._wobblePhase = new Float32Array(MAX_RIBBONS);
    this._colorPhase = new Float32Array(MAX_RIBBONS);
    this._radius = new Float32Array(MAX_RIBBONS);
    for (let i = 0; i < MAX_RIBBONS; i++) {
      // Spread azimuths roughly evenly with a touch of jitter so they don't
      // form a perfect grid.
      const jitter = (Math.random() - 0.5) * (Math.PI * 2 / MAX_RIBBONS) * 0.6;
      this._azimuth[i] = (i / MAX_RIBBONS) * Math.PI * 2 + jitter;
      this._wobblePhase[i] = Math.random() * Math.PI * 2;
      this._colorPhase[i] = Math.random();
      // Slight radial jitter so the ring has some depth.
      this._radius[i] = RING_RADIUS + (Math.random() - 0.5) * 30.0;
    }

    scene.add(mesh);
  }

  setIntensity(t) {
    const v = Math.max(0, Math.min(1, +t || 0));
    this._intensity = v;
    const target = Math.floor(MAX_RIBBONS * v);
    this._mesh.count = target;
    this._mesh.visible = target > 0;
    // Material alpha scales with intensity for a smooth fade.
    this._mat.opacity = v;
  }

  tick(dt) {
    if (this._intensity <= 0 || this._mesh.count <= 0) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._elapsed += dt;
    const cam = this._camera.position;
    const t = this._elapsed;
    const wobbleW = (Math.PI * 2) / WOBBLE_PERIOD;
    const colorW = (Math.PI * 2) / COLOR_CYCLE_PERIOD;
    const count = this._mesh.count;

    // Toroidal ring follow: as the camera moves, each ribbon stays anchored
    // to its azimuth around the CURRENT camera position. No per-ribbon wrap
    // needed — the ring is implicit in the per-frame matrix recompose.
    for (let i = 0; i < count; i++) {
      const az = this._azimuth[i];
      const r = this._radius[i];
      const wobble = Math.sin(t * wobbleW + this._wobblePhase[i]) * WOBBLE_AMPLITUDE;
      const x = cam.x + Math.cos(az) * r;
      const z = cam.z + Math.sin(az) * r;
      const y = cam.y + BASE_Y_OFFSET + wobble;

      _tmpObj.position.set(x, y, z);
      // Face the ribbon's broadside toward the camera ring center (i.e.
      // rotate around Y so the plane's normal points radially outward).
      // The base PlaneGeometry's normal is +Z; rotate by (az + π/2) to
      // make the plane tangent to the ring.
      _tmpObj.rotation.set(0, az + Math.PI * 0.5, 0);
      _tmpObj.scale.set(1, 1, 1);
      _tmpObj.updateMatrix();
      this._mesh.setMatrixAt(i, _tmpObj.matrix);

      // Color cycle: phase per ribbon offset, period COLOR_CYCLE_PERIOD.
      // mix factor 0 = green, 1 = magenta. Real aurora is green-dominant
      // with occasional purple, so bias the cycle low.
      const phase = (t * colorW + this._colorPhase[i] * Math.PI * 2) % (Math.PI * 2);
      // Half-sine biased low: spends ~70% of cycle below 0.5 (green-dominant).
      const raw = (Math.sin(phase) + 1) * 0.5;
      const mix = Math.pow(raw, 2.2) * 0.7;
      _tmpColor.copy(COLOR_GREEN).lerp(COLOR_MAGENTA, mix);
      this._mesh.setColorAt(i, _tmpColor);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
    if (this._mesh.instanceColor) {
      this._mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    if (this._mesh && this._mesh.parent) {
      this._mesh.parent.remove(this._mesh);
    }
    if (this._mesh) this._mesh.dispose?.();
    this._geom.dispose();
    this._mat.dispose();
    this._azimuth = null;
    this._wobblePhase = null;
    this._colorPhase = null;
    this._radius = null;
    this._mesh = null;
  }
}
