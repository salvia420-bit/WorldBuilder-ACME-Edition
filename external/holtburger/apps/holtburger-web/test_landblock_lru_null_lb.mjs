// Batch 8 — LandblockLRU `lru-null-lb` guard test.
//
// Finding `likely:lru-null-lb`: tickEviction() must early-return when the
// player's current LB is unknown (getCurrentLbId() → null). Before the
// fix, a null current key meant the Chebyshev "always-resident 3×3 ring"
// floor was unknown, so eviction picked candidates purely by lastTouchMs
// and could blow away the player's own LB + ring (e.g. ?lbCap=4 at boot →
// pre-spawn ring flicker). With the guard, a null tick is a no-op: the
// resident set is left untouched until a real current LB resolves.
//
// landblock_lru.js is a ZERO-IMPORT LEAF (no THREE dependency), so this
// test imports it directly — no THREE_PATH needed.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_landblock_lru_null_lb.mjs

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

console.log("Batch 8 — LandblockLRU lru-null-lb guard");

// Minimal stub scene3d. evict() optional-chains every scene-graph access,
// so an empty object is enough for the eviction bookkeeping path. We pass
// only the disposable idempotency Sets so evict() can clear them.
function makeStubScene3d() {
  return {
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
  };
}

// Centre LB and its 3×3 ring (8 neighbours) → 9 keys total.
const CX = 0xa9;
const CY = 0xb4;
const centreKey = lbKeyFromXY(CX, CY);
const ringKeys = [];
for (let dy = -1; dy <= 1; dy += 1) {
  for (let dx = -1; dx <= 1; dx += 1) {
    ringKeys.push(lbKeyFromXY(CX + dx, CY + dy));
  }
}
check("ring fixture has 9 keys (centre + 8 neighbours)", ringKeys.length === 9, `len=${ringKeys.length}`);

// --- Test 1: null current LB → tickEviction is a no-op even with maxResident=1.
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 1,
    getCurrentLbId: () => null,
  });
  for (const k of ringKeys) lru.track(k);
  check("9 LBs tracked before null tick", lru.entries.size === 9, `size=${lru.entries.size}`);

  // Drive the tick the way the rAF loop does: getCurrentLbId() → null.
  lru.tickEviction(lru.getCurrentLbId());
  check("null tickEviction evicts NOTHING (resident stays 9)", lru.entries.size === 9, `size=${lru.entries.size}`);
  check("null tickEviction records ZERO evictions", lru.getStats().evicted === 0, `evicted=${lru.getStats().evicted}`);

  // Explicit null arg too (defensive — same path).
  lru.tickEviction(null);
  check("explicit null arg also a no-op (resident stays 9)", lru.entries.size === 9, `size=${lru.entries.size}`);
}

// --- Test 2: once a real current LB resolves, the always-resident 3×3
//     ring (Chebyshev <= 1) survives eviction even at maxResident=1.
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 1,
    getCurrentLbId: () => centreKey,
  });
  for (const k of ringKeys) lru.track(k);
  check("Test2: 9 LBs tracked", lru.entries.size === 9, `size=${lru.entries.size}`);

  lru.tickEviction(centreKey);
  // All 9 are within Chebyshev <= 1 of the centre, so none are eviction
  // candidates — the ring floor holds despite maxResident=1.
  check("real-key tick keeps the full 3×3 ring resident", lru.entries.size === 9, `size=${lru.entries.size}`);
  for (const k of ringKeys) {
    if (!lru.entries.has(k)) {
      check(`ring key 0x${k.toString(16)} still resident`, false);
      break;
    }
  }
  check("every ring key still resident", ringKeys.every((k) => lru.entries.has(k)));
}

// --- Test 3: a far LB OUTSIDE the ring IS evicted once the current key
//     resolves (proves the guard only suppresses the null case, not real
//     eviction).
{
  const lru = new LandblockLRU({
    scene3d: makeStubScene3d(),
    maxResident: 1,
    getCurrentLbId: () => centreKey,
  });
  for (const k of ringKeys) lru.track(k);
  // A far LB well outside Chebyshev 1 (10 LBs away on both axes).
  const farKey = lbKeyFromXY(CX + 10, CY + 10);
  lru.track(farKey);
  check("Test3: 10 LBs tracked (9 ring + 1 far)", lru.entries.size === 10, `size=${lru.entries.size}`);

  // null tick first: still a no-op even though we're over cap.
  lru.tickEviction(null);
  check("over-cap null tick still evicts nothing", lru.entries.size === 10, `size=${lru.entries.size}`);

  // real tick: the far LB (only non-ring candidate) is evicted; ring stays.
  lru.tickEviction(centreKey);
  check("real tick evicts the far (non-ring) LB", !lru.entries.has(farKey));
  check("ring survives the real eviction tick", ringKeys.every((k) => lru.entries.has(k)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
