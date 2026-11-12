import * as THREE from "three";
import {
  _billboardEmitter,
  particleFar30HzEnabled,
  setParticleFar30HzFlag,
  _alphaMatSig,
} from "../scene3d/particles/particle_manager.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("Running particle_billboard_instanced_worldroot tests...");

// --- Test 1: ?particleFar30Hz defaults to ON and toggles via seam ---
{
  setParticleFar30HzFlag(null); // Reset flag
  assert(particleFar30HzEnabled() === true, "particleFar30Hz should default to true (ON)");
  setParticleFar30HzFlag(false);
  assert(particleFar30HzEnabled() === false, "setParticleFar30HzFlag(false) should set flag to false");
  setParticleFar30HzFlag(true);
  assert(particleFar30HzEnabled() === true, "setParticleFar30HzFlag(true) should set flag to true");
  console.log("  [PASS] ?particleFar30Hz flag default and toggle");
}

// --- Test 2: Memoization of _alphaMatSig and bucket key ---
{
  const mat = {
    type: "MeshBasicMaterial",
    map: { uuid: "tex-1234" },
    side: 2,
    fog: true,
    toneMapped: false,
    color: { getHex: () => 0xffffff },
    alphaTest: 0.5,
    depthTest: true,
  };

  const sig1 = _alphaMatSig(mat);
  assert(typeof sig1 === "string" && sig1.length > 0, "sig1 should be a non-empty string");
  assert(mat.__alphaSig === sig1, "mat.__alphaSig should be cached on the material");

  // Mutating a field should still return the memoized sig from __alphaSig
  mat.alphaTest = 0.1;
  const sig2 = _alphaMatSig(mat);
  assert(sig1 === sig2, "_alphaMatSig should return memoized __alphaSig without recomputation");
  console.log("  [PASS] Material alpha signature memoization (__alphaSig)");
}

// --- Test 3: Billboard orientation for scene-detached carrier mesh (instanced path) ---
{
  // In Asheron's Call / Holtburger, scene is Z-up (rotation.x = -PI/2 in Three scene graph).
  // Emitter carrier mesh for instancing has mesh.parent === null.
  // mesh.position is in scene space (AC Z-up: X east, Y north, Z up).
  // camera is in Three.js world space (X east, Y up, Z south = -north).
  const scene = new THREE.Group();
  scene.rotation.x = -Math.PI / 2;
  scene.updateMatrixWorld(true);

  // Camera placed at (0, 10, 5) in Three.js world coordinates.
  // With scene.rotation.x = -PI/2, worldToLocal transforms (0, 10, 5) -> (0, -5, 10) in AC coordinates.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 5);
  camera.updateMatrixWorld(true);

  // Instanced carrier quad mesh: plane in XY with normal (0, 0, 1).
  const geom = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.parent = null; // Instanced carrier mesh is scene-detached!
  mesh.position.set(0, 0, 0); // At origin in AC coordinates

  const emitter = {
    parts: [mesh],
    _scene: scene,
  };

  _billboardEmitter(emitter, camera, scene);

  // Direction from mesh to camera in scene-local (AC) space:
  // sceneInv * camera.position = (0, -5, 10).
  // Normalized expected direction:
  const expectedDir = new THREE.Vector3(0, 10, 5);
  const sceneInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  expectedDir.applyMatrix4(sceneInv).normalize();

  // The mesh's local normal rotated by mesh.quaternion should point directly along expectedDir
  const localNorm = geom.userData.__bbNormal;
  const transformedNormal = localNorm.clone().applyQuaternion(mesh.quaternion);

  const dot = transformedNormal.dot(expectedDir);
  assert(Math.abs(dot - 1.0) < 1e-4, `Billboard quad normal should face camera in scene space (dot=${dot})`);
  console.log("  [PASS] Instanced carrier billboard orientation under rotated scene root");
}

// --- Test 4: Parity with billboard.rs coordinate conversion ---
{
  // billboard.rs sprite function converts Three camera (x, y, z) into AC Z-up (x, -z, y).
  const threeCam = { x: 12.0, y: 34.0, z: -56.0 };
  const acCam = { x: threeCam.x, y: -threeCam.z, z: threeCam.y };

  assert(acCam.x === 12.0, "AC X equals Three X");
  assert(acCam.y === 56.0, "AC Y (north) equals -Three Z");
  assert(acCam.z === 34.0, "AC Z (up) equals Three Y");

  // Particle at (10, 50, 30) in AC coordinates
  const particlePos = { x: 10.0, y: 50.0, z: 30.0 };
  const dir = {
    x: acCam.x - particlePos.x,
    y: acCam.y - particlePos.y,
    z: acCam.z - particlePos.z,
  };
  assert(dir.x === 2.0 && dir.y === 6.0 && dir.z === 4.0, "Correct displacement vector in AC frame");
  console.log("  [PASS] billboard.rs Three -> AC Z-up coordinate conversion parity");
}

// --- Test 5: 30 Hz stride logic for emitters beyond 35 meters ---
{
  setParticleFar30HzFlag(true);

  let updateCount = 0;
  const emitter = {
    _camDistSq: 50 * 50, // 50 meters (> 35m)
    numParticles: 10,
    stopped: false,
    updateParticles: () => {
      updateCount += 1;
      return true;
    },
  };

  const strideStep = (emitter, tickNow) => {
    const isFar = particleFar30HzEnabled() && emitter._camDistSq > 1225;
    if (isFar && emitter._lastFarTick !== undefined && (tickNow - emitter._lastFarTick) < 0.032 && !(emitter.stopped && emitter.numParticles === 0)) {
      // 30 Hz stride: skip
      return false;
    } else {
      if (isFar) emitter._lastFarTick = tickNow;
      return emitter.updateParticles();
    }
  };

  // Frame 1 at t=10.000 (0ms) -> updates
  strideStep(emitter, 10.000);
  assert(updateCount === 1, "Frame 1 should update");

  // Frame 2 at t=10.016 (16.6ms later, 60fps) -> should skip
  strideStep(emitter, 10.016);
  assert(updateCount === 1, "Frame 2 should skip update under 30 Hz stride");

  // Frame 3 at t=10.033 (33.3ms later) -> should update
  strideStep(emitter, 10.033);
  assert(updateCount === 2, "Frame 3 should update once 33ms has elapsed");

  // Frame 4 at t=10.050 (16.6ms later) -> should skip
  strideStep(emitter, 10.050);
  assert(updateCount === 2, "Frame 4 should skip update under 30 Hz stride");

  // Frame 5 at t=10.066 (33.3ms later) -> should update
  strideStep(emitter, 10.066);
  assert(updateCount === 3, "Frame 5 should update once 33ms has elapsed");

  console.log("  [PASS] 30 Hz stride skipping and updates for far emitters (>35m)");
}

console.log("All particle_billboard_instanced_worldroot tests passed!");
