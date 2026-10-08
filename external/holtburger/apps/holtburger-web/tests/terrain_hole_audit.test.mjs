// tests/terrain_hole_audit.test.mjs — bug 5 (2026-10-07): walking across the
// map left terrain holes. The 1 Hz audit re-requests every draw-ring
// landblock that is parked, unbaked-and-idle, or marked baked with no mesh.
// 2026-10-07 (false holes): ring-sweep backlog is `pending`, not a hole —
// only NEGLECTED blocks are counted and re-requested.
//
// Run from apps/holtburger-web/:  node tests/terrain_hole_audit.test.mjs

import assert from "node:assert/strict";
import {
  auditTerrainRing,
  TERRAIN_AUDIT_INTERVAL_MS,
  TERRAIN_AUDIT_GRACE_MS,
} from "../scene3d/terrain_hole_audit.js";

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

check("a parked ring block is re-requested at once (fast-path unpark) but only counted if it stays parked", () => {
  const t = makeScene({ r: 2 });
  t.parked.add(key(0xA6, 0xB4));
  let a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.parked, 0, "a just-unparked block is not a hole");
  assert.equal(a.pending, 1);
  assert.deepEqual(t.fired, [key(0xA6, 0xB4)]);
  // The unpark never takes (stuck): a genuine hole once the grace is up.
  a = auditTerrainRing(t.s, t.center, TERRAIN_AUDIT_GRACE_MS);
  assert.equal(a.parked, 1);
  assert.equal(t.fired.length, 2);
});

check("an unbaked block with an idle, latched stream is re-requested on the 2nd audit; one still loading is left alone", () => {
  const t = makeScene({ r: 1 });
  t.baked.delete(key(0xA5, 0xB5));
  t.baked.delete(key(0xA3, 0xB3));
  t.s._streamGuardState.inFlight.add(`terrain:${key(0xA3, 0xB3)}`);
  // First sighting: could be the sweep's next pick — pending, not fired.
  let a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.unbaked, 0);
  assert.equal(a.pending, 1);
  assert.deepEqual(t.fired, []);
  // The loading block finishes elsewhere; the guard goes idle and the sweep
  // is latched complete → nobody will start 0xA5B5: neglected.
  t.s._streamGuardState.inFlight.clear();
  t.baked.add(key(0xA3, 0xB3));
  a = auditTerrainRing(t.s, t.center, TERRAIN_AUDIT_INTERVAL_MS);
  assert.equal(a.unbaked, 1);
  assert.deepEqual(t.fired, [key(0xA5, 0xB5)]);
});

check("ring-sweep backlog after a crossing is pending, never a hole, and is not re-asked", () => {
  // r=5 crossing east: the new edge row (11 blocks) is unbaked while the
  // sweep drains nearest-first behind a full guard (live: holes=11 per crossing).
  const t = makeScene({ r: 5 });
  const center2 = key(0xA5, 0xB4);
  t.s._pvsSweepIncomplete = true;
  const inF = t.s._streamGuardState.inFlight;
  let now = 0;
  let totalHoles = 0;
  for (let i = 0; i < 8; i++, now += TERRAIN_AUDIT_INTERVAL_MS) {
    // The sweep keeps the guard busy and lands one edge block per second.
    inF.clear();
    inF.add(`terrain:${key(0xAA, 0xAF + i)}`);
    if (i > 0) {
      t.baked.add(key(0xAA, 0xAF + i - 1));
      t.children.push({ userData: { lbX: 0xAA, lbY: 0xAF + i - 1, subdivLevel: 1 } });
    }
    const a = auditTerrainRing(t.s, center2, now);
    totalHoles += a.parked + a.unbaked + a.markNoMesh;
    assert.ok(a.pending > 0);
  }
  assert.equal(totalHoles, 0, "backlog must never be reported as holes");
  assert.deepEqual(t.fired, [], "backlog must not be re-requested (no guard asks / order churn)");
});

check("a stalled stream (busy guard, no progress) reports the block after the grace", () => {
  const t = makeScene({ r: 1 });
  t.baked.delete(key(0xA5, 0xB5));
  t.s._pvsSweepIncomplete = true;
  // A hung bake elsewhere holds the guard: in-flight never changes.
  t.s._streamGuardState.inFlight.add("statics:12345");
  let a = null;
  for (let now = 0; now < TERRAIN_AUDIT_GRACE_MS; now += TERRAIN_AUDIT_INTERVAL_MS) {
    a = auditTerrainRing(t.s, t.center, now);
    assert.equal(a.unbaked, 0, `not a hole inside the grace (t=${now})`);
  }
  assert.deepEqual(t.fired, []);
  a = auditTerrainRing(t.s, t.center, TERRAIN_AUDIT_GRACE_MS + TERRAIN_AUDIT_INTERVAL_MS);
  assert.equal(a.unbaked, 1);
  assert.deepEqual(t.fired, [key(0xA5, 0xB5)]);
});

check("a block that left the ring drops its clock (bounded state)", () => {
  const t = makeScene({ r: 1 });
  t.baked.delete(key(0xA5, 0xB5));
  t.s._pvsSweepIncomplete = true;
  auditTerrainRing(t.s, t.center, 0);
  assert.equal(t.s._terrainAuditState.missingSince.has(key(0xA5, 0xB5)), true);
  auditTerrainRing(t.s, key(0x10, 0x10), TERRAIN_AUDIT_INTERVAL_MS);
  assert.equal(t.s._terrainAuditState.missingSince.has(key(0xA5, 0xB5)), false);
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

check("a baked mark with no mesh WHILE its bake is in flight (prewarm window) is left alone", () => {
  // terrain.js marks the LB, then awaits prewarmSubtree before attaching the
  // mesh; clearing the mark there made the bake throw its own mesh away.
  const t = makeScene({ r: 1 });
  const i = t.children.findIndex((c) => c.userData.lbX === 0xA4 && c.userData.lbY === 0xB5);
  t.children.splice(i, 1);
  t.s._streamGuardState.inFlight.add(`terrain:${key(0xA4, 0xB5)}`);
  const a = auditTerrainRing(t.s, t.center, 0);
  assert.equal(a.markNoMesh, 0);
  assert.equal(t.baked.has(key(0xA4, 0xB5)), true, "mark must survive the prewarm await");
  assert.deepEqual(t.fired, []);
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
