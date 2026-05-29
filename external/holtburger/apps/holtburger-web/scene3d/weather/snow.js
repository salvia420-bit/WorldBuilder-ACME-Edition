// scene3d/weather/snow.js — InstancedMesh snow flakes around the camera.
//
// W2 (2026-05-29). Mirrors RainSystem's camera-anchored cylinder + toroidal
// wrap, but tuned for snow: small quad flakes (not thin streaks), a much
// slower fall, and a per-particle horizontal SWAY (phase-offset sine) so
// flakes drift instead of falling dead-straight. `setIntensity(t)` clamps
// `instance.count` so a fade is free, identical to rain.
//
// Selection (W2): the WeatherEffectsManager picks snow over rain when the
// active weather profile's `temperature_C` is at/below freezing (cold →
// snow). Retail has no clean rain-vs-snow flag — precip type is encoded in
// which streak-mesh GfxObj / PhysicsScript the DayGroup references — so the
// temperature heuristic is the first cut (the manager can upgrade to a
// streak-GfxObj-id keyed selection once W1's SkyObject lookup is wired).

import * as THREE from "three";

const MAX_PARTICLES = 4000;
const CYL_RADIUS = 22.0;
const CYL_HEIGHT = 30.0;
const FALL_SPEED_BASE = 1.6;        // m/s — snow falls far slower than rain
const FALL_SPEED_JITTER = 0.8;      // ± per-particle randomization
const WIND_DRIFT_X = 0.5;           // mean horizontal drift, m/s
const WIND_DRIFT_Z = 0.25;
const SWAY_AMP = 0.7;               // m/s peak sway velocity
const SWAY_FREQ = 0.6;              // Hz-ish base; per-particle jittered
const FLAKE_SIZE = 0.05;            // meters (square quad)
const FLAKE_COLOR = 0xf2f6ff;
const FLAKE_ALPHA = 0.7;

const _tmpObj = new THREE.Object3D();

export class SnowSystem {
  constructor({ scene, camera }) {
    if (!scene || !camera) {
      throw new Error("SnowSystem: scene + camera required");
    }
    this._scene = scene;
    this._camera = camera;
    this._intensity = 0.0;
    this._elapsed = 0.0;

    // A small square quad reads as a flake; rain uses a thin tall plane.
    const geom = new THREE.PlaneGeometry(FLAKE_SIZE, FLAKE_SIZE);

    const mat = new THREE.MeshBasicMaterial({
      color: FLAKE_COLOR,
      transparent: true,
      opacity: FLAKE_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    this._geom = geom;
    this._mat = mat;

    const mesh = new THREE.InstancedMesh(geom, mat, MAX_PARTICLES);
    mesh.name = "snow-flakes";
    mesh.frustumCulled = false;
    mesh.renderOrder = 951; // just after rain
    mesh.count = 0;
    mesh.visible = false;
    this._mesh = mesh;

    // Per-particle state arrays (CPU-side; we push only the matrix).
    this._pos = new Float32Array(MAX_PARTICLES * 3);
    this._vel = new Float32Array(MAX_PARTICLES * 3); // base fall velocity
    this._sway = new Float32Array(MAX_PARTICLES * 2); // [phase, freq]

    const cam = this._camera.position;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this._seedParticle(i, cam.x, cam.y, cam.z, /*atTop=*/ false);
    }

    scene.add(mesh);
  }

  _seedParticle(i, cx, cy, cz, atTop) {
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
    const s = i * 2;
    this._sway[s + 0] = Math.random() * Math.PI * 2;       // phase
    this._sway[s + 1] = SWAY_FREQ * (0.6 + Math.random());  // freq jitter
  }

  setIntensity(t) {
    const v = Math.max(0, Math.min(1, +t || 0));
    this._intensity = v;
    const target = Math.floor(MAX_PARTICLES * v);
    this._mesh.count = target;
    this._mesh.visible = target > 0;
  }

  /**
   * Scale horizontal wind drift (W5). 1.0 = nominal; 0 = calm. Called by
   * the manager each tick so wind tracks storm intensity.
   */
  setWindScale(s) {
    this._windScale = Math.max(0, +s || 0);
  }

  tick(dt) {
    if (this._intensity <= 0 || this._mesh.count <= 0) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._elapsed += dt;
    const cam = this._camera.position;
    const cx = cam.x, cy = cam.y, cz = cam.z;
    const yTop = cy + CYL_HEIGHT * 0.5;
    const yBot = cy - CYL_HEIGHT * 0.5;
    const r2 = CYL_RADIUS * CYL_RADIUS;
    const speedScale = 0.7 + 0.6 * this._intensity;
    const windScale = Number.isFinite(this._windScale) ? this._windScale : 1.0;
    const count = this._mesh.count;
    const t = this._elapsed;

    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const s = i * 2;
      // Per-particle horizontal sway (sine on x, cosine on z so flakes
      // trace little ellipses) layered on the mean wind drift.
      const phase = this._sway[s + 0] + t * this._sway[s + 1] * Math.PI * 2;
      const swayX = Math.sin(phase) * SWAY_AMP;
      const swayZ = Math.cos(phase * 0.7) * SWAY_AMP * 0.6;

      this._pos[p + 0] += (this._vel[p + 0] * windScale + swayX) * dt;
      this._pos[p + 1] += this._vel[p + 1] * dt * speedScale;
      this._pos[p + 2] += (this._vel[p + 2] * windScale + swayZ) * dt;

      const dx = this._pos[p + 0] - cx;
      const dz = this._pos[p + 2] - cz;
      const horiz2 = dx * dx + dz * dz;

      if (this._pos[p + 1] < yBot || horiz2 > r2) {
        this._seedParticle(i, cx, cy, cz, /*atTop=*/ true);
        continue;
      }
      if (this._pos[p + 1] > yTop) {
        this._pos[p + 1] = yTop;
      }

      _tmpObj.position.set(
        this._pos[p + 0],
        this._pos[p + 1],
        this._pos[p + 2]
      );
      // Billboard the flake toward the camera so the quad always shows
      // its face (cheap: copy the camera quaternion).
      _tmpObj.quaternion.copy(this._camera.quaternion);
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
    this._sway = null;
    this._mesh = null;
  }
}
