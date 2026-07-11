// test_lb_objects_shared.mjs — A7-F1 shared LandblockInfo placement cache
// (scene3d/lb_objects_shared.js). Locks in: (1) two consumers share ONE wasm
// fetch; (2) wasm records drained+freed exactly once; (3) 2-read drop; (4) a
// REJECTED fetch is not sticky (statics/buildings starved-retry pairing);
// (5) hard FIFO cap; (6) clearForLb accepts lbId/lbKey/cellId forms.
import {
  fetchLandblockObjectsShared,
  clearForLb,
  clear,
  _cacheSize,
  LB_OBJECTS_SHARED_MAX_ENTRIES,
} from "./scene3d/lb_objects_shared.js";

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed += 1; } else { failed += 1; console.error(`FAIL: ${name}`); }
};

const mkPlacement = (modelId, isBuilding) => {
  const p = {
    landblockId: 0x11220000, modelId, x: 1, y: 2, z: 3, rotationZ: 0,
    qw: 1, qx: 0, qy: 0, qz: 0, isBuilding,
    defaultScriptId: 0, defaultAnimationId: 0,
    freed: 0,
  };
  p.free = () => { p.freed += 1; };
  return p;
};

// ── 1+2: two concurrent readers share one fetch; records freed once ──
{
  clear();
  let calls = 0;
  const placements = [mkPlacement(0x01000001, true), mkPlacement(0x01000002, false)];
  const wasm = {
    fetch_landblock_objects: async () => { calls += 1; return placements; },
  };
  const cellId = (0x1122fffe) >>> 0;
  const [a, b] = await Promise.all([
    fetchLandblockObjectsShared(wasm, cellId, true),
    fetchLandblockObjectsShared(wasm, cellId, false),
  ]);
  check("one wasm call for two readers", calls === 1);
  check("same snapshot array shared", a === b);
  check("snapshot carries fields", a.length === 2 && a[0].modelId === 0x01000001 && a[0].isBuilding === true);
  check("wasm records freed exactly once", placements.every((p) => p.freed === 1));
  check("2-read drop evicted the entry", _cacheSize() === 0);
  const c = await fetchLandblockObjectsShared(wasm, cellId, true);
  check("post-drop read re-fetches", calls === 2 && c !== a);
}

// ── 4: rejection is not sticky ──
{
  clear();
  let calls = 0;
  const wasm = {
    fetch_landblock_objects: async () => {
      calls += 1;
      if (calls === 1) throw new Error("starved");
      return [mkPlacement(0x01000003, false)];
    },
  };
  const cellId = (0x3344fffe) >>> 0;
  let rejected = false;
  try { await fetchLandblockObjectsShared(wasm, cellId, true); } catch (_) { rejected = true; }
  check("first fetch rejected to caller", rejected);
  check("rejected entry evicted (not sticky)", _cacheSize() === 0);
  const snap = await fetchLandblockObjectsShared(wasm, cellId, true);
  check("retry re-fetches after rejection", calls === 2 && snap.length === 1);
}

// ── 5: hard FIFO cap ──
{
  clear();
  const wasm = { fetch_landblock_objects: async () => [] };
  // Single-reader path only (reads never hit 2) → entries linger → cap binds.
  const pending = [];
  for (let i = 0; i < LB_OBJECTS_SHARED_MAX_ENTRIES + 8; i += 1) {
    const cellId = (((0x40 + i) << 24) | (0x01 << 16) | 0xfffe) >>> 0;
    pending.push(fetchLandblockObjectsShared(wasm, cellId, false));
  }
  await Promise.all(pending);
  check("FIFO cap bounds the cache", _cacheSize() <= LB_OBJECTS_SHARED_MAX_ENTRIES);
}

// ── 6: clearForLb id-form tolerance ──
{
  clear();
  const wasm = { fetch_landblock_objects: async () => [] };
  const cellId = (0x5566fffe) >>> 0;
  fetchLandblockObjectsShared(wasm, cellId, false); // single read → lingers
  await Promise.resolve();
  check("entry present before clear", _cacheSize() === 1);
  clearForLb(0x55660000); // full landblockId form
  check("clearForLb(lbId) evicts", _cacheSize() === 0);
  fetchLandblockObjectsShared(wasm, cellId, false);
  clearForLb(cellId); // cellId form
  check("clearForLb(cellId) evicts", _cacheSize() === 0);
}

console.log(`lb-objects-shared: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
