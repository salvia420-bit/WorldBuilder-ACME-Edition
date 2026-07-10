// Session 8 (2026-07-10) — teleport-destination urgent lane tests
// (1115 §4 top item: flush-vs-priority → PRIORITY).
//
// s8 capture finding: the urgency predicate `isNearPlayerLb` keyed ONLY
// off the rig-derived `getCurrentLbId`, which under bake saturation lags a
// teleport by many seconds (17.5s first-hop; the destination 3×3 was
// cap-skipped 299× in the normal lane the whole time). The fix stamps the
// server-authoritative LB from the position-update stream
// (`LandblockLRU.noteServerLb`, both A15-Q4-SYNC copies) and lets urgency
// honor EITHER center. Eviction/reclaim keep reading the rig center only.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_landblock_lru_server_urgency.mjs

const { LandblockLRU, lbKeyFromXY, isNearPlayerLb } = await import(
  "./scene3d/landblock_lru.js"
);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("Session 8 — LandblockLRU server-authoritative urgency lane");

function makeScene3d(rigLbKey) {
  const scene3d = {
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    terrainMaterials: [],
    activeLights: [],
  };
  const lru = new LandblockLRU({
    scene3d,
    maxResident: 200,
    getCurrentLbId: () => rigLbKey,
  });
  scene3d.landblockLru = lru;
  return { scene3d, lru };
}

const A = lbKeyFromXY(0x10, 0x10); // rig town
const B = lbKeyFromXY(0xa9, 0xb4); // teleport destination (far from A)
const B_N1 = lbKeyFromXY(0xa8, 0xb3); // Chebyshev 1 from B
const B_N2 = lbKeyFromXY(0xa7, 0xb4); // Chebyshev 2 from B
const C = lbKeyFromXY(0x60, 0x60); // far from both

// (1) rig-only behavior intact: near the rig LB is urgent, far is not.
{
  const { scene3d } = makeScene3d(A);
  check("(1a) rig LB urgent (pre-fix behavior intact)", isNearPlayerLb(scene3d, A) === true);
  check("(1b) rig 3×3 neighbour urgent", isNearPlayerLb(scene3d, lbKeyFromXY(0x11, 0x11)) === true);
  check("(1c) far LB not urgent with no server note", isNearPlayerLb(scene3d, B) === false);
}

// (2) teleport window: rig still at A, server note at B → B goes urgent,
//     A stays urgent (rig), unrelated C stays normal.
{
  const { scene3d, lru } = makeScene3d(A);
  lru.noteServerLb(B);
  check("(2a) destination urgent while rig lags", isNearPlayerLb(scene3d, B) === true);
  check("(2b) destination Chebyshev-1 neighbour urgent", isNearPlayerLb(scene3d, B_N1) === true);
  check("(2c) destination Chebyshev-2 NOT urgent (radius honored)", isNearPlayerLb(scene3d, B_N2) === false);
  check("(2d) rig center still urgent (OR, not replace)", isNearPlayerLb(scene3d, A) === true);
  check("(2e) unrelated LB still normal lane", isNearPlayerLb(scene3d, C) === false);
}

// (3) noteServerLb accepts a full landblockId (cell bits masked off).
{
  const { scene3d, lru } = makeScene3d(A);
  lru.noteServerLb(((0xa9 << 24) | (0xb4 << 16) | 0x001a) >>> 0);
  check("(3a) full landblockId masked to lb-key", lru._serverLbKey === B);
  check("(3b) urgency reads the masked key", isNearPlayerLb(scene3d, B) === true);
}

// (4) 0/invalid clears the note (fail-soft back to rig-only).
{
  const { scene3d, lru } = makeScene3d(A);
  lru.noteServerLb(B);
  lru.noteServerLb(0);
  check("(4a) noteServerLb(0) clears", lru._serverLbKey === null);
  check("(4b) cleared note → destination back to normal lane", isNearPlayerLb(scene3d, B) === false);
  lru.noteServerLb(null);
  check("(4c) noteServerLb(null) tolerated (stays cleared)", lru._serverLbKey === null);
}

// (5) rig catch-up: once getCurrentLbId returns B too, the note is
//     redundant — same answers.
{
  const { scene3d, lru } = makeScene3d(B);
  lru.noteServerLb(B);
  check("(5a) agree-case urgent", isNearPlayerLb(scene3d, B) === true);
  check("(5b) agree-case far LB normal", isNearPlayerLb(scene3d, C) === false);
}

// (6) fail-soft: no LRU wired / bare scene3d → false, no throw.
{
  check("(6a) no landblockLru → false", isNearPlayerLb({}, B) === false);
  check("(6b) null scene3d → false", isNearPlayerLb(null, B) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
