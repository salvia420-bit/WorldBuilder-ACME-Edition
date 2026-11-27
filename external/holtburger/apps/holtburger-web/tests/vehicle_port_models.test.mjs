// tests/vehicle_port_models.test.mjs — Marine Container Terminal Procedural 3D Models Suite (B2)
// Covers: port_quay_model, port_sts_crane_model, port_yard_crane_model (RMG/RTG + ContainerStackPool),
// and port_shuttle_model.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  manifest as quayManifest,
  buildPortQuay,
} from "../scene3d/vehicle/port_quay_model.js";
import {
  manifest as stsManifest,
  buildStsCrane,
} from "../scene3d/vehicle/port_sts_crane_model.js";
import {
  manifest as yardCraneManifest,
  buildYardCrane,
  buildRmgCrane,
  buildRtgCrane,
  createContainerStackPool,
  buildCompactIsoContainer,
} from "../scene3d/vehicle/port_yard_crane_model.js";
import {
  manifest as shuttleManifest,
  buildPortShuttle,
} from "../scene3d/vehicle/port_shuttle_model.js";
import {
  PORT_ORIGIN,
  PORT_SITE,
  PORT_CONTAINER_WCID,
  PORT_LIVERY_KEYS,
  ISO_CONTAINERS,
  QUAY_SPECS,
  STS_CRANE_SPECS,
  YARD_CRANE_SPECS,
  YARD_BLOCK_SPECS,
  SHUTTLE_SPECS,
  quayRampZ,
  quayRampPitch,
  buildPortLayout,
} from "../scene3d/vehicle/port_specs.js";
import {
  createStsCraneState,
  stepStsCrane,
  createYardCraneState,
  stepYardCrane,
  createShuttleState,
  createYardStackStore,
} from "../scene3d/vehicle/port_kinematics.js";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : e}`);
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
      assert.ok(m.isMeshStandardMaterial, `${label} ${o.name} must use MeshStandardMaterial`);
      assert.equal(m.userData?.csmEnabled, true, `${label} ${o.name} csmEnabled === true`);
    }
  });
}

console.log("=== Marine Container Terminal Procedural 3D Models Suite (B2) ===");

check("T_PM_01 Deterministic manifests, lintManifest() & lintSource() across all 4 port model modules", () => {
  const entries = [
    [quayManifest, "scene3d/vehicle/port_quay_model.js", "vfx-port-quay-model"],
    [stsManifest, "scene3d/vehicle/port_sts_crane_model.js", "vfx-port-sts-crane-model"],
    [yardCraneManifest, "scene3d/vehicle/port_yard_crane_model.js", "vfx-port-yard-crane-model"],
    [shuttleManifest, "scene3d/vehicle/port_shuttle_model.js", "vfx-port-shuttle-model"],
  ];

  for (const [m, rel, expectedId] of entries) {
    assert.equal(m.id, expectedId);
    assert.equal(m.channel, "vehicleModel");
    assert.equal(m.deterministic, true);
    assert.equal(m.lightCountDelta, 0);
    assert.equal(m.cacheKeyScope, "set");
    const mHits = lintManifest(m);
    assert.equal(mHits.length, 0, `${rel} lintManifest hits: ${JSON.stringify(mHits)}`);
    const src = readFileSync(join(ROOT, rel), "utf8");
    const sHits = lintSource(src);
    assert.equal(sHits.length, 0, `${rel} lintSource hits: ${JSON.stringify(sHits)}`);
  }
});

check("T_PM_02 Draw-call budgets, 0 dynamic lights & CSM shader patching across all port models", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const layout = buildPortLayout();

  const quay = buildPortQuay(THREE, layout, { csmState: fakeCsm });
  const sts = buildStsCrane(THREE, { csmState: fakeCsm });
  const rmg = buildRmgCrane(THREE, { csmState: fakeCsm });
  const rtg = buildRtgCrane(THREE, { csmState: fakeCsm });
  const pool = createContainerStackPool(THREE, { maxInstances: 260, csmState: fakeCsm });
  const shuttle = buildPortShuttle(THREE, { csmState: fakeCsm });

  const quayDc = countDrawCalls(quay.root);
  const stsDc = countDrawCalls(sts.root);
  const rmgDc = countDrawCalls(rmg.root);
  const rtgDc = countDrawCalls(rtg.root);
  const poolDc = countDrawCalls(pool.root);
  const shuttleDc = countDrawCalls(shuttle.root);

  assert.ok(quayDc <= QUAY_SPECS.maxDrawCalls, `Quay DC (${quayDc}) <= ${QUAY_SPECS.maxDrawCalls}`);
  assert.ok(stsDc <= STS_CRANE_SPECS.maxDrawCalls, `STS DC (${stsDc}) <= ${STS_CRANE_SPECS.maxDrawCalls}`);
  assert.ok(rmgDc <= YARD_CRANE_SPECS.maxDrawCalls, `RMG DC (${rmgDc}) <= ${YARD_CRANE_SPECS.maxDrawCalls}`);
  assert.ok(rtgDc <= YARD_CRANE_SPECS.maxDrawCalls, `RTG DC (${rtgDc}) <= ${YARD_CRANE_SPECS.maxDrawCalls}`);
  assert.ok(poolDc <= YARD_CRANE_SPECS.stackPoolMaxDrawCalls, `Pool DC (${poolDc}) <= ${YARD_CRANE_SPECS.stackPoolMaxDrawCalls}`);
  assert.ok(shuttleDc <= SHUTTLE_SPECS.maxDrawCalls, `Shuttle DC (${shuttleDc}) <= ${SHUTTLE_SPECS.maxDrawCalls}`);

  // Even WITH carried containers mounted, STS <= 14, RMG/RTG <= 12, Shuttle <= 10!
  sts.update({ carriedContainer: { wcid: 4000022, liveryId: 1 } });
  rmg.update({ carriedContainer: { wcid: 4000021, liveryId: 2 } });
  rtg.update({ carriedContainer: { wcid: 4000020, liveryId: 3, reefer: true } });
  shuttle.update({ cargo: { wcid: 4000022, liveryId: 4 } });

  assert.ok(countDrawCalls(sts.root) <= STS_CRANE_SPECS.maxDrawCalls, `STS loaded DC (${countDrawCalls(sts.root)}) <= 14`);
  assert.ok(countDrawCalls(rmg.root) <= YARD_CRANE_SPECS.maxDrawCalls, `RMG loaded DC (${countDrawCalls(rmg.root)}) <= 12`);
  assert.ok(countDrawCalls(rtg.root) <= YARD_CRANE_SPECS.maxDrawCalls, `RTG loaded DC (${countDrawCalls(rtg.root)}) <= 12`);
  assert.ok(countDrawCalls(shuttle.root) <= SHUTTLE_SPECS.maxDrawCalls, `Shuttle loaded DC (${countDrawCalls(shuttle.root)}) <= 10`);

  for (const obj of [quay, sts, rmg, rtg, pool, shuttle]) {
    assert.equal(countLights(obj.root), 0, `${obj.root.name} must have 0 dynamic THREE.Light instances`);
    assertCsmPatched(obj.root, obj.root.name);
  }

  // Verify makeLampsMaterial + installCsmShaderPatch chained onBeforeCompile & distinct cache keys
  for (const [label, lampsMat, plainMat] of [
    ["quay", quay.lampsMat, quay.quayMesh.material],
    ["sts", sts.lampsMat, sts.structMesh.material],
    ["rmg", rmg.lampsMat, rmg.structMesh.material],
    ["rtg", rtg.lampsMat, rtg.structMesh.material],
    ["shuttle", shuttle.lampsMat, shuttle.tractorMesh.material],
  ]) {
    assert.equal(lampsMat.onBeforeCompile.name, "chainedOnBeforeCompile", `${label} lampsMat must chain CSM`);
    assert.notEqual(lampsMat.customProgramCacheKey(), plainMat.customProgramCacheKey(), `${label} lamps cache key must differ from plain PBR`);
  }

  for (const obj of [quay, sts, rmg, rtg, pool, shuttle]) {
    obj.dispose();
  }
});

check("T_PM_03 Port Quay geometry: 400x46m deck (+2.0m), seawall (-2.5m), flush yard (+0.004m), 17 bollards, 25 fenders & disposal", () => {
  const layout = buildPortLayout(PORT_ORIGIN);
  const quay = buildPortQuay(THREE, layout);
  quay.root.updateMatrixWorld(true);

  near(quay.root.position.x, PORT_ORIGIN[0], 1e-4, "quay origin X");
  near(quay.root.position.y, PORT_ORIGIN[1], 1e-4, "quay origin Y");
  near(quay.root.position.z, PORT_ORIGIN[2], 1e-4, "quay origin Z");

  // Quay + seawall bounds
  const quayBox = new THREE.Box3().setFromObject(quay.quayMesh);
  near(quayBox.min.x, PORT_SITE.xMin, 0.05, "quay minX 44780");
  near(quayBox.max.x, PORT_SITE.xMax, 0.05, "quay maxX 45180");
  near(quayBox.min.y, PORT_SITE.rampMinY, 0.05, "quay ramp foot minY 47810");
  assert.ok(quayBox.max.y >= PORT_SITE.quayY - 0.01, "quay seawall reaches Y = 47880");
  near(quayBox.min.z, QUAY_SPECS.seawallBottomZ, 0.05, "caisson seawall extends down to -2.50 m");
  assert.ok(quayBox.max.z >= QUAY_SPECS.deckZ, "quay deck top >= +2.00 m");

  // Yard concrete apron flush at +0.004 m and butt-joined to warehouse at Y = 47670
  const yardBox = new THREE.Box3().setFromObject(quay.yardApronMesh);
  near(yardBox.min.y, PORT_SITE.yardMinY, 0.05, "yard apron flush with warehouse edge Y=47670");
  near(yardBox.max.y, PORT_SITE.rampMinY, 0.05, "yard apron joins ramp foot at Y=47810");
  near(yardBox.max.z, PORT_SITE.yardVisualZ, 1e-3, "yard apron visual Z === +0.004 m");
  assert.equal(quay.yardApronMesh.material.polygonOffset, true);
  assert.equal(quay.markingsMesh.material.polygonOffset, true);

  // Bollards (17x), Fenders (25x protruding to Y = 47881.2), High-mast floodlight towers (8x)
  assert.equal(quay.bollardsInst.count, 17, "17 T-head bollards");
  assert.equal(quay.fendersInst.count, 25, "25 marine cone fenders");
  assert.equal(quay.lightTowersInst.count, 8, "8 high-mast floodlight towers");

  const fenderGeomBox = new THREE.Box3().setFromBufferAttribute(quay.fendersInst.geometry.getAttribute("position"));
  near(fenderGeomBox.max.y, QUAY_SPECS.fenderDepthM, 0.02, "fender contact face extends +1.20 m seaward");

  // Deterministic update safety
  quay.update(null);
  quay.update({ timeSec: 1.0, nightFactor: 0.5 });
  const i1 = quay.lampsMat.emissiveIntensity;
  quay.update({ timeSec: 1.0, nightFactor: 0.5 });
  assert.equal(quay.lampsMat.emissiveIntensity, i1, "update() is deterministic");

  // Double-dispose idempotency & full disposal check
  const spy = spyDisposal(quay.root);
  quay.dispose();
  quay.dispose();
  assert.ok(spy.geoms.length > 0 && spy.geoms.every((g) => g.disposed), "all quay geometries disposed");
  assert.ok(spy.mats.length > 0 && spy.mats.every((m) => m.disposed), "all quay materials disposed");
});

check("T_PM_04 STS Gantry Crane 5-DOF articulation (boom 0<->80 deg, trolley, hoist, 20/40ft spreader, twistlocks, cargo)", () => {
  const sts = buildStsCrane(THREE);
  const st = createStsCraneState({ id: "STS-1", localX: -80.0 });
  sts.update(st);
  sts.root.updateMatrixWorld(true);

  near(sts.root.position.x, st.x, 1e-4, "STS root X");
  near(sts.root.position.y, st.y, 1e-4, "STS root Y");
  near(sts.root.position.z, STS_CRANE_SPECS.railZ, 1e-4, "STS root Z = 2.0 m");

  // Operational outreach over ship (trolleyY = +28 m, boomAngle = 0, spreaderZ = 10.0, 20ft spreader, twistlocks locked)
  sts.update({
    x: 44880.0,
    boomAngle: 0.0,
    trolleyY: +28.0,
    spreaderZ: 10.0,
    spreaderLen: STS_CRANE_SPECS.spreaderLen20M,
    twistlockAngle: Math.PI * 0.5,
    carriedContainer: { wcid: PORT_CONTAINER_WCID.IsoContainer20, liveryId: 0 },
  });
  sts.root.updateMatrixWorld(true);
  near(sts.boomPivot.rotation.x, 0.0, 1e-6, "boom operational at 0 deg");
  near(sts.trolleyGroup.position.y, 28.0, 1e-4, "trolley waterside outreach +28 m");
  near(sts.spreaderGroup.position.z, 8.0, 1e-4, "spreader local Z = 10.0 - 2.0 = 8.0 m");
  assert.ok(sts.hoistWiresMesh.scale.z > 10.0, "4-wire hoist reeving stretched down to spreader");

  // Check carried 20ft container world Z top aligns cleanly at state.spreaderZ = 10.0 m
  const cargoBox20 = new THREE.Box3().setFromObject(sts.mountedCargo.mesh);
  near(cargoBox20.max.z, 10.0, 0.05, "20ft carried container top flush at spreaderZ=10.0 m");
  near(cargoBox20.max.x - cargoBox20.min.x, ISO_CONTAINERS[4000020].extL, 0.06, "20ft container aligned E-W along X");
  near(cargoBox20.max.y - cargoBox20.min.y, ISO_CONTAINERS[4000020].extW, 0.06, "20ft container width along Y");

  // Telescope spreader to 40ft & carry 40HC
  const arm20X = sts.rightArmMesh.position.x;
  sts.update({
    spreaderLen: STS_CRANE_SPECS.spreaderLen40M,
    carriedContainer: { wcid: PORT_CONTAINER_WCID.IsoContainer40HC, liveryId: 2, reefer: true },
  });
  sts.root.updateMatrixWorld(true);
  assert.ok(sts.rightArmMesh.position.x > arm20X + 2.8, "spreader arms telescoped out from 20ft to 40ft");
  const cargoBox40 = new THREE.Box3().setFromObject(sts.mountedCargo.mesh);
  near(cargoBox40.max.x - cargoBox40.min.x, ISO_CONTAINERS[4000022].extL, 0.06, "40HC container aligned E-W along X");
  near(cargoBox40.max.z - cargoBox40.min.z, ISO_CONTAINERS[4000022].extH, 0.06, "40HC height 2.896 m");

  // Detach cargo & stow boom to 80 deg via stepStsCrane
  sts.update({ carriedContainer: null, trolleyY: 0.0, spreaderZ: 22.0, boomAngle: STS_CRANE_SPECS.boomStowedAngleRad });
  sts.root.updateMatrixWorld(true);
  assert.equal(sts.mountedCargo, null, "carriedContainer null detaches cargo");
  near(sts.boomPivot.rotation.x, STS_CRANE_SPECS.boomStowedAngleRad, 1e-4, "boom stowed at 80 deg");
  const boomBoxStowed = new THREE.Box3().setFromObject(sts.boomMesh);
  assert.ok(boomBoxStowed.max.z > 50.0, `stowed boom tips rise > 50 m (got ${boomBoxStowed.max.z.toFixed(2)})`);

  // Step through live kinematics
  stepStsCrane(st, { targetX: 44890.0, targetTrolleyY: 12.0, targetSpreaderZ: 14.0 }, 0.2);
  sts.update(st);
  sts.update(null);

  const spy = spyDisposal(sts.root);
  sts.dispose();
  assert.ok(spy.geoms.every((g) => g.disposed), "STS geoms disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "STS mats disposed");
});

check("T_PM_05 RMG & RTG Yard Cranes (30m span, 8 steered RTG tires 0<->90 deg, telescoping spreader & cargo)", () => {
  const rmg = buildYardCrane(THREE, "RMG");
  const rtg = buildYardCrane(THREE, "RTG");
  assert.equal(rmg.type, "RMG");
  assert.equal(rtg.type, "RTG");
  assert.equal(rtg.wheelsInst.count, 8, "RTG has 8 large steered rubber tires");
  assert.equal(rtg.bogiesInst.count, 4, "RTG has 4 steering bogie yokes");

  // Verify 30 m portal span
  rmg.root.updateMatrixWorld(true);
  const rmgBox = new THREE.Box3().setFromObject(rmg.structMesh);
  assert.ok(rmgBox.max.y - rmgBox.min.y >= 30.0, "RMG spans >= 30.0 m");

  // Verify RTG 90-degree bogie steering matrix rotation
  const m0 = new THREE.Matrix4();
  const m90 = new THREE.Matrix4();
  rtg.update({ wheelSteerRad: 0.0, wheelSpinRad: 0.0 });
  rtg.bogiesInst.getMatrixAt(0, m0);

  const rtgState = createYardCraneState({ type: "RTG", x: 44870, y: 47723, z: 0 });
  for (let i = 0; i < 60; i++) {
    stepYardCrane(rtgState, { targetY: 47730, targetTrolleyY: 8.5, targetSpreaderZ: 6.5 }, 1 / 30);
  }
  rtg.update(rtgState);
  rtg.bogiesInst.getMatrixAt(0, m90);
  near(rtg.wheelSteerRad, Math.PI * 0.5, 0.02, "RTG bogies rotated to 90 deg for lateral crabbing");
  assert.ok(Math.abs(m0.elements[0] - m90.elements[0]) > 0.9, "RTG bogie matrix rotated 90 deg");

  // Verify spreader telescoping & carried container on RMG
  rmg.update({
    x: 44870, y: 47781, z: 0,
    trolleyY: -6.0,
    spreaderZ: 9.0,
    spreaderLen: STS_CRANE_SPECS.spreaderLen20M,
    twistlockAngle: Math.PI * 0.5,
    carriedContainer: { wcid: 4000020, liveryId: 5 },
  });
  rmg.root.updateMatrixWorld(true);
  assert.ok(rmg.mountedCargo && rmg.mountedCargo.wcid === 4000020);
  const rmgCargoBox = new THREE.Box3().setFromObject(rmg.mountedCargo.mesh);
  near(rmgCargoBox.max.z, 9.0, 0.05, "RMG carried 20ft top aligns at spreaderZ = 9.0 m");

  for (const c of [rmg, rtg]) {
    const spy = spyDisposal(c.root);
    c.dispose();
    assert.ok(spy.geoms.every((g) => g.disposed), `${c.type} geoms disposed`);
    assert.ok(spy.mats.every((m) => m.disposed), `${c.type} mats disposed`);
  }
});

check("T_PM_06 Instanced Container Stack Pool: 240+ ISO containers in <= 6 DC, all 6 liveries, reefers, add/update/remove/cap", () => {
  const store = createYardStackStore(PORT_ORIGIN);
  let placedCount = 0;

  // Populate 240 containers across A1, A2, B1, B2, REEFER mixing 20ft, 40ft, 40HC, all 6 liveries & reefers
  const plan = [
    { block: "A1", bays: [2, 4, 6, 8, 10, 12], rows: [1, 2, 3, 4], tiers: [1, 2, 3], kind: "40ft" },    // 72 x 40ft
    { block: "A2", bays: [2, 4, 6, 8, 10], rows: [1, 2, 3, 4], tiers: [1, 2, 3], kind: "40hc" },        // 60 x 40HC
    { block: "B1", bays: [1, 3, 5, 7, 9, 11, 13, 15], rows: [1, 2, 3], tiers: [1, 2, 3], kind: "20ft" }, // 72 x 20ft
    { block: "B2", bays: [2, 4, 6], rows: [1, 2], tiers: [1, 2], kind: "40ft" },                         // 12 x 40ft
    { block: "REEFER", bays: [2, 4, 6, 8], rows: [1, 2, 3], tiers: [1, 2], kind: "40hc", reefer: true }, // 24 x 40HC reefer
  ];
  for (const p of plan) {
    for (const tier of p.tiers) {
      for (const row of p.rows) {
        for (const bay of p.bays) {
          const res = store.place(p.block, bay, row, tier, {
            containerKind: p.kind,
            liveryId: placedCount % PORT_LIVERY_KEYS.length,
            reefer: Boolean(p.reefer),
          });
          assert.equal(res.ok, true, `store.place failed: ${res.reason}`);
          placedCount++;
        }
      }
    }
  }
  assert.equal(placedCount, 240, "placed 240 valid ISO 9711 containers");

  const pool = createContainerStackPool(THREE, { maxInstances: 240, origin: PORT_ORIGIN });
  const stats = pool.syncFromEntries(store.list());
  assert.equal(stats.total, 240);
  assert.equal(stats.count20, 72);
  assert.equal(stats.count40, 168); // 72 + 60 + 12 + 24
  assert.equal(stats.count40Hc, 84); // 60 + 24
  assert.equal(stats.countReefer, 24);
  assert.equal(pool.count, 240);
  assert.ok(countDrawCalls(pool.root) <= 6, `Stack pool DC (${countDrawCalls(pool.root)}) <= 6 for 240 boxes`);

  // Verify maxInstances cap enforcement
  assert.equal(pool.add("OVERFLOW_241", { x: 44900, y: 47770, z: 0, wcid: 4000021 }), false, "cap rejects 241st container");
  assert.equal(pool.count, 240);

  // Verify remove() frees slot and add()/update() work cleanly
  const firstKey = store.list()[0].key;
  assert.equal(pool.remove(firstKey), true, "remove existing container");
  assert.equal(pool.count, 239);
  assert.equal(pool.remove("NON_EXISTENT"), false);
  assert.equal(pool.add("REPLACEMENT_BOX", { x: 44900, y: 47770, z: 0.004, wcid: 4000022, liveryId: 3, reefer: true }), true);
  assert.equal(pool.count, 240);
  assert.equal(pool.update("REPLACEMENT_BOX", { z: 2.90, liveryId: 5 }), true);
  assert.equal(pool.get("REPLACEMENT_BOX").z, 2.90);
  assert.equal(pool.update("MISSING", { z: 1.0 }), false);

  pool.clear();
  assert.equal(pool.count, 0);
  assert.equal(pool.meshes.body40Mesh.count, 0);
  assert.equal(pool.meshes.reeferMesh.count, 0);

  const spy = spyDisposal(pool.root);
  pool.dispose();
  assert.ok(spy.geoms.length === 6 && spy.geoms.every((g) => g.disposed), "all 6 pool geometries disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "all pool materials disposed");
});

check("T_PM_07 Port Shuttle articulation, ZYX ramp pitch alignment, deckZ=1.32m cargo mount & disposal", () => {
  const shuttle = buildPortShuttle(THREE);
  assert.equal(shuttle.root.rotation.order, "ZYX", "shuttle uses ZYX Euler order for yaw-then-pitch on ramp");
  near(shuttle.deckZ, 1.32, 1e-6, "shuttle deckZ === 1.32 m");

  shuttle.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(shuttle.root);
  near(box.max.y - box.min.y, SHUTTLE_SPECS.overallLengthM, 0.10, "shuttle overall length ~15.2 m");
  near(box.min.z, 0.0, 0.02, "shuttle tires rest on z = 0.0 m");

  // Verify ramp pitch orientation when climbing North (heading=0) vs descending South (heading=PI)
  const midRampY = 0.5 * (PORT_SITE.rampMinY + PORT_SITE.rampMaxY); // 47822.0
  const pitchNorth = quayRampPitch(midRampY, 0.0, PORT_ORIGIN);
  const pitchSouth = quayRampPitch(midRampY, Math.PI, PORT_ORIGIN);
  assert.ok(pitchNorth > 0.07, "climbing North has positive nose-up pitch");
  assert.ok(pitchSouth < -0.07, "descending South has negative nose-down pitch");

  // Climbing North (+Y): nose (+Y local) must be HIGHER in world Z than rear (-Y local)
  shuttle.update({ x: 44960, y: midRampY, z: quayRampZ(midRampY), heading: 0.0, pitch: pitchNorth, steerAngle: 0.25, wheelSpin: 1.5 });
  shuttle.root.updateMatrixWorld(true);
  const noseW = new THREE.Vector3(0, 7.0, 0).applyMatrix4(shuttle.root.matrixWorld);
  const rearW = new THREE.Vector3(0, -7.0, 0).applyMatrix4(shuttle.root.matrixWorld);
  assert.ok(noseW.z > rearW.z + 1.0, `climbing North lifts nose (+Z): noseZ=${noseW.z.toFixed(2)} > rearZ=${rearW.z.toFixed(2)}`);
  near(shuttle.frontLeftSteerPivot.rotation.z, -0.25, 1e-6, "front steer pivot tracks steerAngle");
  near(shuttle.frontLeftWheel.rotation.x, -1.5, 1e-6, "wheels roll with wheelSpin");

  // Descending South (-Y, heading=PI): rear (now pointing North uphill!) must be HIGHER in world Z than nose (pointing South downhill!)
  shuttle.update({ heading: Math.PI, pitch: pitchSouth, steerAngle: 0.0 });
  shuttle.root.updateMatrixWorld(true);
  const noseSouthW = new THREE.Vector3(0, 7.0, 0).applyMatrix4(shuttle.root.matrixWorld);
  const rearSouthW = new THREE.Vector3(0, -7.0, 0).applyMatrix4(shuttle.root.matrixWorld);
  assert.ok(rearSouthW.z > noseSouthW.z + 1.0, `descending South dips nose downhill: rearZ=${rearSouthW.z.toFixed(2)} > noseZ=${noseSouthW.z.toFixed(2)}`);

  // Cargo mounting flush at deckZ = 1.32 m
  const st = createShuttleState({ x: 0, y: 0, heading: 0 });
  shuttle.update({ ...st, x: 0, y: 0, z: 0, pitch: 0, steerAngle: 0, cargo: { wcid: 4000022, liveryId: 1, reefer: true } });
  shuttle.root.updateMatrixWorld(true);
  const cargoBox = new THREE.Box3().setFromObject(shuttle.mountedCargo.mesh);
  near(cargoBox.min.z, 1.32, 0.02, "mounted 40HC rests flush on deckZ = 1.32 m");
  near(cargoBox.max.z, 1.32 + ISO_CONTAINERS[4000022].extH, 0.03, "mounted 40HC top Z = 1.32 + 2.896 m");

  shuttle.update({ cargo: null });
  assert.equal(shuttle.mountedCargo, null, "cargo detached cleanly");

  // Sanity-check standalone compact container builder
  const compact = buildCompactIsoContainer(THREE, { wcid: 4000020, liveryId: 2 });
  assert.ok(compact.mesh.isMesh);
  compact.dispose();

  const spy = spyDisposal(shuttle.root);
  shuttle.dispose();
  assert.ok(spy.geoms.every((g) => g.disposed), "shuttle geoms disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "shuttle mats disposed");
});

check("T_PM_08 Full WebGL2 render pass across combined port terminal scene + CSM lamp shader verification (0 errors)", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const layout = buildPortLayout(PORT_ORIGIN);
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));

  try {
    const quay = buildPortQuay(THREE, layout, { csmState: fakeCsm });
    const sts = buildStsCrane(THREE, { csmState: fakeCsm });
    sts.update({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] - 14.5, z: 2.0, trolleyY: 16.0, spreaderZ: 12.0, carriedContainer: { wcid: 4000021, liveryId: 0 } });
    const rmg = buildRmgCrane(THREE, { csmState: fakeCsm });
    rmg.update({ x: PORT_ORIGIN[0] - 90, y: PORT_ORIGIN[1] - 99, z: 0, trolleyY: -4.0, spreaderZ: 8.5 });
    const rtg = buildRtgCrane(THREE, { csmState: fakeCsm });
    rtg.update({ x: PORT_ORIGIN[0] - 90, y: PORT_ORIGIN[1] - 157, z: 0, wheelSteerRad: 0.4, trolleyY: 2.0, spreaderZ: 9.0 });
    const pool = createContainerStackPool(THREE, { maxInstances: 64, origin: PORT_ORIGIN, csmState: fakeCsm });
    pool.add("C1", { x: PORT_ORIGIN[0] - 100, y: PORT_ORIGIN[1] - 110, z: 0.004, heading: Math.PI * 0.5, wcid: 4000020, liveryId: 0 });
    pool.add("C2", { x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] - 110, z: 0.004, heading: Math.PI * 0.5, wcid: 4000021, liveryId: 1 });
    pool.add("C3", { x: PORT_ORIGIN[0] + 102, y: PORT_ORIGIN[1] - 168, z: 0.004, heading: Math.PI * 0.5, wcid: 4000022, liveryId: 2, reefer: true });
    const shuttle = buildPortShuttle(THREE, { csmState: fakeCsm });
    shuttle.update({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] - 13, z: 2.0, heading: Math.PI * 0.5, cargo: { wcid: 4000022, liveryId: 4 } });

    const shaderTypes = new Map();
    const shaderSources = new Map();
    const programShaders = new Map();
    let currentProgram = null;
    let activeMeshName = null;
    const boundFsByMesh = new Map();

    const gl = createFakeWebGL2({
      maxTextures: 16,
      onCall(name, args) {
        if (name === "shaderSource") shaderSources.set(args[0], String(args[1]));
        else if (name === "attachShader") {
          const list = programShaders.get(args[0]) || [];
          list.push(args[1]);
          programShaders.set(args[0], list);
        } else if (name === "useProgram") currentProgram = args[0];
        else if (
          (name === "drawArrays" || name === "drawElements" || name === "drawArraysInstanced" || name === "drawElementsInstanced") &&
          activeMeshName
        ) {
          const shaders = programShaders.get(currentProgram) || [];
          const fsList = shaders
            .filter((sh) => shaderTypes.get(sh) === gl.FRAGMENT_SHADER)
            .map((sh) => shaderSources.get(sh) || "");
          const prev = boundFsByMesh.get(activeMeshName) || [];
          prev.push(...fsList);
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

    const lampTargets = [
      ["port-emissive-lamps-mesh", quay.lampsMesh],
      ["sts-beacons-mesh", sts.beaconsMesh],
      ["rmg-beacons-mesh", rmg.beaconsMesh],
      ["shuttle-lamps-mesh", shuttle.lampsMesh],
    ];
    for (const [label, mesh] of lampTargets) {
      mesh.onBeforeRender = () => { activeMeshName = label; };
      mesh.onAfterRender = () => { activeMeshName = null; };
    }

    const scene = new THREE.Scene();
    scene.add(quay.root, sts.root, rmg.root, rtg.root, pool.root, shuttle.root);

    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 2000);
    camera.position.set(PORT_ORIGIN[0], PORT_ORIGIN[1] - 260, 120);
    camera.lookAt(PORT_ORIGIN[0], PORT_ORIGIN[1] - 80, 0);

    gl.__fake.reset();
    renderer.render(scene, camera);

    const c = gl.__fake.counts;
    const totalDraws =
      (c.drawArrays || 0) +
      (c.drawElements || 0) +
      (c.drawArraysInstanced || 0) +
      (c.drawElementsInstanced || 0);
    assert.ok(totalDraws > 20, `WebGL2 emitted ${totalDraws} draw calls across combined port scene`);
    assert.equal(gl.__fake.unitConflicts, 0, "0 GL texture unit conflicts");
    assert.equal(gl.__fake.uboErrors, 0, "0 GL UBO errors");
    assert.equal(errors.length, 0, `console errors: ${errors.join(" | ")}`);

    for (const [label] of lampTargets) {
      const fsList = boundFsByMesh.get(label) || [];
      assert.ok(fsList.length > 0, `${label} must emit a draw call`);
      for (const fs of fsList) {
        assert.ok(fs.includes("emissive * vColor.rgb"), `${label} bound FS must retain emissive * vColor.rgb`);
        assert.ok(fs.includes("_csmShadowFactor"), `${label} bound FS must retain _csmShadowFactor`);
      }
    }

    for (const obj of [quay, sts, rmg, rtg, pool, shuttle]) {
      scene.remove(obj.root);
      obj.dispose();
    }
    renderer.dispose();
  } finally {
    console.error = origError;
  }
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
