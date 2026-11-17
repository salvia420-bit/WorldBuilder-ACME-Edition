// tests/vehicle_trailer_models.test.mjs — procedural semi-trailer chassis (scene3d/vehicle/trailer_models.js).
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildSemiTrailer, TRAILER_WCID, CHASSIS_DECK_Z, TWISTLOCK_STATE } from "../scene3d/vehicle/trailer_models.js";
import { buildIsoContainer, CONTAINER_WCID } from "../scene3d/vehicle/container_models.js";

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  [OK] ${name}`); } catch (e) { failed++; console.log(`  [FAIL] ${name}: ${e.message}`); } };

t("trailer WCIDs never collide with container WCIDs", () => {
  for (const w of Object.values(TRAILER_WCID)) assert.ok(!Object.values(CONTAINER_WCID).includes(w));
});
for (const [kind, cw, minL] of [["20ft", CONTAINER_WCID.IsoContainer20, 6.9], ["40ft", CONTAINER_WCID.IsoContainer40HC, 12.2]]) {
  t(`${kind}: builds, <= 4 merged meshes + twistlocks, no lights`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    let meshes = 0, lights = 0;
    tr.root.traverse((o) => { if (o.isMesh) meshes++; if (o.isLight) lights++; });
    assert.equal(lights, 0);
    assert.equal(meshes, 3 + tr.twistlockPivots.length);
    assert.equal(tr.twistlockPivots.length, kind === "40ft" ? 8 : 4);
  });
  t(`${kind}: length and container seat height`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    const b = new THREE.Box3().setFromObject(tr.root);
    assert.ok(b.max.y - b.min.y >= minL, `length ${b.max.y - b.min.y}`);
    assert.ok(Math.abs(b.min.z) < 0.01, "sits on z=0");
    const c = buildIsoContainer(THREE, cw);
    tr.attachContainer(c);
    const cb = new THREE.Box3().setFromObject(c.root);
    assert.ok(Math.abs(cb.min.z - CHASSIS_DECK_Z) < 0.05, `container floor at ${cb.min.z}`);
  });
  t(`${kind}: TwistlockState turns the heads 90 degrees`, () => {
    const tr = buildSemiTrailer(THREE, kind, { twistlockState: TWISTLOCK_STATE.Unlocked });
    assert.equal(tr.twistlockPivots[0].rotation.z, 0);
    tr.update(0.033, { twistlockState: TWISTLOCK_STATE.Locked });
    assert.ok(Math.abs(tr.twistlockPivots[0].rotation.z - Math.PI / 2) < 1e-9);
  });
}
t("20ft container rides at the rear of a 40ft chassis", () => {
  const tr = buildSemiTrailer(THREE, "40ft");
  const c = tr.attachContainer(buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer20));
  assert.ok(c.root.position.y < 0);
});
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
