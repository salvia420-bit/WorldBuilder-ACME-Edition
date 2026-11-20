// tests/vehicle_semi_model.test.mjs — Procedural 6x4 Day-Cab Semi-Truck (`semi-379`, "Ironhorse 379") Test Suite
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_semi_model.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  SEMI_DIMENSIONS,
  SEMI_LIVERIES,
  SEMI_LIVERY_INDEX,
  SEMI_PALETTE,
  getSemiLivery,
  buildSemiTruck,
  manifest,
} from "../scene3d/vehicle/semi_truck_model.js";
import { buildSemiTrailer, CHASSIS_KINGPIN_Z } from "../scene3d/vehicle/trailer_models.js";
import { buildIsoContainer, CONTAINER_WCID } from "../scene3d/vehicle/container_models.js";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEMI_MODEL_PATH = join(HERE, "../scene3d/vehicle/semi_truck_model.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-4, msg = "near") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

console.log("=== Semi-Truck 3D Model (`semi-379`) Suite ===");

// 1. Exports, Manifest & VFX Firewall Lint
check("exports, manifest & lint_caps compliance (0 source hits, 0 manifest errors)", () => {
  assert.equal(manifest.id, "vfx-semi-379-model");
  assert.equal(manifest.lightCountDelta, 0);
  assert.equal(manifest.deterministic, true);
  assert.equal(lintManifest(manifest).length, 0);

  const src = readFileSync(SEMI_MODEL_PATH, "utf8");
  const hits = lintSource(src);
  assert.equal(hits.length, 0, `lintSource hits: ${JSON.stringify(hits)}`);

  assert.equal(Object.keys(SEMI_LIVERIES).length, 6);
  assert.equal(SEMI_LIVERY_INDEX.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(SEMI_LIVERIES[i].id, i);
    assert.equal(getSemiLivery(i), SEMI_LIVERIES[i]);
    assert.equal(getSemiLivery(SEMI_LIVERY_INDEX[i]), SEMI_LIVERIES[i]);
  }
  assert.ok(SEMI_PALETTE.chromeBright);
});

// 2. Draw Call Budget (<= 16) & Zero Light Churn
check("draw call budget <= 16 and zero THREE.Light across 100 headlight toggles", () => {
  const activeLights = [];
  const semi = buildSemiTruck(THREE, {}, { liveScene3d: { activeLights } });

  let drawCalls = 0;
  let lights = 0;
  semi.root.traverse((obj) => {
    if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) drawCalls++;
    if (obj.isLight) lights++;
  });
  assert.ok(drawCalls <= 16 && drawCalls >= 12, `drawCalls=${drawCalls}`);
  assert.equal(semi.maxDrawCalls, 16);
  assert.equal(lights, 0);
  assert.equal(activeLights.length, 1);
  assert.equal(semi.pooledLight.intensity, 0);
  assert.equal(semi.headlightBeams.visible, false);

  for (let i = 0; i < 100; i++) {
    const on = i % 2 === 0;
    semi.update({ headlights: on });
    let countLights = 0;
    semi.root.traverse((obj) => { if (obj.isLight) countLights++; });
    assert.equal(countLights, 0);
    assert.equal(semi.headlightBeams.visible, on);
    if (on) assert.ok(semi.pooledLight.intensity > 0);
    else assert.equal(semi.pooledLight.intensity, 0);
  }
  semi.dispose();
  assert.equal(activeLights.length, 0);
});

// 3. All 6 Fleet Liveries (0..5 & Key Lookup)
check("all 6 fleet liveries produce distinct primary paint vertex colors", () => {
  const seenHex = new Set();
  const sampleColor = new THREE.Color();

  for (let i = 0; i < 6; i++) {
    const expectedHex = SEMI_LIVERIES[i].hex;
    const semiByProfile = buildSemiTruck(THREE, { liveryId: i });
    const semiByKey = buildSemiTruck(THREE, {}, { livery: SEMI_LIVERY_INDEX[i] });

    for (const s of [semiByProfile, semiByKey]) {
      assert.equal(s.livery.id, i);
      const body = s.root.getObjectByName("semi-body-paint");
      const col = body.geometry.getAttribute("color");
      let foundExpected = false;
      for (let v = 0; v < col.count; v++) {
        sampleColor.setRGB(col.getX(v), col.getY(v), col.getZ(v));
        if (sampleColor.getHex() === expectedHex) {
          foundExpected = true;
          break;
        }
      }
      assert.ok(foundExpected, `livery ${i} (${SEMI_LIVERY_INDEX[i]}) color 0x${expectedHex.toString(16)} present`);
      s.dispose();
    }
    seenHex.add(expectedHex);
  }
  assert.equal(seenHex.size, 6);
});

// 4. Exact Dimensions & Structural Layout
check("exact dimensions (7.00m length, wheels, fifth-wheel, seats, clear rear window, exhaust stacks)", () => {
  const semi = buildSemiTruck(THREE, { profileKey: "semi-379" });
  const box = new THREE.Box3().setFromObject(semi.root);

  near(box.min.y, -3.45, 0.02, "min.y");
  near(box.max.y, 3.55, 0.02, "max.y");
  near(box.max.y - box.min.y, 7.00, 0.02, "overallLength");
  near(box.min.z, 0.0, 0.01, "min.z ground contact");
  near(box.max.z, 3.72, 0.02, "max.z exhaust tips");

  // Pivots
  near(semi.suspFL.position.x, -1.06, 1e-6);
  near(semi.suspFL.position.y, 2.65, 1e-6);
  near(semi.suspFL.position.z, 0.505, 1e-6);
  near(semi.suspFR.position.x, 1.06, 1e-6);
  near(semi.suspFR.position.y, 2.65, 1e-6);
  near(semi.suspTandemFront.position.y, -1.35, 1e-6);
  near(semi.suspTandemRear.position.y, -2.67, 1e-6);
  near(semi.fifthWheelPivot.position.x, 0, 1e-6);
  near(semi.fifthWheelPivot.position.y, -2.01, 1e-6);
  near(semi.fifthWheelPivot.position.z, 0.96, 1e-6);
  near(semi.steeringWheelPivot.position.x, -0.52, 1e-6);
  near(semi.steeringWheelPivot.position.y, 0.76, 1e-6);
  near(semi.steeringWheelPivot.position.z, 1.98, 1e-6);

  // 2 Cab seats in semi-interior-rubber
  const interior = semi.root.getObjectByName("semi-interior-rubber");
  const pos = interior.geometry.getAttribute("position");
  let hasDriverSeat = false;
  let hasPassengerSeat = false;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x <= -0.30 && x >= -0.75 && y >= 0.0 && y <= 0.55 && z >= 1.60 && z <= 1.75) hasDriverSeat = true;
    if (x >= 0.30 && x <= 0.75 && y >= 0.0 && y <= 0.55 && z >= 1.60 && z <= 1.75) hasPassengerSeat = true;
  }
  assert.ok(hasDriverSeat, "driver seat present at [-0.52, +0.28, 1.72]");
  assert.ok(hasPassengerSeat, "passenger seat present at [+0.52, +0.28, 1.72]");

  // Clear rear cab window in semi-cab-glass at y = -0.30, z: 2.12..2.84
  const glass = semi.root.getObjectByName("semi-cab-glass");
  const gpos = glass.geometry.getAttribute("position");
  let hasRearWindow = false;
  for (let i = 0; i < gpos.count; i++) {
    const x = gpos.getX(i), y = gpos.getY(i), z = gpos.getZ(i);
    if (Math.abs(x) <= 0.77 && Math.abs(y + 0.30) <= 0.02 && z >= 2.10 && z <= 2.86) hasRearWindow = true;
  }
  assert.ok(hasRearWindow, "clear rear cab window pane present at y=-0.30");

  // Exhaust stacks at ±1.08, -0.44, top z = 3.72
  const chrome = semi.root.getObjectByName("semi-chrome-trim");
  const cpos = chrome.geometry.getAttribute("position");
  let hasLeftStack = false;
  let hasRightStack = false;
  for (let i = 0; i < cpos.count; i++) {
    const x = cpos.getX(i), y = cpos.getY(i), z = cpos.getZ(i);
    if (Math.abs(x + 1.08) < 0.08 && Math.abs(y + 0.44) < 0.08 && z > 3.70) hasLeftStack = true;
    if (Math.abs(x - 1.08) < 0.08 && Math.abs(y + 0.44) < 0.08 && z > 3.70) hasRightStack = true;
  }
  assert.ok(hasLeftStack && hasRightStack, "exhaust stacks reach z=3.72 at x=±1.08, y=-0.44");

  semi.dispose();
});

// 5. PBR Materials & CSM Shader Patch
check("PBR materials use 0xffffff + vertexColors + shadow flags + installCsmShaderPatch", () => {
  const csmLegacy = { patchedMaterials: new Set() };
  const semi = buildSemiTruck(THREE, {}, { csmState: csmLegacy });

  for (const key of ["matBody", "matChrome", "matChassis", "matRubber"]) {
    const m = semi.materials[key];
    assert.ok(m.isMeshStandardMaterial, `${key} is MeshStandardMaterial`);
    assert.equal(m.color.getHex(), 0xffffff, `${key} color === 0xffffff`);
    assert.equal(m.vertexColors, true, `${key} vertexColors`);
    assert.equal(m.castShadow, true, `${key} castShadow`);
    assert.equal(m.receiveShadow, true, `${key} receiveShadow`);
    assert.ok(csmLegacy.patchedMaterials.has(m), `${key} patched by installCsmShaderPatch`);
    assert.equal(m.userData.csmEnabled, true, `${key} csmEnabled`);
  }
  semi.dispose();

  const csmShared = { uniforms: {} };
  const semiShared = buildSemiTruck(THREE, {}, { csmState: csmShared });
  for (const key of ["matBody", "matChrome", "matChassis", "matRubber"]) {
    const m = semiShared.materials[key];
    assert.equal(m.userData.csmEnabled, true, `${key} csmEnabled with shared uniforms`);
    assert.equal(typeof m.onBeforeCompile, "function");
  }
  semiShared.dispose();
});

// 6. Articulation & Animation (update)
check("steering taper, 2.5x steering wheel, rolling wheels, speedo, shifter, fifth-wheel, glad-hands, lamps", () => {
  const semi = buildSemiTruck(THREE, {});

  // Low speed 38 deg clamp
  semi.update({ speed: 5.0, steerAngle: 1.2 });
  near(semi.steerPivotFL.rotation.z, SEMI_DIMENSIONS.maxSteerLowSpeedRad, 1e-5, "38 deg low-speed steer clamp");
  near(semi.steerPivotFR.rotation.z, SEMI_DIMENSIONS.maxSteerLowSpeedRad, 1e-5);
  near(semi.steeringWheelPivot.rotation.z, SEMI_DIMENSIONS.maxSteerLowSpeedRad * 2.5, 1e-5, "2.5x steering wheel");

  // High speed 12 deg taper at 27 m/s
  semi.update({ speed: 27.0, steerAngle: 1.0 });
  near(semi.steerPivotFL.rotation.z, SEMI_DIMENSIONS.maxSteerHighSpeedRad, 1e-5, "12 deg high-speed taper");

  // Rolling wheels
  assert.equal(semi.rollingWheels.length, 4);
  const prevRoll = semi.wheelRollAngle;
  semi.update({ speed: 10.1, dt: 0.1 });
  near(semi.wheelRollAngle - prevRoll, (10.1 * 0.1) / 0.505, 1e-4, "forward wheel roll");
  semi.update({ speed: -5.05, dt: 0.1 });
  const expectedAfterRev = (prevRoll + (10.1 * 0.1) / 0.505 + (-5.05 * 0.1) / 0.505 + 2 * Math.PI) % (2 * Math.PI);
  near(semi.wheelRollAngle, expectedAfterRev, 1e-4, "reverse wheel roll");

  // Speedometer needle (X-Z dial orientation via rotation.x = PI/2 + rotation.z sweep)
  near(semi.speedoNeedlePivot.rotation.x, Math.PI / 2, 1e-6, "speedoNeedlePivot oriented in X-Z plane");
  semi.update({ speed: 0 });
  const a0 = semi.speedoNeedlePivot.rotation.z;
  semi.update({ speed: 20 });
  const a20 = semi.speedoNeedlePivot.rotation.z;
  semi.update({ speed: 40 });
  const a40 = semi.speedoNeedlePivot.rotation.z;
  assert.ok(a0 !== a20 && a20 !== a40, "speedometer needle sweeps 0..40 m/s");
  semi.root.updateMatrixWorld(true);
  const needleBox = new THREE.Box3().setFromObject(semi.speedoNeedlePivot);
  assert.ok(needleBox.max.y - needleBox.min.y < 0.01, "speedo needle sweeps flat in X-Z dial plane");

  // Shifter cane (-1, 0, 1..5)
  semi.update({ gear: -1 });
  const gxRev = semi.shifterPivot.rotation.x;
  semi.update({ gear: 3 });
  const gx3 = semi.shifterPivot.rotation.x;
  semi.update({ gear: 0 });
  near(semi.shifterPivot.rotation.x, 0, 1e-6);
  assert.ok(gxRev < 0 && gx3 > 0);

  // Coupled glad-hands, fifth-wheel pitch, braking lamps
  const gPosUncoupled = semi.gladHandPivot.position.y;
  semi.update({ coupled: true, trailerPitch: 0.12, braking: true });
  near(semi.fifthWheelPivot.rotation.x, 0.12, 1e-6);
  assert.ok(semi.gladHandPivot.position.y !== gPosUncoupled, "glad-hands extend when coupled");
  assert.ok(semi.materials.matLamps.emissiveIntensity > 1.5, "brake lamps brighten");

  semi.dispose();
});

// 7. getFifthWheelWorldAnchor & Flush Mating with 20ft & 40ft Trailers
check("getFifthWheelWorldAnchor & flush mating with 20ft and 40ft trailers across ±60° articulation", () => {
  const semi = buildSemiTruck(THREE, {});
  semi.root.position.set(150, 300, 12);
  semi.root.rotation.z = 0.4;
  semi.root.updateMatrixWorld(true);

  const anchor = semi.getFifthWheelWorldAnchor();
  const expected = semi.root.localToWorld(new THREE.Vector3(0, -2.01, 0.96));
  assert.ok(anchor.distanceTo(expected) < 1e-6, "fifthWheelWorldAnchor matches localToWorld");

  for (const [kind, art] of [["20ft", 0.0], ["40ft", 0.5]]) {
    const tr = buildSemiTrailer(THREE, kind);
    semi.attachTrailer(tr, art);
    assert.equal(semi.coupled, true);
    assert.equal(tr.landingGearRetracted, true);
    near(tr.root.position.z, 0.96 - CHASSIS_KINGPIN_Z, 1e-6, `${kind} flush z=0`);

    const kpWorld = tr.root.localToWorld(new THREE.Vector3(0, tr.kingpinY, tr.kingpinZ));
    const fwWorld = semi.getFifthWheelWorldAnchor();
    assert.ok(kpWorld.distanceTo(fwWorld) < 1e-4, `${kind} kingpin coincides with fifth wheel`);

    // Verify cab swing clearance (cab rear y=-0.30, half-width 0.98) vs trailer front corners (±1.219, kpY + 0.90)
    for (let degA = -60; degA <= 60; degA += 15) {
      const a = (degA * Math.PI) / 180;
      for (const sx of [-1.219, 1.219]) {
        const localCornerY = tr.kingpinY + 0.90;
        const dxFromKp = sx;
        const dyFromKp = 0.90;
        // Rotated by a around kingpin (0, -2.01):
        const cornerX = dxFromKp * Math.cos(a) - dyFromKp * Math.sin(a);
        const cornerY = -2.01 + dxFromKp * Math.sin(a) + dyFromKp * Math.cos(a);
        // Must clear cab rear wall y = -0.30 if within cab X span [-0.98, 0.98]
        if (Math.abs(cornerX) <= 0.98) {
          assert.ok(cornerY < -0.30 - 0.15, `${kind} corner swing ${degA}° clears cab rear (${cornerY})`);
        }
      }
    }

    semi.detachTrailer();
    assert.equal(semi.coupled, false);
    assert.equal(tr.landingGearRetracted, false);
    tr.dispose();
  }

  semi.dispose();
});

// 8. Hardening: Zero Vector3 Allocs in update(), NaN/null immunity, Outward Winding, Deduplicated Dispose
check("zero Vector3 allocations in update(), NaN/null safety, outward winding >99%, deduplicated dispose()", () => {
  let vector3Allocs = 0;
  class MonitoredVector3 extends THREE.Vector3 {
    constructor(...args) {
      vector3Allocs++;
      super(...args);
    }
  }
  const customThree = Object.create(THREE);
  customThree.Vector3 = MonitoredVector3;

  const activeLights = [];
  const semi = buildSemiTruck(customThree, null, { liveScene3d: { activeLights } });
  vector3Allocs = 0;

  for (let i = 0; i < 100; i++) {
    semi.update({ headlights: true, speed: 15, steerAngle: 0.1, braking: i % 2 === 0, coupled: true }, 0.033);
  }
  assert.equal(vector3Allocs, 0, `expected 0 Vector3 allocs, got ${vector3Allocs}`);

  // Null/NaN/Infinity immunity
  semi.update(null);
  semi.update(undefined);
  semi.update({ speed: Infinity, dt: NaN, steerAngle: -Infinity, accel: NaN, trailerPitch: Infinity });
  assert.ok(Number.isFinite(semi.wheelRollAngle));
  assert.ok(Number.isFinite(semi.steerPivotFL.rotation.z));
  assert.ok(Number.isFinite(semi.fifthWheelPivot.rotation.x));

  // Finite floats & outward face winding >99% on solid meshes
  semi.root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    for (const attrName of ["position", "normal", "color"]) {
      const attr = obj.geometry.getAttribute(attrName);
      if (!attr) continue;
      for (let i = 0; i < attr.array.length; i++) {
        assert.ok(Number.isFinite(attr.array[i]), `non-finite ${attrName} in ${obj.name}`);
      }
    }
  });

  for (const meshName of ["semi-body-paint", "semi-chrome-trim", "semi-chassis-steel", "semi-interior-rubber"]) {
    const mesh = semi.root.getObjectByName(meshName);
    const pos = mesh.geometry.getAttribute("position");
    const nor = mesh.geometry.getAttribute("normal");
    let aligned = 0;
    let total = 0;
    for (let i = 0; i < pos.count; i += 3) {
      const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
      const bx = pos.getX(i + 1) - ax, by = pos.getY(i + 1) - ay, bz = pos.getZ(i + 1) - az;
      const cx = pos.getX(i + 2) - ax, cy = pos.getY(i + 2) - ay, cz = pos.getZ(i + 2) - az;
      const fx = by * cz - bz * cy, fy = bz * cx - bx * cz, fz = bx * cy - by * cx;
      if (Math.hypot(fx, fy, fz) < 1e-8) continue;
      total++;
      if (fx * nor.getX(i) + fy * nor.getY(i) + fz * nor.getZ(i) > 0) aligned++;
    }
    assert.ok(total > 0 && aligned / total > 0.99, `${meshName} winding ${aligned}/${total}`);
  }

  // Deduplicated dispose()
  const geomCounts = new Map();
  const matCounts = new Map();
  semi.root.traverse((obj) => {
    if (obj.geometry && !geomCounts.has(obj.geometry)) {
      geomCounts.set(obj.geometry, 0);
      const orig = obj.geometry.dispose.bind(obj.geometry);
      obj.geometry.dispose = () => {
        geomCounts.set(obj.geometry, geomCounts.get(obj.geometry) + 1);
        orig();
      };
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && !matCounts.has(m)) {
          matCounts.set(m, 0);
          const orig = m.dispose.bind(m);
          m.dispose = () => {
            matCounts.set(m, matCounts.get(m) + 1);
            orig();
          };
        }
      }
    }
  });

  semi.dispose();
  assert.ok(geomCounts.size > 0);
  for (const [g, cnt] of geomCounts) assert.equal(cnt, 1, `geom ${g.uuid} disposed ${cnt}x`);
  for (const [m, cnt] of matCounts) assert.equal(cnt, 1, `mat ${m.uuid} disposed ${cnt}x`);
  assert.equal(activeLights.length, 0);
});

// 9. Regression: Unobstructed Rear Window Raycaster Sightline, ±72° Articulation Clearance & Headlights Persistence
check("rear window Raycaster sightline (0/187 opaque hits), ±72° rack/cab clearance (20ft/40ft/40HC), omitted headlights persistence", () => {
  const semi = buildSemiTruck(THREE, {});
  semi.root.updateMatrixWorld(true);

  // 9a. 17 x 11 = 187 Raycaster probe through rear window aperture x in [-0.74, +0.74], z in [2.13, 2.83] (inside [2.12, 2.84])
  // plus inclusive [2.12, 2.84] check against headache rack (semi-chassis-steel).
  const opaqueMeshes = [];
  semi.root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.name === "semi-cab-glass" || obj.name === "headlightBeams") return;
    opaqueMeshes.push(obj);
  });
  const chassisOnly = [semi.root.getObjectByName("semi-chassis-steel")];
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3(0, -1, 0);
  let hits = 0;
  let rackBoundaryHits = 0;
  let totalRays = 0;
  for (let ix = 0; ix < 17; ix++) {
    const rx = -0.74 + (ix / 16) * 1.48;
    for (let iz = 0; iz < 11; iz++) {
      const rz = 2.13 + (iz / 10) * 0.70;
      origin.set(rx, -0.10, rz);
      raycaster.set(origin, dir);
      const res = raycaster.intersectObjects(opaqueMeshes, false);
      totalRays++;
      if (res.length > 0) hits++;

      const rzBound = 2.12 + (iz / 10) * 0.72;
      origin.set(rx, -0.10, rzBound);
      raycaster.set(origin, dir);
      if (raycaster.intersectObjects(chassisOnly, false).length > 0) rackBoundaryHits++;
    }
  }
  assert.equal(totalRays, 187);
  assert.equal(hits, 0, `expected 0/187 rear window ray hits, got ${hits}`);
  assert.equal(rackBoundaryHits, 0, `expected 0/187 headache rack hits on [2.12, 2.84], got ${rackBoundaryHits}`);

  // 9b. Headache rack clear of cab rear wall (y = -0.30) by >= 0.10 m and clear of articulated 20ft/40ft/40HC across ±72°
  const chassisMesh = semi.root.getObjectByName("semi-chassis-steel");
  const cPos = chassisMesh.geometry.getAttribute("position");
  let rackMaxY = -Infinity;
  let rackMinY = Infinity;
  for (let i = 0; i < cPos.count; i++) {
    const x = cPos.getX(i), y = cPos.getY(i), z = cPos.getZ(i);
    if (z >= 0.98 && y > -0.52 && y < -0.20 && Math.abs(x) <= 0.96) {
      if (y > rackMaxY) rackMaxY = y;
      if (y < rackMinY) rackMinY = y;
    }
  }
  assert.ok(rackMinY > -0.52 && rackMaxY <= -0.40 + 1e-6, `headache rack Y [${rackMinY}, ${rackMaxY}] must clear cab -0.30 by >= 0.10 m`);

  const tmpV = new THREE.Vector3();
  for (const [label, kind, with40HC] of [["20ft", "20ft", false], ["40ft", "40ft", false], ["40ft+40HC", "40ft", true]]) {
    const tr = buildSemiTrailer(THREE, kind);
    const c40 = with40HC ? buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer40HC) : null;
    if (c40) tr.attachContainer(c40);

    for (let degA = -72; degA <= 72; degA += 2) {
      const art = (degA * Math.PI) / 180;
      semi.attachTrailer(tr, art);
      tr.root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        const pos = obj.geometry.getAttribute("position");
        if (!pos) return;
        for (let i = 0; i < pos.count; i++) {
          tmpV.set(pos.getX(i), pos.getY(i), pos.getZ(i));
          obj.localToWorld(tmpV);
          semi.root.worldToLocal(tmpV);
          if (Math.abs(tmpV.x) <= 0.98 && tmpV.z >= 1.22 && tmpV.z <= 3.05) {
            assert.ok(tmpV.y < -0.30 - 0.05, `${label} @ ${degA}° hits cab wall y=${tmpV.y}`);
          }
          if (Math.abs(tmpV.x) <= 0.96 && tmpV.z >= 0.98 && tmpV.z <= 2.96) {
            assert.ok(tmpV.y < rackMinY - 0.05, `${label} @ ${degA}° hits headache rack y=${tmpV.y} >= ${rackMinY}`);
          }
        }
      });
    }
    semi.detachTrailer();
    if (c40) c40.dispose();
    tr.dispose();
  }

  // 9c. Glad-hand hoses stay clear of cab (-0.30) and trailer nose (z <= 1.44) when coupled
  semi.update({ coupled: true });
  semi.root.updateMatrixWorld(true);
  const ghBox = new THREE.Box3().setFromObject(semi.gladHandPivot);
  assert.ok(ghBox.max.y < -0.30 - 0.10, `coupled glad-hands max.y=${ghBox.max.y} clear of cab`);
  assert.ok(ghBox.min.z > 1.50, `coupled glad-hands min.z=${ghBox.min.z} clear above trailer nose`);

  // 9d. Omitted headlights on subsequent update() preserves matLamps.emissiveIntensity
  semi.update({ headlights: true });
  near(semi.materials.matLamps.emissiveIntensity, 1.2, 1e-6, "headlights on emissive");
  assert.equal(semi.headlightBeams.visible, true);
  semi.update({ speed: 5.0 });
  near(semi.materials.matLamps.emissiveIntensity, 1.2, 1e-6, "omitted headlights keeps emissive 1.2");
  assert.equal(semi.headlightBeams.visible, true);
  semi.update({ braking: true });
  near(semi.materials.matLamps.emissiveIntensity, 2.2, 1e-6, "braking overrides emissive to 2.2");
  semi.update({ braking: false });
  near(semi.materials.matLamps.emissiveIntensity, 1.2, 1e-6, "releasing brake restores headlights emissive 1.2");
  semi.update({ headlights: false });
  near(semi.materials.matLamps.emissiveIntensity, 0.65, 1e-6, "headlights off restores 0.65");

  semi.dispose();
});

// 10. Rotated Headlight FxLightSource Tracking + Zero Allocations + Dispose Cleanup (BUG-6, ADV-4)
check("rotated headlight FxLightSource aligns with heading = PI/2, tracks motion with 0 Vector3 allocs, and releases on dispose", () => {
  let vector3Allocs = 0;
  class MonitoredVector3 extends THREE.Vector3 {
    constructor(...args) {
      vector3Allocs++;
      super(...args);
    }
  }
  const customThree = Object.create(THREE);
  customThree.Vector3 = MonitoredVector3;

  const activeLights = [];
  const semi = buildSemiTruck(customThree, {}, { liveScene3d: { activeLights } });
  semi.root.position.set(100, 200, 10);
  semi.root.rotation.z = -Math.PI / 2; // compass heading = +pi/2 (East = +X)
  semi.root.updateMatrixWorld(true);

  vector3Allocs = 0;
  semi.update({ headlights: true, speed: 5.0 });
  assert.equal(vector3Allocs, 0, "zero Vector3 allocations on headlight update");
  near(semi.pooledLight.position.x, 100 + 3.60, 1e-3, "semi headlight X rotated East (+X)");
  near(semi.pooledLight.position.y, 200, 1e-3, "semi headlight Y rotated East (0 offset)");
  near(semi.pooledLight.position.z, 10 + 1.24, 1e-3, "semi headlight Z offset preserved");

  // Subsequent update without s.headlights keeps tracking moved/turned root
  semi.root.position.set(110, 220, 10);
  semi.root.rotation.z = -Math.PI; // compass heading = pi (South = -Y)
  semi.root.updateMatrixWorld(true);
  semi.update({ speed: 6.0 });
  assert.equal(vector3Allocs, 0, "zero Vector3 allocations on omitted-headlights tracking update");
  near(semi.pooledLight.position.x, 110, 1e-3, "semi headlight X tracks South heading");
  near(semi.pooledLight.position.y, 220 - 3.60, 1e-3, "semi headlight Y tracks South (-Y)");

  semi.dispose();
  assert.equal(semi.pooledLight.released, true, "semi pooledLight.released === true on dispose");
  assert.equal(semi.pooledLight.intensity, 0, "semi pooledLight.intensity === 0 on dispose");
  assert.equal(activeLights.length, 0, "semi pooledLight removed from activeLights");
});

console.log(`\nvehicle_semi_model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
