// tests/vehicle_trailer_models.test.mjs — procedural semi-trailer chassis (scene3d/vehicle/trailer_models.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  buildSemiTrailer,
  TRAILER_WCID,
  TRAILER_SPECS,
  CHASSIS_DECK_Z,
  CHASSIS_KINGPIN_Z,
  TWISTLOCK_STATE,
} from "../scene3d/vehicle/trailer_models.js";
import { buildIsoContainer, CONTAINER_WCID } from "../scene3d/vehicle/container_models.js";
import { lintSource } from "../scene3d/vfx/lint_caps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAILER_MODELS_PATH = join(HERE, "../scene3d/vehicle/trailer_models.js");

let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log(`  [OK] ${name}`); } catch (e) { failed++; console.log(`  [FAIL] ${name}: ${e.message}`); } };

t("trailer WCIDs never collide with container WCIDs & lintSource clean", () => {
  for (const w of Object.values(TRAILER_WCID)) assert.ok(!Object.values(CONTAINER_WCID).includes(w));
  assert.equal(CHASSIS_KINGPIN_Z, 0.96);
  assert.equal(CHASSIS_DECK_Z, 1.32);
  const hits = lintSource(readFileSync(TRAILER_MODELS_PATH, "utf8"));
  assert.equal(hits.length, 0, `lintSource hits: ${JSON.stringify(hits)}`);
});

t("TRAILER_SPECS exposes kingpinY, bogieY, effectiveWheelbase, wheelRadius", () => {
  assert.equal(TRAILER_SPECS["20ft"].kingpinY, 2.80);
  assert.equal(TRAILER_SPECS["20ft"].bogieY, -1.895);
  assert.equal(TRAILER_SPECS["20ft"].effectiveWheelbase, 4.695);
  assert.equal(TRAILER_SPECS["20ft"].wheelRadius, 0.505);

  assert.equal(TRAILER_SPECS["40ft"].kingpinY, 5.35);
  assert.equal(TRAILER_SPECS["40ft"].bogieY, -4.445);
  assert.equal(TRAILER_SPECS["40ft"].effectiveWheelbase, 9.795);
  assert.equal(TRAILER_SPECS["40ft"].wheelRadius, 0.505);
});

for (const [kind, cw, minL] of [["20ft", CONTAINER_WCID.IsoContainer20, 6.9], ["40ft", CONTAINER_WCID.IsoContainer40HC, 12.2]]) {
  t(`${kind}: builds, 6 merged meshes + twistlocks, 2 wheelGroups, no lights`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    let meshes = 0, lights = 0;
    tr.root.traverse((o) => { if (o.isMesh) meshes++; if (o.isLight) lights++; });
    assert.equal(lights, 0);
    assert.equal(meshes, 6 + tr.twistlockPivots.length);
    assert.equal(tr.twistlockPivots.length, kind === "40ft" ? 8 : 4);
    assert.equal(tr.wheelGroups.length, 2);
    tr.dispose();
  });

  t(`${kind}: kingpin coupler underside at 0.96 m and main rails clear >= 0.96 m`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    const frame = tr.root.getObjectByName("trailer-frame");
    const pos = frame.geometry.getAttribute("position");
    const kpY = TRAILER_SPECS[kind].kingpinY;

    let plateMinZ = Infinity;
    let pinMinZ = Infinity;
    let railMinZInCouplerZone = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (Math.abs(y - kpY) <= 0.81) {
        if (Math.abs(x) > 0.58 && Math.abs(x) <= 0.66) {
          if (z < plateMinZ) plateMinZ = z;
        }
        if (Math.hypot(x, y - kpY) <= 0.03) {
          if (z < pinMinZ) pinMinZ = z;
        } else if (Math.abs(x) >= 0.42 && Math.abs(x) <= 0.58 && Math.abs(y - kpY) <= 0.78) {
          if (z < railMinZInCouplerZone) railMinZInCouplerZone = z;
        }
      }
    }
    assert.ok(Math.abs(plateMinZ - CHASSIS_KINGPIN_Z) < 1e-4, `${kind} coupler plate underside ${plateMinZ} != 0.96`);
    assert.ok(pinMinZ < CHASSIS_KINGPIN_Z - 0.05, `${kind} kingpin protrudes below 0.96 (${pinMinZ})`);
    assert.ok(railMinZInCouplerZone >= CHASSIS_KINGPIN_Z - 1e-4, `${kind} main rail hangs below 0.96 (${railMinZInCouplerZone})`);
    tr.dispose();
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
    tr.dispose();
    c.dispose();
  });

  t(`${kind}: landingGearGroup retracts +0.45 m idempotently and extends back to z=0`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    const b0 = new THREE.Box3().setFromObject(tr.landingGearGroup);
    assert.ok(Math.abs(b0.min.z) < 1e-4);
    assert.equal(tr.landingGearRetracted, false);

    tr.setLandingGearRetracted(true);
    tr.setLandingGearRetracted(true);
    assert.equal(tr.landingGearRetracted, true);
    const b1 = new THREE.Box3().setFromObject(tr.landingGearGroup);
    assert.ok(Math.abs(b1.min.z - 0.45) < 1e-4, `retracted gear min.z=${b1.min.z}`);

    tr.update({ landingGearRetracted: false });
    assert.equal(tr.landingGearRetracted, false);
    const b2 = new THREE.Box3().setFromObject(tr.landingGearGroup);
    assert.ok(Math.abs(b2.min.z) < 1e-4);
    tr.dispose();
  });

  t(`${kind}: wheelGroups centered at axles & dual-signature update() rolls wheels`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    const midY = (tr.wheelGroups[0].position.y + tr.wheelGroups[1].position.y) / 2;
    assert.ok(Math.abs(midY - TRAILER_SPECS[kind].bogieY) < 1e-6);

    // Verify axle-centered pivot: rotating 45° leaves center at (0, axleY, 0.505)
    const ay0 = tr.wheelGroups[0].position.y;
    tr.update(0.1, { speed: 10.1 });
    const expected1 = (10.1 * 0.1) / 0.505;
    assert.ok(Math.abs(tr.wheelRollAngle - expected1) < 1e-4);
    tr.update({ speed: 10.1, dt: 0.1 });
    assert.ok(Math.abs(tr.wheelRollAngle - 2 * expected1) < 1e-4);

    tr.wheelGroups[0].rotation.x = Math.PI / 4;
    tr.root.updateMatrixWorld(true);
    const wc = new THREE.Box3().setFromObject(tr.wheelGroups[0]).getCenter(new THREE.Vector3());
    assert.ok(Math.abs(wc.y - ay0) < 0.02 && Math.abs(wc.z - 0.505) < 0.02, "axle-centered wheel rotation");
    tr.dispose();
  });

  t(`${kind}: setBrakeLights boosts brakeLampMat without affecting markerLampMat`, () => {
    const tr = buildSemiTrailer(THREE, kind);
    assert.equal(tr.materials.brakeLampMat.emissiveIntensity, 0.6);
    assert.equal(tr.materials.markerLampMat.emissiveIntensity, 0.6);
    tr.setBrakeLights(true);
    assert.ok(tr.materials.brakeLampMat.emissiveIntensity > 2.0);
    assert.equal(tr.materials.markerLampMat.emissiveIntensity, 0.6);
    tr.update(0.033, { brakeLights: false });
    assert.equal(tr.materials.brakeLampMat.emissiveIntensity, 0.6);
    tr.dispose();
  });

  t(`${kind}: TwistlockState turns the heads 90 degrees`, () => {
    const tr = buildSemiTrailer(THREE, kind, { twistlockState: TWISTLOCK_STATE.Unlocked });
    assert.equal(tr.twistlockPivots[0].rotation.z, 0);
    tr.update(0.033, { twistlockState: TWISTLOCK_STATE.Locked });
    assert.ok(Math.abs(tr.twistlockPivots[0].rotation.z - Math.PI / 2) < 1e-9);
    tr.dispose();
  });
}

t("20ft container rides at the rear of a 40ft chassis & detachContainer/dispose safety", () => {
  const tr = buildSemiTrailer(THREE, "40ft");
  const c = buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer20);
  tr.attachContainer(c);
  assert.ok(c.root.position.y < 0);
  assert.equal(tr.mountedContainer, c);

  const detached = tr.detachContainer();
  assert.equal(detached, c);
  assert.equal(tr.mountedContainer, null);
  assert.equal(c.root.parent, null);
  assert.equal(tr.detachContainer(), null);

  // Re-attach and call tr.dispose() — must detach without disposing container
  tr.attachContainer(c);
  let containerDisposed = false;
  c.root.traverse((o) => {
    if (o.geometry) {
      const orig = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => { containerDisposed = true; orig(); };
    }
  });
  tr.dispose();
  assert.equal(containerDisposed, false, "trailer.dispose() must not dispose mounted container");
  c.dispose();
});

t("attachContainer(c, null) safely defaults options without throwing", () => {
  const tr = buildSemiTrailer(THREE, "40ft");
  const c = buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer20);
  const attached = tr.attachContainer(c, null);
  assert.equal(attached, c);
  assert.ok(c.root.position.y < 0);
  assert.equal(tr.attachContainer(null, null), null);
  tr.dispose();
  c.dispose();
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
