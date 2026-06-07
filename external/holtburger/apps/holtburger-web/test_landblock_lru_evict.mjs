// Batch 11 — LandblockLRU InstancedMesh refcount eviction test (#7).
//
// Finding #7: the cross-LB statics InstancedMesh / LOD nodes batch
// placements from EVERY LB in the bake ring into a single draw call, so
// they must NOT be removed/disposed until the LAST covered LB evicts.
// Before the fix, eviction either ignored them (VBO leak — node never
// disposed) or, in a naive single-LB scheme, would have disposed a node
// still drawing statics for other resident LBs (z-fight / disappearing
// trees). The fix tracks each node under every covered lb-key
// (`userData.coversLbKeys` Set) and refcounts on eviction:
//   - drop THIS lbKey from the node's coversLbKeys Set
//   - if the Set is now empty → remove from staticsGroup + dispose
//     GEOMETRY ONLY (material is `__cacheOwned`, shared — never disposed)
//   - else keep the node live AND re-mark this LB statics-baked (so a
//     re-walk doesn't bake duplicate singletons on top of the live node)
//
// landblock_lru.js is a ZERO-IMPORT LEAF (no THREE dependency), so this
// test imports it directly — no THREE_PATH needed.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_landblock_lru_evict.mjs

import { LandblockLRU, lbKeyFromXY } from "./scene3d/landblock_lru.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("Batch 11 — LandblockLRU InstancedMesh refcount eviction (#7)");

// Stub scene3d. evict() optional-chains scene-graph access; we provide a
// staticsGroup with a recording remove(), plus the idempotency Sets so
// evict() can clear them (and step 6b can re-add staticsBakedLbs).
function makeStubScene3d() {
  const removed = [];
  return {
    staticsGroup: {
      children: [],
      remove(node) { removed.push(node); },
    },
    _removed: removed,
    activeLights: [],
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
  };
}

// Fake InstancedMesh-like node: a coversLbKeys Set, a geometry with a
// dispose spy, and a __cacheOwned material whose dispose MUST NOT fire.
function makeFakeInstancedNode(coverKeys) {
  const geomDisposes = { n: 0 };
  const matDisposes = { n: 0 };
  return {
    isFakeNode: true,
    userData: { coversLbKeys: new Set(coverKeys) },
    geometry: { dispose() { geomDisposes.n += 1; } },
    material: { userData: { __cacheOwned: true }, dispose() { matDisposes.n += 1; } },
    parent: null,
    removeFromParent() { this.parent = null; },
    _geomDisposes: geomDisposes,
    _matDisposes: matDisposes,
  };
}

// Fake LOD-wrapper node: levels[].object.geometry each with a dispose spy.
function makeFakeLodNode(coverKeys) {
  const d0 = { n: 0 };
  const d1 = { n: 0 };
  return {
    isFakeLod: true,
    userData: { coversLbKeys: new Set(coverKeys), isInstancedLod: true },
    levels: [
      { object: { geometry: { dispose() { d0.n += 1; } } } },
      { object: { geometry: { dispose() { d1.n += 1; } } } },
    ],
    removeFromParent() {},
    _d0: d0,
    _d1: d1,
  };
}

const keyA = lbKeyFromXY(0x10, 0x10); // far apart so neither is in the
const keyB = lbKeyFromXY(0x40, 0x40); // other's always-resident ring.

// --- Test 1: a node covering {keyA, keyB} survives evict(keyA), then is
//     disposed on evict(keyB).
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({
    scene3d,
    maxResident: 1,
    getCurrentLbId: () => null,
  });
  const node = makeFakeInstancedNode([keyA, keyB]);
  lru.track(keyA, { instancedNodes: [node] });
  lru.track(keyB, { instancedNodes: [node] });
  check("both LBs tracked", lru.entries.size === 2, `size=${lru.entries.size}`);

  // Evict keyA: the node still covers keyB → NOT removed/disposed.
  lru.evict(keyA);
  check("evict(keyA): node geometry NOT disposed (still covers keyB)", node._geomDisposes.n === 0, `n=${node._geomDisposes.n}`);
  check("evict(keyA): node NOT removed from staticsGroup", scene3d._removed.length === 0, `removed=${scene3d._removed.length}`);
  check("evict(keyA): coversLbKeys === {keyB}", node.userData.coversLbKeys.size === 1 && node.userData.coversLbKeys.has(keyB), `keys=${[...node.userData.coversLbKeys].map(k=>k.toString(16))}`);
  check("evict(keyA): keyA RE-MARKED statics-baked (node still draws it)", scene3d.staticsBakedLbs.has(keyA));
  check("evict(keyA): entry for keyA removed from LRU", !lru.entries.has(keyA));

  // Evict keyB: last covered LB → node removed + geometry disposed once.
  lru.evict(keyB);
  check("evict(keyB): node geometry disposed exactly once", node._geomDisposes.n === 1, `n=${node._geomDisposes.n}`);
  check("evict(keyB): node removed from staticsGroup", scene3d._removed.length === 1 && scene3d._removed[0] === node, `removed=${scene3d._removed.length}`);
  check("evict(keyB): __cacheOwned material NEVER disposed", node._matDisposes.n === 0, `n=${node._matDisposes.n}`);
  check("evict(keyB): coversLbKeys now empty", node.userData.coversLbKeys.size === 0);
  check("evict(keyB): keyB NOT re-marked statics-baked (node gone)", !scene3d.staticsBakedLbs.has(keyB));
  check("evict(keyB): entry for keyB removed from LRU", !lru.entries.has(keyB));
}

// --- Test 2: a singleton-only LB (no instanced node) evicts as today.
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => null });
  lru.track(keyA); // no disposables, no instancedNodes
  check("Test2: singleton LB tracked", lru.entries.has(keyA));
  const ok = lru.evict(keyA);
  check("Test2: singleton evict returns true", ok === true);
  check("Test2: singleton evict removed nothing from staticsGroup", scene3d._removed.length === 0);
  check("Test2: singleton evict clears staticsBakedLbs (not re-marked)", !scene3d.staticsBakedLbs.has(keyA));
  check("Test2: singleton entry removed", !lru.entries.has(keyA));
}

// --- Test 3: a single-LB instanced node (covers only {keyA}) is disposed
//     immediately on evict(keyA) — refcount reaches 0 in one eviction.
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => null });
  const node = makeFakeInstancedNode([keyA]);
  lru.track(keyA, { instancedNodes: [node] });
  lru.evict(keyA);
  check("Test3: single-LB node geometry disposed once", node._geomDisposes.n === 1, `n=${node._geomDisposes.n}`);
  check("Test3: single-LB node removed from staticsGroup", scene3d._removed.length === 1 && scene3d._removed[0] === node);
  check("Test3: single-LB node material NOT disposed", node._matDisposes.n === 0);
  check("Test3: keyA NOT re-marked statics-baked", !scene3d.staticsBakedLbs.has(keyA));
}

// --- Test 4: LOD-wrapped node disposes BOTH levels' geometries on final
//     evict; survives an earlier eviction of a co-covered LB.
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => null });
  const lod = makeFakeLodNode([keyA, keyB]);
  lru.track(keyA, { instancedNodes: [lod] });
  lru.track(keyB, { instancedNodes: [lod] });

  lru.evict(keyA);
  check("Test4: LOD survives co-covered evict (level0 geom not disposed)", lod._d0.n === 0);
  check("Test4: LOD survives co-covered evict (level1 geom not disposed)", lod._d1.n === 0);

  lru.evict(keyB);
  check("Test4: LOD level0 geometry disposed once on final evict", lod._d0.n === 1, `n=${lod._d0.n}`);
  check("Test4: LOD level1 geometry disposed once on final evict", lod._d1.n === 1, `n=${lod._d1.n}`);
}

// --- Test 5: track() dedups a node re-listed under the SAME key (a
//     re-walk / idempotent re-bake must not list the node twice, which
//     would double-dispose its geometry).
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => null });
  const node = makeFakeInstancedNode([keyA]);
  lru.track(keyA, { instancedNodes: [node] });
  lru.track(keyA, { instancedNodes: [node] }); // re-track same node + key
  const bucket = lru.entries.get(keyA).disposables.instancedNodes;
  check("Test5: node listed exactly once after re-track", bucket.length === 1, `len=${bucket.length}`);
  lru.evict(keyA);
  check("Test5: geometry disposed exactly once (no double-dispose)", node._geomDisposes.n === 1, `n=${node._geomDisposes.n}`);
}

// --- Test 6: disposables record finalized shape includes instancedNodes.
{
  const scene3d = makeStubScene3d();
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => null });
  lru.track(keyA);
  const d = lru.entries.get(keyA).disposables;
  check("Test6: disposables has geometries/materials/textures/lights/instancedNodes",
    Array.isArray(d.geometries) && Array.isArray(d.materials) && Array.isArray(d.textures) && Array.isArray(d.lights) && Array.isArray(d.instancedNodes));
}

// --- Test 7 (pvs-signed-key shared helper): lbKeyOf masks unsigned.
//     The plan's GATE: lbKeyOf(0xA9B40000)>>>0 === 2847145984.
import { lbKeyOf } from "./scene3d/landblock_lru.js";
{
  check("Test7: lbKeyOf(0xA9B40000) === 2847145984 (unsigned, not negative)",
    (lbKeyOf(0xA9B40000) >>> 0) === 2847145984,
    `got=${lbKeyOf(0xA9B40000) >>> 0}`);
  check("Test7: raw `& 0xffff0000` WOULD be negative (proves the bug exists)",
    (0xA9B40000 & 0xffff0000) < 0,
    `raw=${0xA9B40000 & 0xffff0000}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
