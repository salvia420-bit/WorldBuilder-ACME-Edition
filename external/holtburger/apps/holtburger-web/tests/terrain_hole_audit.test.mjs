// tests/terrain_hole_audit.test.mjs — bug 5 (2026-10-07): walking across the
// map left terrain holes. The 1 Hz audit re-requests every draw-ring
// landblock that is parked, unbaked-and-idle, or marked baked with no mesh.
//
// Run from apps/holtburger-web/:  node tests/terrain_hole_audit.test.mjs

import assert from "node:assert/strict";
import { auditTerrainRing, TERRAIN_AUDIT_INTERVAL_MS } from "../scene3d/terrain_hole_audit.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const key = (x, y) => ((x << 24) | (y << 16)) >>> 0;
function makeScene({ r = 1, cx = 0xA4, cy = 0xB4 } = {}) {
  const baked = new Set();
  const children = [];
  const fired = [];
  const parked = new Set();
  const s = {
    terrainBakedLbs: baked,
    terrainGroup: { children },
    _pvsEffectiveRingRadius: r,
    landblockLru: { isParked: (k) => parked.has(k) },
    _streamGuardState: { inFlight: new Set() },
    loadTerrainForLandblock: (x, y) => { fired.push(key(x, y)); return Promise.resolve(null); },
  };
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const k = key(cx + dx, cy + dy);
    baked.add(k);
    children.push({ userData: { lbX: cx + dx, lbY: cy + dy, subdivLevel: 1 } });
  }
  return { s, baked, children, fired, parked, center: key(cx, cy) };
}

check("a fully loaded ring re-requests nothing", () => {
  const t = makeScene({ r: 2 });
  const a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.checked, 25);
  assert.equal(a.parked + a.unbaked + a.markNoMesh, 0);
  assert.equal(t.fired.length, 0);
});

check("a parked ring block is re-requested (the loader fast path unparks it)", () => {
  const t = makeScene({ r: 2 });
  t.parked.add(key(0xA6, 0xB4));
  const a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.parked, 1);
  assert.deepEqual(t.fired, [key(0xA6, 0xB4)]);
});

check("an unbaked, idle block is re-requested; one still loading is left alone", () => {
  const t = makeScene({ r: 1 });
  t.baked.delete(key(0xA5, 0xB5));
  t.baked.delete(key(0xA3, 0xB3));
  t.s._streamGuardState.inFlight.add(`terrain:${key(0xA3, 0xB3)}`);
  const a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.unbaked, 1);
  assert.deepEqual(t.fired, [key(0xA5, 0xB5)]);
});

check("a baked mark with no mesh (lost to a torn-down re-bake) is cleared and re-baked", () => {
  const t = makeScene({ r: 1 });
  const i = t.children.findIndex((c) => c.userData.lbX === 0xA4 && c.userData.lbY === 0xB5);
  t.children.splice(i, 1);
  const a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.markNoMesh, 1);
  assert.equal(t.baked.has(key(0xA4, 0xB5)), false);
  assert.deepEqual(t.fired, [key(0xA4, 0xB5)]);
});

check("runs at most once per interval", () => {
  const t = makeScene({ r: 1 });
  assert.ok(auditTerrainRing(t.s, t.center, 100));
  assert.equal(auditTerrainRing(t.s, t.center, 100 + TERRAIN_AUDIT_INTERVAL_MS - 1), null);
  assert.ok(auditTerrainRing(t.s, t.center, 100 + TERRAIN_AUDIT_INTERVAL_MS));
});

check("sealed dungeon / slot-grid (published radius 0) is never audited", () => {
  const t = makeScene({ r: 1 });
  t.baked.clear();
  t.s._pvsEffectiveRingRadius = 0;
  assert.equal(auditTerrainRing(t.s, t.center, 0), null);
  t.s._pvsEffectiveRingRadius = 1;
  t.s._sealedEvictLbKey = t.center;
  assert.equal(auditTerrainRing(t.s, t.center, 5000), null);
  assert.equal(t.fired.length, 0);
});

console.log(`\nterrain_hole_audit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
