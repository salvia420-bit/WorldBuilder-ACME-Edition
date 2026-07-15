// ?walkInInstance (2026-07-15) — the EVICTION CONTRACT test.
//
// There are TWO eviction contracts for statics nodes and they must not be
// confused, because each is wrong for the other's node:
//
//   per-LB nodes (singletons, per-LB BatchedMesh, and now walk-in InstancedMesh)
//     carry `userData.landblockId` and are removed by the per-LB scene-graph
//     walker in landblock_lru.evict() ("kill by userData.landblockId").
//   RING-wide instanced nodes span many LBs, carry NO landblockId, and are
//     refcount-evicted via `userData.coversLbKeys` — the walker MUST skip them,
//     or walking out of ONE landblock would delete statics belonging to the
//     other 120 still resident.
//
// ?walkInInstance introduces the first InstancedMesh that is per-LB. This test
// pins both halves of that: the walk-in node IS evicted (and disposed — its
// instanceMatrix is a GPU buffer the disposables list does not cover), and the
// ring node is NOT.
//
// Run: cd apps/holtburger-web/ && node test_walkin_instance_evict.mjs
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
if (!locateThree()) { console.log("walkin-instance-evict test: SKIP (three not located)."); process.exit(0); }

const THREE = await import("three");
const { LandblockLRU, lbKeyFromXY } = await import("./scene3d/landblock_lru.js");

let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

console.log("?walkInInstance — per-LB eviction contract");
console.log("=========================");

const LB_X = 0x40, LB_Y = 0x41;
const lbKey = lbKeyFromXY(LB_X, LB_Y);
const OTHER = lbKeyFromXY(0x50, 0x51);
const fullLandblockId = (((LB_X & 0xff) << 24) | ((LB_Y & 0xff) << 16) | 0x0012) >>> 0; // real ids carry a cell

const geom = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  return g;
};
const disposed = new Set();
const trackDispose = (o, tag) => {
  const orig = o.dispose.bind(o);
  o.dispose = () => { disposed.add(tag); orig(); };
  return o;
};

// The node ?walkInInstance pass 2 builds: per-LB, stamped landblockId.
const walkInInstanced = trackDispose(new THREE.InstancedMesh(geom(), new THREE.MeshBasicMaterial(), 4), "walkin");
walkInInstanced.name = "static-instanced-walkin";
walkInInstanced.userData = { landblockId: fullLandblockId, modelId: 0x11 };

// The node the RING baker builds: spans LBs, NO landblockId, coversLbKeys.
const ringInstanced = trackDispose(new THREE.InstancedMesh(geom(), new THREE.MeshBasicMaterial(), 9), "ring");
ringInstanced.name = "static-instanced-ring";
ringInstanced.userData = { modelId: 0x22, coversLbKeys: new Set([lbKey, OTHER]) };

// A per-LB BatchedMesh (pre-existing contract — must still be evicted+disposed).
const perLbBatched = trackDispose(new THREE.BatchedMesh(4, 64, 128, new THREE.MeshBasicMaterial()), "batched");
perLbBatched.name = "static-batch-perlb";
perLbBatched.userData = { landblockId: fullLandblockId, __staticBatch: true };

// A plain singleton on the SAME LB (pre-existing contract).
const singleton = new THREE.Mesh(geom(), new THREE.MeshBasicMaterial());
singleton.name = "static-singleton";
singleton.userData = { landblockId: fullLandblockId };

// A walk-in instanced node belonging to a DIFFERENT LB — must survive.
const otherLbInstanced = trackDispose(new THREE.InstancedMesh(geom(), new THREE.MeshBasicMaterial(), 2), "other");
otherLbInstanced.name = "static-instanced-otherlb";
otherLbInstanced.userData = { landblockId: (((0x50 & 0xff) << 24) | ((0x51 & 0xff) << 16)) >>> 0 };

const staticsGroup = new THREE.Group();
staticsGroup.add(walkInInstanced, ringInstanced, perLbBatched, singleton, otherLbInstanced);

const scene3d = {
  staticsGroup,
  activeLights: [],
  terrainBakedLbs: new Set(),
  buildingsBakedLbs: new Set(),
  staticsBakedLbs: new Set([lbKey]),
  envCellLoadedLbs: new Set(),
  terrainMaterials: [],
};
const lru = new LandblockLRU({ scene3d, maxResident: 64, getCurrentLbId: () => OTHER });
lru.track(lbKey);
lru.evict(lbKey);

const names = staticsGroup.children.map((c) => c.name);
check("1: walk-in InstancedMesh IS evicted (userData.landblockId matched)",
  !names.includes("static-instanced-walkin"), names.join(","));
check("2: walk-in InstancedMesh IS disposed (instanceMatrix is a GPU buffer)",
  disposed.has("walkin"), disposed.has("walkin") ? "" : "LEAK — dispose never called");
check("3: RING InstancedMesh is NOT evicted (no landblockId; coversLbKeys refcount owns it)",
  names.includes("static-instanced-ring"),
  names.includes("static-instanced-ring") ? "" : "would delete statics of 120 resident LBs");
check("4: RING InstancedMesh is NOT disposed", !disposed.has("ring"));
check("5: per-LB BatchedMesh still evicted + disposed (pre-existing contract intact)",
  !names.includes("static-batch-perlb") && disposed.has("batched"));
check("6: plain singleton still evicted (pre-existing contract intact)",
  !names.includes("static-singleton"));
check("7: another LB's walk-in instanced node survives + is not disposed",
  names.includes("static-instanced-otherlb") && !disposed.has("other"));

console.log("=========================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
