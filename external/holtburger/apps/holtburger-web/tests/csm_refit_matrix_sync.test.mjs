// tests/csm_refit_matrix_sync.test.mjs
//
// Verification of CSM pre-render matrix sync:
// Ensures light.shadow.updateMatrices(light) is called when cascade bounds change
// (in setupCsm, _placeCascade, and refreshCsmUniforms) so that light.shadow.matrix
// and uCsmMatrix0/1/2 uniforms are immediately in sync with cascade camera bounds,
// eliminating the 1-frame stale shadow matrix flicker when the camera moves.

import * as THREE from "three";

globalThis.window = globalThis.window || {};
globalThis.location = { search: "" };
window.location = globalThis.location;

const CSM = await import("../scene3d/csm.js");
const { setupCsm, updateCsm, refreshCsmUniforms } = CSM;

let passed = 0;
let failed = 0;

function check(label, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  [OK] ${label}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("CSM Pre-Render Matrix Sync Tests");

// 1. setupCsm initialization sync
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 10, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const csmState = setupCsm(scene, {
    splits: [30, 100, 300],
    stable: false,
    sunDir: { x: 50, y: 100, z: 20 },
  });

  check("setupCsm returns valid state", !!csmState && csmState.lights.length === 3);

  // Each cascade light must have light.shadow.matrix computed on initialization
  for (let i = 0; i < 3; i++) {
    const light = csmState.lights[i];
    const shadowCam = light.shadow.camera;
    const shadowMat = light.shadow.matrix;

    // Expected shadow matrix = texCoordMatrix * projectionMatrix * viewMatrix
    const expected = new THREE.Matrix4();
    expected.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    expected.multiply(shadowCam.projectionMatrix);
    expected.multiply(shadowCam.matrixWorldInverse);

    let maxDiff = 0;
    for (let k = 0; k < 16; k++) {
      maxDiff = Math.max(maxDiff, Math.abs(shadowMat.elements[k] - expected.elements[k]));
    }
    check(
      `cascade ${i} shadow.matrix initialized and matches camera bounds immediately`,
      maxDiff < 1e-5 && shadowMat.elements.some((v) => Math.abs(v) > 0.001),
      `maxDiff=${maxDiff}`
    );
  }
}

// 2. updateCsm with camera movement (view-slice fit)
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(100, 10, 200);
  camera.lookAt(100, 0, 150);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const csmState = setupCsm(scene, {
    splits: [30, 100, 300],
    stable: false,
    sunDir: { x: 30, y: 80, z: 20 },
  });

  // Move camera significantly to trigger cascade refit
  camera.position.set(300, 25, 450);
  camera.lookAt(320, 20, 400);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  updateCsm(csmState, camera, { x: 30, y: 80, z: 20 });
  refreshCsmUniforms(csmState);

  check("updateCsm refit triggered", csmState.didRefitThisTick === true);

  for (let i = 0; i < 3; i++) {
    const light = csmState.lights[i];
    const shadowCam = light.shadow.camera;
    const shadowMat = light.shadow.matrix;

    const expected = new THREE.Matrix4();
    expected.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    expected.multiply(shadowCam.projectionMatrix);
    expected.multiply(shadowCam.matrixWorldInverse);

    let maxDiff = 0;
    for (let k = 0; k < 16; k++) {
      maxDiff = Math.max(maxDiff, Math.abs(shadowMat.elements[k] - expected.elements[k]));
    }
    check(
      `view-slice cascade ${i} shadow.matrix immediately in sync after camera move`,
      maxDiff < 1e-5,
      `maxDiff=${maxDiff}`
    );

    // Uniform value must match shadow.matrix
    const uMat = csmState.uniforms[`uCsmMatrix${i}`].value;
    let uDiff = 0;
    for (let k = 0; k < 16; k++) {
      uDiff = Math.max(uDiff, Math.abs(uMat.elements[k] - shadowMat.elements[k]));
    }
    check(
      `view-slice cascade ${i} uniform uCsmMatrix${i} matches shadow.matrix on same frame`,
      uDiff < 1e-5,
      `uDiff=${uDiff}`
    );
  }
}

// 3. updateCsm with stable cascades
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(500, 15, 600);
  camera.lookAt(500, 15, 550);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const csmState = setupCsm(scene, {
    splits: [30, 100, 300],
    stable: true,
    sunDir: { x: 40, y: 90, z: 10 },
  });

  // Move camera far enough to leave cascade 0 slack zone
  camera.position.set(550, 15, 600);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  updateCsm(csmState, camera, { x: 40, y: 90, z: 10 });

  for (let i = 0; i < 3; i++) {
    const light = csmState.lights[i];
    const shadowCam = light.shadow.camera;
    const shadowMat = light.shadow.matrix;

    const expected = new THREE.Matrix4();
    expected.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    expected.multiply(shadowCam.projectionMatrix);
    expected.multiply(shadowCam.matrixWorldInverse);

    let maxDiff = 0;
    for (let k = 0; k < 16; k++) {
      maxDiff = Math.max(maxDiff, Math.abs(shadowMat.elements[k] - expected.elements[k]));
    }
    check(
      `stable cascade ${i} shadow.matrix in sync after slack-break move`,
      maxDiff < 1e-5,
      `maxDiff=${maxDiff}`
    );
  }
}

// 4. Multi-tick walk test: zero 1-frame stale matrix lag across consecutive ticks
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -10);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const csmState = setupCsm(scene, {
    splits: [30, 100, 300],
    stable: false,
    sunDir: { x: 10, y: 60, z: 15 },
  });

  let anyOutOfSync = false;

  for (let frame = 1; frame <= 15; frame++) {
    // Walk forward along Z and slightly turn
    camera.position.z -= 4.0;
    camera.position.x += Math.sin(frame * 0.3) * 1.5;
    camera.lookAt(camera.position.x, camera.position.y, camera.position.z - 10);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    updateCsm(csmState, camera, { x: 10, y: 60, z: 15 });
    refreshCsmUniforms(csmState);

    // Test a world point: camera position
    const pWorld = camera.position.clone();

    for (let i = 0; i < 3; i++) {
      const light = csmState.lights[i];
      const shadowMat = light.shadow.matrix;
      const uMat = csmState.uniforms[`uCsmMatrix${i}`].value;

      // Point transformed by shadow.matrix
      const pShadow = pWorld.clone().applyMatrix4(shadowMat);
      // Point transformed by uniform matrix
      const pUniform = pWorld.clone().applyMatrix4(uMat);

      if (pShadow.distanceTo(pUniform) > 1e-4) {
        anyOutOfSync = true;
      }
    }
  }

  check("multi-frame walking maintains zero stale-matrix lag across all 15 frames", !anyOutOfSync);
}

// 5. Global state export test
{
  check("__hbCsmState exported to globalThis", !!globalThis.__hbCsmState && globalThis.__hbCsmState.lights?.length === 3);
}

console.log(`\nCSM Pre-Render Matrix Sync: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
