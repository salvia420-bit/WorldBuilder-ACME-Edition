// Session 11 (1118 §4) — sealed keep-ring escape-hatch suite.
//
// Companion to test_landblock_lru_evict.mjs Test 8 (which covers the
// DEFAULT-ON behavior: the sealed purge keeps the dungeon LB's 3×3 floor so
// onPositionUpdate's per-packet 3×3 re-stream can't ping-pong against the
// purge — the measured TN park↔unpark storm, PRE 3–6k ops/stop).
//
// SEALED_KEEP_RING_ON is a module-load const read from window.location.search,
// so this suite installs a window stub with ?sealedKeepRing=off BEFORE the
// dynamic import to exercise the LEGACY park-everything-but-keep arm and prove
// the escape hatch genuinely flips the floor back to keep-only.
//
// Run with: node test_landblock_lru_sealed_keepring.mjs

// warmPark=off pins classic evict (a present window stub otherwise defaults
// warmPark ON, which would PARK the ring instead of evicting it).
globalThis.window = { location: { search: "?sealedKeepRing=off&warmPark=off" } };

const { LandblockLRU, lbKeyFromXY } = await import("./scene3d/landblock_lru.js");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("Session 11 — sealed keep-ring escape hatch (?sealedKeepRing=off)");

function makeStubScene3d() {
  return {
    staticsGroup: { children: [], remove() {} },
    activeLights: [],
    terrainBakedLbs: new Set(),
    buildingsBakedLbs: new Set(),
    staticsBakedLbs: new Set(),
    envCellLoadedLbs: new Set(),
    terrainMaterials: [],
  };
}

// Classic mode (no ?warmPark ⇒ warmParkEnabled false), so the purge EVICTS.
// With ?sealedKeepRing=off the floor collapses to keep-only, so every
// neighbour — including the 3×3 — is reclaimed (the legacy 127→~2 behavior).
{
  const scene3d = makeStubScene3d();
  const keep = lbKeyFromXY(0x40, 0x40);
  const lru = new LandblockLRU({ scene3d, maxResident: 1, getCurrentLbId: () => keep });
  lru.track(keep);
  const ring = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const k = lbKeyFromXY(0x40 + dx, 0x40 + dy);
      ring.push(k);
      lru.track(k);
    }
  }
  lru.track(lbKeyFromXY(0x10, 0x10));
  lru.track(lbKeyFromXY(0x60, 0x60));
  check("off: 11 LBs tracked (keep + 8 ring + 2 far)", lru.entries.size === 11, `size=${lru.entries.size}`);

  lru.tickEviction(keep, keep);
  check("off: keep LB retained", lru.entries.has(keep));
  check("off: the 3×3 ring IS reclaimed (legacy — no floor exemption)",
    ring.every((k) => !lru.entries.has(k)),
    `resident=${ring.filter((k) => lru.entries.has(k)).length}/8`);
  check("off: only the keep LB remains", lru.entries.size === 1, `size=${lru.entries.size}`);
  check("off: all 10 non-keep LBs reclaimed", lru.getStats().evicted === 10, `evicted=${lru.getStats().evicted}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
