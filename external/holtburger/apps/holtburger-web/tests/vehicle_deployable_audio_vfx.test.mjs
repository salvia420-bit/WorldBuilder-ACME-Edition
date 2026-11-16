// tests/vehicle_deployable_audio_vfx.test.mjs — Comprehensive unit test suite
// for deployable pooled VFX (SamSmokeTrailPool, MortarVfxSimulator, HeavyLaserBeamPool)
// and spatialized WebAudio synthesis (DeployableAudioManager).

import * as THREE from "three";
import assert from "node:assert/strict";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import {
  SamSmokeTrailPool,
  MortarVfxSimulator,
  HeavyLaserBeamPool,
  manifest as vfxManifest,
} from "../scene3d/vehicle/deployable_vfx.js";
import {
  DeployableAudioManager,
  DEPLOYABLE_AUDIO_TUNING,
} from "../scene3d/vehicle/deployable_audio.js";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

installFakeAudio();

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

const near = (a, b, eps = 1e-4, msg = "") => {
  assert.ok(Math.abs(a - b) <= eps, `${msg ? `${msg}: ` : ""}expected ${b} ± ${eps}, got ${a}`);
};

console.log("=== Deployable VFX & Audio Test Suite ===");

// 1. SAM Smoke Trail Pool
await check("T_VFX_01 SamSmokeTrailPool capacity & manifest", () => {
  const pool = new SamSmokeTrailPool(THREE, 4);
  assert.equal(pool.trails.length, 4, "4 trails pre-allocated");
  assert.equal(lintManifest(pool.manifest).length, 0, "manifest lint clean");
  pool.dispose();
});

await check("T_VFX_02 SamSmokeTrailPool spawn, lifecycle & decay", () => {
  const pool = new SamSmokeTrailPool(THREE, 2);
  const t0 = pool.spawn([10, 20, 5]);
  assert.ok(t0, "trail spawned");
  assert.equal(t0.active, true);
  assert.equal(t0.mesh.visible, true);
  near(t0.mesh.position.x, 10);
  near(t0.mesh.position.y, 20);
  near(t0.mesh.position.z, 5);

  const t1 = pool.spawn([0, 0, 0]);
  assert.ok(t1, "second trail spawned");
  const t2 = pool.spawn([0, 0, 0]);
  assert.equal(t2, null, "pool exhaustion returns null");

  pool.update(1.5);
  near(t0.mat.opacity, 0.4, 0.05, "halfway decay");

  pool.update(1.6);
  assert.equal(t0.active, false, "retired after 3.0s");
  assert.equal(t0.mesh.visible, false);

  const t3 = pool.spawn([1, 1, 1]);
  assert.ok(t3, "recycled slot reused");
  pool.dispose();
});

// 2. Mortar VFX Simulator
await check("T_VFX_03 MortarVfxSimulator manifest & trajectory", () => {
  const sim = new MortarVfxSimulator();
  assert.equal(lintManifest(sim.manifest).length, 0, "manifest lint clean");
  const aim = sim.computeTrajectory50_50([0, 0, 0], [100, 100, 0], [20, 0, 0], 5.0);
  near(aim[0], 150, 1e-4, "aim X = 0.5*100 + 0.5*(100 + 100) = 150");
  near(aim[1], 100, 1e-4, "aim Y = 100");
});

await check("T_VFX_04 MortarVfxSimulator dual bounces & shockwave", () => {
  const sim = new MortarVfxSimulator();
  const bounces = sim.simulateBounces(-30.0);
  assert.equal(bounces.bouncesCount, 2);
  near(bounces.bounce1Vz, 13.5, 1e-4);
  near(bounces.bounce2Vz, -4.05, 1e-4);

  const shock = sim.createShockwaveMesh(THREE);
  assert.ok(shock.mesh);
  sim.expandShockwave(shock.mesh, shock.mat, 0.1, 0.2);
  near(shock.mesh.scale.x, 5.5, 0.1);
  near(shock.mat.opacity, 0.5, 0.05);
  sim.expandShockwave(shock.mesh, shock.mat, 0.25, 0.2);
  assert.equal(shock.mesh.visible, false);
  shock.geom.dispose();
  shock.mat.dispose();
});

// 3. Heavy Laser Beam Pool
await check("T_VFX_05 HeavyLaserBeamPool capacity, fire & exponential decay", () => {
  const pool = new HeavyLaserBeamPool(THREE, 4);
  assert.equal(pool.beams.length, 4);
  assert.equal(lintManifest(pool.manifest).length, 0, "manifest lint clean");

  const beam = pool.fire([0, 0, 0], [0, 850, 0]);
  assert.ok(beam);
  assert.equal(beam.active, true);
  near(beam.mat.opacity, 1.0);
  near(beam.mesh.position.y, 425);

  pool.update(0.04);
  near(beam.mat.opacity, Math.exp(-1), 0.05);

  pool.update(0.3);
  assert.equal(beam.active, false);
  assert.equal(beam.mesh.visible, false);
  pool.dispose();
});

// 4. Module VFX manifest
await check("T_VFX_06 Module level VFX manifest", () => {
  assert.equal(lintManifest(vfxManifest).length, 0);
});

function createMockAudioContext() {
  const param = (v = 0) => ({
    value: v,
    setValueAtTime(val) { this.value = val; },
    linearRampToValueAtTime(val) { this.value = val; },
    exponentialRampToValueAtTime(val) { this.value = val; },
    cancelScheduledValues() {},
  });
  const mockNode = (extra = {}) => ({
    connections: [],
    connect(to) { this.connections.push(to); return to; },
    disconnect() { this.connections = []; },
    ...extra,
  });
  return {
    state: "running",
    currentTime: 10.0,
    sampleRate: 44100,
    destination: mockNode(),
    createGain() { return mockNode({ gain: param(1) }); },
    createOscillator() {
      return mockNode({
        frequency: param(440),
        type: "sine",
        start() {},
        stop() {},
      });
    },
    createBiquadFilter() {
      return mockNode({
        frequency: param(1000),
        Q: param(1),
        type: "lowpass",
      });
    },
    createPanner() {
      return mockNode({
        positionX: param(0),
        positionY: param(0),
        positionZ: param(0),
        panningModel: "HRTF",
        distanceModel: "exponential",
        refDistance: 1,
        maxDistance: 100,
        rolloffFactor: 1,
      });
    },
    createBuffer(channels, length, sampleRate) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: () => new Float32Array(length),
      };
    },
    createBufferSource() {
      return mockNode({
        buffer: null,
        start() {},
        stop() {},
      });
    },
  };
}

// 5. Deployable Audio Manager
await check("T_AUD_01 DEPLOYABLE_AUDIO_TUNING constants", () => {
  assert.equal(DEPLOYABLE_AUDIO_TUNING.speedOfSound, 343);
  assert.equal(DEPLOYABLE_AUDIO_TUNING.generatorBaseHz, 55);
  assert.equal(DEPLOYABLE_AUDIO_TUNING.pneumaticDurationSec, 0.35);
  assert.equal(DEPLOYABLE_AUDIO_TUNING.samDurationSec, 1.2);
  assert.equal(DEPLOYABLE_AUDIO_TUNING.mortarExplosionMaxRangeM, 2500);
});

await check("T_AUD_02 DeployableAudioManager generator hum lifecycle", () => {
  const ctx = createMockAudioContext();
  const bus = { ctx, node: ctx.destination };
  const mgr = new DeployableAudioManager(bus);

  const hum = mgr.createGeneratorHum("gen-1", [10, 20, 0]);
  assert.ok(hum);
  assert.equal(hum.active, true);

  // Update fuel
  mgr.updateGeneratorFuel("gen-1", 120);
  near(hum.masterGain.gain.value, 0.35);

  // Zero fuel
  mgr.updateGeneratorFuel("gen-1", 0);
  near(hum.masterGain.gain.value, 0.0);

  // Stop hum
  mgr.stopGeneratorHum("gen-1");
  assert.equal(mgr.generators.has("gen-1"), false);
  mgr.dispose();
});

await check("T_AUD_03 DeployableAudioManager weapon sounds execution", () => {
  const ctx = createMockAudioContext();
  const bus = { ctx, node: ctx.destination };
  const mgr = new DeployableAudioManager(bus);

  // Pneumatic rise
  mgr.playPneumaticRise([0, 0, 1]);

  // SAM launch
  mgr.playSamLaunch([0, 0, 2]);

  // Mortar launch, bounces, explosion
  mgr.playMortarLaunch([10, 0, 0]);
  mgr.playMortarBounce([100, 100, 0], 1);
  mgr.playMortarBounce([105, 105, 0], 2);
  mgr.playMortarExplosion([500, 500, 0], [0, 0, 0]);

  // Laser discharge
  mgr.playLaserDischarge([0, 0, 1]);

  mgr.dispose();
});

await check("T_AUD_04 DeployableAudioManager graceful fallback when context missing", () => {
  const mgr = new DeployableAudioManager(null);
  assert.equal(mgr.createGeneratorHum("gen-null"), null);
  mgr.playPneumaticRise();
  mgr.playSamLaunch();
  mgr.playMortarLaunch();
  mgr.playMortarBounce();
  mgr.playMortarExplosion();
  mgr.playLaserDischarge();
  mgr.dispose();
});

console.log("");
console.log(`vehicle_deployable_audio_vfx: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
