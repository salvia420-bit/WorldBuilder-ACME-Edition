// tools/rust_parity/gen_cull.mjs — the JS reference for
// crates/holtburger-scene/src/cull.rs (pinned by tests/cull_parity.rs).
//
// Runs the REAL JS: three r184 `Frustum.setFromProjectionMatrix` /
// `intersectsSphere` / `Plane.setComponents + normalize + distanceToPoint` /
// `Sphere.applyMatrix4`, scene3d/culling.js `FrustumCuller.update` (the
// AC-space MVP = projection · matrixWorldInverse · worldRoot.matrixWorld) and
// statics.js `_cullStaticsWalk` (through `__cullStaticsWalkForTest`) with the
// `?cullDist` horizon armed, over random cameras — perspective and
// orthographic, WebGL and WebGPU coordinate systems, reversed depth on and off
// — and random sphere sets (incl. exact plane-boundary spheres, zero / empty
// radii, huge coordinates), plus hand-made degenerate matrices. Floats travel
// as f64 bit patterns (fixture_util.mjs).
//
// Run (from apps/holtburger-web/): node tools/rust_parity/gen_cull.mjs
//   → crates/holtburger-scene/tests/fixtures/cull.json

// The statics walk's distance branch reads `?cullDist` once at module load:
// arm it BEFORE culling.js / statics.js are imported.
const CULL_DIST_M = 640;
globalThis.window = {
  location: { search: `?cullDist=${CULL_DIST_M}` },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};
globalThis.location = globalThis.window.location;

const THREE = await import("three");
const { f64arr, f64hex, inputRng, writeFixture } = await import("./fixture_util.mjs");
const { FrustumCuller, CULL_DIST_SQ } = await import("../../scene3d/culling.js");
const S = await import("../../scene3d/statics.js");

if (CULL_DIST_SQ !== CULL_DIST_M * CULL_DIST_M) throw new Error(`?cullDist did not arm: CULL_DIST_SQ=${CULL_DIST_SQ}`);
const HORIZON = Math.sqrt(CULL_DIST_SQ);

const r = inputRng(20261026 ^ 0xc011);
const rnd = (a, b) => a + (b - a) * r();
const pick = (arr) => arr[Math.floor(r() * arr.length)];

const planesOf = (f) => f.planes.flatMap((p) => [p.normal.x, p.normal.y, p.normal.z, p.constant]);
const bitString = (bools) => bools.map((b) => (b ? "1" : "0")).join("");

// A camera somewhere over Dereth, in three world space (AC (x, y, z) → (x, z, -y)).
function randomCamera(i) {
  const ortho = i % 7 === 3;
  const cam = ortho
    ? new THREE.OrthographicCamera(-rnd(10, 400), rnd(10, 400), rnd(10, 300), -rnd(10, 300), rnd(0.05, 5), rnd(300, 6000))
    : new THREE.PerspectiveCamera(rnd(20, 100), rnd(0.5, 2.5), rnd(0.05, 5), rnd(300, 6000));
  cam.coordinateSystem = i % 3 === 1 ? THREE.WebGPUCoordinateSystem : THREE.WebGLCoordinateSystem;
  // three r184: the renderer sets this on reversed-depth targets; the camera
  // then builds the reversed projection (Matrix4.makePerspective/Orthographic).
  cam._reversedDepth = i % 4 >= 2;
  cam.updateProjectionMatrix();
  const ax = rnd(0, 255 * 192), ay = rnd(0, 255 * 192), az = rnd(-20, 300);
  cam.position.set(ax, az, -ay);
  if (i % 5 === 4) {
    cam.quaternion.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
  } else {
    cam.lookAt(ax + rnd(-200, 200), az + rnd(-80, 40), -(ay + rnd(-200, 200)));
  }
  return cam;
}

// The app's world: worldRoot rotates AC Z-up → three Y-up. A few cases use a
// general worldRoot transform to exercise arbitrary MVPs.
function randomWorld(i, cam) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  if (i % 11 === 10) {
    worldRoot.position.set(rnd(-50, 50), rnd(-50, 50), rnd(-50, 50));
    worldRoot.scale.set(rnd(0.5, 2), rnd(0.5, 2), rnd(0.5, 2));
    worldRoot.rotation.y = rnd(-1, 1);
  }
  scene.add(worldRoot);
  scene.add(cam);
  scene.updateMatrixWorld(true);
  return { scene, worldRoot };
}

// Spheres in AC space around the camera — half of them along its view
// direction (mostly kept), the rest anywhere (mostly culled) — plus exact
// plane-boundary ones.
const _dir = new THREE.Vector3();
function randomSpheres(culler, cam, n) {
  const c = culler._camAc;
  cam.getWorldDirection(_dir); // three world → AC: (x, y, z) → (x, -z, y)
  const fx = _dir.x, fy = -_dir.z, fz = _dir.y;
  const far = 3000;
  const out = [];
  for (let k = 0; k < n; k++) {
    const kind = k % 12;
    let x, y, z, rad;
    if (kind < 6) {
      const d = rnd(1, kind < 3 ? 400 : 1500);
      x = c.x + fx * d + rnd(-0.3, 0.3) * d; y = c.y + fy * d + rnd(-0.3, 0.3) * d; z = c.z + fz * d + rnd(-0.2, 0.2) * d;
      rad = kind === 5 ? 0 : rnd(0, 30);
    }
    else if (kind === 6) { x = c.x + rnd(-far, far); y = c.y + rnd(-far, far); z = c.z + rnd(-far, far); rad = rnd(0, 2000); }
    else if (kind === 7) { x = c.x + rnd(-50, 50); y = c.y + rnd(-50, 50); z = c.z + rnd(-50, 50); rad = 0; }
    else if (kind === 8) { x = c.x + rnd(-900, 900); y = c.y + rnd(-900, 900); z = c.z + rnd(-100, 100); rad = -1; } // three's empty sphere
    else { x = c.x + rnd(-1200, 1200); y = c.y + rnd(-1200, 1200); z = c.z + rnd(-150, 150); rad = rnd(0, 60); }
    out.push([x, y, z, rad]);
  }
  // Exact boundaries: centre placed, radius = -distance to one plane, so the
  // test is `d < d` (false → kept). Also the next float on each side.
  for (let k = 0; k < 6; k++) {
    const p = culler.frustum.planes[k];
    const x = c.x + rnd(-400, 400), y = c.y + rnd(-400, 400), z = c.z + rnd(-60, 60);
    const d = p.distanceToPoint(new THREE.Vector3(x, y, z));
    if (!Number.isFinite(d)) continue;
    const rad = -d;
    out.push([x, y, z, rad]);
    out.push([x, y, z, rad * (1 - 2 ** -52)]);
    out.push([x, y, z, rad * (1 + 2 ** -52)]);
  }
  return out;
}

const frustums = [];
const statics = [];
const N_CAMERAS = 160;
const N_SPHERES = 32;
let visibleCount = 0, culledCount = 0, interCount = 0;

for (let i = 0; i < N_CAMERAS; i++) {
  const cam = randomCamera(i);
  const { worldRoot } = randomWorld(i, cam);
  const culler = new FrustumCuller();
  if (!culler.update(cam, worldRoot)) throw new Error("culler.update failed");
  const spheres = randomSpheres(culler, cam, N_SPHERES);
  const inter = spheres.map(([x, y, z, rad]) => culler.frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(x, y, z), rad)));
  for (const b of inter) if (b) interCount++;
  frustums.push({
    mvp: f64arr(culler._mvp.elements), cs: culler.coordinateSystem, rev: culler.reversedDepth,
    planes: f64arr(planesOf(culler.frustum)), spheres: f64arr(spheres.flat()), inter: bitString(inter),
  });
  // The real statics walk over the same spheres: one plain Mesh per sphere
  // with its cull sphere pre-cached (what `_resolveStaticCullSphere` returns),
  // random prior visibility; the walk writes the verdict incl. the horizon.
  const group = new THREE.Group();
  for (const [x, y, z, rad] of spheres) {
    const m = new THREE.Mesh();
    m.userData = { _cullSphere: new THREE.Sphere(new THREE.Vector3(x, y, z), rad) };
    m.visible = r() < 0.5;
    group.add(m);
  }
  const res = S.__cullStaticsWalkForTest(group, group.children, culler);
  const want = group.children.map((m) => m.visible);
  for (const w of want) { if (w) visibleCount++; else culledCount++; }
  statics.push({
    mvp: f64arr(culler._mvp.elements), cs: culler.coordinateSystem, rev: culler.reversedDepth,
    cam: f64arr([culler._camAc.x, culler._camAc.y, culler._camAc.z]),
    distOn: CULL_DIST_SQ !== Infinity, horizon: f64hex(HORIZON),
    spheres: f64arr(spheres.flat()), want: bitString(want), tested: res.tested, culled: res.culled,
  });
}

// Hand-made matrices straight into three's Frustum: all-zero (every plane
// NaN → every sphere kept), a zero row, an invalid coordinate system (three
// throws without reversed depth; with it, planes are built).
const degenerate = [];
{
  const mats = [
    new Array(16).fill(0),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, -1, 0, 0, -2, 0],
  ];
  const probe = [[0, 0, -5, 1], [10, -3, 2, 0], [0, 0, 0, -1], [1e300, 0, 0, 1]];
  for (const e of mats) {
    for (const [cs, rev] of [[2000, false], [2001, false], [2000, true], [1234, true], [1234, false]]) {
      const m = new THREE.Matrix4().fromArray(e);
      const f = new THREE.Frustum();
      let throws = false;
      try { f.setFromProjectionMatrix(m, cs, rev); } catch (_) { throws = true; }
      degenerate.push({
        mvp: f64arr(e), cs, rev, throws,
        planes: throws ? null : f64arr(planesOf(f)),
        spheres: f64arr(probe.flat()),
        inter: throws ? null : bitString(probe.map(([x, y, z, rad]) => f.intersectsSphere(new THREE.Sphere(new THREE.Vector3(x, y, z), rad)))),
      });
    }
  }
}

// Plane.setComponents + normalize + distanceToPoint, and Sphere.applyMatrix4.
const planes = [];
for (let i = 0; i < 96; i++) {
  const comp = [rnd(-5, 5), rnd(-5, 5), rnd(-5, 5), rnd(-3000, 3000)];
  if (i % 16 === 0) comp[0] = comp[1] = comp[2] = 0; // zero normal: 1/0
  const p = new THREE.Plane().setComponents(...comp).normalize();
  const pts = [[rnd(-1e4, 1e4), rnd(-1e4, 1e4), rnd(-1e3, 1e3)], [0, 0, 0], [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)]];
  planes.push({
    comp: f64arr(comp), plane: f64arr([p.normal.x, p.normal.y, p.normal.z, p.constant]),
    points: f64arr(pts.flat()), dist: f64arr(pts.map((q) => p.distanceToPoint(new THREE.Vector3(...q)))),
  });
}
const sphereApply = [];
for (let i = 0; i < 96; i++) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(rnd(-3e4, 3e4), rnd(-300, 300), rnd(-3e4, 3e4)),
    new THREE.Quaternion(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize(),
    i % 3 === 0 ? new THREE.Vector3(1, 1, 1) : new THREE.Vector3(rnd(0.2, 3), rnd(0.2, 3), rnd(0.2, 3)),
  );
  if (i % 9 === 4) m.elements[3] = rnd(-0.01, 0.01); // a projective row: applyMatrix4's divide
  const c = [rnd(-20, 20), rnd(-20, 20), rnd(-20, 20)];
  const rad = i % 10 === 0 ? -1 : rnd(0, 40);
  const s = new THREE.Sphere(new THREE.Vector3(...c), rad).applyMatrix4(m);
  sphereApply.push({ m: f64arr(m.elements), c: f64arr(c), r: f64hex(rad), out: f64arr([s.center.x, s.center.y, s.center.z, s.radius]) });
}

const path = writeFixture("cull", {
  three: THREE.REVISION,
  cullDist: CULL_DIST_M,
  frustums, statics, degenerate, planes, sphereApply,
});
const total = frustums.reduce((n, c) => n + c.inter.length, 0);
console.log(`wrote ${frustums.length} frustums (${total} sphere tests, ${interCount} intersect), ${statics.length} walks (${visibleCount} kept / ${culledCount} culled), ` +
  `${degenerate.length} degenerate, ${planes.length} planes, ${sphereApply.length} sphere transforms → ${path}`);
