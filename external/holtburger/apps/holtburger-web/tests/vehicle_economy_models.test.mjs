// tests/vehicle_economy_models.test.mjs — Headless WebGL2 & Procedural Model Suite for M3.3 (F13)
// Covers all 32 Phase B/C/E WCIDs (4000060..4000067, 4000070..4000095 / DeployableKind 30..61):
//   - economy_specs.js canonical specs & resolution
//   - Specialized ISO containers (22R1, 45R1, 22T1, 22K2, 22B0, 22U1, 22P1, 42P1)
//   - Prospecting pallets (4000070..4000074): ISO 6780 pallet, stowed envelope, delta, loadSlot, pallet jack
//   - Industrial skids (4000075..4000087) & Civic structures (4000090..4000095)
//   - scene3d/vehicle/index.js `buildEconomyModel` & `buildDeployableModel` direct THREE.Group return & null on 9999999
//   - 0 dynamic lights, CSM PBR, 0 NaN, FakeWebGL2 render, single-dispose-per-material, 0 lintSource/lintManifest hits

import * as THREE from "three";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import {
  ECONOMY_CONTAINER_WCID,
  PROSPECTING_WCID,
  INDUSTRIAL_SKID_WCID,
  CIVIC_WCID,
  ECONOMY_KIND_TO_WCID,
  ECONOMY_WCID_TO_KIND,
  resolveEconomyWcid,
} from "../scene3d/vehicle/economy_specs.js";
import {
  buildIsoContainer,
  CONTAINER_WCID,
  ISO_CONTAINER_SPECS,
  CONTAINER_SLOTS_REEFER_20,
  CONTAINER_SLOTS_REEFER_40,
} from "../scene3d/vehicle/container_models.js";
import {
  buildDeployable,
  DEPLOYABLE_WCID,
  DEPLOYABLE_KINDS,
  manifest as deployableManifest,
} from "../scene3d/vehicle/deployable_models.js";
import { manifest as prospectingManifest } from "../scene3d/vehicle/prospecting_models.js";
import { manifest as industryManifest } from "../scene3d/vehicle/industry_models.js";
import { manifest as civicManifest } from "../scene3d/vehicle/civic_models.js";
import { resolveContainerLogisticsSpec } from "../scene3d/vehicle/container_logistics.js";
import { resolvePortContainerSpec } from "../scene3d/vehicle/port_specs.js";
import { computeCraneSpanY, CRANE_SPAN_Y_20FT, CRANE_SPAN_Y_40FT } from "../scene3d/vehicle/sidelifter_kinematics.js";
import { buildPalletJack } from "../scene3d/vehicle/pallet_jack_model.js";
import { buildEconomyModel, buildDeployableModel } from "../scene3d/vehicle/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const VEHICLE_DIR = path.join(APP_ROOT, "scene3d", "vehicle");

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

function assertNoNaN(root, label) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    for (const arr of [o.position.toArray(), o.scale.toArray(), o.quaternion.toArray()]) {
      for (const v of arr) {
        assert.ok(Number.isFinite(v), `${label} non-finite transform value ${v}`);
      }
    }
    if (o.geometry?.attributes?.position) {
      const pos = o.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i++) {
        assert.ok(Number.isFinite(pos[i]), `${label} non-finite vertex position`);
      }
    }
  });
}

function spySingleDispose(root, disposeFn) {
  const counts = new Map();
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!counts.has(m)) {
        counts.set(m, 0);
        const orig = m.dispose.bind(m);
        m.dispose = () => {
          counts.set(m, counts.get(m) + 1);
          orig();
        };
      }
    }
  });
  assert.ok(counts.size > 0, "Expected >= 1 material to dispose");
  disposeFn();
  for (const [m, c] of counts.entries()) {
    assert.equal(c, 1, `Material ${m.type} disposed ${c} times (expected 1)`);
  }
}

function renderWithFakeGl(root) {
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const canvas = fakeCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 1.33, 0.1, 200);
  cam.position.set(6, -8, 5);
  cam.lookAt(0, 0, 1);
  scene.add(root);
  gl.__fake.reset();
  renderer.render(scene, cam);
  const draws = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
  assert.ok(draws > 0, `Expected drawCalls > 0, got ${draws}`);
  scene.remove(root);
  renderer.dispose();
}

console.log("=== Economy, Prospecting, Industry & Civic Procedural 3D Models Suite ===");

await check("ECON_01 Spec maps cover all 32 WCIDs (4000060..4000067, 4000070..4000095) and Kinds 30..61", () => {
  assert.equal(Object.keys(ECONOMY_KIND_TO_WCID).length, 32);
  assert.equal(Object.keys(ECONOMY_WCID_TO_KIND).length, 32);
  for (let k = 30; k <= 61; k++) {
    const w = ECONOMY_KIND_TO_WCID[k];
    assert.ok(w >= 4000060 && w <= 4000095, `Kind ${k} -> ${w}`);
    assert.equal(ECONOMY_WCID_TO_KIND[w], k);
    assert.equal(resolveEconomyWcid(k), w);
    assert.equal(resolveEconomyWcid(w), w);
  }
  assert.equal(resolveEconomyWcid("22R1"), 4000060);
  assert.equal(resolveEconomyWcid("45R1"), 4000061);
  assert.equal(resolveEconomyWcid("GPR"), 4000070);
  assert.equal(resolveEconomyWcid(9999999), null);
});

await check("ECON_02 Specialized ISO Containers (4000060..4000067): ISO 1161 spans, reefer slots, <= 8 DC, 0 lights, render & dispose", () => {
  assert.equal(CONTAINER_SLOTS_REEFER_20.length, 8);
  assert.equal(CONTAINER_SLOTS_REEFER_40.length, 18);

  for (const wcid of Object.values(ECONOMY_CONTAINER_WCID)) {
    const spec = ISO_CONTAINER_SPECS[wcid];
    assert.ok(spec, `Missing spec for ${wcid}`);
    assert.equal(spec.cornerCastingsCenter.width, 2.259);
    assert.equal(spec.cornerCastingsCenter.length, spec.external.length < 7 ? 5.853 : 11.985);
    assert.equal(spec.hasForkliftPockets, spec.external.length < 7);

    const cont = buildIsoContainer(THREE, wcid, { doorProgress: 0 });
    assert.equal(countLights(cont.root), 0, `${wcid} has 0 lights`);
    const dc = countDrawCalls(cont.root);
    assert.ok(dc >= 3 && dc <= 8, `${wcid} base draw calls (${dc}) in [3, 8]`);
    assertNoNaN(cont.root, `container-${wcid}`);
    cont.setDoorProgress(1.0);
    cont.update(0.016, { doorProgress: 0.5 });
    renderWithFakeGl(cont.root);
    spySingleDispose(cont.root, () => cont.dispose());

    // Logistics, port_specs & sidelifter compatibility
    const logSpec = resolveContainerLogisticsSpec(wcid);
    assert.ok(logSpec && logSpec.interior, `container_logistics supports ${wcid}`);
    const portSpec = resolvePortContainerSpec(wcid);
    assert.equal(portSpec.wcid, wcid);
    const expectedSpan = spec.external.length < 7 ? CRANE_SPAN_Y_20FT : CRANE_SPAN_Y_40FT;
    assert.equal(computeCraneSpanY(wcid), expectedSpan);
  }
});

await check("ECON_03 Prospecting Pallets (4000070..4000074): ISO 6780 pallet, stowed envelope, delta, container loadSlot & pallet jack", () => {
  for (const wcid of Object.values(PROSPECTING_WCID)) {
    const unit = buildDeployable(THREE, wcid, { stowed: false });
    assert.equal(countLights(unit.root), 0, `${wcid} 0 lights`);
    const dc = countDrawCalls(unit.root);
    assert.ok(dc >= 2 && dc <= 10, `${wcid} draw calls (${dc}) <= 10`);
    assert.doesNotThrow(() => unit.update(null));
    unit.update({ simTimeSec: 1.2, online: true, progressPct: 50 });
    unit.root.updateMatrixWorld(true);
    const deployedBox = new THREE.Box3().setFromObject(unit.root);

    unit.setStowed(true);
    unit.root.updateMatrixWorld(true);
    const stowedBox = new THREE.Box3().setFromObject(unit.root);
    assert.ok(stowedBox.min.x >= -0.555 && stowedBox.max.x <= 0.555, `${wcid} stowed X`);
    assert.ok(stowedBox.min.y >= -0.555 && stowedBox.max.y <= 0.555, `${wcid} stowed Y`);
    assert.ok(stowedBox.min.z >= -1e-4 && stowedBox.max.z <= 2.05, `${wcid} stowed Z (${stowedBox.max.z})`);

    const diff =
      Math.abs(stowedBox.min.x - deployedBox.min.x) +
      Math.abs(stowedBox.max.x - deployedBox.max.x) +
      Math.abs(stowedBox.min.y - deployedBox.min.y) +
      Math.abs(stowedBox.max.y - deployedBox.max.y) +
      Math.abs(stowedBox.min.z - deployedBox.min.z) +
      Math.abs(stowedBox.max.z - deployedBox.max.z);
    assert.ok(diff > 0.02, `${wcid} has stowed-vs-deployed delta (${diff})`);

    assertNoNaN(unit.root, `prospect-${wcid}`);
    renderWithFakeGl(unit.root);
    spySingleDispose(unit.root, () => unit.dispose());
  }

  // Load 4000070..4000074 into 22R1 reefer container slots and onto pallet jack
  const reefer = buildIsoContainer(THREE, 4000060, { doorProgress: 1.0 });
  const slot = reefer.loadSlot(0, 4000070);
  assert.ok(slot && slot.deployableModel && slot.deployableModel.wcid === 4000070);
  reefer.dispose();

  const pj = buildPalletJack(THREE, { carriedWcid: 4000072 });
  assert.doesNotThrow(() => pj.update({ carriedWcid: 4000073 }));
  pj.dispose();
});

await check("ECON_04 Industrial Skids (4000075..4000087) & Civic Structures (4000090..4000095): <= 10 DC, 0 lights, update(null), render & dispose", () => {
  const allWcids = [...Object.values(INDUSTRIAL_SKID_WCID), ...Object.values(CIVIC_WCID)];
  for (const wcid of allWcids) {
    const unit = buildDeployable(THREE, wcid, { stowed: false });
    assert.equal(unit.wcid, wcid);
    assert.equal(countLights(unit.root), 0, `${wcid} has 0 dynamic lights`);
    const dc = countDrawCalls(unit.root);
    assert.ok(dc >= 2 && dc <= 10, `${wcid} draw calls (${dc}) <= 10`);
    assert.doesNotThrow(() => unit.update(null), `${wcid} update(null) safe`);
    unit.update({ simTimeSec: 2.5, online: true, progressPct: 75 });
    assertNoNaN(unit.root, `unit-${wcid}`);
    renderWithFakeGl(unit.root);
    spySingleDispose(unit.root, () => unit.dispose());
  }
});

await check("ECON_05 index.js buildEconomyModel & buildDeployableModel return THREE.Group directly or null for 9999999", () => {
  assert.equal(buildDeployableModel, buildEconomyModel);
  assert.equal(buildEconomyModel(THREE, 9999999), null);
  assert.equal(buildEconomyModel(THREE, "nonexistent_unit"), null);

  for (let k = 30; k <= 61; k++) {
    const wcid = ECONOMY_KIND_TO_WCID[k];
    const rootByWcid = buildEconomyModel(THREE, wcid);
    assert.ok(rootByWcid && rootByWcid.isObject3D, `buildEconomyModel(${wcid}) returns Object3D`);
    assert.equal(countLights(rootByWcid), 0);
    assertNoNaN(rootByWcid, `factory-${wcid}`);
    renderWithFakeGl(rootByWcid);
    spySingleDispose(rootByWcid, () => rootByWcid.userData.dispose());

    const rootByKind = buildEconomyModel(THREE, k);
    assert.ok(rootByKind && rootByKind.isObject3D, `buildEconomyModel(kind=${k}) returns Object3D`);
    rootByKind.userData.dispose();
  }
});

await check("ECON_06 lintManifest (0 errors) & lintSource (0 hits across all economy vehicle model files)", () => {
  for (const m of [deployableManifest, prospectingManifest, industryManifest, civicManifest]) {
    assert.deepEqual(lintManifest(m), []);
  }
  const files = [
    "economy_specs.js",
    "prospecting_models.js",
    "industry_models.js",
    "civic_models.js",
    "economy_hud.js",
    "container_models.js",
    "deployable_models.js",
  ];
  for (const name of files) {
    const hits = lintSource(readFileSync(path.join(VEHICLE_DIR, name), "utf8"));
    assert.deepEqual(hits, [], `${name} lintSource violations: ${JSON.stringify(hits)}`);
  }
  assert.ok(Object.values(DEPLOYABLE_KINDS).includes(61));
  assert.ok(Object.values(DEPLOYABLE_WCID).includes(4000095));
});

await check("ECON_07 Flat-rack cargoBayGroup stays visible at doorProgress=0 & Reefer (22R1/45R1) floor deck covers all reefer slots", () => {
  for (const wcid of [4000066, 4000067]) {
    const rack = buildIsoContainer(THREE, wcid, { doorProgress: 0 });
    assert.equal(rack.cargoBayGroup.visible, true, `${wcid} flatRack cargoBayGroup visible at default doorProgress=0`);
    const slot = rack.loadSlot(0, 4000070);
    assert.ok(slot && slot.deployableModel, `${wcid} flatRack loadSlot(0, 4000070) succeeded`);
    rack.setDoorProgress(0);
    assert.equal(rack.cargoBayGroup.visible, true, `${wcid} flatRack cargoBayGroup stays visible after setDoorProgress(0)`);
    rack.dispose();
  }

  // Box containers keep interior bay culling when doors are closed
  const boxReefer = buildIsoContainer(THREE, 4000060, { doorProgress: 0 });
  assert.equal(boxReefer.cargoBayGroup.visible, false, "22R1 box cargoBayGroup culled at doorProgress=0");
  boxReefer.setDoorProgress(1);
  assert.equal(boxReefer.cargoBayGroup.visible, true, "22R1 box cargoBayGroup visible at doorProgress=1");
  boxReefer.setDoorProgress(0);
  assert.equal(boxReefer.cargoBayGroup.visible, false, "22R1 box cargoBayGroup culled again at doorProgress=0");
  boxReefer.dispose();

  for (const [wcid, slots, maxBulkheadY] of [
    [4000060, CONTAINER_SLOTS_REEFER_20, 1.95],
    [4000061, CONTAINER_SLOTS_REEFER_40, 5.05],
  ]) {
    const cont = buildIsoContainer(THREE, wcid, { doorProgress: 1 });
    const floorMesh = cont.root.getObjectByName("container-floor-deck");
    assert.ok(floorMesh, `${wcid} has container-floor-deck`);
    cont.root.updateMatrixWorld(true);
    const floorBox = new THREE.Box3().setFromObject(floorMesh);
    const halfL = cont.spec.external.length * 0.5;
    assert.ok(floorBox.min.y <= -halfL + 0.08 + 1e-3, `${wcid} floor min.y (${floorBox.min.y}) reaches rear sill`);
    assert.ok(floorBox.max.y <= maxBulkheadY, `${wcid} floor max.y (${floorBox.max.y}) stops at front reefer bulkhead`);
    for (const sl of slots) {
      assert.ok(
        floorBox.min.y <= sl.y - sl.dy * 0.5 + 1e-3 && floorBox.max.y >= sl.y + sl.dy * 0.5 - 1e-3,
        `${wcid} floor Box3 [${floorBox.min.y.toFixed(3)}, ${floorBox.max.y.toFixed(3)}] covers slot ${sl.slotIndex} [${(sl.y - sl.dy * 0.5).toFixed(3)}, ${(sl.y + sl.dy * 0.5).toFixed(3)}]`
      );
    }
    cont.dispose();
  }
});

await check("ECON_08 All 11 ISO containers have zero floating decals, flush wall/door-header seals & readable contrast markings", () => {
  const closestPt = new THREE.Vector3();
  function extractTris(mesh) {
    const pos = mesh.geometry.getAttribute("position");
    const tris = [];
    for (let i = 0; i < pos.count; i += 3) {
      tris.push(
        new THREE.Triangle(
          new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)),
          new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)),
          new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)),
        ),
      );
    }
    return tris;
  }

  for (const wcid of Object.values(CONTAINER_WCID)) {
    const cont = buildIsoContainer(THREE, wcid, { doorProgress: 0 });
    const spec = cont.spec;
    const variant = spec.variant || "box";
    const halfL = spec.external.length * 0.5;
    const H = spec.external.height;
    const bodyMesh = cont.root.getObjectByName("container-body");
    const castingsMesh = cont.root.getObjectByName("container-corner-castings");
    const markingsMesh = cont.root.getObjectByName("container-markings");
    assert.ok(bodyMesh && castingsMesh && markingsMesh, `${wcid} has body, castings & markings meshes`);

    // 1. Every marking box in container-markings must rest solidly on body/castings (zero floating decals)
    const supportTris = [...extractTris(bodyMesh), ...extractTris(castingsMesh)];
    const mPos = markingsMesh.geometry.getAttribute("position");
    assert.ok(mPos.count > 0 && mPos.count % 36 === 0, `${wcid} markings geometry consists of whole boxes`);
    for (let b = 0; b < mPos.count; b += 36) {
      let minVertDist = Infinity;
      let maxVertDist = 0;
      for (let i = b; i < b + 36; i++) {
        const p = new THREE.Vector3(mPos.getX(i), mPos.getY(i), mPos.getZ(i));
        let dMin = Infinity;
        for (const tri of supportTris) {
          tri.closestPointToPoint(p, closestPt);
          const d = p.distanceTo(closestPt);
          if (d < dMin) dMin = d;
        }
        if (dMin < minVertDist) minVertDist = dMin;
        if (dMin > maxVertDist) maxVertDist = dMin;
      }
      assert.ok(
        minVertDist <= 0.006 && maxVertDist <= 0.025,
        `${wcid} (${variant}) marking box #${b / 36} floating: minDist=${minVertDist.toFixed(4)}m maxDist=${maxVertDist.toFixed(4)}m`,
      );
    }

    // 2. Whole-container 3D structural connectivity: all visible shells across body, floor, castings, markings, doors, ramp & lamps form 1 connected component
    cont.root.updateMatrixWorld(true);
    const shells = [];
    cont.root.traverse((obj) => {
      if (!obj.isMesh || !obj.visible) return;
      const pos = obj.geometry.getAttribute("position");
      const mat = obj.matrixWorld;
      const nTri = pos.count / 3;
      const parent = Int32Array.from({ length: nTri }, (_, idx) => idx);
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
      const vertMap = new Map();
      const triPts = [];
      for (let t = 0; t < nTri; t++) {
        const pts = [];
        for (let k = 0; k < 3; k++) {
          const idx = t * 3 + k;
          const v = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(mat);
          pts.push(v);
          const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
          const prev = vertMap.get(key);
          if (prev !== undefined) union(t, prev);
          else vertMap.set(key, t);
        }
        triPts.push(pts);
      }
      const groups = new Map();
      for (let t = 0; t < nTri; t++) {
        const r = find(t);
        let g = groups.get(r);
        if (!g) { g = { mesh: obj.name, box: new THREE.Box3() }; groups.set(r, g); }
        for (const p of triPts[t]) g.box.expandByPoint(p);
      }
      for (const g of groups.values()) shells.push(g);
    });
    const sp = Int32Array.from({ length: shells.length }, (_, idx) => idx);
    const sfind = (x) => { while (sp[x] !== x) { sp[x] = sp[sp[x]]; x = sp[x]; } return x; };
    const sunion = (a, b) => { a = sfind(a); b = sfind(b); if (a !== b) sp[a] = b; };
    const connEps = 0.002;
    for (let i = 0; i < shells.length; i++) {
      const a = shells[i].box;
      for (let j = i + 1; j < shells.length; j++) {
        const b = shells[j].box;
        if (a.min.x <= b.max.x + connEps && a.max.x >= b.min.x - connEps &&
            a.min.y <= b.max.y + connEps && a.max.y >= b.min.y - connEps &&
            a.min.z <= b.max.z + connEps && a.max.z >= b.min.z - connEps) {
          sunion(i, j);
        }
      }
    }
    const compRoots = new Set();
    for (let i = 0; i < shells.length; i++) compRoots.add(sfind(i));
    assert.equal(compRoots.size, 1, `${wcid} (${variant}) must form 1 connected 3D component (found ${compRoots.size})`);

    // 3. Zero exterior z-fighting on hazard chevrons vs top castings (Z=H) and roof vs top rails (Z=H-0.004)
    if (spec.hasHazardChevrons) {
      const mBox = new THREE.Box3().setFromObject(markingsMesh);
      assert.ok(
        mBox.max.z <= H - 0.118,
        `${wcid} (${variant}) hazard chevrons max.z (${mBox.max.z.toFixed(4)}) must sit below top corner castings (${(H - 0.118).toFixed(4)})`,
      );
    }

    // 4. Flat-rack (22P1/42P1): zero markings in open side air above deck, end bulkheads capped flush with top castings,
    //    steel under-deck flush with timber floor underside (zero 6mm gap) & side girders frame timber deck cleanly
    if (variant === "flatRack") {
      for (let i = 0; i < mPos.count; i++) {
        const y = mPos.getY(i);
        const z = mPos.getZ(i);
        assert.ok(
          !(z > spec.floorZ && Math.abs(y) < halfL - 0.16),
          `${wcid} flatRack marking vertex (${mPos.getX(i).toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) must not float in open side air`,
        );
      }
      const bodyBox = new THREE.Box3().setFromObject(bodyMesh);
      assert.ok(bodyBox.max.z >= H - 0.01, `${wcid} flatRack end headers reach top casting level (${bodyBox.max.z.toFixed(3)} vs ${H})`);
      const floorMesh = cont.root.getObjectByName("container-floor-deck");
      const floorBox = new THREE.Box3().setFromObject(floorMesh);
      const bPos = bodyMesh.geometry.getAttribute("position");
      let underDeckTopZ = 0;
      let sideGirderTopZ = 0;
      const halfW = spec.external.width * 0.5;
      for (let i = 0; i < bPos.count; i += 3) {
        const xs = [bPos.getX(i), bPos.getX(i + 1), bPos.getX(i + 2)];
        const ys = [bPos.getY(i), bPos.getY(i + 1), bPos.getY(i + 2)];
        const zs = [bPos.getZ(i), bPos.getZ(i + 1), bPos.getZ(i + 2)];
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const maxZ = Math.max(...zs);
        if (minX < 0 && maxX > 0 && minY < 0 && maxY > 0 && maxZ < 0.4) {
          if (maxZ > underDeckTopZ) underDeckTopZ = maxZ;
        }
        if (xs.every((x) => Math.abs(Math.abs(x) - halfW) < 0.005) && minY < 0 && maxY > 0 && maxZ < 0.4) {
          if (maxZ > sideGirderTopZ) sideGirderTopZ = maxZ;
        }
      }
      assert.ok(
        Math.abs(underDeckTopZ - floorBox.min.z) <= 0.002,
        `${wcid} flatRack under-deck top (${underDeckTopZ.toFixed(4)}m) must meet timber floor underside (${floorBox.min.z.toFixed(4)}m)`,
      );
      assert.ok(
        sideGirderTopZ >= floorBox.max.z - 0.003,
        `${wcid} flatRack side girder top (${sideGirderTopZ.toFixed(4)}m) must frame timber deck top (${floorBox.max.z.toFixed(4)}m)`,
      );
    }

    // 5. Tanktainers (22T1/22K2): zero markings outboard of cylindrical tank shell & full-width saddle cross-bearers reaching side rails
    if (variant === "tank" || variant === "gasTank") {
      const tankR = variant === "gasTank" ? 0.96 : 1.02;
      for (let i = 0; i < mPos.count; i++) {
        const x = mPos.getX(i);
        const y = mPos.getY(i);
        const z = mPos.getZ(i);
        assert.ok(
          !(Math.abs(x) > tankR + 0.02 && Math.abs(y) < halfL - 0.16 && z > 0.16 && z < H - 0.30),
          `${wcid} ${variant} marking vertex (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) must not float outboard of tank`,
        );
      }
      const bPos = bodyMesh.geometry.getAttribute("position");
      const halfW = spec.external.width * 0.5;
      let maxCrossBearerX = 0;
      for (let i = 0; i < bPos.count; i += 3) {
        const xs = [bPos.getX(i), bPos.getX(i + 1), bPos.getX(i + 2)];
        const ys = [bPos.getY(i), bPos.getY(i + 1), bPos.getY(i + 2)];
        const zs = [bPos.getZ(i), bPos.getZ(i + 1), bPos.getZ(i + 2)];
        if (Math.min(...ys) <= 1.8 && Math.max(...ys) >= 1.8 && Math.max(...zs) <= 0.15 && Math.min(...xs) < 0 && Math.max(...xs) > 0) {
          maxCrossBearerX = Math.max(maxCrossBearerX, Math.max(...xs));
        }
      }
      assert.ok(
        maxCrossBearerX >= halfW - 0.09,
        `${wcid} ${variant} saddle cross-bearer maxX (${maxCrossBearerX.toFixed(3)}m) must reach bottom side rail (${(halfW - 0.08).toFixed(3)}m)`,
      );
    }

    // 6. Box-walled variants (incl. 22R1/45R1 reefers): side walls seal cleanly to top rail, rear header seals to closed door top,
    //    and reefer front machinery bulkhead seals cleanly to front edge of reefer floor deck (zero floor hole)
    if (variant !== "flatRack" && variant !== "tank" && variant !== "gasTank") {
      const bPos = bodyMesh.geometry.getAttribute("position");
      const halfW = spec.external.width * 0.5;
      let sideWallMaxZ = 0;
      let rearHeaderMinZ = Infinity;
      let reeferBulkheadMinY = Infinity;
      for (let i = 0; i < bPos.count; i += 3) {
        const xs = [bPos.getX(i), bPos.getX(i + 1), bPos.getX(i + 2)];
        const ys = [bPos.getY(i), bPos.getY(i + 1), bPos.getY(i + 2)];
        const zs = [bPos.getZ(i), bPos.getZ(i + 1), bPos.getZ(i + 2)];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);
        // Side wall outer face triangle spanning mid-length (y = 0) below top side rail (z < H - 0.055)
        if (xs.every((x) => Math.abs(Math.abs(x) - halfW) < 0.005) && minY < 0 && maxY > 0 && minZ < 1.0 && maxZ < H - 0.055) {
          if (maxZ > sideWallMaxZ) sideWallMaxZ = maxZ;
        }
        // Rear door header triangle spanning door center (x = 0) at rear end (y < -halfL + 0.07)
        if (ys.every((y) => y < -halfL + 0.07) && minX < 0 && maxX > 0 && maxZ > H - 0.02) {
          if (minZ < rearHeaderMinZ) rearHeaderMinZ = minZ;
        }
        // Reefer interior front evaporator bulkhead rear face (y > 1.0, spans x = 0, interior height 0.5..2.0)
        if (variant === "reefer" && minX < -0.9 && maxX > 0.9 && minY > 1.0 && minZ < 0.5 && maxZ > 2.0 && maxY < halfL - 0.04) {
          if (minY < reeferBulkheadMinY) reeferBulkheadMinY = minY;
        }
      }
      assert.ok(
        sideWallMaxZ >= H - 0.065,
        `${wcid} (${variant}) exterior side wall top (${sideWallMaxZ.toFixed(3)}m) must meet top side rail (${(H - 0.060).toFixed(3)}m)`,
      );
      const doorTopZ = spec.floorZ + spec.door.height;
      assert.ok(
        rearHeaderMinZ <= doorTopZ + 0.005,
        `${wcid} (${variant}) rear header bottom (${rearHeaderMinZ.toFixed(3)}m) must seal to closed door top (${doorTopZ.toFixed(3)}m)`,
      );
      if (variant === "reefer") {
        const floorBox = new THREE.Box3().setFromObject(cont.root.getObjectByName("container-floor-deck"));
        assert.ok(
          reeferBulkheadMinY <= floorBox.max.y + 0.01,
          `${wcid} reefer bulkhead minY (${reeferBulkheadMinY.toFixed(3)}m) must meet reefer floor front edge (${floorBox.max.y.toFixed(3)}m)`,
        );
      }
    }

    cont.dispose();
  }

  // 5. Contrast check: white default reefer emits dark markings, dark explicit livery emits white markings
  const whiteReefer = buildIsoContainer(THREE, 4000060, { doorProgress: 0 });
  const wCol = whiteReefer.root.getObjectByName("container-markings").geometry.getAttribute("color");
  assert.ok(wCol.getX(0) < 0.15, `Default white 22R1 reefer uses dark BIC decals (got r=${wCol.getX(0).toFixed(3)})`);
  whiteReefer.dispose();

  const blueReefer = buildIsoContainer(THREE, 4000060, { liveryId: 0, doorProgress: 0 });
  const bCol = blueReefer.root.getObjectByName("container-markings").geometry.getAttribute("color");
  assert.ok(bCol.getX(0) > 0.70, `Dark maritimeBlue 22R1 reefer uses light BIC decals (got r=${bCol.getX(0).toFixed(3)})`);
  blueReefer.dispose();
});

console.log(`\nvehicle_economy_models: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
