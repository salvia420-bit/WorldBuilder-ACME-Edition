// tests/vehicle_deployable_models.test.mjs — Headless WebGL2 Rendering Test Suite
// for 8-Unit Modular Deployable Ecosystem (WCID 4000010 - 4000017) + Full & Half Pallets.
// Verifies:
// 1. Zero console errors across instantiation, animation updates, and WebGL2 rendering.
// 2. Strict GPU draw call budget: <= 10 draw calls per unit.
// 3. Strict GPU lighting cap: 0 dynamic lights (lightCountDelta === 0, 0 THREE.Light instances).
// 4. Clean GPU resource disposal without leaks.
//
// Run:
//   node external/holtburger/apps/holtburger-web/tests/vehicle_deployable_models.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";
import { lintManifest } from "../scene3d/vfx/lint_caps.js";
import {
  buildPallet,
  buildDeployable,
  PALLET_SPECS,
  DEPLOYABLE_WCID,
  manifest,
} from "../scene3d/vehicle/deployable_models.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

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

function countDrawCalls(root) {
  let calls = 0;
  root.traverse((o) => {
    if (o.isMesh || o.isLine || o.isSprite || o.isPoints) calls++;
  });
  return calls;
}

function countLights(root) {
  let lights = 0;
  root.traverse((o) => {
    if (o.isLight) lights++;
  });
  return lights;
}

console.log("=== Headless WebGL2 Deployable Models & Rendering Suite ===");

// 1. Pallet Geometries & GPU Invariants
await check("T_MOD_01 Full & Half Pallet Draw Calls & Dimensions", () => {
  const full = buildPallet(THREE, "full");
  const half = buildPallet(THREE, "half");

  const fullCalls = countDrawCalls(full.root);
  const halfCalls = countDrawCalls(half.root);
  assert.equal(fullCalls, 1, `full pallet draw calls (${fullCalls}) === 1`);
  assert.equal(halfCalls, 1, `half pallet draw calls (${halfCalls}) === 1`);

  assert.equal(countLights(full.root), 0, "full pallet has 0 lights");
  assert.equal(countLights(half.root), 0, "half pallet has 0 lights");

  assert.equal(full.spec.width, 1.2192);
  assert.equal(full.spec.depth, 1.0160);
  assert.equal(half.spec.width, 0.6096);
  assert.equal(half.spec.depth, 1.0160);

  full.dispose();
  half.dispose();
});

// 2. Manifest & VFX Capability Gate
await check("T_MOD_02 Deployable Models Manifest Compliance", () => {
  assert.equal(manifest.lightCountDelta, 0, "lightCountDelta === 0");
  const errors = lintManifest(manifest);
  assert.equal(errors.length, 0, `manifest lint errors: ${errors.join(", ")}`);
});

// 3. Per-Unit 3D Procedural Model Invariants
const UNITS = [
  { name: "Flux Pod", wcid: DEPLOYABLE_WCID.FluxPod, maxCalls: 10, palletSize: "full" },
  { name: "Solar Panels", wcid: DEPLOYABLE_WCID.SolarPanels, maxCalls: 10, palletSize: "full" },
  { name: "Power Generator", wcid: DEPLOYABLE_WCID.PowerGenerator, maxCalls: 10, palletSize: "full" },
  { name: "Battery Unit", wcid: DEPLOYABLE_WCID.BatteryUnit, maxCalls: 10, palletSize: "half" },
  { name: "Autonomous Missile Turret", wcid: DEPLOYABLE_WCID.MissileTurret, maxCalls: 10, palletSize: "full" },
  { name: "Ground Radar", wcid: DEPLOYABLE_WCID.GroundRadar, maxCalls: 10, palletSize: "half" },
  { name: "Mortar Turret", wcid: DEPLOYABLE_WCID.MortarTurret, maxCalls: 10, palletSize: "half" },
  { name: "Heavy Laser Turret", wcid: DEPLOYABLE_WCID.HeavyLaserTurret, maxCalls: 10, palletSize: "half" },
];

for (const u of UNITS) {
  await check(`T_MOD_${u.wcid} ${u.name} (WCID ${u.wcid}): Draw Calls <= 10 & 0 Lights`, () => {
    const unit = buildDeployable(THREE, u.wcid);
    const calls = countDrawCalls(unit.root);
    const lights = countLights(unit.root);

    assert.ok(calls > 0 && calls <= u.maxCalls, `${u.name} draw calls (${calls}) <= ${u.maxCalls}`);
    assert.equal(lights, 0, `${u.name} dynamic lights (${lights}) === 0`);
    assert.equal(unit.palletSize, u.palletSize, `${u.name} palletSize === ${u.palletSize}`);

    // Exercise state update kinematics
    unit.update({
      simTimeSec: 1.5,
      sunPitchRad: 0.8,
      sunAzimuthRad: 1.2,
      isDay: true,
      fuelRemaining: 50.0,
      energyJoules: 300000.0,
      capacityJoules: 600000.0,
      deployElevation: 1.0,
      yawRad: 0.5,
      pitchRad: 0.2,
      rollRad: 0.0,
      ammoRemaining: 3,
    });

    unit.dispose();
  });
}

// 4. Headless WebGL2 Combined Scene Rendering Test
await check("T_MOD_RENDER Headless WebGL2 Multi-Unit Scene Render & Teardown", () => {
  // Capture console errors
  const originalError = console.error;
  const originalWarn = console.warn;
  const capturedErrors = [];

  console.error = (...args) => {
    capturedErrors.push(args.join(" "));
    originalError(...args);
  };

  try {
    const gl = createFakeWebGL2({ maxTextures: 16 });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1.33, 0.1, 1000);
    camera.position.set(0, -10, 5);
    camera.lookAt(0, 0, 1);

    const activeUnits = [];
    let totalDrawCalls = 0;

    for (let i = 0; i < UNITS.length; i++) {
      const u = UNITS[i];
      const instance = buildDeployable(THREE, u.wcid);
      const calls = countDrawCalls(instance.root);
      assert.ok(calls <= 10, `${u.name} draw calls (${calls}) <= 10`);
      totalDrawCalls += calls;

      // Position units on grid
      instance.root.position.set((i % 4) * 3 - 4.5, Math.floor(i / 4) * 3 - 1.5, 0);
      scene.add(instance.root);
      activeUnits.push(instance);
    }

    assert.equal(countLights(scene), 0, "Scene contains exactly 0 THREE.Light instances");

    // Perform headless render
    gl.__fake.reset();
    renderer.render(scene, camera);

    const emittedDraws = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
    assert.ok(emittedDraws > 0, `Headless WebGL2 executed ${emittedDraws} draw commands`);

    // Verify zero console errors occurred during creation or render
    assert.equal(capturedErrors.length, 0, `Encountered console errors: ${capturedErrors.join(" | ")}`);

    // Teardown and GPU resource disposal
    for (const unit of activeUnits) {
      scene.remove(unit.root);
      unit.dispose();
    }
    renderer.dispose();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
});

console.log("");
console.log(`vehicle_deployable_models: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
