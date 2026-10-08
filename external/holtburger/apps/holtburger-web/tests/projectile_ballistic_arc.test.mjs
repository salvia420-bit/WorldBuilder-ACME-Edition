// projectile_ballistic_arc.test.mjs — physupd-2 (2026-10-08, `?projectileExactArc`).
//
// Retail `CPhysicsObj::UpdatePhysicsInternal` (acclient.c:317756-317776) moves
// a missile by v·q + ½·a·q² from the OLD velocity and only THEN applies
// v += a·q — exact for constant gravity at any quantum, so the client arc is
// frame-rate independent and matches ACE's. The legacy semi-implicit Euler
// sank 0.5·g·q·T below it. ALIGN_PATH heads along the step's chord
// (acclient.c:322800-322804).
//
// Drives the REAL `_tickBallisticProjectiles` (+ the helpers it calls) lifted
// out of scene3d/entities.js by brace matching, on a fake performance clock.
//
// Run: node tests/projectile_ballistic_arc.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";

const SRC = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
function methodSource(name) {
  const start = SRC.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `method ${name} not found`);
  const i = SRC.indexOf("{", SRC.indexOf(")", start));
  let depth = 0;
  for (let j = i; j < SRC.length; j += 1) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start + 1, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const METHODS = [
  "_tickBallisticProjectiles",
  "_stopBallisticProjectile",
  "_setProjectileLightsOn",
  "_spinProjectile",
  "_alignToVelocity",
].map(methodSource).join("\n");
const makeHarness = (exact) => new Function(`
  const PROJECTILE_GRAVITY_Z = -9.8;
  const PROJECTILE_TERRAIN_STOP_ON = false;
  const PROJECTILE_TERRAIN_STOP_EPS = 0.25;
  const PROJECTILE_EXACT_ARC_ON = ${exact};
  const PROJECTILE_ENV_SWEEP_ON = false;
  const _terrainZAt = () => null;
  return class { ${METHODS} };
`)();
const Exact = makeHarness(true);
const Legacy = makeHarness(false);

// Fake wall clock (the tick reads `performance.now()`).
let fakeNow = 0;
const realPerf = globalThis.performance;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => fakeNow }, configurable: true, writable: true,
});
test.after(() => {
  Object.defineProperty(globalThis, "performance", {
    value: realPerf, configurable: true, writable: true,
  });
});

function bolt({ vy = 20, vz = 5, gravity = true, align = false } = {}) {
  return {
    root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), userData: {} },
    lastVel: { vx: 0, vy, vz },
    _ballistic: true,
    _ballisticGravity: gravity,
    _ballisticAlignPath: align,
    _ballisticLastMs: 0,
  };
}
/** Fly one bolt through `passes` tick passes of `dtMs` each. */
function fly(H, e, passes, dtMs) {
  const h = new H();
  h.entityMap = new Map([[1, e]]);
  fakeNow = 0;
  for (let k = 1; k <= passes; k += 1) {
    fakeNow = k * dtMs;
    h._tickBallisticProjectiles();
  }
  return e;
}
const SCHEDULES = [
  ["one 1 s pass (10 × 0.1 s substeps)", 1, 1000],
  ["ten 100 ms passes", 10, 100],
  ["sixty 60 fps passes", 60, 1000 / 60],
];

for (const [name, passes, dtMs] of SCHEDULES) {
  test(`exact arc — ${name}: z = vz0·T + ½·g·T², vz = vz0 + g·T`, () => {
    const e = fly(Exact, bolt(), passes, dtMs);
    const p = e.root.position;
    assert.ok(Math.abs(p.y - 20) < 1e-9, `y ${p.y}`);
    assert.ok(Math.abs(p.z - (5 - 4.9)) < 1e-4, `z ${p.z} (want 0.1)`);
    assert.ok(Math.abs(e.lastVel.vz - (5 - 9.8)) < 1e-9, `vz ${e.lastVel.vz}`);
    assert.equal(e._ballistic, true, "still in flight");
  });
}

test("legacy Euler (flag off) sinks 0.5·g·q·T — the step-size dependence the fix removes", () => {
  const coarse = fly(Legacy, bolt(), 1, 1000).root.position.z;
  const fine = fly(Legacy, bolt(), 60, 1000 / 60).root.position.z;
  assert.ok(Math.abs(coarse - (0.1 - 0.5 * 9.8 * 0.1)) < 1e-6, `coarse ${coarse}`);
  assert.ok(Math.abs(fine - (0.1 - 0.5 * 9.8 * (1 / 60))) < 1e-6, `fine ${fine}`);
});

test("non-gravity missile flies a straight line under either integrator", () => {
  for (const H of [Exact, Legacy]) {
    const e = fly(H, bolt({ gravity: false }), 7, 1000 / 30);
    const T = 7 / 30;
    assert.ok(Math.abs(e.root.position.z - 5 * T) < 1e-9);
    assert.equal(e.lastVel.vz, 5);
  }
});

test("ALIGN_PATH faces the step's chord, not the end-of-step velocity", () => {
  // One 0.1 s substep: chord vz = vz0 + ½·g·q = 4.51, end velocity vz = 4.02.
  const e = fly(Exact, bolt({ align: true }), 1, 100);
  const disp = e.root.position.clone().normalize();
  const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(e.root.quaternion);
  assert.ok(fwd.distanceTo(disp) < 1e-9, `forward ${fwd.toArray()} vs chord ${disp.toArray()}`);
  const endVel = new THREE.Vector3(0, 20, e.lastVel.vz).normalize();
  assert.ok(fwd.distanceTo(endVel) > 1e-3, "differs from the end-of-step velocity");
});
