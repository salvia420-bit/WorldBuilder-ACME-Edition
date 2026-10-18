// tests/interior_shadow_raster_scope.test.mjs — ?interiorShadowCull's forced
// raster under the per-light ?shadowMoverScope gate (review 2026-10-18,
// RENDER-5).
//
// lighting.js applyMoverScopedShadowGate (default on) drives each managed light
// by hand: shadowMap.autoUpdate = false AND light.shadow.autoUpdate = false.
// three r184's WebGLShadowMap.render skips a light whose shadow has
// `autoUpdate === false && needsUpdate === false`, so requestShadowRaster's
// map-wide `shadowMap.needsUpdate = true` alone rastered nothing: an interior
// cast flip waited for the ?shadowMaxStale ceiling (12 frames), and
// ?shadowStaticCache overlaid the pre-flip statics in the meantime. Runs
// three's real WebGLRenderer + WebGLShadowMap over tests/helpers/fake_webgl2.mjs
// and counts the rasters of the managed light.
//
// Run:  cd apps/holtburger-web && node tests/interior_shadow_raster_scope.test.mjs

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { requestShadowRaster } = await import("../scene3d/interior_shadow_cull.js");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const gl = createFakeWebGL2();
const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
camera.position.set(0, 5, 10);
camera.lookAt(0, 0, 0);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(10, 20, 5);
sun.castShadow = true;
scene.add(sun);
const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.2), new THREE.MeshStandardMaterial());
wall.castShadow = true; // an interior cell wall, built casting
scene.add(wall);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial());
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// What the mover-scope gate leaves behind (lighting.js applyMoverScopedShadowGate).
renderer.shadowMap.autoUpdate = false;
sun.shadow.autoUpdate = false;
sun.userData.hbShadowManaged = true;
const scene3d = { renderer, _shadowScope: { renderer, lights: [sun] } };

// three calls getFrameExtents once per light it actually rasters.
let rasters = 0;
const getFrameExtents = sun.shadow.getFrameExtents;
sun.shadow.getFrameExtents = function () { rasters += 1; return getFrameExtents.call(this); };

// The gate's warm raster.
sun.shadow.needsUpdate = true;
renderer.shadowMap.needsUpdate = true;
renderer.render(scene, camera);
check("warm: the managed light rasters once", rasters === 1, `rasters=${rasters}`);
renderer.render(scene, camera);
check("gated: no raster without a request", rasters === 1, `rasters=${rasters}`);

// The camera crossed a doorway: cells.js flips the interior casters and asks
// for one raster.
wall.castShadow = false;
check("the request is accepted on a manually driven map", requestShadowRaster(renderer, scene3d) === true);
check("…and marks the managed light with the STATIC reason (?shadowStaticCache refreshes its statics)",
  sun.shadow.needsUpdate === true && (sun.userData.hbShadowReason & 2) !== 0, `reason=${sun.userData.hbShadowReason}`);
renderer.render(scene, camera);
check("the cast flip rasters on the next frame, not at the stale ceiling", rasters === 2, `rasters=${rasters}`);
renderer.render(scene, camera);
check("…once", rasters === 2, `rasters=${rasters}`);

// A scope that belongs to another renderer is not touched.
const other = { shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false } };
sun.shadow.needsUpdate = false;
sun.userData.hbShadowReason = 0;
check("a scope of another renderer is left alone",
  requestShadowRaster(other, scene3d) === true && sun.shadow.needsUpdate === false && sun.userData.hbShadowReason === 0);

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
