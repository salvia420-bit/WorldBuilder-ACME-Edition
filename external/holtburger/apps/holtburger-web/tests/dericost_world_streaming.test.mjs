// tests/dericost_world_streaming.test.mjs — Area 6: Dericost continent streaming,
// landblock culling, building mesh batching & freezing, and eviction cleanup.
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  initDericostWorld,
  tickDericostWorld,
  buildLandblockGroup,
  disposeLandblockGroup,
  __resetDericostWorldForTest,
} from "../scene3d/dericost_world.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

console.log("TEST: Dericost Continent Streaming, Culling & Batching");

// 1. Landblock group creation, culling, batching and freezing
{
  const st = {
    mats: null,
    sceneryTemplates: new Map(),
    buildingTemplates: new Map(),
    doorTemplate: null,
    root: new THREE.Group(),
    lbGroups: new Map(),
  };

  const rawScenery = [
    { obj_id: "0x02100001", x: 20, y: 30, z: 10, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1 },
    { obj_id: "0x02100001", x: 40, y: 50, z: 12, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1 },
    { obj_id: "0x01100001", x: 60, y: 70, z: 15, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1.2 },
  ];

  const buildings = [
    { is_building: true, obj_id: "0x01100001", x: 80, y: 80, z: 20, qx: 0, qy: 0, qz: 0, qw: 1 },
    { is_building: true, obj_id: "0x01100001", x: 120, y: 120, z: 22, qx: 0, qy: 0, qz: 0, qw: 1 },
    { is_door: true, x: 80, y: 70, z: 20, qx: 0, qy: 0, qz: 0, qw: 1 },
    { is_door: true, x: 120, y: 110, z: 22, qx: 0, qy: 0, qz: 0, qw: 1 },
  ];

  const grp = buildLandblockGroup(st, 10, 10, rawScenery, buildings);

  check("group is frozen (matrixAutoUpdate = false)", grp.matrixAutoUpdate === false);

  let instancedCount = 0;
  let allFrustumCulled = true;
  let allFrozen = true;
  let allHaveBoundingSpheres = true;
  let foundBatchedBuildings = false;
  let foundBatchedDoors = false;

  grp.traverse((child) => {
    if (child.isInstancedMesh) {
      instancedCount++;
      if (!child.frustumCulled) allFrustumCulled = false;
      if (child.matrixAutoUpdate !== false) allFrozen = false;
      if (!child.boundingSphere) allHaveBoundingSpheres = false;
      // Buildings of archetype 0x01100001 have count 2
      if (child.count === 2) {
        foundBatchedBuildings = true;
      }
    }
  });

  check("instanced meshes are created for scenery and buildings", instancedCount > 0, `count=${instancedCount}`);
  check("all InstancedMeshes have frustumCulled = true", allFrustumCulled);
  check("all InstancedMeshes are frozen (matrixAutoUpdate = false)", allFrozen);
  check("bounding spheres computed for culling", allHaveBoundingSpheres);
  check("town buildings batched by archetype with instance count matching record count", foundBatchedBuildings);

  // Doors batched
  grp.traverse((child) => {
    if (child.isInstancedMesh && child.material === st.mats.runicDoor) {
      if (child.count === 2) foundBatchedDoors = true;
    }
  });
  check("town doors batched into InstancedMesh with count = 2", foundBatchedDoors);
}

// 2. Dispose evicted landblock InstancedMesh instances with im.dispose()
{
  const st = {
    mats: null,
    sceneryTemplates: new Map(),
    buildingTemplates: new Map(),
    doorTemplate: null,
    root: new THREE.Group(),
    lbGroups: new Map(),
  };

  const rawScenery = [
    { obj_id: "0x02100001", x: 20, y: 30, z: 10, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1 },
  ];
  const buildings = [
    { is_building: true, obj_id: "0x01100001", x: 80, y: 80, z: 20, qx: 0, qy: 0, qz: 0, qw: 1 },
  ];

  const grp = buildLandblockGroup(st, 12, 12, rawScenery, buildings);
  st.root.add(grp);

  const disposedMeshes = [];
  let totalInstanced = 0;
  grp.traverse((child) => {
    if (child.isInstancedMesh) {
      totalInstanced++;
      const origDispose = child.dispose.bind(child);
      child.dispose = () => {
        disposedMeshes.push(child);
        origDispose();
      };
    }
  });

  disposeLandblockGroup(st, grp);

  check("disposeLandblockGroup removes group from root", !st.root.children.includes(grp));
  check("disposeLandblockGroup calls im.dispose() on every InstancedMesh", disposedMeshes.length === totalInstanced && totalInstanced > 0, `disposed=${disposedMeshes.length}/${totalInstanced}`);
}

// 3. Evict Dericost landblocks when returning to Dereth (ay < 67000)
{
  __resetDericostWorldForTest();
  const scene3d = {
    scene: new THREE.Scene(),
    terrainGroup: { parent: new THREE.Group() },
  };

  const st = initDericostWorld(scene3d);

  // Manually attach a dummy landblock group to simulate loaded landblocks on Dericost
  const dummyGrp = new THREE.Group();
  const dummyIm = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2);
  let disposedCalled = false;
  dummyIm.dispose = () => { disposedCalled = true; };
  dummyGrp.add(dummyIm);
  st.root.add(dummyGrp);

  const hex = "0A0A";
  st.lbGroups.set(hex, { lbX: 10, lbY: 10, status: "ready", group: dummyGrp });

  // Camera in Dereth: ax = 10000, ay = 50000 (< 67000), az = 50
  // Note: ay = -camera.position.z in AC coords
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10000, 50, -50000); // cp.x = 10000, cp.y = 50, cp.z = -50000 => ay = 50000 < 67000

  tickDericostWorld(scene3d, camera, 1000);

  check("st.lbGroups is cleared when returning to Dereth (ay < 67000)", st.lbGroups.size === 0);
  check("st.root children are removed when returning to Dereth", st.root.children.length === 0);
  check("evicted landblock InstancedMesh instances receive im.dispose()", disposedCalled);
  check("st.root.visible is false when in Dereth", st.root.visible === false);

  __resetDericostWorldForTest();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "All tests must pass");
