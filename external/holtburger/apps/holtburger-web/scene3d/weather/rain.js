// scene3d/weather/rain.js — InstancedMesh rain streaks around the camera.
//
// Particles live inside a moving cylinder of radius R and height H anchored
// to the camera. Each tick we advance positions by velocity*dt and toroidal-
// wrap any particle that exits the cylinder (below ground OR outside the
// horizontal disc) back to a fresh position at the top of the cylinder.
// `setIntensity(t)` clamps `instance.count = floor(MAX*t)` so a fade-out is
// free — unused particles simply aren't drawn.

import * as THREE from "three";

const MAX_PARTICLES = 6000;
const CYL_RADIUS = 25.0;
const CYL_HEIGHT = 30.0;
const FALL_SPEED_BASE = 12.0;       // m/s straight down at intensity 1.0
const FALL_SPEED_JITTER = 2.5;      // ± per-particle randomization
const WIND_DRIFT_X = 0.8;           // small horizontal drift, m/s
const WIND_DRIFT_Z = 0.3;
const STREAK_LEN = 0.6;             // meters
const STREAK_WIDTH = 0.012;         // meters
const STREAK_COLOR = 0xb8c8dc;
const STREAK_ALPHA = 0.45;

const _tmpObj = new THREE.Object3D();

export class RainSystem {
  constructor({ scene, camera }) {
    if (!scene || !camera) {
      throw new Error("RainSystem: scene + camera required");
    }
    this._scene = scene;
    this._camera = camera;
    this._intensity = 0.0;

    const geom = new THREE.PlaneGeometry(STREAK_WIDTH, STREAK_LEN);
    // Translate so the streak hangs DOWNWARD from its position (anchor at top).
    geom.translate(0, -STREAK_LEN * 0.5, 0);

    const mat = new THREE.MeshBasicMaterial({
      color: STREAK_COLOR,
      transparent: true,
      opacity: STREAK_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    this._geom = geom;
    this._mat = mat;

    const mesh = new THREE.InstancedMesh(geom, mat, MAX_PARTICLES);
    mesh.name = "rain-streaks";
    mesh.frustumCulled = false;
    mesh.renderOrder = 950;
    mesh.count = 0;
    mesh.visible = false;
    this._mesh = mesh;

    // Per-particle state arrays (CPU-side; we push only the matrix to GPU).
    this._pos = new Float32Array(MAX_PARTICLES * 3);
    this._vel = new Float32Array(MAX_PARTICLES * 3);

    // Seed positions inside the cylinder so the very first visible frame is
    // already saturated (no spawn-in fade).
    const cam = this._camera.position;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._seedParticle(i, cam.x, cam.y, cam.z, /*atTop=*/ false);
    }

    scene.add(mesh);
  }

  _seedParticle(i, cx, cy, cz, atTop) {
    // Uniform-area sample inside the disc: r = R*sqrt(u), θ = 2π*v.
    const r = CYL_RADIUS * Math.sqrt(Math.random());
    const th = Math.random() * Math.PI * 2;
    const yOff = atTop
      ? CYL_HEIGHT * 0.5
      : (Math.random() - 0.5) * CYL_HEIGHT;
    const idx = i * 3;
    this._pos[idx + 0] = cx + r * Math.cos(th);
    this._pos[idx + 1] = cy + yOff;
    this._pos[idx + 2] = cz + r * Math.sin(th);
    const speed = FALL_SPEED_BASE + (Math.random() - 0.5) * FALL_SPEED_JITTER;
    this._vel[idx + 0] = WIND_DRIFT_X;
    this._vel[idx + 1] = -speed;
    this._vel[idx + 2] = WIND_DRIFT_Z;
  }

  setIntensity(t) {
    const v = Math.max(0, Math.min(1, +t || 0));
    this._intensity = v;
    const target = Math.floor(MAX_PARTICLES * v);
    this._mesh.count = target;
    this._mesh.visible = target > 0;
  }

  tick(dt) {
    if (this._intensity <= 0 || this._mesh.count <= 0) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const cam = this._camera.position;
    const cx = cam.x, cy = cam.y, cz = cam.z;
    const yTop = cy + CYL_HEIGHT * 0.5;
    const yBot = cy - CYL_HEIGHT * 0.5;
    const r2 = CYL_RADIUS * CYL_RADIUS;
    const speedScale = 0.7 + 0.6 * this._intensity; // light drizzle → heavy
    const count = this._mesh.count;

    for (let i = 0; i < count; i++) {
      const p = i * 3;
      this._pos[p + 0] += this._vel[p + 0] * dt;
      this._pos[p + 1] += this._vel[p + 1] * dt * speedScale;
      this._pos[p + 2] += this._vel[p + 2] * dt;

      const dx = this._pos[p + 0] - cx;
      const dz = this._pos[p + 2] - cz;
      const horiz2 = dx * dx + dz * dz;

      // Wrap if below ground-of-cylinder OR drifted past the disc edge OR
      // the camera moved far enough that the particle is now stranded.
      if (this._pos[p + 1] < yBot || horiz2 > r2) {
        this._seedParticle(i, cx, cy, cz, /*atTop=*/ true);
        continue;
      }
      // Re-anchor vertically if the camera moved UP faster than rain falls.
      if (this._pos[p + 1] > yTop) {
        this._pos[p + 1] = yTop;
      }

      _tmpObj.position.set(
        this._pos[p + 0],
        this._pos[p + 1],
        this._pos[p + 2]
      );
      _tmpObj.rotation.set(0, 0, 0);
      _tmpObj.scale.set(1, 1, 1);
      _tmpObj.updateMatrix();
      this._mesh.setMatrixAt(i, _tmpObj.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._mesh && this._mesh.parent) {
      this._mesh.parent.remove(this._mesh);
    }
    if (this._mesh) this._mesh.dispose?.();
    this._geom.dispose();
    this._mat.dispose();
    this._pos = null;
    this._vel = null;
    this._mesh = null;
  }
}
