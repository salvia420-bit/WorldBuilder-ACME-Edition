// tests/dericost_world_streaming.test.mjs — Area 6: Dericost continent streaming,
// landblock culling, building mesh batching & freezing, and eviction cleanup.
import assert from "node:assert/strict";
import * as THREE from "three";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  initDericostWorld,
  tickDericostWorld,
  buildLandblockGroup,
  disposeLandblockGroup,
  loadDericostAssetIndex,
  __resetDericostWorldForTest,
} from "../scene3d/dericost_world.js";
import { extractDericostLandblockData } from "../scene3d/world_terrain.js";
import { createWorldStreamer } from "../scene3d/world_stream.js";

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

// 4. loadDericostAssetIndex normalizes town building keys to 4-char uppercase hex ("2CB2" for Vasmora)
{
  const townsPath = "/workspace/wb/hb-serve/dist/current/dericost/towns/dericost_towns_index.json";
  const buildingsDir = "/workspace/wb/hb-serve/dist/current/dericost/buildings";
  const hasRealDist = existsSync(townsPath) && existsSync(buildingsDir);
  const townsJson = hasRealDist
    ? readFileSync(townsPath, "utf8")
    : JSON.stringify({ towns: [{ name: "Vasmora", lbX: 44, lbY: 178 }] });

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("dericost_towns_index.json")) {
      return { ok: true, status: 200, json: async () => JSON.parse(townsJson) };
    }
    return { ok: false, status: 404 };
  };
  try {
    const st = { assetIndex: null, assetIndexPromise: null };
    const idx = await loadDericostAssetIndex(st);
    check("loadDericostAssetIndex loaded successfully", idx.loaded === true);
    check("buildingsSet has Vasmora hex '2CB2' (not decimal '11442')", idx.buildingsSet.has("2CB2") === true && idx.buildingsSet.has("11442") === false);
    if (hasRealDist) {
      const diskHexes = new Set(
        readdirSync(buildingsDir)
          .filter((f) => f.endsWith(".buildings.jsonl"))
          .map((f) => f.replace(/^0x/i, "").replace(/\.buildings\.jsonl$/i, "").toUpperCase())
      );
      let missing = 0;
      let extra = 0;
      for (const h of diskHexes) if (!idx.buildingsSet.has(h)) missing++;
      for (const h of idx.buildingsSet) if (!diskHexes.has(h)) extra++;
      check("buildingsSet matches baked dericost/buildings/*.buildings.jsonl (0 missing, 0 extra)", missing === 0 && extra === 0, `size=${idx.buildingsSet.size}, disk=${diskHexes.size}, missing=${missing}, extra=${extra}`);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
}

// 5. extractDericostLandblockData accepts explicit worldData & landblock_stream passes it without _st.data
{
  const WORLD_VERTS = 255 * 8 + 1;
  const hIdxDericost = new Uint8Array(WORLD_VERTS * WORLD_VERTS);
  const typesDericost = new Uint8Array(WORLD_VERTS * WORLD_VERTS);
  const table = new Float32Array(256);
  table[139] = 278.0;
  for (let row = 0; row <= 8; row++) {
    for (let col = 0; col <= 8; col++) {
      const gIdx = (144 * 8 + row) * WORLD_VERTS + (166 * 8 + col);
      hIdxDericost[gIdx] = 139;
      typesDericost[gIdx] = 7;
    }
  }
  const worldData = { hIdxDericost, typesDericost, table };
  const extracted = extractDericostLandblockData(166, 144, worldData);
  check("extractDericostLandblockData works with explicit worldData when _st is null", extracted !== null && extracted.heights.length === 81 && extracted.heights[0] === 278 && extracted.codes[0] === 7);

  const prevFetch = globalThis.fetch;
  const prevWin = globalThis.window;
  const prevLoc = globalThis.location;
  const populated = [];
  try {
    const emptyU8 = new Uint8Array(WORLD_VERTS * WORLD_VERTS);
    const metaJson = { landHeightTable: Array.from(table) };
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.endsWith("world_meta.json")) {
        return { ok: true, status: 200, json: async () => metaJson };
      }
      if (s.endsWith("dericost_height.u8")) {
        return { ok: true, status: 200, arrayBuffer: async () => hIdxDericost.buffer };
      }
      if (s.endsWith("dericost_types.u8")) {
        return { ok: true, status: 200, arrayBuffer: async () => typesDericost.buffer };
      }
      if (s.endsWith(".u8")) {
        return { ok: true, status: 200, arrayBuffer: async () => emptyU8.buffer };
      }
      return { ok: false, status: 404 };
    };
    globalThis.location = { search: "" };
    globalThis.window = globalThis;
    globalThis.__sessionHandle = {
      populateTerrain(lbId, heights, codes) {
        populated.push({ lbId: lbId >>> 0, heights, codes });
      },
    };
    const { createLandblockStream } = await import("../app/landblock_stream.js");
    const stream = createLandblockStream({
      getWorldObjectManager: () => null,
      getLiveScene: () => null,
      getLocalPlayerGuid: () => 0,
      getLastLocalPlayerLb: () => 0,
      setLastLocalPlayerLb: () => {},
      getWasmModule: () => null,
    });
    await stream.ensureTerrainAroundLandblock(0xA6908000);
    const center = populated.find((p) => p.lbId === 0xA6908000);
    check(
      "ensureTerrainAroundLandblock passes loadWorldData() to extractDericostLandblockData (9/9 Dericost LBs)",
      populated.length === 9 && populated.every((p) => (p.lbId & 0x8000) !== 0) && center?.heights?.[0] === 278,
      `populated=${populated.length}`
    );
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.window = prevWin;
    globalThis.location = prevLoc;
  }
}

// 6. Adversarial (Finding 6): Dericost (0, 0) outdoor cell 0x00008001 must NOT be treated as lbId = 0
{
  const calls = [];
  const serverLbs = [];
  const terrainPrefetchedLbs = new Set();
  const buildingAabbsPopulatedLbs = new Set();
  const cellContainersPopulatedLbs = new Set();
  const objectsRenderAddedLbs = new Set();
  const s3d = {
    landblockLru: {
      noteServerLb(lb) { serverLbs.push(lb >>> 0); },
    },
    loadEnvCellsForLandblock(lb) { calls.push(["loadEnvCellsForLandblock", lb >>> 0]); },
    loadTerrainForLandblock(cx, cy) { calls.push(["loadTerrainForLandblock", cx, cy]); },
    loadTerrainRing(cx, cy) { calls.push(["loadTerrainRing", cx, cy]); },
    loadBuildingsForLandblock(cx, cy) { calls.push(["loadBuildingsForLandblock", cx, cy]); },
    loadStaticsForLandblock(cx, cy) { calls.push(["loadStaticsForLandblock", cx, cy]); },
    loadSpawnsForLandblock(cx, cy) { calls.push(["loadSpawnsForLandblock", cx, cy]); },
  };
  const ws = createWorldStreamer({
    getLocalPlayerGuid: () => 1001,
    emitLandblockChanged: (prevLb, lbId) => calls.push(["emitLandblockChanged", prevLb >>> 0, lbId >>> 0]),
    ensureTerrainAroundLandblock: (lb) => {
      calls.push(["ensureTerrainAroundLandblock", lb >>> 0]);
      terrainPrefetchedLbs.add(lb >>> 0);
    },
    ensureBuildingAabbsAroundLandblock: (lb) => {
      calls.push(["ensureBuildingAabbsAroundLandblock", lb >>> 0]);
      buildingAabbsPopulatedLbs.add((lb & 0xffff0000) >>> 0);
    },
    ensureCellContainersForLandblock: (lb) => {
      calls.push(["ensureCellContainersForLandblock", lb >>> 0]);
      cellContainersPopulatedLbs.add((lb & 0xffff0000) >>> 0);
    },
    ensureLandblockObjectsForLandblock: (lb) => {
      calls.push(["ensureLandblockObjectsForLandblock", lb >>> 0]);
      objectsRenderAddedLbs.add(lb >>> 0);
    },
    getLiveScene3d: () => s3d,
    terrainPrefetchedLbs,
    buildingAabbsPopulatedLbs,
    cellContainersPopulatedLbs,
    objectsRenderAddedLbs,
  });

  // Invalid Dereth cell 0x00000021 still produces zero streaming calls
  ws.onPositionUpdate({ kind: 0, guid: 1001, landblockId: 0x00000021, x: 10, y: 10 });
  check("invalid Dereth cell 0x00000021 produces zero streaming calls", calls.length === 0 && serverLbs[0] === 0);

  calls.length = 0;
  serverLbs.length = 0;

  // Dericost (0, 0) cell 0x00008001 streams 0x00008000 and 3D (0, 0) ring
  ws.onPositionUpdate({ kind: 0, guid: 1001, landblockId: 0x00008001, x: 10, y: 10 });
  const emits = calls.filter((c) => c[0] === "emitLandblockChanged");
  const terrains = calls.filter((c) => c[0] === "ensureTerrainAroundLandblock");
  const rings = calls.filter((c) => c[0] === "loadTerrainRing");
  const buildings = calls.filter((c) => c[0] === "loadBuildingsForLandblock");

  check("Dericost (0, 0) 0x00008001 emits landblockChanged(0 -> 0x00008000)",
    emits.length === 1 && emits[0][1] === 0 && emits[0][2] === 0x00008000, JSON.stringify(emits));
  check("Dericost (0, 0) 0x00008001 passes non-zero 0x00008000 to noteServerLb",
    serverLbs.length === 1 && serverLbs[0] === 0x00008000, JSON.stringify(serverLbs));
  check("Dericost (0, 0) 0x00008001 triggers ensureTerrainAroundLandblock(0x00008000) and 3D loadTerrainRing(0, 0) + buildings(0, 0)",
    terrains.length === 1 && terrains[0][1] === 0x00008000 &&
    rings.length === 1 && rings[0][1] === 0 && rings[0][2] === 0 &&
    buildings.length === 1 && buildings[0][1] === 0 && buildings[0][2] === 0);

  // Heartbeat in same Dericost (0, 0) cell shift-skips outdoor ring and does not re-emit
  calls.length = 0;
  ws.onPositionUpdate({ kind: 0, guid: 1001, landblockId: 0x00008002, x: 12, y: 12 });
  check("Dericost (0, 0) heartbeat shift-skips outdoor ring and does not re-call building AABBs",
    calls.filter((c) => c[0] === "emitLandblockChanged").length === 0 &&
    calls.filter((c) => c[0] === "loadTerrainRing").length === 0 &&
    calls.filter((c) => c[0] === "ensureBuildingAabbsAroundLandblock").length === 0);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "All tests must pass");
process.exit(failed === 0 ? 0 : 1);
