// tests/vehicle_deployable_models.test.mjs — Headless WebGL2 Rendering Test Suite
// for 8-Unit Modular Deployable Ecosystem (WCID 4000010 - 4000017) + Unified ISO 6780 Pallet.
// Verifies:
// 1. Unified 1.100 × 1.100 × 0.145 m 4-way pallet specs, tunnel clearance, and retractable leveling jacks.
// 2. Zero console errors across instantiation, animation updates, and WebGL2 rendering.
// 3. Strict GPU draw call budget: <= 10 draw calls per unit (<= 2 for pallet).
// 4. Strict GPU lighting cap: 0 dynamic lights (lightCountDelta === 0, 0 THREE.Light instances).
// 5. Strict stowed Box3 envelope (|x|,|y| <= 0.555 m, 0 <= z <= 2.05 m) and measurable stowed-vs-deployed delta.
// 6. Clean GPU resource disposal without leaks.
//
// Run:
//   node external/holtburger/apps/holtburger-web/tests/vehicle_deployable_models.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";
import { lintManifest } from "../scene3d/vfx/lint_caps.js";
import {
  GeomAcc,
  cShade,
  buildPallet,
  buildDeployable,
  PALLET_SPECS,
  DEPLOYABLE_KINDS,
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
    if (o.visible && (o.isMesh || o.isLine || o.isSprite || o.isPoints)) calls++;
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

function boxVolume(b) {
  const s = new THREE.Vector3();
  b.getSize(s);
  return s.x * s.y * s.z;
}

function boxesDiffer(a, b, eps = 0.01) {
  return (
    Math.abs(a.min.x - b.min.x) > eps ||
    Math.abs(a.min.y - b.min.y) > eps ||
    Math.abs(a.min.z - b.min.z) > eps ||
    Math.abs(a.max.x - b.max.x) > eps ||
    Math.abs(a.max.y - b.max.y) > eps ||
    Math.abs(a.max.z - b.max.z) > eps
  );
}

console.log("=== Headless WebGL2 Deployable Models & Rendering Suite ===");

// 1. Unified ISO 6780 Pallet Geometries, 4-Way Fork Tunnels, Leveling Jacks & GPU Invariants
await check("T_MOD_01 Unified 1.100×1.100×0.145m 4-Way Pallet, Jacks & Draw Calls <= 2", () => {
  assert.equal(PALLET_SPECS.standard.width, 1.100);
  assert.equal(PALLET_SPECS.standard.depth, 1.100);
  assert.equal(PALLET_SPECS.standard.height, 0.145);
  assert.equal(PALLET_SPECS.standard.deckUndersideZ, 0.123);
  assert.equal(PALLET_SPECS.standard.tunnelMinZ, 0.018);
  assert.equal(PALLET_SPECS.standard.tunnelMaxZ, 0.123);
  assert.equal(PALLET_SPECS.full, PALLET_SPECS.standard);
  assert.deepEqual(PALLET_SPECS.mountOffsets.fullBed, [0.0, -1.15, 0.72]);

  const std = buildPallet(THREE, "standard", { stowed: true });
  const legacyFull = buildPallet(THREE, "full", { stowed: false });
  const legacyHalf = buildPallet(THREE, "half", { stowed: true });

  for (const p of [std, legacyFull, legacyHalf]) {
    const calls = countDrawCalls(p.root);
    assert.ok(calls >= 1 && calls <= 2, `pallet draw calls (${calls}) in [1, 2]`);
    assert.equal(countLights(p.root), 0, "pallet has 0 lights");
    assert.equal(p.spec.width, 1.100);
    assert.equal(p.spec.depth, 1.100);
    assert.equal(p.spec.height, 0.145);
    assert.equal(p.size, "standard");
  }

  // Verify retractable leveling jacks: stowed inside ±0.550 & z >= 0.02, deployed extended to ±0.580 & z = 0.000
  std.root.updateMatrixWorld(true);
  const stowedBox = new THREE.Box3().setFromObject(std.root);
  assert.ok(stowedBox.min.x >= -0.551 && stowedBox.max.x <= 0.551, `stowed X [${stowedBox.min.x}, ${stowedBox.max.x}]`);
  assert.ok(stowedBox.min.y >= -0.551 && stowedBox.max.y <= 0.551, `stowed Y [${stowedBox.min.y}, ${stowedBox.max.y}]`);
  assert.ok(Math.abs(stowedBox.max.z - 0.145) < 1e-4, `stowed height ${stowedBox.max.z}`);
  const jacksStowedBox = new THREE.Box3().setFromObject(std.levelingJacks);
  assert.ok(jacksStowedBox.min.z >= 0.02, `stowed leveling jacks raised >= 0.02m (got ${jacksStowedBox.min.z})`);
  assert.ok(Math.abs(jacksStowedBox.max.x) <= 0.550 && Math.abs(jacksStowedBox.max.y) <= 0.550, "stowed jacks tucked inside ±0.550m");

  std.setDeployed(true);
  std.root.updateMatrixWorld(true);
  const jacksDeployedBox = new THREE.Box3().setFromObject(std.levelingJacks);
  assert.ok(Math.abs(jacksDeployedBox.min.z - 0.0) < 1e-4, `deployed jacks rest at z = 0.000m (got ${jacksDeployedBox.min.z})`);
  assert.ok(jacksDeployedBox.max.x >= 0.57 && jacksDeployedBox.max.y >= 0.57, "deployed jacks extend outward to ~±0.58m");

  // Verify symmetric 4-way fork tunnels (x/y ∈ ±[0.090, 0.390], z ∈ [0.018, 0.123]) have no deck triangles inside
  const posAttr = std.mesh.geometry.getAttribute("position");
  let vertsInForkTunnelY = 0;
  for (let i = 0; i < posAttr.count; i += 3) {
    const cx = (posAttr.getX(i) + posAttr.getX(i + 1) + posAttr.getX(i + 2)) / 3;
    const cy = (posAttr.getY(i) + posAttr.getY(i + 1) + posAttr.getY(i + 2)) / 3;
    const cz = (posAttr.getZ(i) + posAttr.getZ(i + 1) + posAttr.getZ(i + 2)) / 3;
    if (cz > 0.020 && cz < 0.121) {
      const inXTunnel = Math.abs(cx) > 0.095 && Math.abs(cx) < 0.385;
      const inYTunnel = Math.abs(cy) > 0.095 && Math.abs(cy) < 0.385;
      if (inXTunnel || inYTunnel) vertsInForkTunnelY++;
    }
  }
  assert.equal(vertsInForkTunnelY, 0, "4-way fork tunnels clear of structural block geometry");

  std.dispose();
  legacyFull.dispose();
  legacyHalf.dispose();
});

// 1b. GeomAcc & Linear Color Export Verification
await check("T_MOD_01b GeomAcc Export & Linear AO Shading", () => {
  const acc = new GeomAcc();
  const cTop = [0.5, 0.4, 0.3];
  const cBot = cShade(cTop, 0.85);
  assert.ok(Math.abs(cBot[0] - 0.425) < 1e-6);
  acc.box(0, 0, 0.5, 0.2, 0.2, 0.2, cTop);
  acc.cylinder(0, 0, 0.5, 0.1, 0.4, 8, cTop, "z");
  const g = acc.toBufferGeometry(THREE);
  assert.ok(g.getAttribute("position").count > 0);
  assert.ok(g.getAttribute("normal").count > 0);
  assert.ok(g.getAttribute("color").count > 0);
  g.dispose();
});

// 2. Manifest & VFX Capability Gate
await check("T_MOD_02 Deployable Models Manifest Compliance", () => {
  assert.equal(manifest.lightCountDelta, 0, "lightCountDelta === 0");
  const errors = lintManifest(manifest);
  assert.equal(errors.length, 0, `manifest lint errors: ${errors.join(", ")}`);
});

// 3. Per-Unit 3D Procedural Model Invariants (All 8 unified on "full" pallet, strict stowed Box3 & articulation delta)
const UNITS = [
  { name: "Flux Pod", wcid: DEPLOYABLE_WCID.FluxPod, maxCalls: 10, palletSize: "full" },
  { name: "Solar Panels", wcid: DEPLOYABLE_WCID.SolarPanels, maxCalls: 10, palletSize: "full" },
  { name: "Power Generator", wcid: DEPLOYABLE_WCID.PowerGenerator, maxCalls: 10, palletSize: "full" },
  { name: "Battery Unit", wcid: DEPLOYABLE_WCID.BatteryUnit, maxCalls: 10, palletSize: "full" },
  { name: "Autonomous Missile Turret", wcid: DEPLOYABLE_WCID.MissileTurret, maxCalls: 10, palletSize: "full" },
  { name: "Ground Radar", wcid: DEPLOYABLE_WCID.GroundRadar, maxCalls: 10, palletSize: "full" },
  { name: "Mortar Turret", wcid: DEPLOYABLE_WCID.MortarTurret, maxCalls: 10, palletSize: "full" },
  { name: "Heavy Laser Turret", wcid: DEPLOYABLE_WCID.HeavyLaserTurret, maxCalls: 10, palletSize: "full" },
];

for (const u of UNITS) {
  await check(`T_MOD_${u.wcid} ${u.name} (WCID ${u.wcid}): <= 10 Calls, 0 Lights, Stowed Envelope & Delta`, () => {
    const unit = buildDeployable(THREE, u.wcid, { stowed: false });
    const calls = countDrawCalls(unit.root);
    const lights = countLights(unit.root);

    assert.ok(calls > 0 && calls <= u.maxCalls, `${u.name} draw calls (${calls}) <= ${u.maxCalls}`);
    assert.equal(lights, 0, `${u.name} dynamic lights (${lights}) === 0`);
    assert.equal(unit.palletSize, u.palletSize, `${u.name} palletSize === ${u.palletSize}`);

    // Exercise state update kinematics while deployed
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
    unit.root.updateMatrixWorld(true);
    const deployedBox = new THREE.Box3().setFromObject(unit.root);

    // Stow and verify strict Box3 envelope: |x|,|y| <= 0.555 m, 0 <= z <= 2.05 m
    unit.setStowed(true);
    assert.equal(unit.pallet.stowed, true, `${u.name} pallet.stowed synced`);
    unit.root.updateMatrixWorld(true);
    const stowedBox = new THREE.Box3().setFromObject(unit.root);
    assert.ok(stowedBox.min.x >= -0.555 && stowedBox.max.x <= 0.555, `${u.name} stowed X [${stowedBox.min.x.toFixed(4)}, ${stowedBox.max.x.toFixed(4)}] within ±0.555`);
    assert.ok(stowedBox.min.y >= -0.555 && stowedBox.max.y <= 0.555, `${u.name} stowed Y [${stowedBox.min.y.toFixed(4)}, ${stowedBox.max.y.toFixed(4)}] within ±0.555`);
    assert.ok(stowedBox.min.z >= -1e-4 && stowedBox.max.z <= 2.05, `${u.name} stowed Z [${stowedBox.min.z.toFixed(4)}, ${stowedBox.max.z.toFixed(4)}] within [0, 2.05]`);

    // Verify measurable stowed-vs-deployed geometric transform delta
    assert.ok(
      boxesDiffer(stowedBox, deployedBox, 0.02) || Math.abs(boxVolume(stowedBox) - boxVolume(deployedBox)) > 0.01,
      `${u.name} exhibits measurable stowed-vs-deployed articulation delta`,
    );

    unit.dispose();
  });
}

// 4. Regression Tests: PowerGenerator online/fuel gate & buildDeployable kind/name lookup
await check("T_MOD_REG_01 PowerGenerator online/fuel spin gate", () => {
  // 1) online: false with fuel > 0 must NOT spin
  const gOffline = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
  gOffline.update({ dt: 0.1, fuelSecondsRemaining: 60, online: false });
  assert.equal(gOffline.flywheelAngle, 0, "offline generator with fuel must not spin");
  gOffline.dispose();

  // 2) online: true with fuel === 0 must NOT spin
  const gEmpty = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
  gEmpty.update({ dt: 0.1, fuelSecondsRemaining: 0, online: true });
  assert.equal(gEmpty.flywheelAngle, 0, "online generator with 0 fuelSecondsRemaining must not spin");
  gEmpty.update({ dt: 0.1, fuelRemaining: 0, online: true });
  assert.equal(gEmpty.flywheelAngle, 0, "online generator with 0 fuelRemaining must not spin");
  gEmpty.dispose();

  // 3) Backward-compatible: online omitted + fuel > 0 spins
  const gCompatFuel = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
  gCompatFuel.update({ dt: 0.1, fuelSecondsRemaining: 120 });
  assert.ok(Math.abs(gCompatFuel.flywheelAngle - 2.5) < 1e-6, `omitted online + fuel > 0 spins (${gCompatFuel.flywheelAngle})`);
  gCompatFuel.dispose();

  // 4) No fuel key + online: true spins
  const gOnlineOnly = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
  gOnlineOnly.update({ dt: 0.1, online: true });
  assert.ok(Math.abs(gOnlineOnly.flywheelAngle - 2.5) < 1e-6, `online-only without fuel key spins (${gOnlineOnly.flywheelAngle})`);
  gOnlineOnly.dispose();

  // 5) online: true + fuel > 0 spins
  const gBoth = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
  gBoth.update({ dt: 0.1, fuelSecondsRemaining: 60, online: true });
  assert.ok(Math.abs(gBoth.flywheelAngle - 2.5) < 1e-6, `online + fuel > 0 spins (${gBoth.flywheelAngle})`);
  gBoth.dispose();
});

await check("T_MOD_REG_02 buildDeployable lookup by DEPLOYABLE_KINDS and case-insensitive names", () => {
  const expected = [
    [DEPLOYABLE_KINDS.FluxPod, "FluxPod", DEPLOYABLE_WCID.FluxPod],
    [DEPLOYABLE_KINDS.SolarPanels, "SolarPanels", DEPLOYABLE_WCID.SolarPanels],
    [DEPLOYABLE_KINDS.PowerGenerator, "PowerGenerator", DEPLOYABLE_WCID.PowerGenerator],
    [DEPLOYABLE_KINDS.BatteryUnit, "BatteryUnit", DEPLOYABLE_WCID.BatteryUnit],
    [DEPLOYABLE_KINDS.MissileTurret, "MissileTurret", DEPLOYABLE_WCID.MissileTurret],
    [DEPLOYABLE_KINDS.GroundRadar, "GroundRadar", DEPLOYABLE_WCID.GroundRadar],
    [DEPLOYABLE_KINDS.MortarTurret, "MortarTurret", DEPLOYABLE_WCID.MortarTurret],
    [DEPLOYABLE_KINDS.HeavyLaserTurret, "HeavyLaserTurret", DEPLOYABLE_WCID.HeavyLaserTurret],
  ];
  for (const [kind, name, wcid] of expected) {
    const byKind = buildDeployable(THREE, kind, { stowed: true });
    assert.equal(byKind.wcid, wcid, `kind ${kind} -> WCID ${wcid}`);
    byKind.dispose();

    const byName = buildDeployable(THREE, name, { stowed: true });
    assert.equal(byName.wcid, wcid, `name ${name} -> WCID ${wcid}`);
    byName.dispose();

    const byLower = buildDeployable(THREE, name.toLowerCase(), { stowed: true });
    assert.equal(byLower.wcid, wcid, `lowercase ${name.toLowerCase()} -> WCID ${wcid}`);
    byLower.dispose();
  }

  for (const bad of [DEPLOYABLE_KINDS.None, DEPLOYABLE_KINDS.RadarStation, "None", "RadarStation", "unknown", 999]) {
    assert.throws(() => buildDeployable(THREE, bad), /Unknown deployable WCID/);
  }
});

function localBoxInParent(obj, parent) {
  parent.updateMatrixWorld(true);
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  obj.traverse((m) => {
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute("position");
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      box.expandByPoint(v);
    }
  });
  return box;
}

await check("T_MOD_REG_03 SolarPanels stowed wings disjointness (inner vs outer, left vs right)", () => {
  for (const initStowed of [true, false]) {
    const solar = buildDeployable(THREE, DEPLOYABLE_WCID.SolarPanels, { stowed: initStowed });
    if (!initStowed) solar.setStowed(true);
    solar.root.updateMatrixWorld(true);

    const leftInnerLocal = localBoxInParent(solar.leftWing, solar.leftInnerPivot);
    const leftOuterLocal = localBoxInParent(solar.leftOuterPivot, solar.leftInnerPivot);
    assert.equal(
      leftInnerLocal.intersectsBox(leftOuterLocal),
      false,
      `leftWing local Z [${leftInnerLocal.min.z.toFixed(4)}, ${leftInnerLocal.max.z.toFixed(4)}] disjoint from leftOuterPivot [${leftOuterLocal.min.z.toFixed(4)}, ${leftOuterLocal.max.z.toFixed(4)}]`,
    );
    assert.ok(leftInnerLocal.max.z < leftOuterLocal.min.z, "left inner wing strictly clears outer wing along local Z");

    const rightInnerLocal = localBoxInParent(solar.rightWing, solar.rightInnerPivot);
    const rightOuterLocal = localBoxInParent(solar.rightOuterPivot, solar.rightInnerPivot);
    assert.equal(
      rightInnerLocal.intersectsBox(rightOuterLocal),
      false,
      `rightWing local Z [${rightInnerLocal.min.z.toFixed(4)}, ${rightInnerLocal.max.z.toFixed(4)}] disjoint from rightOuterPivot [${rightOuterLocal.min.z.toFixed(4)}, ${rightOuterLocal.max.z.toFixed(4)}]`,
    );
    assert.ok(rightInnerLocal.max.z < rightOuterLocal.min.z, "right inner wing strictly clears outer wing along local Z");

    const leftWorld = new THREE.Box3().setFromObject(solar.leftInnerPivot);
    const rightWorld = new THREE.Box3().setFromObject(solar.rightInnerPivot);
    assert.ok(leftWorld.max.x < -0.01, `left assembly max.x (${leftWorld.max.x.toFixed(4)}) < -0.01`);
    assert.ok(rightWorld.min.x > 0.01, `right assembly min.x (${rightWorld.min.x.toFixed(4)}) > +0.01`);
    assert.equal(leftWorld.intersectsBox(rightWorld), false, "left and right stowed wing assemblies are Box3-disjoint");

    const rootBox = new THREE.Box3().setFromObject(solar.root);
    assert.ok(rootBox.min.x >= -0.5501 && rootBox.max.x <= 0.5501, `SolarPanels stowed X within ±0.550`);
    assert.ok(rootBox.min.y >= -0.5501 && rootBox.max.y <= 0.5501, `SolarPanels stowed Y within ±0.550`);
    assert.ok(rootBox.min.z >= -1e-4 && rootBox.max.z <= 2.05, `SolarPanels stowed Z within [0, 2.05]`);

    solar.dispose();
  }
});

function separatedTriAxis(a0, a1, a2, b0, b1, b2, axis, eps = 1e-5) {
  const lenSq = axis.lengthSq();
  if (lenSq < 1e-14) return false;
  const invLen = 1 / Math.sqrt(lenSq);
  const ax = axis.x * invLen;
  const ay = axis.y * invLen;
  const az = axis.z * invLen;
  const pa0 = a0.x * ax + a0.y * ay + a0.z * az;
  const pa1 = a1.x * ax + a1.y * ay + a1.z * az;
  const pa2 = a2.x * ax + a2.y * ay + a2.z * az;
  const pb0 = b0.x * ax + b0.y * ay + b0.z * az;
  const pb1 = b1.x * ax + b1.y * ay + b1.z * az;
  const pb2 = b2.x * ax + b2.y * ay + b2.z * az;
  const minA = Math.min(pa0, pa1, pa2);
  const maxA = Math.max(pa0, pa1, pa2);
  const minB = Math.min(pb0, pb1, pb2);
  const maxB = Math.max(pb0, pb1, pb2);
  return maxA <= minB + eps || maxB <= minA + eps;
}

function triTriOverlap3D(a0, a1, a2, b0, b1, b2, eps = 1e-5) {
  const e0 = new THREE.Vector3().subVectors(a1, a0);
  const e1 = new THREE.Vector3().subVectors(a2, a1);
  const e2 = new THREE.Vector3().subVectors(a0, a2);
  const f0 = new THREE.Vector3().subVectors(b1, b0);
  const f1 = new THREE.Vector3().subVectors(b2, b1);
  const f2 = new THREE.Vector3().subVectors(b0, b2);
  if (separatedTriAxis(a0, a1, a2, b0, b1, b2, new THREE.Vector3().crossVectors(e0, e1), eps)) return false;
  if (separatedTriAxis(a0, a1, a2, b0, b1, b2, new THREE.Vector3().crossVectors(f0, f1), eps)) return false;
  const edgesA = [e0, e1, e2];
  const edgesB = [f0, f1, f2];
  const cross = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      cross.crossVectors(edgesA[i], edgesB[j]);
      if (separatedTriAxis(a0, a1, a2, b0, b1, b2, cross, eps)) return false;
    }
  }
  return true;
}

function extractWorldTriangles(obj) {
  const tris = [];
  obj.traverse((m) => {
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getIndex();
    const mw = m.matrixWorld;
    const vtx = (vi) => new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mw);
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        const a = vtx(idx.getX(i));
        const b = vtx(idx.getX(i + 1));
        const c = vtx(idx.getX(i + 2));
        tris.push({ a, b, c, box: new THREE.Box3().setFromPoints([a, b, c]) });
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        const a = vtx(i);
        const b = vtx(i + 1);
        const c = vtx(i + 2);
        tris.push({ a, b, c, box: new THREE.Box3().setFromPoints([a, b, c]) });
      }
    }
  });
  return tris;
}

function countTriTriHits(trisA, trisB, eps = 1e-5) {
  let hits = 0;
  for (const ta of trisA) {
    for (const tb of trisB) {
      if (!ta.box.intersectsBox(tb.box)) continue;
      if (triTriOverlap3D(ta.a, ta.b, ta.c, tb.a, tb.b, tb.c, eps)) hits++;
    }
  }
  return hits;
}

await check("T_MOD_REG_04 SolarPanels deployed pedestal-vs-wing & wing-vs-wing clearance across sunPitch/sunHeading sweep", () => {
  const solar = buildDeployable(THREE, DEPLOYABLE_WCID.SolarPanels, { stowed: false });
  let pedestalMesh = null;
  let statusLedMesh = null;
  let actuatorsMesh = null;
  solar.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "solar-pedestal") pedestalMesh = o;
    else if (o.name === "solar-status-led") statusLedMesh = o;
    else if (o.parent === solar.trunnion) actuatorsMesh = o;
  });
  assert.ok(pedestalMesh && statusLedMesh && actuatorsMesh, "expected pedestal, status LED, and actuators meshes");

  const pitches = [0, 0.44, 0.78, 1.4, Math.PI / 2];
  const headings = [0, Math.PI / 2, Math.PI, -0.9];

  for (const sunHeading of headings) {
    for (const sunPitch of pitches) {
      solar.update({ sunHeading, sunPitch });
      solar.root.updateMatrixWorld(true);

      const pedTris = [...extractWorldTriangles(pedestalMesh), ...extractWorldTriangles(statusLedMesh)];
      const actTris = extractWorldTriangles(actuatorsMesh);
      const lInTris = extractWorldTriangles(solar.leftWing);
      const lOutTris = extractWorldTriangles(solar.leftOuterPivot);
      const rInTris = extractWorldTriangles(solar.rightWing);
      const rOutTris = extractWorldTriangles(solar.rightOuterPivot);
      const lAllTris = [...lInTris, ...lOutTris];
      const rAllTris = [...rInTris, ...rOutTris];

      assert.equal(countTriTriHits(pedTris, lAllTris), 0, `0 pedestal-vs-left-wing tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(pedTris, rAllTris), 0, `0 pedestal-vs-right-wing tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(lInTris, lOutTris), 0, `0 left inner-vs-outer tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(rInTris, rOutTris), 0, `0 right inner-vs-outer tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(lAllTris, rAllTris), 0, `0 left-vs-right tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(actTris, lAllTris), 0, `0 actuators-vs-left tri hits at hdg=${sunHeading}, pit=${sunPitch}`);
      assert.equal(countTriTriHits(actTris, rAllTris), 0, `0 actuators-vs-right tri hits at hdg=${sunHeading}, pit=${sunPitch}`);

      // Verify wing lowest vertex clears inverter cabinet top (z = 0.58 m)
      const wingBox = new THREE.Box3().setFromObject(solar.leftInnerPivot).union(new THREE.Box3().setFromObject(solar.rightInnerPivot));
      assert.ok(wingBox.min.z > 0.58, `wing min.z (${wingBox.min.z.toFixed(4)}) clears inverter cabinet (0.58m) at pit=${sunPitch}`);
    }
  }

  // Also verify legacy sunPitchRad / sunAzimuthRad keys at steep pitch
  solar.update({ sunAzimuthRad: -0.9, sunPitchRad: 1.4 });
  solar.root.updateMatrixWorld(true);
  const pedTris = [...extractWorldTriangles(pedestalMesh), ...extractWorldTriangles(statusLedMesh)];
  const wingTris = [...extractWorldTriangles(solar.leftInnerPivot), ...extractWorldTriangles(solar.rightInnerPivot)];
  assert.equal(countTriTriHits(pedTris, wingTris), 0, "0 pedestal-vs-wing tri hits using sunPitchRad/sunAzimuthRad");

  solar.dispose();
});

await check("T_MOD_REG_05 Mortar, HeavyLaser, Missile & GroundRadar deployed 0 tri-tri self-intersections across yaw/pitch sweeps", () => {
  // 1) 4000016 MortarTurret
  const mortar = buildDeployable(THREE, DEPLOYABLE_WCID.MortarTurret, { stowed: false });
  let mortarBase = null;
  let mortarLed = null;
  let mortarRam = null;
  let mortarCheek = null;
  mortar.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "mortar-status-led") mortarLed = o;
    else if (o.name === "mortar-lift-ram") mortarRam = o;
    else if (o.parent === mortar.root && o !== mortar.pallet.mesh && o !== mortar.pallet.levelingJacks) mortarBase = o;
    else if (o.parent === mortar.carriage) mortarCheek = o;
  });
  assert.ok(mortarBase && mortarLed && mortarRam && mortarCheek, "expected MortarTurret meshes");

  for (const deployElevation of [undefined, 0, 1.0]) {
    for (const yawRad of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
      for (const pitchRad of [-1.2, -0.52, 0, 0.8]) {
        mortar.update({ deployElevation, yawRad, pitchRad });
        mortar.root.updateMatrixWorld(true);
        const statTris = [...extractWorldTriangles(mortar.pallet.root), ...extractWorldTriangles(mortarBase), ...extractWorldTriangles(mortarLed)];
        const ramTris = mortarRam.visible ? extractWorldTriangles(mortarRam) : [];
        const cheekTris = extractWorldTriangles(mortarCheek);
        const barTris = extractWorldTriangles(mortar.barrel);
        assert.equal(countTriTriHits(statTris, cheekTris), 0, `Mortar 0 stat-vs-cheek hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
        assert.equal(countTriTriHits(statTris, barTris), 0, `Mortar 0 stat-vs-barrel hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
        assert.equal(countTriTriHits(cheekTris, barTris), 0, `Mortar 0 cheek-vs-barrel hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
        assert.equal(countTriTriHits(ramTris, [...statTris, ...cheekTris, ...barTris]), 0, `Mortar 0 ram hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
      }
    }
  }
  mortar.dispose();

  // 2) 4000017 HeavyLaserTurret
  const laser = buildDeployable(THREE, DEPLOYABLE_WCID.HeavyLaserTurret, { stowed: false });
  let laserPed = null;
  let laserLock = null;
  let laserYoke = null;
  laser.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "laser-travel-lock-cradle") laserLock = o;
    else if (o.parent === laser.root && o !== laser.pallet.mesh && o !== laser.pallet.levelingJacks) laserPed = o;
    else if (o.parent === laser.turretHead) laserYoke = o;
  });
  assert.ok(laserPed && laserLock && laserYoke, "expected HeavyLaserTurret meshes");

  for (const yawRad of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
    for (const pitchRad of [-0.45, 0, 0.3, 0.65, 0.9, 1.1, 1.4, 1.57]) {
      laser.update({ yawRad, pitchRad });
      laser.root.updateMatrixWorld(true);
      const pedTris = [...extractWorldTriangles(laser.pallet.root), ...extractWorldTriangles(laserPed)];
      const lockTris = extractWorldTriangles(laserLock);
      const yokeTris = extractWorldTriangles(laserYoke);
      const barTris = extractWorldTriangles(laser.barrelGimbal);
      assert.equal(countTriTriHits(pedTris, lockTris), 0, `Laser 0 ped-vs-lock hits (yaw=${yawRad}, pit=${pitchRad})`);
      assert.equal(countTriTriHits([...pedTris, ...lockTris], [...yokeTris, ...barTris]), 0, `Laser 0 base-vs-turret hits (yaw=${yawRad}, pit=${pitchRad})`);
      assert.equal(countTriTriHits(yokeTris, barTris), 0, `Laser 0 yoke-vs-barrel hits (yaw=${yawRad}, pit=${pitchRad})`);
    }
  }
  laser.setStowed(true);
  laser.root.updateMatrixWorld(true);
  {
    const pedTris = [...extractWorldTriangles(laser.pallet.root), ...extractWorldTriangles(laserPed)];
    const lockTris = extractWorldTriangles(laserLock);
    const yokeTris = extractWorldTriangles(laserYoke);
    const barTris = extractWorldTriangles(laser.barrelGimbal);
    assert.equal(countTriTriHits(pedTris, lockTris), 0, "Laser stowed 0 ped-vs-lock hits");
    assert.equal(countTriTriHits([...pedTris, ...lockTris], [...yokeTris, ...barTris]), 0, "Laser stowed 0 base-vs-turret hits");
    assert.equal(countTriTriHits(yokeTris, barTris), 0, "Laser stowed 0 yoke-vs-barrel hits");
  }
  laser.dispose();

  // 3) 4000014 MissileTurret
  const missile = buildDeployable(THREE, DEPLOYABLE_WCID.MissileTurret, { stowed: false });
  const samWell = missile.root.getObjectByName("sam-base-well");
  const samLed = missile.root.getObjectByName("sam-status-led");
  const samPiston = missile.root.getObjectByName("pneumatic-cylinders");
  assert.ok(samWell && samLed && samPiston, "expected MissileTurret meshes");

  for (const deployElevation of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    for (const yawRad of [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
      for (const pitchRad of [-0.2, 0, 0.45, 0.9, 1.1, 1.4, 1.57]) {
        missile.update({ deployElevation, yawRad, pitchRad });
        missile.root.updateMatrixWorld(true);
        if (pitchRad === 0 && yawRad === 0) {
          const pBox = new THREE.Box3().setFromObject(samPiston);
          let podMesh = null;
          missile.gimbal.traverse((o) => { if (o.isMesh && !podMesh) podMesh = o; });
          const gBox = new THREE.Box3().setFromObject(podMesh);
          const gap = gBox.min.z - pBox.max.z;
          assert.ok(gap <= 0 && gap >= -0.025, `Missile deployed(elev=${deployElevation}) piston-to-pod gap (${gap.toFixed(6)}m) cleanly seated`);
        }
        const wellTris = [...extractWorldTriangles(missile.pallet.root), ...extractWorldTriangles(samWell), ...extractWorldTriangles(samLed)];
        const pisTris = extractWorldTriangles(samPiston);
        const podTris = extractWorldTriangles(missile.gimbal);
        assert.equal(countTriTriHits(wellTris, podTris), 0, `Missile 0 well-vs-pod hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
        assert.equal(countTriTriHits(pisTris, podTris), 0, `Missile 0 piston-vs-pod hits (elev=${deployElevation}, yaw=${yawRad}, pit=${pitchRad})`);
      }
    }
  }
  missile.setStowed(true);
  missile.root.updateMatrixWorld(true);
  {
    const pBox = new THREE.Box3().setFromObject(samPiston);
    let podMesh = null;
    missile.gimbal.traverse((o) => { if (o.isMesh && !podMesh) podMesh = o; });
    const gBox = new THREE.Box3().setFromObject(podMesh);
    const gap = gBox.min.z - pBox.max.z;
    assert.ok(gap <= 0 && gap >= -0.025, `Missile stowed piston-to-pod gap (${gap.toFixed(6)}m) cleanly seated`);
    const wellTris = [...extractWorldTriangles(missile.pallet.root), ...extractWorldTriangles(samWell), ...extractWorldTriangles(samLed)];
    const pisTris = extractWorldTriangles(samPiston);
    const podTris = extractWorldTriangles(missile.gimbal);
    assert.equal(countTriTriHits(wellTris, podTris), 0, "Missile stowed 0 well-vs-pod hits");
    assert.equal(countTriTriHits(pisTris, podTris), 0, "Missile stowed 0 piston-vs-pod hits");
  }
  missile.dispose();

  // 4) 4000015 GroundRadar
  const groundRadar = buildDeployable(THREE, DEPLOYABLE_WCID.GroundRadar, { stowed: false });
  const grPed = groundRadar.root.getObjectByName("ground-radar-pedestal");
  const grScope = groundRadar.root.getObjectByName("ground-radar-ppi-scope");
  const grLower = groundRadar.root.getObjectByName("ground-radar-mast-lower");
  const grUpper = groundRadar.root.getObjectByName("ground-radar-mast-upper");
  assert.ok(grPed && grScope && grLower && grUpper, "expected GroundRadar meshes");

  for (const simTimeSec of [0, 0.5, 1.0, 1.5]) {
    groundRadar.update({ simTimeSec });
    groundRadar.root.updateMatrixWorld(true);
    const statTris = [
      ...extractWorldTriangles(groundRadar.pallet.root),
      ...extractWorldTriangles(grPed),
      ...extractWorldTriangles(grScope),
      ...extractWorldTriangles(grLower),
      ...extractWorldTriangles(grUpper),
    ];
    const antTris = extractWorldTriangles(groundRadar.antennaGroup);
    assert.equal(countTriTriHits(statTris, antTris), 0, `GroundRadar 0 mast-vs-antenna hits at t=${simTimeSec}`);
  }
  groundRadar.dispose();
});

await check("T_MOD_REG_06 Stowed/Intermediate/Recoil Tri-Tri Clearance, setDeployed, String WCID & Lifecycle Polish", () => {
  // 1) 4000016 MortarTurret: intermediate deployElevation, clamped recoilSec, and stowed clearance
  const mortar = buildDeployable(THREE, DEPLOYABLE_WCID.MortarTurret, { stowed: false });
  let mBase = null;
  let mLed = null;
  let mRam = null;
  let mCheek = null;
  mortar.root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "mortar-status-led") mLed = o;
    else if (o.name === "mortar-lift-ram") mRam = o;
    else if (o.parent === mortar.root && o !== mortar.pallet.mesh && o !== mortar.pallet.levelingJacks) mBase = o;
    else if (o.parent === mortar.carriage) mCheek = o;
  });
  assert.ok(mBase && mLed && mRam && mCheek, "expected MortarTurret sub-meshes");

  for (const deployElevation of [undefined, 0, 0.01, 0.1, 0.25, 0.5, 1.0]) {
    for (const recoilSec of [0, 1, 10]) {
      for (const yawRad of [-Math.PI / 2, 0, Math.PI / 2, Math.PI]) {
        for (const pitchRad of [-1.2, -0.52, 0.8]) {
          mortar.update({ deployElevation, recoilSec, yawRad, pitchRad });
          mortar.root.updateMatrixWorld(true);
          assert.equal(mRam.visible, true, `mortar-lift-ram visible at elev=${deployElevation}`);
          assert.ok(Number.isFinite(mRam.scale.z) && mRam.scale.z > 0.1, `mortar-lift-ram valid scale.z at elev=${deployElevation}`);
          const statTris = [...extractWorldTriangles(mortar.pallet.root), ...extractWorldTriangles(mBase), ...extractWorldTriangles(mLed)];
          const ramTris = extractWorldTriangles(mRam);
          const cheekTris = extractWorldTriangles(mCheek);
          const barTris = extractWorldTriangles(mortar.barrel);
          assert.equal(countTriTriHits(statTris, cheekTris), 0, `Mortar 0 stat-vs-cheek (elev=${deployElevation}, recoil=${recoilSec})`);
          assert.equal(countTriTriHits(statTris, barTris), 0, `Mortar 0 stat-vs-barrel (elev=${deployElevation}, recoil=${recoilSec})`);
          assert.equal(countTriTriHits(cheekTris, barTris), 0, `Mortar 0 cheek-vs-barrel (elev=${deployElevation}, recoil=${recoilSec})`);
          assert.equal(countTriTriHits(ramTris, [...statTris, ...cheekTris, ...barTris]), 0, `Mortar 0 ram hits (elev=${deployElevation})`);
        }
      }
    }
  }
  // Stowed both via setStowed(true) and constructor { stowed: true }
  for (const ctorStowed of [false, true]) {
    const mStow = buildDeployable(THREE, DEPLOYABLE_WCID.MortarTurret, { stowed: ctorStowed });
    if (!ctorStowed) mStow.setStowed(true);
    mStow.root.updateMatrixWorld(true);
    let sBase = null;
    let sLed = null;
    let sCheek = null;
    mStow.root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.name === "mortar-status-led") sLed = o;
      else if (o.parent === mStow.root && o !== mStow.pallet.mesh && o !== mStow.pallet.levelingJacks && o.name !== "mortar-lift-ram") sBase = o;
      else if (o.parent === mStow.carriage) sCheek = o;
    });
    const statTris = [...extractWorldTriangles(mStow.pallet.root), ...extractWorldTriangles(sBase), ...extractWorldTriangles(sLed)];
    const cheekTris = extractWorldTriangles(sCheek);
    const barTris = extractWorldTriangles(mStow.barrel);
    assert.equal(countTriTriHits(statTris, cheekTris), 0, `Mortar stowed(${ctorStowed}) 0 stat-vs-cheek`);
    assert.equal(countTriTriHits(statTris, barTris), 0, `Mortar stowed(${ctorStowed}) 0 stat-vs-barrel`);
    assert.equal(countTriTriHits(cheekTris, barTris), 0, `Mortar stowed(${ctorStowed}) 0 cheek-vs-barrel`);
    mStow.dispose();
  }
  mortar.dispose();

  // 2) 4000015 GroundRadar stowed & deployed 0 non-hinge tri-tri hits (including lower vs upper mast outside hinge collar)
  const countNonHingeMastHits = (gr) => {
    const lower = gr.root.getObjectByName("ground-radar-mast-lower");
    const upper = gr.root.getObjectByName("ground-radar-mast-upper");
    const invMast = new THREE.Matrix4().copy(gr.mastPivot.matrixWorld).invert();
    const toMastZBounds = (tri) => {
      const la = tri.a.clone().applyMatrix4(invMast);
      const lb = tri.b.clone().applyMatrix4(invMast);
      const lc = tri.c.clone().applyMatrix4(invMast);
      return { minZ: Math.min(la.z, lb.z, lc.z), maxZ: Math.max(la.z, lb.z, lc.z) };
    };
    const lowTris = extractWorldTriangles(lower).map((t) => ({ ...t, ...toMastZBounds(t) }));
    const upTris = extractWorldTriangles(upper).map((t) => ({ ...t, ...toMastZBounds(t) }));
    let nonHingeHits = 0;
    for (const ta of lowTris) {
      for (const tb of upTris) {
        if (!ta.box.intersectsBox(tb.box)) continue;
        if (!triTriOverlap3D(ta.a, ta.b, ta.c, tb.a, tb.b, tb.c)) continue;
        const inHingeCollar =
          ta.minZ >= 0.614 && ta.maxZ <= 0.666 &&
          tb.minZ >= 0.614 && tb.maxZ <= 0.680;
        if (!inHingeCollar) nonHingeHits++;
      }
    }
    return { lowTris, upTris, nonHingeHits };
  };

  for (const mode of ["ctorStowed", "setStowed", "setDeployedFalse", "deployed"]) {
    const gr = buildDeployable(THREE, DEPLOYABLE_WCID.GroundRadar, { stowed: mode === "ctorStowed" });
    if (mode === "setStowed") gr.setStowed(true);
    else if (mode === "setDeployedFalse") {
      gr.setDeployed(true);
      gr.setDeployed(false);
    }
    const poses = mode === "deployed" ? [0, 0.5, 1.0, 1.5] : [0];
    for (const simTimeSec of poses) {
      if (mode === "deployed") gr.update({ simTimeSec });
      gr.root.updateMatrixWorld(true);
      const ped = gr.root.getObjectByName("ground-radar-pedestal");
      const scope = gr.root.getObjectByName("ground-radar-ppi-scope");
      const pedTris = [...extractWorldTriangles(gr.pallet.root), ...extractWorldTriangles(ped), ...extractWorldTriangles(scope)];
      const { lowTris, upTris, nonHingeHits } = countNonHingeMastHits(gr);
      const antTris = extractWorldTriangles(gr.antennaGroup);
      assert.equal(countTriTriHits(pedTris, lowTris), 0, `GroundRadar (${mode}) 0 ped-vs-lower`);
      assert.equal(countTriTriHits(pedTris, upTris), 0, `GroundRadar (${mode}) 0 ped-vs-upper`);
      assert.equal(countTriTriHits(pedTris, antTris), 0, `GroundRadar (${mode}) 0 ped-vs-antenna`);
      assert.equal(countTriTriHits([...lowTris, ...upTris], antTris), 0, `GroundRadar (${mode}) 0 mast-vs-antenna`);
      assert.equal(nonHingeHits, 0, `GroundRadar (${mode}, t=${simTimeSec}) 0 non-hinge lower-vs-upper mast hits`);
    }
    gr.dispose();
  }

  // 3) 4000010 FluxPod stowed & deployed 0 tri-tri hits
  for (const stowed of [true, false]) {
    const fp = buildDeployable(THREE, DEPLOYABLE_WCID.FluxPod, { stowed });
    fp.root.updateMatrixWorld(true);
    const str = fp.root.getObjectByName("flux-pod-structure");
    const glass = fp.root.getObjectByName("flux-pod-glass");
    const strTris = [...extractWorldTriangles(fp.pallet.root), ...extractWorldTriangles(str)];
    assert.equal(countTriTriHits(strTris, extractWorldTriangles(glass)), 0, `FluxPod stowed=${stowed} 0 structure-vs-glass`);
    assert.equal(countTriTriHits(strTris, extractWorldTriangles(fp.lightsNS)), 0, `FluxPod stowed=${stowed} 0 structure-vs-lightsNS`);
    assert.equal(countTriTriHits(strTris, extractWorldTriangles(fp.lightsEW)), 0, `FluxPod stowed=${stowed} 0 structure-vs-lightsEW`);
    for (let ai = 0; ai < 3; ai++) {
      const ant = fp.root.getObjectByName(`flux-antenna-pivot-${ai}`);
      assert.equal(countTriTriHits(strTris, extractWorldTriangles(ant)), 0, `FluxPod stowed=${stowed} 0 structure-vs-antenna-${ai}`);
    }
    fp.dispose();
  }

  // 4) 4000012 PowerGenerator stowed & deployed 0 tri-tri hits + flywheel reset on stow + legacy keys
  for (const stowed of [true, false]) {
    const pg = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed });
    pg.root.updateMatrixWorld(true);
    const body = pg.root.getObjectByName("generator-chassis-turbine");
    const bodyTris = [...extractWorldTriangles(pg.pallet.root), ...extractWorldTriangles(body)];
    const canTris = extractWorldTriangles(pg.canopyPivot);
    const stackTris = extractWorldTriangles(pg.exhaustStackMesh);
    const fwTris = extractWorldTriangles(pg.flywheel);
    assert.equal(countTriTriHits(bodyTris, canTris), 0, `PowerGenerator stowed=${stowed} 0 body-vs-canopy`);
    assert.equal(countTriTriHits(stackTris, canTris), 0, `PowerGenerator stowed=${stowed} 0 stack-vs-canopy`);
    assert.equal(countTriTriHits(bodyTris, fwTris), 0, `PowerGenerator stowed=${stowed} 0 body-vs-flywheel`);
    pg.dispose();
  }
  {
    const pg = buildDeployable(THREE, DEPLOYABLE_WCID.PowerGenerator, { stowed: false });
    pg.update({ dt: 0.1, running: true });
    assert.ok(pg.flywheelAngle > 0, "PowerGenerator running legacy key spins");
    pg.setStowed(true);
    assert.equal(pg.flywheelAngle, 0, "PowerGenerator setStowed(true) resets flywheelAngle");
    assert.equal(pg.flywheel.rotation.z, 0, "PowerGenerator setStowed(true) resets flywheel.rotation.z");
    pg.setDeployed(true);
    pg.update({ dt: 0.1, online: true, fuelPct: 0.0 });
    assert.equal(pg.flywheelAngle, 0, "PowerGenerator fuelPct=0 blocks spin");
    pg.dispose();
  }

  // 5) 4000013 BatteryUnit stowed & deployed 0 tri-tri hits + legacy keys
  for (const stowed of [true, false]) {
    const bu = buildDeployable(THREE, DEPLOYABLE_WCID.BatteryUnit, { stowed });
    bu.root.updateMatrixWorld(true);
    const bank = bu.root.getObjectByName("battery-capacitor-bank");
    const bankTris = [...extractWorldTriangles(bu.pallet.root), ...extractWorldTriangles(bank)];
    const hoodTris = extractWorldTriangles(bu.hoodPivot);
    const barTris = bu.socBars.flatMap((b) => extractWorldTriangles(b));
    assert.equal(countTriTriHits(bankTris, hoodTris), 0, `BatteryUnit stowed=${stowed} 0 bank-vs-hood`);
    assert.equal(countTriTriHits(bankTris, barTris), 0, `BatteryUnit stowed=${stowed} 0 bank-vs-socBars`);
    bu.dispose();
  }
  {
    const bu = buildDeployable(THREE, DEPLOYABLE_WCID.BatteryUnit, { stowed: false });
    bu.update({ chargePct: 0.8 });
    assert.equal(bu.socBars.filter((b) => b.material.color.getHex() === 0x00ff66).length, 4, "BatteryUnit chargePct=0.8 lights 4 bars");
    bu.update({ capacitorJoules: 300000, maxCapacitorJoules: 300000 });
    assert.equal(bu.socBars.filter((b) => b.material.color.getHex() === 0x00ff66).length, 5, "BatteryUnit custom maxCapacitorJoules lights 5 bars");
    bu.dispose();
  }
  for (const cfg of [{ stowed: false, chargePct: 0 }, { stowed: false, chargePct: 1.0 }, { stowed: true }]) {
    const bu = buildDeployable(THREE, DEPLOYABLE_WCID.BatteryUnit, { stowed: false });
    bu.update({ chargePct: 1.0 });
    const matOn = bu.socBars[0].material;
    bu.setStowed(true);
    const matStandby = bu.socBars[0].material;
    const matOff = bu.socBars[1].material;
    bu.setStowed(cfg.stowed);
    if (!cfg.stowed) bu.update({ chargePct: cfg.chargePct });

    const counts = new Map([
      [matOff, 0],
      [matOn, 0],
      [matStandby, 0],
    ]);
    for (const m of [matOff, matOn, matStandby]) {
      const orig = m.dispose.bind(m);
      m.dispose = () => {
        counts.set(m, (counts.get(m) || 0) + 1);
        orig();
      };
    }
    bu.dispose();
    for (const [label, mat] of [["matOff", matOff], ["matOn", matOn], ["matStandby", matStandby]]) {
      assert.equal(
        counts.get(mat),
        1,
        `BatteryUnit dispose(${JSON.stringify(cfg)}) disposes ${label} exactly once`,
      );
    }
  }

  // 6) setDeployed + string WCID lookup + 4000014 MissileTurret setStowed(false) riser & yaw/pitch fallbacks
  for (const u of UNITS) {
    const byStr = buildDeployable(THREE, String(u.wcid), { stowed: true });
    assert.equal(byStr.wcid, u.wcid, `string WCID "${u.wcid}" resolves`);
    assert.equal(typeof byStr.setDeployed, "function", `${u.name} exposes setDeployed`);
    assert.equal(byStr.stowed, true);
    byStr.setDeployed(true);
    assert.equal(byStr.stowed, false, `${u.name} setDeployed(true) -> stowed=false`);
    byStr.setDeployed(false);
    assert.equal(byStr.stowed, true, `${u.name} setDeployed(false) -> stowed=true`);
    byStr.dispose();
  }
  assert.throws(() => buildDeployable(THREE, "4000002"), /Unknown deployable WCID/);

  const missile = buildDeployable(THREE, "4000014", { stowed: true });
  missile.setStowed(false);
  assert.equal(missile.riserGroup.position.z, 0.85, "MissileTurret setStowed(false) sets riserGroup.position.z = 0.85");
  missile.update({ yaw: 0.7, pitch: 0.3 });
  assert.ok(Math.abs(missile.turntable.rotation.z - 0.7) < 1e-6, "MissileTurret legacy yaw fallback");
  assert.ok(Math.abs(missile.gimbal.rotation.x - 0.3) < 1e-6, "MissileTurret legacy pitch fallback");
  missile.dispose();
});

// 5. Headless WebGL2 Combined Scene Rendering Test
await check("T_MOD_RENDER Headless WebGL2 Multi-Unit Scene Render & Teardown", () => {
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
    for (let i = 0; i < UNITS.length; i++) {
      const u = UNITS[i];
      const instance = buildDeployable(THREE, u.wcid);
      const calls = countDrawCalls(instance.root);
      assert.ok(calls <= 10, `${u.name} draw calls (${calls}) <= 10`);

      instance.root.position.set((i % 4) * 3 - 4.5, Math.floor(i / 4) * 3 - 1.5, 0);
      scene.add(instance.root);
      activeUnits.push(instance);
    }

    assert.equal(countLights(scene), 0, "Scene contains exactly 0 THREE.Light instances");

    gl.__fake.reset();
    renderer.render(scene, camera);

    const emittedDraws = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
    assert.ok(emittedDraws > 0, `Headless WebGL2 executed ${emittedDraws} draw commands`);
    assert.equal(capturedErrors.length, 0, `Encountered console errors: ${capturedErrors.join(" | ")}`);

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
