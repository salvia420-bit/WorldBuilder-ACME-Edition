// scene3d/weather/lightning.js — Poisson-triggered flash + delayed thunder.
//
// Standalone DirectionalLight (intensity 0 baseline) pulses through a 3-sub-
// pulse profile over ~250 ms. After the flash, the audio one-shot is fired
// at `t_play = distance / SPEED_OF_SOUND` to give the visual→audio gap that
// sells "lightning is far". Poisson trigger: per tick, P(strike) = λ * dt
// (small-dt approximation of the homogeneous Poisson process).

import * as THREE from "three";

const FLASH_COLOR = 0xeaf2ff;
const PULSE_OFFSETS_MS = [0, 80, 180];     // sub-pulse start times
const PULSE_INTENSITIES = [4, 2, 6];       // unit-scale, multiplied by setIntensity
const PULSE_DURATION_MS = 60;              // each sub-pulse ramps up/down over this
const FLASH_TOTAL_MS = 280;                // after this, light is back to 0
const FAKE_DIST_MIN_M = 200;               // ~0.6 s thunder delay
const FAKE_DIST_MAX_M = 1700;              // ~5.0 s thunder delay
const SPEED_OF_SOUND_MPS = 343;
const DEFAULT_THUNDER_DID = 0x0A000045;

export class LightningSystem {
  constructor({ scene, audioManager, getCameraWorldPos, thunderDid }) {
    if (!scene) throw new Error("LightningSystem: scene required");
    this._scene = scene;
    this._audio = audioManager || null;
    this._getCameraWorldPos =
      typeof getCameraWorldPos === "function" ? getCameraWorldPos : null;
    this._thunderDid = (thunderDid ?? DEFAULT_THUNDER_DID) >>> 0;

    this._rate = 0;        // flashes/sec (λ)
    this._intensity = 1.0; // multiplier on PULSE_INTENSITIES

    const light = new THREE.DirectionalLight(FLASH_COLOR, 0);
    light.name = "lightning-flash";
    light.position.set(0, 800, 0); // arbitrary; directional only cares about direction
    light.target.position.set(0, 0, 0);
    scene.add(light);
    scene.add(light.target);
    this._light = light;

    // Active flash state. _flashStartMs = -1 means inactive.
    this._flashStartMs = -1;
    this._elapsedMs = 0;
    // Pending thunder schedule. { atMs, did, worldPos }.
    this._pendingThunder = [];
  }

  setRate(r) {
    this._rate = Math.max(0, +r || 0);
  }

  setIntensity(i) {
    this._intensity = Math.max(0, +i || 0);
  }

  _triggerFlash() {
    this._flashStartMs = this._elapsedMs;
    // Pick a fake distance (200 m..1.7 km) → audio delay + thunder volume.
    const dist =
      FAKE_DIST_MIN_M + Math.random() * (FAKE_DIST_MAX_M - FAKE_DIST_MIN_M);
    const delayMs = (dist / SPEED_OF_SOUND_MPS) * 1000;
    const playAtMs = this._elapsedMs + delayMs;
    // Closer thunder → louder (clamp 0.25..0.85).
    const distNorm = (dist - FAKE_DIST_MIN_M) / (FAKE_DIST_MAX_M - FAKE_DIST_MIN_M);
    const gain = 0.85 - 0.6 * distNorm;
    let worldPos = { x: 0, y: 0, z: 0 };
    if (this._getCameraWorldPos) {
      try {
        const p = this._getCameraWorldPos();
        if (p) worldPos = { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 };
      } catch (_) {}
    }
    this._pendingThunder.push({ atMs: playAtMs, did: this._thunderDid, worldPos, gain });
  }

  _evalFlashIntensity(localMs) {
    // Sum of triangular pulses centered at each PULSE_OFFSETS_MS entry,
    // half-width = PULSE_DURATION_MS / 2.
    let total = 0;
    const half = PULSE_DURATION_MS * 0.5;
    for (let k = 0; k < PULSE_OFFSETS_MS.length; k++) {
      const center = PULSE_OFFSETS_MS[k] + half;
      const peak = PULSE_INTENSITIES[k] * this._intensity;
      const d = Math.abs(localMs - center);
      if (d < half) {
        total += peak * (1 - d / half);
      }
    }
    return total;
  }

  tick(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    const dtMs = dt * 1000;
    this._elapsedMs += dtMs;

    // Poisson trigger — only when no flash is currently active.
    if (this._rate > 0 && this._flashStartMs < 0) {
      const p = this._rate * dt;
      if (Math.random() < p) {
        this._triggerFlash();
      }
    }

    // Update active flash light intensity.
    if (this._flashStartMs >= 0) {
      const localMs = this._elapsedMs - this._flashStartMs;
      if (localMs >= FLASH_TOTAL_MS) {
        this._light.intensity = 0;
        this._flashStartMs = -1;
      } else {
        this._light.intensity = this._evalFlashIntensity(localMs);
      }
    }

    // Fire any pending thunder whose schedule has come due.
    if (this._pendingThunder.length > 0) {
      const remaining = [];
      for (const item of this._pendingThunder) {
        if (this._elapsedMs >= item.atMs) {
          if (this._audio && typeof this._audio.play === "function") {
            try {
              this._audio.play(item.did, item.worldPos, {
                gain: item.gain,
                refDistance: 50,
                maxDistance: 5000,
                rolloffFactor: 0.4,
              });
            } catch (_) {}
          }
        } else {
          remaining.push(item);
        }
      }
      this._pendingThunder = remaining;
    }
  }

  /** Force a single flash now (for dev/test). */
  flashNow() {
    this._flashStartMs = -1; // allow re-trigger even if mid-flash
    this._triggerFlash();
  }

  dispose() {
    if (this._light) {
      if (this._light.parent) this._light.parent.remove(this._light);
      if (this._light.target && this._light.target.parent) {
        this._light.target.parent.remove(this._light.target);
      }
      this._light.dispose?.();
    }
    this._light = null;
    this._pendingThunder = [];
    this._flashStartMs = -1;
  }
}
