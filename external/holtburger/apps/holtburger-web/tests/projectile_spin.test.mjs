// projectile_spin.test.mjs — PROJ-SPIN (2026-10-05).
//
// 1. A RotationSpeed missile (ACE Omega = (2π·RotationSpeed, 0, 0), ALIGN_PATH
//    cleared — SpellProjectile.cs:120-126) spins by retail
//    `UpdatePhysicsInternal`'s `Frame::grotate(omega·quantum)`
//    (acclient.c:317777-317783): a WORLD-frame axis-angle rotation
//    PRE-multiplied onto the orientation (grotate, acclient.c:357422-357456).
//    Drives the REAL `_spinProjectile` + `_tickBallisticProjectiles` bodies
//    lifted out of scene3d/entities.js by brace matching.
// 2. GR particles (ParabolicLVGAGR/LVLALR/GVGAGR) rotate by retail
//    `Frame::rotate(c·t)` — a LOCAL axis-angle, so a multi-axis C spins
//    steadily about ĉ instead of the old Euler tumble. Drives the REAL
//    exported `particleSpinQuat` from scene3d/particles/particle.js.
//
// Run: node tests/projectile_spin.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { particleSpinQuat } from "../scene3d/particles/particle.js";

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
const Harness = new Function(`
  const PROJECTILE_GRAVITY_Z = -9.8;
  const PROJECTILE_TERRAIN_STOP_ON = false;
  const PROJECTILE_TERRAIN_STOP_EPS = 0.25;
  const PROJECTILE_EXACT_ARC_ON = true;
  const PROJECTILE_ENV_SWEEP_ON = false; // the sweep is covered by projectile_visual_fidelity
  const _terrainZAt = () => null;
  return class { ${METHODS} };
`)();

function inst(q = new THREE.Quaternion()) {
  return { root: { position: new THREE.Vector3(), quaternion: q.clone(), userData: {} } };
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
function sameRot(a, b, eps = 1e-6) {
  // q and -q are the same rotation.
  return Math.abs(Math.abs(a.dot(b)) - 1) < eps;
}

test("omega spins about the WORLD axis (grotate pre-multiply)", () => {
  const h = new Harness();
  // Bolt yawed 90° (AC heading about +Z), Whirling Blade omega (4π, 0, 0).
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const e = inst(yaw);
  e._ballisticOmega = { x: 4 * Math.PI, y: 0, z: 0 };
  h._spinProjectile(e, 0.05); // 0.2π rad
  const want = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2 * Math.PI)
    .multiply(yaw); // world-frame: dq ⊗ q
  assert.ok(sameRot(e.root.quaternion, want), "world-frame pre-multiply");
  const local = yaw.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2 * Math.PI),
  );
  assert.ok(!sameRot(e.root.quaternion, local), "NOT a local (post-multiply) spin");
  assert.ok(close(e.root.quaternion.length(), 1, 1e-9), "unit quaternion");
});

test("substeps compose to the single-step rotation (constant world axis)", () => {
  const h = new Harness();
  const a = inst(), b = inst();
  a._ballisticOmega = b._ballisticOmega = { x: 1.5, y: -2, z: 7 };
  h._spinProjectile(a, 0.3);
  for (let k = 0; k < 3; k += 1) h._spinProjectile(b, 0.1);
  assert.ok(sameRot(a.root.quaternion, b.root.quaternion, 1e-9));
  const angle = 2 * Math.acos(Math.min(1, Math.abs(a.root.quaternion.w)));
  assert.ok(close(angle, Math.hypot(1.5, 2, 7) * 0.3, 1e-6), `angle ${angle}`);
});

test("no omega / sub-threshold step leaves the orientation alone", () => {
  const h = new Harness();
  const q0 = new THREE.Quaternion(0.1, 0.2, 0.3, 0.927).normalize();
  const e = inst(q0);
  h._spinProjectile(e, 0.1); // no _ballisticOmega
  e._ballisticOmega = { x: 1e-3, y: 0, z: 0 };
  h._spinProjectile(e, 0.1); // |w| = 1e-4 < grotate's 2e-4
  assert.ok(e.root.quaternion.equals(q0));
});

test("ballistic tick: a spinning missile turns by omega × elapsed and keeps flying", () => {
  const h = new Harness();
  const now = performance.now();
  const e = inst();
  e.lastVel = { vx: 0, vy: 20, vz: 0 };
  e.lastVelMs = now - 250;
  e._ballistic = true;
  e._ballisticOmega = { x: 4 * Math.PI, y: 0, z: 0 };
  h.entityMap = new Map([[1, e]]);
  h._tickBallisticProjectiles();
  const rdt = (e._ballisticLastMs - e.lastVelMs) / 1000;
  assert.ok(rdt > 0.2 && rdt < 2, `rdt ${rdt}`);
  assert.ok(close(e.root.position.y, 20 * rdt, 1e-6), "position integrated");
  const want = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 4 * Math.PI * rdt);
  assert.ok(sameRot(e.root.quaternion, want, 1e-6), "spun by omega·rdt about world X");
  // Impact stop ends the spin with the flight.
  h._stopBallisticProjectile(e);
  assert.equal(e._ballisticOmega, null);
});

test("ballistic tick: an ALIGN_PATH bolt (no omega) still faces its velocity", () => {
  const h = new Harness();
  const e = inst();
  e.lastVel = { vx: 3, vy: 4, vz: 0 };
  e.lastVelMs = performance.now() - 100;
  e._ballistic = true;
  e._ballisticAlignPath = true;
  h.entityMap = new Map([[1, e]]);
  h._tickBallisticProjectiles();
  const f = new THREE.Vector3(0, 1, 0).applyQuaternion(e.root.quaternion);
  assert.ok(close(f.x, 0.6) && close(f.y, 0.8) && close(f.z, 0), `forward ${f.toArray()}`);
});

test("GR particle spin: retail local axis-angle of c·t", () => {
  const q = new THREE.Quaternion();
  // Single-axis C (Lightning Bolt 0x32000195: C = (0, 20, 0)) — unchanged
  // from the old Euler read.
  particleSpinQuat({ x: 0, y: 20, z: 0 }, 0.1, q);
  const euler = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 2, 0, "YXZ"));
  assert.ok(sameRot(q, euler), "single-axis C matches the legacy Euler");
  // Multi-axis C (0x3200002C: (1.2, 3, 168)) — a steady spin about ĉ.
  const c = { x: 1.2, y: 3, z: 168 };
  const axis = new THREE.Vector3(c.x, c.y, c.z).normalize();
  for (const t of [0.05, 0.3, 0.71]) {
    particleSpinQuat(c, t, q);
    const kept = axis.clone().applyQuaternion(q);
    assert.ok(kept.distanceTo(axis) < 1e-6, `axis is invariant at t=${t}`);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    const want = (Math.hypot(c.x, c.y, c.z) * t) % (2 * Math.PI);
    const wrapped = Math.min(want, 2 * Math.PI - want);
    assert.ok(close(angle, wrapped, 1e-5), `angle ${angle} vs ${wrapped} at t=${t}`);
  }
  // Zero lifetime → identity.
  particleSpinQuat(c, 0, q);
  assert.ok(q.equals(new THREE.Quaternion()));
});
