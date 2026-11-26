// tests/vehicle_warehouse_models.test.mjs — Procedural 3D Models Suite (M2)
// Covers: warehouse_rack_model, agf_forklift_model, amr_underride_model, warehouse_infra_model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  manifest as rackManifest,
  buildRackRow,
  buildRackBay,
} from "../scene3d/vehicle/warehouse_rack_model.js";
import {
  manifest as agfManifest,
  buildAgfForklift,
} from "../scene3d/vehicle/agf_forklift_model.js";
import {
  manifest as amrManifest,
  buildAmrUnderride,
} from "../scene3d/vehicle/amr_underride_model.js";
import {
  manifest as infraManifest,
  buildConcreteApron,
  buildTransferStand,
  buildTransferStandGroup,
  buildScissorLiftTable,
  buildChargingDock,
  buildChargingDockGroup,
} from "../scene3d/vehicle/warehouse_infra_model.js";
import { buildPallet } from "../scene3d/vehicle/deployable_models.js";
import {
  NE_FLATLAND_SITE,
  PALLET_ENVELOPE_SPECS,
  RACK_SPECS,
  AGF_SPECS,
  AMR_SPECS,
  STAND_SPECS,
  LIFT_TABLE_SPECS,
  computeRackSlotLocalPose,
  computeRackRowBounds,
  buildDefaultHubLayout,
  localToWorld2D,
} from "../scene3d/vehicle/warehouse_specs.js";
import {
  computeMastStages,
  stepAmrKinematics,
} from "../scene3d/vehicle/warehouse_kinematics.js";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ALL_9_WCIDS = PALLET_ENVELOPE_SPECS.cargoWcids;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-4, msg = "near") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
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

function spyDisposal(root, extraObjects = []) {
  const geoms = [];
  const mats = [];
  const seenG = new Set();
  const seenM = new Set();
  const visit = (o) => {
    if (!o) return;
    if (o.geometry && !seenG.has(o.geometry)) {
      seenG.add(o.geometry);
      const rec = { disposed: false, name: o.name || "geom" };
      const orig = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => {
        rec.disposed = true;
        orig();
      };
      geoms.push(rec);
    }
    if (o.material) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m && !seenM.has(m)) {
          seenM.add(m);
          const rec = { disposed: false, name: o.name || "mat" };
          const orig = m.dispose.bind(m);
          m.dispose = () => {
            rec.disposed = true;
            orig();
          };
          mats.push(rec);
        }
      }
    }
  };
  if (root) root.traverse(visit);
  for (const ex of extraObjects) visit(ex);
  return { geoms, mats };
}

function assertCsmPatched(root, label) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.isMeshBasicMaterial) continue; // floor blue-spot chevron uses MeshBasicMaterial
      assert.ok(m.isMeshStandardMaterial, `${label} ${o.name} MeshStandardMaterial`);
      assert.equal(m.userData?.csmEnabled, true, `${label} ${o.name} csmEnabled === true`);
    }
  });
}

console.log("=== Warehouse Hub Procedural 3D Models Suite (M2) ===");

check("T_WM_01 Manifests, lintManifest() & lintSource() across all 4 M2 modules", () => {
  const entries = [
    [rackManifest, "scene3d/vehicle/warehouse_rack_model.js", "vfx-warehouse-rack-model"],
    [agfManifest, "scene3d/vehicle/agf_forklift_model.js", "vfx-agf-forklift-model"],
    [amrManifest, "scene3d/vehicle/amr_underride_model.js", "vfx-amr-underride-model"],
    [infraManifest, "scene3d/vehicle/warehouse_infra_model.js", "vfx-warehouse-infra-model"],
  ];

  for (const [m, rel, expectedId] of entries) {
    assert.equal(m.id, expectedId);
    assert.equal(m.lightCountDelta, 0);
    assert.equal(m.cacheKeyScope, "set");
    assert.equal(m.deterministic, true);
    const mHits = lintManifest(m);
    assert.equal(mHits.length, 0, `${rel} lintManifest hits: ${JSON.stringify(mHits)}`);
    const src = readFileSync(join(ROOT, rel), "utf8");
    const sHits = lintSource(src);
    assert.equal(sHits.length, 0, `${rel} lintSource hits: ${JSON.stringify(sHits)}`);
  }
});

check("T_WM_02 Draw-call budgets, 0 lights, CSM patching & combined infra ceiling", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const layout = buildDefaultHubLayout();

  const rackSingle = buildRackRow(THREE, { id: "R1", bayCount: 8, doubleSided: false }, { csmState: fakeCsm });
  const rackDouble = buildRackRow(THREE, { id: "R2_3", bayCount: 8, doubleSided: true }, { csmState: fakeCsm });
  const rackBay = buildRackBay(THREE, { csmState: fakeCsm });
  const agf = buildAgfForklift(THREE, { csmState: fakeCsm });
  const amr = buildAmrUnderride(THREE, { csmState: fakeCsm });
  const apron = buildConcreteApron(THREE, layout, { csmState: fakeCsm });
  const standGroup = buildTransferStandGroup(THREE, layout.stands, { origin: layout.origin, csmState: fakeCsm });
  const chargerGroup = buildChargingDockGroup(THREE, layout.chargers, { origin: layout.origin, csmState: fakeCsm });
  const liftTable = buildScissorLiftTable(THREE, { csmState: fakeCsm });

  assert.ok(countDrawCalls(rackSingle.root) <= 4, `single rack DC (${countDrawCalls(rackSingle.root)}) <= 4`);
  assert.ok(countDrawCalls(rackDouble.root) <= 4, `double rack DC (${countDrawCalls(rackDouble.root)}) <= 4`);
  assert.ok(countDrawCalls(rackBay.root) <= 4, `single bay DC (${countDrawCalls(rackBay.root)}) <= 4`);
  assert.ok(countDrawCalls(agf.root) <= 10, `AGF DC (${countDrawCalls(agf.root)}) <= 10`);
  assert.ok(countDrawCalls(amr.root) <= 6, `AMR DC (${countDrawCalls(amr.root)}) <= 6`);
  assert.ok(countDrawCalls(apron.root) <= 3, `Apron DC (${countDrawCalls(apron.root)}) <= 3`);
  assert.ok(countDrawCalls(standGroup.root) <= 2, `StandGroup DC (${countDrawCalls(standGroup.root)}) <= 2`);
  const combinedStandChargerDc = countDrawCalls(standGroup.root) + countDrawCalls(chargerGroup.root);
  assert.ok(combinedStandChargerDc <= 3, `Combined Stands+Chargers DC (${combinedStandChargerDc}) <= 3`);
  assert.ok(countDrawCalls(liftTable.root) <= 4, `LiftTable DC (${countDrawCalls(liftTable.root)}) <= 4`);

  for (const obj of [rackSingle, rackDouble, rackBay, agf, amr, apron, standGroup, chargerGroup, liftTable]) {
    assert.equal(countLights(obj.root), 0, `${obj.root.name} must have 0 lights`);
    assertCsmPatched(obj.root, obj.root.name);
  }

  // Verify makeLampsMaterial + installCsmShaderPatch chained onBeforeCompile
  assert.equal(agf.lampsMat.onBeforeCompile.name, "chainedOnBeforeCompile");
  assert.equal(amr.statusMat.onBeforeCompile.name, "chainedOnBeforeCompile");
  assert.equal(liftTable.beaconMat.onBeforeCompile.name, "chainedOnBeforeCompile");
  assert.equal(chargerGroup.ledMesh.material.onBeforeCompile.name, "chainedOnBeforeCompile");

  for (const obj of [rackSingle, rackDouble, rackBay, agf, amr, apron, standGroup, chargerGroup, liftTable]) {
    obj.dispose();
  }
});

check("T_WM_03 Rack Row bounds, slot world pos, all 9 WCIDs, highlight & >120 m LOD proxy", () => {
  const single = buildRackRow(THREE, { id: "R1", bayCount: 8, doubleSided: false });
  single.root.updateMatrixWorld(true);
  const bSingle = computeRackRowBounds(8, false, RACK_SPECS);
  const boxSingle = new THREE.Box3().setFromObject(single.root);
  near(boxSingle.min.x, bSingle.minX, 1e-3, "single minX");
  near(boxSingle.max.x, bSingle.maxX, 1e-3, "single maxX");
  near(boxSingle.min.y, bSingle.minY, 1e-3, "single minY");
  near(boxSingle.max.y, bSingle.maxY, 1e-3, "single maxY");
  near(boxSingle.min.z, bSingle.minZ, 1e-3, "single minZ");
  near(boxSingle.max.z, bSingle.maxZ, 1e-3, "single maxZ");

  const dbl = buildRackRow(THREE, { id: "R2_3", bayCount: 8, doubleSided: true });
  dbl.root.position.set(100, 200, 0);
  dbl.root.rotation.z = -Math.PI * 0.5;
  dbl.root.updateMatrixWorld(true);
  const bDbl = computeRackRowBounds(8, true, RACK_SPECS);
  // Check local bounds by resetting temporarily or checking width/depth/height
  dbl.root.position.set(0, 0, 0);
  dbl.root.rotation.z = 0;
  dbl.root.updateMatrixWorld(true);
  const boxDbl = new THREE.Box3().setFromObject(dbl.root);
  near(boxDbl.max.x - boxDbl.min.x, bDbl.width, 1e-3, "double width");
  near(boxDbl.max.y - boxDbl.min.y, bDbl.depth, 1e-3, "double depth");
  near(boxDbl.max.z - boxDbl.min.z, bDbl.height, 1e-3, "double height");

  // Rotated getSlotWorldPos parity with localToWorld2D + computeRackSlotLocalPose
  dbl.root.position.set(44816.0, 46944.0, 0.0);
  dbl.root.rotation.z = -Math.PI * 0.25;
  const outVec = new THREE.Vector3();
  const retVec = dbl.getSlotWorldPos(3, 2, 1, 1, outVec);
  assert.equal(retVec, outVec);
  const lp = computeRackSlotLocalPose(3, 2, 1, RACK_SPECS, { doubleSided: true, side: 1 });
  const [ewx, ewy] = localToWorld2D(lp.x, lp.y, 44816.0, 46944.0, Math.PI * 0.25);
  near(outVec.x, ewx, 1e-4, "rotated slot world X");
  near(outVec.y, ewy, 1e-4, "rotated slot world Y");
  near(outVec.z, RACK_SPECS.tierZ[2], 1e-4, "slot world Z === 4.700");

  // Load all 9 stowed deployable WCIDs + fallback pallet
  const slotsToLoad = [
    [0, 0, 0, 0, ALL_9_WCIDS[0]],
    [0, 1, 0, 1, ALL_9_WCIDS[1]],
    [1, 2, 0, 0, ALL_9_WCIDS[2]],
    [1, 3, 0, 1, ALL_9_WCIDS[3]],
    [2, 0, 1, 0, ALL_9_WCIDS[4]],
    [2, 1, 1, 1, ALL_9_WCIDS[5]],
    [3, 2, 1, 0, ALL_9_WCIDS[6]],
    [3, 3, 1, 1, ALL_9_WCIDS[7]],
    [4, 1, 0, 0, ALL_9_WCIDS[8]],
    [4, 2, 0, 1, 4000099], // bare fallback pallet
  ];
  for (const [b, t, s, sl, wcid] of slotsToLoad) {
    const entry = dbl.loadSlot(b, t, s, sl, wcid);
    assert.ok(entry && entry.model?.root, `loaded WCID ${wcid}`);
    dbl.root.updateMatrixWorld(true);
    const slotBox = new THREE.Box3().setFromObject(entry.slotGroup);
    near(slotBox.min.z, RACK_SPECS.tierZ[t], 1e-3, `WCID ${wcid} rests on tier ${t}`);
    assert.ok(slotBox.max.z - slotBox.min.z <= 2.055, `WCID ${wcid} stowed height <= 2.055`);
  }

  // Highlight attach/detach
  assert.equal(dbl.setHighlightedSlot(1, 2, 0, 1, "reachable"), true);
  assert.ok(countDrawCalls(dbl.root) > 4);
  assert.equal(dbl.setHighlightedSlot(null, null, null, null, null), false);

  // >120 m LOD proxy test
  assert.equal(dbl.setCargoLodDistance(150), true, "LOD active > 120 m");
  assert.equal(dbl.isLodActive, true);
  assert.equal(dbl.cargoGroup.visible, false);
  assert.equal(dbl.proxyMesh.parent, dbl.root);
  assert.equal(dbl.proxyMesh.frustumCulled, false);
  assert.equal(dbl.proxyMesh.count, slotsToLoad.length);
  // 4 structural + 1 instanced proxy = 5 visible draw calls
  let visDc = 0;
  dbl.root.traverseVisible((o) => {
    if (o.isMesh) visDc++;
  });
  assert.equal(visDc, 5, "LOD proxy collapses 10 loaded slots into 4 + 1 = 5 visible draw calls");

  assert.equal(dbl.setCargoLodDistance(40), false, "LOD inactive <= 120 m");
  assert.equal(dbl.isLodActive, false);
  assert.equal(dbl.cargoGroup.visible, true);
  assert.equal(dbl.proxyMesh.parent, null);

  // Unload & dispose
  const spySingle = spyDisposal(single.root, [single.proxyMesh]);
  single.dispose();
  assert.ok(spySingle.geoms.every((g) => g.disposed), "single rack geoms disposed");
  assert.ok(spySingle.mats.every((m) => m.disposed), "single rack mats disposed");

  const spyDbl = spyDisposal(dbl.root, [dbl.proxyMesh]);
  dbl.dispose();
  assert.ok(spyDbl.geoms.every((g) => g.disposed), "double rack geoms disposed");
  assert.ok(spyDbl.mats.every((m) => m.disposed), "double rack mats disposed");
});

check("T_WM_04 AGF Forklift kinematics bounds, 3-stage mast, supportSurfaceZ & 9 WCIDs", () => {
  const agf = buildAgfForklift(THREE);
  agf.root.updateMatrixWorld(true);

  const boxMin = new THREE.Box3().setFromObject(agf.root);
  near(boxMin.max.x - boxMin.min.x, AGF_SPECS.overallWidthM, 1e-3, "AGF overallWidthM 1.140");
  near(boxMin.min.y, AGF_SPECS.rearOverhangY, 1e-3, "AGF rearOverhangY -1.930");
  near(boxMin.max.y, AGF_SPECS.forkTipY, 1e-3, "AGF forkTipY +1.300");
  near(boxMin.min.z, 0.0, 1e-3, "AGF rests on ground z = 0");
  near(boxMin.max.z, AGF_SPECS.collapsedMastHeightM, 1e-3, "AGF collapsed mast === 2.160 m (< 2.28 m door)");

  // Freelift max (1.700 m): outer mast stays 2.160 m (< 2.28 m door!)
  agf.update({ forkHeightM: AGF_SPECS.freeliftMaxZ });
  agf.root.updateMatrixWorld(true);
  const boxFreelift = new THREE.Box3().setFromObject(agf.root);
  assert.ok(boxFreelift.max.z <= 2.165, `freelift max.z (${boxFreelift.max.z}) <= 2.165 (< 2.28 door)`);
  near(agf.stage2Group.position.z, 0.0, 1e-6);
  near(agf.stage3Group.position.z, 0.0, 1e-6);

  // Full telescopic lift (7.250 m)
  agf.update({ forkHeightM: AGF_SPECS.forkMaxZ, sideShiftM: 0.25, mastTiltRad: 0.5, steerAngleRad: 3.0 });
  const stagesMax = computeMastStages(AGF_SPECS.forkMaxZ);
  near(agf.stage2Group.position.z, stagesMax.stage2Offset, 1e-6);
  near(agf.stage3Group.position.z, stagesMax.stage3Offset, 1e-6);
  near(agf.sideShiftM, AGF_SPECS.sideShiftMaxM, 1e-6, "sideShift clamped +0.100");
  near(agf.mastTiltRad, AGF_SPECS.mastTiltBackRad, 1e-6, "mastTilt clamped +5 deg");
  near(agf.steerAngleRad, AGF_SPECS.maxSteerRad, 1e-6, "steerAngle clamped +82 deg");

  // Reset tilt/shift & verify supportSurfaceZ cargoMount threading
  agf.update({ sideShiftM: 0, mastTiltRad: 0, steerAngleRad: 0 });
  const wp = new THREE.Vector3();

  agf.update({ forkHeightM: 0.045, supportSurfaceZ: 0.0 });
  agf.root.updateMatrixWorld(true);
  agf.cargoMount.getWorldPosition(wp);
  near(wp.z, 0.000, 1e-6, "ground forkHeight=0.045 -> cargoMount z=0.000");

  agf.update({ forkHeightM: 0.250, supportSurfaceZ: 0.0 });
  agf.root.updateMatrixWorld(true);
  agf.cargoMount.getWorldPosition(wp);
  near(wp.z, 0.127, 1e-6, "ground forkHeight=0.250 -> cargoMount z=0.127");

  agf.update({ forkHeightM: 0.425, supportSurfaceZ: 0.380 });
  agf.root.updateMatrixWorld(true);
  agf.cargoMount.getWorldPosition(wp);
  near(wp.z, 0.380, 1e-6, "stand forkHeight=0.425, surf=0.380 -> cargoMount z=0.380");

  agf.update({ forkHeightM: 0.550, supportSurfaceZ: 0.380 });
  agf.root.updateMatrixWorld(true);
  agf.cargoMount.getWorldPosition(wp);
  near(wp.z, 0.427, 1e-6, "stand forkHeight=0.550, surf=0.380 -> cargoMount z=0.427");

  agf.update({ forkHeightM: 7.250, supportSurfaceZ: 7.050 });
  agf.root.updateMatrixWorld(true);
  agf.cargoMount.getWorldPosition(wp);
  near(wp.z, 7.127, 1e-6, "L3 rack forkHeight=7.250, surf=7.050 -> cargoMount z=7.127");

  // Null / partial update safety
  agf.update(null);
  agf.update(undefined);
  agf.update({ dt: 0.016, statusMode: "transit" });

  // Mount all 9 stowed deployable WCIDs
  for (const wcid of ALL_9_WCIDS) {
    agf.update({ carriedWcid: wcid, forkHeightM: 0.250, supportSurfaceZ: 0.0 });
    assert.equal(agf.cargoMount.children.length, 1);
    agf.root.updateMatrixWorld(true);
    const cb = new THREE.Box3().setFromObject(agf.mountedCargo.model.root);
    near(cb.min.z, 0.127, 1e-3, `AGF WCID ${wcid} bottom at 0.127 m`);
    near((cb.min.y + cb.max.y) * 0.5, AGF_SPECS.cargoCenterY, 5e-3, `AGF WCID ${wcid} centered at Y=0.700`);
  }

  const spy = spyDisposal(agf.root);
  agf.dispose();
  assert.ok(spy.geoms.every((g) => g.disposed), "AGF geoms disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "AGF mats disposed");
});

check("T_WM_05 Underride AMR bounds, keepCargoHeading turntable world lock & 9 WCIDs", () => {
  const amr = buildAmrUnderride(THREE);
  amr.root.updateMatrixWorld(true);

  const boxLow = new THREE.Box3().setFromObject(amr.root);
  near(boxLow.max.x - boxLow.min.x, AMR_SPECS.widthM, 1e-3, "AMR width 0.780 m");
  near(boxLow.max.y - boxLow.min.y, AMR_SPECS.lengthM, 1e-3, "AMR length 1.040 m");
  near(boxLow.min.z, 0.0, 1e-3, "AMR sits on z = 0");
  near(boxLow.max.z, AMR_SPECS.loweredHeightM, 1e-3, "AMR lowered platen 0.260 m (< 0.360 m tunnel)");

  amr.update({ liftHeightM: AMR_SPECS.raisedHeightM, statusMode: "lifting" });
  amr.root.updateMatrixWorld(true);
  const boxHigh = new THREE.Box3().setFromObject(amr.root);
  near(boxHigh.max.z, AMR_SPECS.raisedHeightM, 1e-3, "AMR raised platen 0.450 m (> 0.380 m rails)");

  // keepCargoHeading sign convention check with stepAmrKinematics
  let kin = { x: 0, y: 0, heading: 0.0, liftHeightM: 0.450, turntableYawRad: 0.0, heldCargoHeading: 0.0 };
  const targetEast = { x: 3.0, y: 0.0, heading: Math.PI * 0.5 };
  const qWorld = new THREE.Quaternion();
  const qIdent = new THREE.Quaternion();
  for (let i = 0; i < 60; i++) {
    kin = stepAmrKinematics(kin, { targetPose: targetEast, keepCargoHeading: true, heldCargoHeading: 0.0 }, 1 / 60);
    amr.root.position.set(kin.x, kin.y, 0);
    amr.root.rotation.z = -kin.heading;
    amr.update(kin);
    amr.root.updateMatrixWorld(true);
    amr.cargoMount.getWorldQuaternion(qWorld);
    const dot = Math.abs(qWorld.dot(qIdent));
    near(dot, 1.0, 1e-5, `keepCargoHeading world quaternion stays identity at step ${i}`);
  }

  // Mount all 9 stowed deployable WCIDs
  amr.root.position.set(0, 0, 0);
  amr.root.rotation.z = 0;
  amr.update({ turntableYawRad: 0, liftHeightM: AMR_SPECS.raisedHeightM });
  for (const wcid of ALL_9_WCIDS) {
    amr.update({ carriedWcid: wcid });
    assert.equal(amr.cargoMount.children.length, 1);
    amr.root.updateMatrixWorld(true);
    const cb = new THREE.Box3().setFromObject(amr.mountedCargo.model.root);
    near(cb.min.z, AMR_SPECS.raisedHeightM, 1e-3, `AMR WCID ${wcid} rests on raised platen 0.450 m`);
  }

  const spy = spyDisposal(amr.root);
  amr.dispose();
  assert.ok(spy.geoms.every((g) => g.disposed), "AMR geoms disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "AMR mats disposed");
});

check("T_WM_06 Infra: Apron polygonOffset, TransferStand tunnel, LiftTable split-rail & Chargers", () => {
  const layout = buildDefaultHubLayout();
  const apron = buildConcreteApron(THREE, layout);
  apron.root.updateMatrixWorld(true);
  const apronBox = new THREE.Box3().setFromObject(apron.slabMesh);
  near(apronBox.max.z, NE_FLATLAND_SITE.apronVisualZ, 1e-4, "apron slab top === +0.004 m");
  assert.equal(apron.slabMesh.material.polygonOffset, true);
  assert.equal(apron.markMesh.material.polygonOffset, true);
  assert.equal(apron.fidMesh.material.polygonOffset, true);

  // Single Transfer Stand tunnel & dimensions
  const stand = buildTransferStand(THREE);
  stand.root.updateMatrixWorld(true);
  const standBox = new THREE.Box3().setFromObject(stand.root);
  near(standBox.max.x - standBox.min.x, STAND_SPECS.outerWidthM, 1e-3, "Stand outerWidth 1.280");
  near(standBox.max.y - standBox.min.y, STAND_SPECS.outerDepthM, 1e-3, "Stand outerDepth 1.140");
  // Verify central tunnel x in (-0.430, +0.430), z in (0, 0.360) has zero vertices
  const stPos = stand.instMesh.geometry.getAttribute("position");
  for (let i = 0; i < stPos.count; i++) {
    const vx = stPos.getX(i);
    const vz = stPos.getZ(i);
    const inTunnel = Math.abs(vx) < STAND_SPECS.railInnerX - 1e-4 && vz < STAND_SPECS.tunnelHeightM - 1e-4;
    assert.equal(inTunnel, false, `Stand vertex (${vx}, ${vz}) must not intrude into AMR tunnel`);
  }

  // TransferStandGroup mounting & highlighting
  const standGroup = buildTransferStandGroup(THREE, layout.stands, { origin: layout.origin });
  for (let i = 0; i < ALL_9_WCIDS.length; i++) {
    const entry = standGroup.setSlotCargo(i, ALL_9_WCIDS[i]);
    assert.ok(entry && entry.model?.root);
  }
  assert.equal(standGroup.setHighlighted("S1", "target"), true);
  assert.ok(countDrawCalls(standGroup.root) >= 2);
  assert.equal(standGroup.setHighlighted(null, null), false);

  // Scissor Lift Table lowered & raised bounds + central tunnel clearance + all 9 WCIDs
  const lift = buildScissorLiftTable(THREE);
  lift.root.updateMatrixWorld(true);
  const liftLowBox = new THREE.Box3().setFromObject(lift.root);
  near(liftLowBox.max.x - liftLowBox.min.x, LIFT_TABLE_SPECS.outerWidthM, 1e-3, "Lift outerWidth 1.340");
  near(liftLowBox.max.y - liftLowBox.min.y, LIFT_TABLE_SPECS.outerDepthM, 1e-3, "Lift outerDepth 1.300");
  near(liftLowBox.min.z, 0.0, 1e-4, "Lift lowered min.z === 0.000");

  lift.update({ heightM: LIFT_TABLE_SPECS.raisedZ, statusMode: "ready", highlightState: null });
  lift.root.updateMatrixWorld(true);
  const liftHighBox = new THREE.Box3().setFromObject(lift.root);
  near(liftHighBox.max.z, LIFT_TABLE_SPECS.raisedZ, 1e-3, "Lift raised max.z === 0.380");

  assert.equal(lift.setHighlighted("reachable"), true);
  assert.ok(countDrawCalls(lift.root) > 4);
  assert.equal(lift.setHighlighted(null), false);

  // Verify split-rail deck leaves central tunnel x in (-0.430, +0.430) open
  const deckPos = lift.liftDeckGroup.getObjectByName("lift-deck-mesh").geometry.getAttribute("position");
  for (let i = 0; i < deckPos.count; i++) {
    assert.ok(
      Math.abs(deckPos.getX(i)) >= LIFT_TABLE_SPECS.railInnerX - 1e-4,
      `Lift deck vertex X=${deckPos.getX(i)} must stay outside central ±0.430 m AMR tunnel`
    );
  }

  for (const wcid of ALL_9_WCIDS) {
    lift.update({ heightM: LIFT_TABLE_SPECS.raisedZ, carriedWcid: wcid, highlightState: null });
    lift.root.updateMatrixWorld(true);
    const cb = new THREE.Box3().setFromObject(lift.mountedCargo.model.root);
    near(cb.min.z, LIFT_TABLE_SPECS.raisedZ, 1e-3, `Lift WCID ${wcid} rests at raised 0.380 m`);
  }

  // Charging docks
  const dock = buildChargingDock(THREE);
  assert.equal(dock.setState("charging"), true);
  const dockGroup = buildChargingDockGroup(THREE, layout.chargers, { origin: layout.origin });
  assert.equal(dockGroup.setDockState("CH1", "charging"), true);
  assert.equal(dockGroup.setDockState(3, "fault"), true);

  for (const obj of [apron, stand, standGroup, lift, dock, dockGroup]) {
    const spy = spyDisposal(obj.root);
    obj.dispose();
    assert.ok(spy.geoms.every((g) => g.disposed), `${obj.root.name} geoms disposed`);
    assert.ok(spy.mats.every((m) => m.disposed), `${obj.root.name} mats disposed`);
  }
});

check("T_WM_07 Full WebGL2 render pass across combined warehouse scene (0 errors)", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const layout = buildDefaultHubLayout();
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));

  try {
    const apron = buildConcreteApron(THREE, layout, { csmState: fakeCsm });
    const rack = buildRackRow(THREE, { id: "R1", bayCount: 4, doubleSided: true }, { csmState: fakeCsm });
    rack.root.position.set(layout.origin[0] - 16, layout.origin[1], 0);
    rack.loadSlot(0, 1, 0, 0, 4000017);
    rack.loadSlot(1, 2, 1, 1, 4000002);

    const agf = buildAgfForklift(THREE, { csmState: fakeCsm });
    agf.root.position.set(layout.origin[0] - 8, layout.origin[1] + 3, 0);
    agf.update({ forkHeightM: 2.45, carriedWcid: 4000014, statusMode: "lifting" });

    const amr = buildAmrUnderride(THREE, { csmState: fakeCsm });
    amr.root.position.set(layout.origin[0] - 4, layout.origin[1] - 25, 0);
    amr.update({ liftHeightM: 0.45, turntableYawRad: 0.4, carriedWcid: 4000010, statusMode: "transit" });

    const stands = buildTransferStandGroup(THREE, layout.stands, { origin: layout.origin, csmState: fakeCsm });
    stands.setSlotCargo(0, 4000012);
    const chargers = buildChargingDockGroup(THREE, layout.chargers, { origin: layout.origin, csmState: fakeCsm });
    chargers.setDockState(0, "charging");
    const lift = buildScissorLiftTable(THREE, { csmState: fakeCsm });
    lift.root.position.set(layout.origin[0] - 46, layout.origin[1] - 14, 0);
    lift.update({ heightM: 0.38, carriedWcid: 4000011, statusMode: "ready" });

    const scene = new THREE.Scene();
    scene.add(apron.root, rack.root, agf.root, amr.root, stands.root, chargers.root, lift.root);

    const gl = createFakeWebGL2({ maxTextures: 16 });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const camera = new THREE.PerspectiveCamera(60, 1.33, 0.1, 1000);
    camera.position.set(layout.origin[0], layout.origin[1] - 45, 22);
    camera.lookAt(layout.origin[0], layout.origin[1], 0);

    gl.__fake.reset();
    renderer.render(scene, camera);

    const c = gl.__fake.counts;
    const totalDraws =
      (c.drawArrays || 0) +
      (c.drawElements || 0) +
      (c.drawArraysInstanced || 0) +
      (c.drawElementsInstanced || 0);
    assert.ok(totalDraws > 0, `WebGL2 emitted ${totalDraws} draw calls`);
    assert.equal(gl.__fake.unitConflicts, 0, "0 GL texture unit conflicts");
    assert.equal(gl.__fake.uboErrors, 0, "0 GL UBO errors");
    assert.equal(errors.length, 0, `console errors: ${errors.join(" | ")}`);

    // Also render rack with >120m LOD proxy active
    rack.setCargoLodDistance(200);
    gl.__fake.reset();
    renderer.render(scene, camera);
    const lodDraws =
      (gl.__fake.counts.drawArrays || 0) +
      (gl.__fake.counts.drawElements || 0) +
      (gl.__fake.counts.drawArraysInstanced || 0) +
      (gl.__fake.counts.drawElementsInstanced || 0);
    assert.ok(lodDraws > 0, `WebGL2 emitted ${lodDraws} draw calls with LOD proxy`);
    assert.equal(errors.length, 0);

    for (const obj of [apron, rack, agf, amr, stands, chargers, lift]) {
      scene.remove(obj.root);
      obj.dispose();
    }
    renderer.dispose();
  } finally {
    console.error = origError;
  }
});

check("T_WM_08 Regression: makeLampsMaterial + CSM bound GLSL retains emissive * vColor.rgb and _csmShadowFactor", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const layout = buildDefaultHubLayout();
  const agf = buildAgfForklift(THREE, { csmState: fakeCsm });
  const amr = buildAmrUnderride(THREE, { csmState: fakeCsm });
  const lift = buildScissorLiftTable(THREE, { csmState: fakeCsm });
  const chargers = buildChargingDockGroup(THREE, layout.chargers, { origin: [0, 0, 0], useLocalPos: true, csmState: fakeCsm });

  const shaderTypes = new Map();
  const shaderSources = new Map();
  const programShaders = new Map();
  let currentProgram = null;
  let activeMeshName = null;
  const boundFsByMesh = new Map();

  const gl = createFakeWebGL2({
    maxTextures: 16,
    onCall(name, args) {
      if (name === "shaderSource") {
        shaderSources.set(args[0], String(args[1]));
      } else if (name === "attachShader") {
        const list = programShaders.get(args[0]) || [];
        list.push(args[1]);
        programShaders.set(args[0], list);
      } else if (name === "useProgram") {
        currentProgram = args[0];
      } else if (
        (name === "drawArrays" ||
          name === "drawElements" ||
          name === "drawArraysInstanced" ||
          name === "drawElementsInstanced") &&
        activeMeshName
      ) {
        const shaders = programShaders.get(currentProgram) || [];
        const fsSources = shaders
          .filter((sh) => shaderTypes.get(sh) === gl.FRAGMENT_SHADER)
          .map((sh) => shaderSources.get(sh) || "");
        const prev = boundFsByMesh.get(activeMeshName) || [];
        prev.push(...fsSources);
        boundFsByMesh.set(activeMeshName, prev);
      }
    },
  });
  const origCreateShader = gl.createShader.bind(gl);
  gl.createShader = (type) => {
    const sh = origCreateShader(type);
    shaderTypes.set(sh, type);
    return sh;
  };

  // Verify customProgramCacheKey separates lamp materials from plain PBR+CSM materials
  const chMat = agf.root.getObjectByName("agf-chassis-mesh").material;
  const hullMat = amr.root.getObjectByName("amr-hull-mesh").material;
  const baseMat = lift.root.getObjectByName("lift-base-mesh").material;
  assert.notEqual(agf.lampsMat.customProgramCacheKey(), chMat.customProgramCacheKey());
  assert.notEqual(amr.statusMat.customProgramCacheKey(), hullMat.customProgramCacheKey());
  assert.notEqual(lift.beaconMat.customProgramCacheKey(), baseMat.customProgramCacheKey());

  const targetMeshes = [
    ["agf-lamps-mesh", agf.root.getObjectByName("agf-lamps-mesh")],
    ["amr-status-bar-mesh", amr.root.getObjectByName("amr-status-bar-mesh")],
    ["lift-beacon-mesh", lift.root.getObjectByName("lift-beacon-mesh")],
    ["charging-docks-led-instanced", chargers.ledMesh],
  ];
  for (const [name, mesh] of targetMeshes) {
    assert.ok(mesh, `expected mesh ${name}`);
    mesh.onBeforeRender = () => { activeMeshName = name; };
    mesh.onAfterRender = () => { activeMeshName = null; };
  }

  const scene = new THREE.Scene();
  // Add PBR chassis/hull/base meshes first so plain CSM programs compile & cache before lamp meshes
  scene.add(agf.root, amr.root, lift.root, chargers.root);

  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const camera = new THREE.PerspectiveCamera(60, 1.33, 0.1, 200);
  camera.position.set(0, -15, 10);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);

  for (const [name] of targetMeshes) {
    const fsList = boundFsByMesh.get(name) || [];
    assert.ok(fsList.length > 0, `${name} must issue at least one draw call`);
    for (const fs of fsList) {
      assert.ok(fs.includes("emissive * vColor.rgb"), `${name} bound FS must retain emissive * vColor.rgb`);
      assert.ok(fs.includes("_csmShadowFactor"), `${name} bound FS must retain _csmShadowFactor`);
    }
  }

  for (const obj of [agf, amr, lift, chargers]) {
    scene.remove(obj.root);
    obj.dispose();
  }
  renderer.dispose();
});

check("T_WM_09 Regression: AGF fork & shank geometry has 0 triangle AABB overlaps with ISO 6780 pallet", () => {
  const extractTriangleAabbs = (mesh) => {
    const pos = mesh.geometry.getAttribute("position");
    const idx = mesh.geometry.getIndex();
    const m = mesh.matrixWorld;
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const out = [];
    const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      v0.fromBufferAttribute(pos, i0).applyMatrix4(m);
      v1.fromBufferAttribute(pos, i1).applyMatrix4(m);
      v2.fromBufferAttribute(pos, i2).applyMatrix4(m);
      out.push({
        minX: Math.min(v0.x, v1.x, v2.x),
        maxX: Math.max(v0.x, v1.x, v2.x),
        minY: Math.min(v0.y, v1.y, v2.y),
        maxY: Math.max(v0.y, v1.y, v2.y),
        minZ: Math.min(v0.z, v1.z, v2.z),
        maxZ: Math.max(v0.z, v1.z, v2.z),
      });
    }
    return out;
  };
  const countAabbOverlaps = (trisA, trisB) => {
    let overlaps = 0;
    for (const a of trisA) {
      for (const b of trisB) {
        if (
          a.minX <= b.maxX && a.maxX >= b.minX &&
          a.minY <= b.maxY && a.maxY >= b.minY &&
          a.minZ <= b.maxZ && a.maxZ >= b.minZ
        ) {
          overlaps++;
        }
      }
    }
    return overlaps;
  };

  const agf = buildAgfForklift(THREE);
  const pallet = buildPallet(THREE, "standard", { stowed: true });
  pallet.root.position.set(0, AGF_SPECS.cargoCenterY, 0);

  for (const [forkH, surfZ] of [
    [0.085, 0.0],
    [0.105, 0.0],
    [0.465, 0.380],
    [2.435, 2.350],
  ]) {
    agf.update({ forkHeightM: forkH, supportSurfaceZ: surfZ, carriedWcid: 0 });
    agf.root.updateMatrixWorld(true);
    pallet.root.position.set(0, AGF_SPECS.cargoCenterY, surfZ);
    pallet.root.updateMatrixWorld(true);

    const forkMesh = agf.root.getObjectByName("agf-carriage-forks-mesh");
    const forkTris = extractTriangleAabbs(forkMesh);
    const palletTris = [];
    pallet.root.traverse((o) => {
      if (o.isMesh) palletTris.push(...extractTriangleAabbs(o));
    });
    const overlaps = countAabbOverlaps(forkTris, palletTris);
    assert.equal(overlaps, 0, `forkHeightM=${forkH}, supportSurfaceZ=${surfZ} must have 0 fork-vs-pallet overlaps (got ${overlaps})`);
  }

  // Also test mounted stowed cargo via agf.update({ carriedWcid }) at forkHeightM=0.085
  agf.update({ forkHeightM: 0.085, supportSurfaceZ: 0.0, carriedWcid: 4000010 });
  agf.root.updateMatrixWorld(true);
  const forkMesh = agf.root.getObjectByName("agf-carriage-forks-mesh");
  const forkTris = extractTriangleAabbs(forkMesh);
  const mountedTris = [];
  agf.mountedCargo.model.root.traverse((o) => {
    if (o.isMesh) mountedTris.push(...extractTriangleAabbs(o));
  });
  assert.equal(countAabbOverlaps(forkTris, mountedTris), 0, "mounted deployable at forkHeightM=0.085 must have 0 fork overlaps");

  pallet.dispose();
  agf.dispose();
});

check("T_WM_10 Regression: Rack loadSlot preserves active >120 m LOD when replacing single occupied slot", () => {
  const rack = buildRackRow(THREE, { id: "R-LOD", bayCount: 4, doubleSided: true });
  rack.loadSlot(0, 0, 0, 0, 4000010);
  assert.equal(rack.setCargoLodDistance(300), true);
  assert.equal(rack.isLodActive, true);
  assert.equal(rack.cargoGroup.visible, false);
  assert.equal(rack.proxyMesh.count, 1);

  // Replace the single occupied slot with a new WCID while >120 m LOD is active
  const replaced = rack.loadSlot(0, 0, 0, 0, 4000017);
  assert.ok(replaced && replaced.wcid === 4000017);
  assert.equal(rack.isLodActive, true, "replacing single slot must preserve isLodActive === true");
  assert.equal(rack.cargoGroup.visible, false, "cargoGroup.visible must remain false in LOD mode");
  assert.equal(rack.proxyMesh.parent, rack.root, "proxyMesh must remain attached");
  assert.equal(rack.proxyMesh.visible, true, "proxyMesh.visible must remain true");
  assert.equal(rack.proxyMesh.count, 1, "proxyMesh.count must remain 1");

  // Explicit unload to 0 occupied slots should cleanly exit LOD mode
  assert.equal(rack.unloadSlot(0, 0, 0, 0), true);
  assert.equal(rack.isLodActive, false);
  assert.equal(rack.cargoGroup.visible, true);
  assert.equal(rack.proxyMesh.parent, null);

  rack.dispose();
});

check("T_WM_11 Regression: setCargoLodDistance matches AC cameraPos under worldRoot.rotation.x = -PI/2 and 0", () => {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const hubRoot = new THREE.Group();
  worldRoot.add(hubRoot);

  const rack = buildRackRow(THREE, { id: "R-ROT", bayCount: 8, doubleSided: true });
  rack.root.position.set(44820, 46950, 0);
  rack.root.rotation.z = -Math.PI * 0.5;
  hubRoot.add(rack.root);
  rack.loadSlot(0, 0, 0, 0, 4000010);

  scene.updateMatrixWorld(true);
  assert.equal(rack.setCargoLodDistance([44825.2, 46948.4, 4.65]), false, "rotated worldRoot: near AC camera must disable LOD");
  assert.equal(rack.isLodActive, false);
  assert.equal(rack.cargoGroup.visible, true);
  assert.equal(rack.proxyMesh.visible, false);
  assert.equal(rack.proxyMesh.parent, null);

  assert.equal(rack.setCargoLodDistance([44825.2, 46948.4 + 200, 4.65]), true, "rotated worldRoot: >120m AC camera must enable LOD");
  assert.equal(rack.isLodActive, true);
  assert.equal(rack.cargoGroup.visible, false);
  assert.equal(rack.proxyMesh.visible, true);
  assert.equal(rack.proxyMesh.parent, rack.root);

  worldRoot.rotation.x = 0;
  scene.updateMatrixWorld(true);
  assert.equal(rack.setCargoLodDistance([44825.2, 46948.4, 4.65]), false, "unrotated worldRoot: near AC camera must disable LOD");
  assert.equal(rack.setCargoLodDistance([44825.2, 46948.4 + 200, 4.65]), true, "unrotated worldRoot: >120m AC camera must enable LOD");

  rack.dispose();

  // Also cover Scene -> translated hubRoot([44832, 46944, 0]) -> rack.root without worldRoot
  const sceneNoWr = new THREE.Scene();
  const hubOnly = new THREE.Group();
  hubOnly.position.set(44832, 46944, 0);
  sceneNoWr.add(hubOnly);
  const rackNoWr = buildRackRow(THREE, { id: "R-NO-WR", bayCount: 8, doubleSided: true });
  rackNoWr.root.position.set(-6.35, 4.0, 0);
  hubOnly.add(rackNoWr.root);
  rackNoWr.loadSlot(0, 0, 0, 0, 4000010);
  sceneNoWr.updateMatrixWorld(true);
  const wc = new THREE.Vector3();
  rackNoWr.root.getWorldPosition(wc);
  assert.equal(rackNoWr.setCargoLodDistance([wc.x, wc.y - 10, 3.8]), false, "translated hubRoot under Scene without worldRoot: near10 must disable LOD");
  assert.equal(rackNoWr.setCargoLodDistance([wc.x, wc.y - 200, 3.8]), true, "translated hubRoot under Scene without worldRoot: far200 must enable LOD");
  rackNoWr.dispose();
});

console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
