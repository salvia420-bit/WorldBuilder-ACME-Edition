// tests/envcell_pool_reoffer.test.mjs
// Verification suite for Area 5: EnvCell Shell Pooling & Warm-Parked Static Drop Fix.
//
// 1. EnvCell Shell Pooling:
//    On cold boots, textures are pending BC7. Previously, pool_producer.js:280
//    explicitly skipped _holdOut for domain === "ec", permanently fusing all
//    cold-boot EnvCell surfaces into per-cell legacy meshes in cells.js:2347-2389
//    (causing 0/279 EnvCells pooled and hundreds of extra draw calls).
//    Now, domain === "ec" surfaces are held out, parented to meshGroup as temporary
//    singletons, and rehomed into the draw pools when atlasRefeed settles.
//
// 2. Warm-Parked Static Drop Fix:
//    Previously, pool_producer.js:854 (!h.node.parent) falsely dropped warm-PARKED
//    outdoor "st" holdouts as reOfferStale because park() detaches the landblock's
//    nodes from staticsGroup. Now, warm-PARKED nodes (isParked) are preserved and
//    re-offered into the pools.

import * as THREE from "three";
import assert from "node:assert/strict";

globalThis.location = { search: "" };
globalThis.window = globalThis;

import {
  initPoolWorld,
  poolWorldActive,
  poolWorldCensus,
  addSingletonsToPools,
  poolAtlasRefeed,
  getPoolWorld,
  _resetPoolWorldForTest,
} from "../scene3d/pool_producer.js";

import {
  armEnvCellPoolGroups,
  offerCellSurfacesToPools,
  poolCellVisibilityTick,
  releasePooledCellsForLb,
  envCellPoolCensus,
  _resetEnvCellPoolsForTest,
} from "../scene3d/pool_envcells.js";
import { getFrameWorkScheduler } from "../scene3d/frame_work.js";
import { tileOfLb } from "../scene3d/residency_grid.js";

import {
  initTexCompressedOnly,
  _setBc7SupportForTest,
  _resetTexCompressedOnlyForTest,
} from "../scene3d/bc7_textures.js";

import { _resetDrawPoolsForTest } from "../scene3d/pool_registry.js";

const ARMED_FLAGS = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";

function makeTriGeom() {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const norm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const baked = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(norm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("acBakedLight", new THREE.BufferAttribute(baked, 4, true));
  g.setIndex([0, 1, 2]);
  return g;
}

function makePageTex(size = 256) {
  const tex = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
  tex.needsUpdate = false;
  return tex;
}

console.log("TEST: EnvCell Shell Pooling & Warm-Parked Static Drop Fix");

// ============================================================================
// PART 1: Pending-BC7 EnvCell Shell Holdout & Re-Offer Pooling
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetEnvCellPoolsForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const staticsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const scene3d = {
    staticsGroup,
    cellsGroup,
    cellContainers3d: new Map(),
  };

  initPoolWorld({ THREE, group: staticsGroup, search: ARMED_FLAGS });
  armEnvCellPoolGroups({ staticsGroup, cellsGroup, indoorLayer: 1 });

  const RS_EC = 0x06001001;
  const LB_EC = 0x40400000;
  const CELL_ID = 0x40400101;

  // Material with BC7 pending
  const tex = makePageTex(256);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = {
    surfaceDid: 0x08001001,
    __pvwRsId: RS_EC,
    __texRsId: RS_EC,
    __bc7Pending: true,
    __acBakedLight: true,
  };

  const geom = makeTriGeom();
  const cellContainer = new THREE.Group();
  const meshGroup = new THREE.Group();
  cellContainer.add(meshGroup);
  cellsGroup.add(cellContainer);
  scene3d.cellContainers3d.set(CELL_ID, cellContainer);

  const entries = [
    {
      group: { geometry: geom, surfaceDid: 0x08001001 },
      material: mat,
    },
  ];

  // 1. Offer the EnvCell surfaces during cold boot
  const pooledFlags = offerCellSurfacesToPools(scene3d, {
    lbKey: LB_EC,
    cellId: CELL_ID,
    cellMatrix: new THREE.Matrix4(),
    meshGroup,
    entries,
  });

  const world = getPoolWorld();
  assert.equal(world.stats.heldOut, 1, "EnvCell surface was FILED in holdout ledger (not skipped!)");
  assert.equal(world.stats.heldOutByReason.bc7Pending, 1, "filed under bc7Pending reason");
  assert.equal(world.holdouts.has(RS_EC), true, "holdouts map has RS_EC");

  // The held-out mesh was parented to meshGroup as a temporary singleton
  assert.equal(meshGroup.children.length, 1, "meshGroup received temporary singleton mesh");
  const heldMesh = meshGroup.children[0];
  assert.equal(heldMesh.isMesh, true, "is a THREE.Mesh");
  assert.equal(heldMesh.parent, meshGroup, "parent is meshGroup");

  // pooledFlags returns true so cells.js does NOT fuse it into opaqueMesh
  assert.deepEqual(pooledFlags, [true], "pooledFlags is true so cells.js skips legacy fusion");

  // 2. Simulate BC7 texture landing and atlasRefeed
  delete mat.userData.__bc7Pending; // verdict settled
  const rehomed = poolAtlasRefeed(RS_EC);

  assert.equal(rehomed >= 1, true, "poolAtlasRefeed reported rehomed >= 1");
  assert.equal(world.stats.reOffered, 1, "reOffered incremented");
  assert.equal(world.stats.reOfferAdmitted, 1, "reOfferAdmitted incremented");
  assert.equal(world.stats.refeedRehomed, 1, "refeedRehomed incremented");

  // The held-out mesh was removed from meshGroup when admitted to pool
  assert.equal(heldMesh.parent, null, "held mesh removed from meshGroup");
  assert.equal(meshGroup.children.length, 0, "meshGroup is now empty (pool renders it!)");

  console.log("  ok - 1. Cold-boot EnvCell pending-BC7 holdouts rehomed into draw pools");
}

// ============================================================================
// PART 2: Warm-PARKED Outdoor "st" Holdouts Not Dropped as Stale
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const staticsGroup = new THREE.Group();
  const RS_ST = 0x06002002;
  const LB_PARKED = 0x50500000;

  const parkedSet = new Set([LB_PARKED]);
  const parkPoolMap = new Map();
  parkPoolMap.set(LB_PARKED, { statics: [], buildings: [] });

  const scene3d = {
    staticsGroup,
    landblockLru: {
      isParked: (k) => parkedSet.has(k >>> 0),
      parkPool: parkPoolMap,
    },
  };

  initPoolWorld({ THREE, group: staticsGroup, search: ARMED_FLAGS });

  const tex = makePageTex(256);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = {
    surfaceDid: 0x08002002,
    __pvwRsId: RS_ST,
    __texRsId: RS_ST,
    __bc7Pending: true,
  };

  const geom = makeTriGeom();
  const node = new THREE.Mesh(geom, mat);
  node.userData = { landblockId: LB_PARKED };

  // Initial feed while pending BC7
  const r = addSingletonsToPools([node], scene3d, { domain: "st", lbKey: LB_PARKED });
  assert.equal(r.pooled, 0, "pending node refused");
  assert.equal(r.passthrough[0], node, "returned in passthrough");

  const world = getPoolWorld();
  assert.equal(world.stats.heldOut, 1, "node held out in ledger");

  // Simulate warm-park: staticsGroup detaches node (parent = null)
  // and stashes it into parkPool.statics
  node.parent = null;
  parkPoolMap.get(LB_PARKED).statics.push(node);

  // Settle BC7 and trigger refeed
  delete mat.userData.__bc7Pending;
  poolAtlasRefeed(RS_ST);

  // CRITICAL ASSERTION: Warm-parked node was NOT dropped as stale!
  assert.equal(world.stats.reOfferStale, 0, "warm-PARKED holdout NOT counted as reOfferStale");
  assert.equal(world.stats.reOffered, 1, "warm-PARKED holdout was re-offered");
  assert.equal(world.stats.reOfferAdmitted, 1, "warm-PARKED holdout was admitted to pool");

  // And it was removed from parkPool.statics so unpark will not duplicate it
  assert.equal(parkPoolMap.get(LB_PARKED).statics.includes(node), false, "removed from park stash");

  console.log("  ok - 2. Warm-parked outdoor static holdouts preserved and pooled");
}

// ============================================================================
// PART 3: Truly Evicted Landblock Holdouts Properly Dropped as Stale
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const staticsGroup = new THREE.Group();
  const RS_EVICT = 0x06003003;
  const LB_EVICT = 0x60600000;

  const scene3d = {
    staticsGroup,
    landblockLru: {
      isParked: () => false, // NOT parked (truly evicted)
    },
  };

  initPoolWorld({ THREE, group: staticsGroup, search: ARMED_FLAGS });

  const tex = makePageTex(256);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = {
    surfaceDid: 0x08003003,
    __pvwRsId: RS_EVICT,
    __texRsId: RS_EVICT,
    __bc7Pending: true,
  };

  const geom = makeTriGeom();
  const node = new THREE.Mesh(geom, mat);
  node.userData = { landblockId: LB_EVICT };

  addSingletonsToPools([node], scene3d, { domain: "st", lbKey: LB_EVICT });

  const world = getPoolWorld();
  assert.equal(world.stats.heldOut, 1, "filed in holdout ledger");

  // Node parent is null and landblock is NOT parked => truly evicted!
  node.parent = null;

  delete mat.userData.__bc7Pending;
  poolAtlasRefeed(RS_EVICT);

  assert.equal(world.stats.reOfferStale, 1, "truly evicted node counted as reOfferStale");
  assert.equal(world.stats.reOfferAdmitted, 0, "evicted node not admitted to pool");

  console.log("  ok - 3. Truly evicted landblocks correctly dropped as reOfferStale");
}

// ============================================================================
// PART 4: releasePooledCellsForLb Purges Pending EnvCell Holdouts
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetEnvCellPoolsForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const staticsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const scene3d = { staticsGroup, cellsGroup, cellContainers3d: new Map() };

  initPoolWorld({ THREE, group: staticsGroup, search: ARMED_FLAGS });
  armEnvCellPoolGroups({ staticsGroup, cellsGroup });

  const RS_REL = 0x06004004;
  const LB_REL = 0x70700000;
  const CELL_REL = 0x70700101;

  const tex = makePageTex(256);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = {
    surfaceDid: 0x08004004,
    __pvwRsId: RS_REL,
    __texRsId: RS_REL,
    __bc7Pending: true,
  };

  const geom = makeTriGeom();
  const meshGroup = new THREE.Group();

  offerCellSurfacesToPools(scene3d, {
    lbKey: LB_REL,
    cellId: CELL_REL,
    cellMatrix: new THREE.Matrix4(),
    meshGroup,
    entries: [{ group: { geometry: geom, surfaceDid: 0x08004004 }, material: mat }],
  });

  const world = getPoolWorld();
  assert.equal(world.holdouts.has(RS_REL), true, "holdout was filed");

  // Releasing cells for this LB must purge the pending holdout to prevent leaks
  releasePooledCellsForLb(LB_REL);
  assert.equal(world.holdouts.has(RS_REL), false, "releasePooledCellsForLb purged pending holdout");

  console.log("  ok - 4. releasePooledCellsForLb clears pending holdouts without leaks");
}

// ============================================================================
// PART 5: Non-Identity cellMatrix Holdout & Re-Offer Preserves Exact Transform
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetEnvCellPoolsForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const staticsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const scene3d = { staticsGroup, cellsGroup, cellContainers3d: new Map() };

  initPoolWorld({ THREE, group: staticsGroup, search: ARMED_FLAGS });
  armEnvCellPoolGroups({ staticsGroup, cellsGroup, indoorLayer: 1 });

  const RS_XFORM = 0x06005005;
  const LB_XFORM = 0x00070000;
  const CELL_XFORM = 0x00070143;

  const tex = makePageTex(256);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = {
    surfaceDid: 0x08005005,
    __pvwRsId: RS_XFORM,
    __texRsId: RS_XFORM,
    __bc7Pending: true,
    __acBakedLight: true,
  };

  const geom = makeTriGeom();
  const cellContainer = new THREE.Group();
  const meshGroup = new THREE.Group();
  meshGroup.position.set(70, -60, 12);
  meshGroup.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  meshGroup.layers.set(1);
  meshGroup.updateMatrix();
  cellContainer.add(meshGroup);
  cellsGroup.add(cellContainer);
  cellsGroup.updateMatrixWorld(true);
  scene3d.cellContainers3d.set(CELL_XFORM, cellContainer);

  offerCellSurfacesToPools(scene3d, {
    lbKey: LB_XFORM,
    cellId: CELL_XFORM,
    cellMatrix: meshGroup.matrix.clone(),
    meshGroup,
    entries: [{ group: { geometry: geom, surfaceDid: 0x08005005 }, material: mat }],
  });

  assert.equal(meshGroup.children.length, 1, "held-out mesh added to meshGroup");
  const heldMesh = meshGroup.children[0];
  cellsGroup.updateMatrixWorld(true);

  // Held-out mesh must sit at local identity inside meshGroup so its matrixWorld
  // equals cellMatrix (NOT 2x cellMatrix!).
  assert.equal(heldMesh.position.x, 0, "heldMesh local X is 0");
  assert.equal(heldMesh.position.y, 0, "heldMesh local Y is 0");
  assert.equal(heldMesh.position.z, 0, "heldMesh local Z is 0");
  assert.equal(heldMesh.layers.mask, meshGroup.layers.mask, "heldMesh inherits indoor layer mask");
  for (let i = 0; i < 16; i += 1) {
    assert.ok(
      Math.abs(heldMesh.matrixWorld.elements[i] - meshGroup.matrixWorld.elements[i]) < 1e-6,
      `matrixWorld[${i}] matches meshGroup.matrixWorld (no double-transform)`,
    );
  }

  // When BC7 settles and poolAtlasRefeed runs, __poolCellPos/Quat/Scl must be
  // restored so the cellsGroup-parented draw pool receives the exact cellMatrix!
  delete mat.userData.__bc7Pending;
  const rehomed = poolAtlasRefeed(RS_XFORM);
  assert.equal(rehomed >= 1, true, "rehomed into pool");
  assert.equal(heldMesh.parent, null, "removed from meshGroup");
  assert.ok(Math.abs(heldMesh.position.x - 70) < 1e-6, "restored cell X=70 for pool admission");
  assert.ok(Math.abs(heldMesh.position.y - (-60)) < 1e-6, "restored cell Y=-60 for pool admission");
  assert.ok(Math.abs(heldMesh.position.z - 12) < 1e-6, "restored cell Z=12 for pool admission");

  console.log("  ok - 5. Non-identity cellMatrix holdout & re-offer avoids 2x double-transform");
}

// ============================================================================
// PART 6: Stage-C Aliased rsId Staging, W2 Non-Spin & Committed-Only Re-Offer
// ============================================================================
{
  _resetDrawPoolsForTest();
  _resetPoolWorldForTest();
  _resetEnvCellPoolsForTest();
  _resetTexCompressedOnlyForTest();

  _setBc7SupportForTest(true);

  const ARMED_STAGE_C = `${ARMED_FLAGS}&frameWork=on&uploadStage=on`;
  const sched = getFrameWorkScheduler();
  const staticsGroup = new THREE.Group();
  const cellsGroup = new THREE.Group();
  const scene3d = { staticsGroup, cellsGroup, cellContainers3d: new Map() };

  initPoolWorld({
    THREE,
    group: staticsGroup,
    renderer: { initTexture: () => {} },
    search: ARMED_STAGE_C,
  });
  armEnvCellPoolGroups({ staticsGroup, cellsGroup, indoorLayer: 1 });

  const world = getPoolWorld();
  assert.ok(world.controller && world.uploads, "Stage B+C controller + UploadStager armed");

  // Two distinct materials sharing ONE texture uuid with DIFFERENT rsIds:
  // previously mat2 hit `c.layerOf.get(uuid)` without staging RS_2, wedging
  // `flipDeferrals` forever!
  const sharedTex = makePageTex(256);
  const RS_1 = 0x06006001;
  const RS_2 = 0x06006002;
  const mat1 = new THREE.MeshStandardMaterial({ map: sharedTex });
  mat1.userData = { surfaceDid: 0x08006001, __texRsId: RS_1, __acBakedLight: true };
  const mat2 = new THREE.MeshStandardMaterial({ map: sharedTex });
  mat2.userData = { surfaceDid: 0x08006002, __texRsId: RS_2, __acBakedLight: true };

  // Also enqueue 3 extra U-TEX items so `uploads.drain()` hits its 2-item U-TEX
  // cap on frame 1 — verifying W2 does NOT busy-spin re-enqueueing itself!
  for (let k = 0; k < 3; k += 1) {
    world.uploads.enqueueTexture({
      texture: makePageTex(64),
      rsId: 0x06006100 + k,
      cls: "U-TEX",
      bytes: 1024,
    });
  }

  const LB_C = 0x80800000;
  const CELL_C = 0x80800101;
  const geom = makeTriGeom();
  const meshGroup = new THREE.Group();

  offerCellSurfacesToPools(scene3d, {
    lbKey: LB_C,
    cellId: CELL_C,
    cellMatrix: new THREE.Matrix4(),
    meshGroup,
    urgent: true,
    entries: [
      { group: { geometry: geom, surfaceDid: 0x08006001 }, material: mat1 },
      { group: { geometry: geom, surfaceDid: 0x08006002 }, material: mat2 },
    ],
  });

  // Before feed commits, 10 PVS ticks MUST NOT trigger any auto-reoffer tornado!
  for (let t = 0; t < 10; t += 1) {
    poolCellVisibilityTick(new Set([CELL_C]));
  }
  assert.equal(envCellPoolCensus().reofferedSurfaces, 0, "uncommitted cell never triggers 60Hz reoffer tornado");

  // Run P4 frames until uploads + feed commit cleanly
  for (let f = 0; f < 6; f += 1) {
    world.controller.tickP4();
    sched.run({});
  }
  assert.equal(world.uploads.isStaged(RS_1), true, "RS_1 staged");
  assert.equal(world.uploads.isStaged(RS_2), true, "aliased RS_2 staged via shared-uuid hit");
  assert.equal(world.registry.hasCell(CELL_C), true, "CELL_C committed to PoolRegistry");
  assert.equal(world.controller.stats_().feedsInFlight, 0, "0 feeds wedged in flight");

  // Record committed state in PVS, then simulate away-teleport SlotGrid vacate+release
  // while LandblockLRU keeps LB_C warm-parked.
  poolCellVisibilityTick(new Set([CELL_C]));
  const tileC = tileOfLb(0x80, 0x80);
  world.controller.onVacate(tileC);
  world.registry.releaseTile(tileC);
  assert.equal(world.registry.hasCell(CELL_C), false, "SlotGrid tile release cleared CELL_C");

  // Returning to LB_C: PVS auto-reoffers ONCE, readmitting vacated tileC instead
  // of abandoning the plan!
  poolCellVisibilityTick(new Set([CELL_C]));
  for (let t = 0; t < 10; t += 1) {
    poolCellVisibilityTick(new Set([CELL_C]));
  }
  assert.equal(envCellPoolCensus().reofferedLbs, 1, "auto-reoffer fired ONCE (never per-frame)");
  assert.equal(world.controller.stats.feedsAbandoned, 0, "readmitted tile accepted plan (0 abandoned)");
  for (let f = 0; f < 4; f += 1) {
    world.controller.tickP4();
    sched.run({});
  }
  assert.equal(world.registry.hasCell(CELL_C), true, "CELL_C re-committed cleanly after unpark");

  console.log("  ok - 6. Stage-C aliased rsId staging, non-spinning W2 & one-shot committed reoffer");
}

console.log("EnvCell Pool Re-Offer & Warm-Parked Drop: ALL 6 TEST SUITES PASSED.");
