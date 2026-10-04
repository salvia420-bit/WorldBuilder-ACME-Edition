// ?statBatchRuns (perf T1, OpenAC comparison 2026-10-04) — cell-run selection
// for the static batch walk. Fixtures and loader are shared with
// test_stat_batch_walk.mjs (copied so the two suites stay independent).
//
// Original header of the shared part follows.
// ?statBatchNoSort / ?statBatchMemo (2026-08-06) — headless test for THE
// PER-INSTANCE WALK in scene3d/static_batch_x.js.
//
// WHY THIS SUITE EXISTS AND WHY IT NEEDS THE REAL THREE. `?statBatchMemo=slack`
// transcribes three's NON-SORTED `BatchedMesh.onBeforeRender` branch
// (three.core.js r184 :27329-27362) so it can dilate the frustum. A
// transcription that has drifted from the original is an invisible image bug —
// wrong multidraw byte offsets draw another geometry's triangles. So the
// central assertion here is not "it looks right", it is: **with both margins at
// zero, our loop's `_multiDrawStarts` / `_multiDrawCounts` / indirect array /
// `_multiDrawCount` are byte-identical to what three's own loop just wrote**,
// against the actual r0.184.0 build that `index.html:969` pins. A stub cannot
// show you that, so this suite SKIPS rather than passes when `three` is absent.
//
// The second load-bearing property is the SUPERSET guarantee: after a dilated
// build, moving the camera anywhere inside the validity region must leave the
// cached set a superset of the exact set at the new pose. That is what makes a
// reused answer unable to drop visible geometry, and it is tested by computing
// both sets and comparing them, not by arguing about it.
//
// Run: cd apps/holtburger-web/ && node test_stat_batch_runs.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
if (!tp) {
  console.log("stat-batch-walk test: SKIP (three not located).");
  console.log("  This suite is the ONLY check that the ?statBatchMemo=slack loop still");
  console.log("  matches three's own; run `npm i three@0.184.0` in apps/holtburger-web/.");
  process.exit(0);
}
const THREE = await import("file://" + tp);
console.log("?statBatchRuns — cell-run selection");
console.log("=========================");

// Load static_batch_x.js with the three import stripped (module only uses THREE).
let src = readFileSync(resolvePath(__dirname, "scene3d/static_batch_x.js"), "utf8");
src = src.replace(/^\s*import\s+.*$/gm, "");
const stripped = src
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const factory = new Function(
  "THREE",
  stripped +
    "\n; return { __resetStatBatchXForTest, consolidateStaticSingletonsCrossLb, " +
    "evictStaticBatchXForLb, tickStatBatchXOptimize, getStatBatchXStats, " +
    "statBatchNoSortEnabled, __setStatBatchNoSortForTest, " +
    "statBatchMemoMode, __setStatBatchMemoForTest, __setStatGeomDedupForTest, " +
    "statBatchSphereMode, __setStatBatchSphereForTest, statBatchRunsMode, __setStatBatchRunsForTest };"
);
const M = factory(THREE);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) pos.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
function singleton(surfaceDid, x, z, lbId, geom, mat) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, z);
  m.userData = { surfaceDid, landblockId: lbId >>> 0 };
  return m;
}
const LB = 0x96960000 >>> 0;

/** A bucket holding `n` instances spread over a 400x400 patch — wide enough
 *  that a 60-degree camera sees maybe a third of them, which is the only way
 *  the frustum branches get exercised at all. */
function makeBucket(mat, n = 240, geomVariants = 3) {
  const scene3d = { staticsGroup: new THREE.Group() };
  const geoms = [];
  for (let i = 0; i < geomVariants; i++) geoms.push(triGeom(1 + i));
  const nodes = [];
  // deterministic pseudo-random spread (no Math.random — a flaky suite is worse
  // than no suite)
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < n; i++) {
    nodes.push(singleton(0x08000001, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400, LB, geoms[i % geomVariants], mat));
  }
  const r = M.consolidateStaticSingletonsCrossLb(nodes, scene3d, LB);
  if (!r) throw new Error("consolidation returned null");
  const bm = scene3d.staticsGroup.children.find((c) => c.isBatchedMesh);
  scene3d.staticsGroup.updateMatrixWorld(true);
  return { scene3d, bm };
}

/**
 * Move the SAME camera object, the way the render loop does. The memo keys on
 * camera IDENTITY as well as pose (`st.camera === camera`) — a single-slot
 * cache with two cameras alive, e.g. a shadow cascade and the colour pass,
 * must miss rather than hand one camera's answer to the other. So a test that
 * built two camera objects would be testing the wrong thing.
 */
function moveCam(cam, dx, dy, dz, yaw) {
  cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
  if (yaw) cam.rotateY(yaw);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}

function makeCamera(px, py, pz, lookAt) {
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 600);
  cam.position.set(px, py, pz);
  cam.lookAt(lookAt || new THREE.Vector3(0, 0, 0));
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  return cam;
}

/** Snapshot everything a draw reads out of a BatchedMesh. */
function snapshot(bm) {
  const n = bm._multiDrawCount | 0;
  return {
    n,
    starts: Array.from(bm._multiDrawStarts.slice(0, n)),
    counts: Array.from(bm._multiDrawCounts.slice(0, n)),
    indirect: Array.from(bm._indirectTexture.image.data.slice(0, n)),
  };
}
function sameSnapshot(a, b) {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) {
    if (a.starts[i] !== b.starts[i] || a.counts[i] !== b.counts[i] || a.indirect[i] !== b.indirect[i]) return false;
  }
  return true;
}
const threeBuild = (bm, cam) =>
  THREE.BatchedMesh.prototype.onBeforeRender.call(bm, null, null, cam, bm.geometry, bm.material, null);
const memoBuild = (bm, cam) => bm.onBeforeRender(null, null, cam, bm.geometry, bm.material, null);

function opaqueMat() { const m = new THREE.MeshStandardMaterial(); m.transparent = false; return m; }
function clipMapMat() {
  const m = new THREE.MeshStandardMaterial();
  m.transparent = true; m.depthWrite = true; m.alphaTest = 0.784; m.blending = THREE.NormalBlending;
  return m;
}
function translucentMat() {
  const m = new THREE.MeshStandardMaterial();
  m.transparent = true; m.depthWrite = false; m.opacity = 0.5; m.blending = THREE.NormalBlending;
  return m;
}
function additiveMat() {
  const m = new THREE.MeshStandardMaterial();
  m.transparent = true; m.depthWrite = false; m.blending = THREE.AdditiveBlending;
  return m;
}

const reset = (mode, slacks, noSort, sphere) => {
  M.__resetStatBatchXForTest();
  M.__setStatGeomDedupForTest(false);
  M.__setStatBatchNoSortForTest(!!noSort);
  M.__setStatBatchMemoForTest(mode, slacks);
  // Every reader here memoises, so a flag left set by one section leaks into
  // every later one. `?statBatchSphere` defaults to "off" and must be reset
  // explicitly, not left to `__resetStatBatchXForTest`.
  M.__setStatBatchSphereForTest(sphere || "off");
};


const ids = (snap) => new Set(snap.indirect);
const subset = (a, b) => { for (const x of a) if (!b.has(x)) return false; return true; };
const resetRuns = (memo, runs, cellM) => {
  reset(memo, memo === "slack" ? { transM: 8, rotDeg: 3 } : undefined, false, "off");
  M.__setStatBatchRunsForTest(runs, cellM ?? 48);
};

// ---------------------------------------------------------------------------
console.log("\n-- 1. flag reader (default OFF; exact-match opt-in) --");
{
  const _l = globalThis.location;
  for (const [search, want, cell] of [
    ["", "off", 48], ["?statBatchRuns=yes", "off", 48], ["?statBatchRuns=on", "on", 48],
    ["?statBatchRuns=on:96", "on", 96], ["?statBatchRuns=on:1", "on", 48],
  ]) {
    globalThis.location = { search };
    M.__setStatBatchRunsForTest(undefined, 48);
    const got = M.statBatchRunsMode();
    const cm = M.getStatBatchXStats().walk.runs.cellM;
    check(`1.${search || "(absent)"} -> ${want}, cell ${cell}`, got === want && cm === cell, `${got} ${cm}`);
  }
  if (_l === undefined) delete globalThis.location; else globalThis.location = _l;
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. exact tier: a SUPERSET of three's answer, ranges intact --");
{
  resetRuns("off", "on");
  const { bm } = makeBucket(opaqueMat(), 600, 3);
  const cam = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
  let worstOver = 0, allSuper = true, rangesOk = true;
  for (let step = 0; step < 12; step++) {
    moveCam(cam, 3, 0, -2, 0.5);
    threeBuild(bm, cam);
    const exact = snapshot(bm);
    memoBuild(bm, cam);
    const runs = snapshot(bm);
    if (!subset(ids(exact), ids(runs))) allSuper = false;
    // Each emitted id carries exactly three's (start, count) for that id.
    const byId = new Map();
    for (let k = 0; k < exact.n; k++) byId.set(exact.indirect[k], [exact.starts[k], exact.counts[k]]);
    for (let k = 0; k < runs.n; k++) {
      const e = byId.get(runs.indirect[k]);
      if (e && (e[0] !== runs.starts[k] || e[1] !== runs.counts[k])) rangesOk = false;
    }
    if (exact.n > 0) worstOver = Math.max(worstOver, runs.n / exact.n - 1);
  }
  const st = M.getStatBatchXStats().walk.runs;
  check("2a: every exact instance is drawn (never a drop)", allSuper);
  check("2b: shared ids carry three's own byte offset + count", rangesOk);
  check("2c: no over-inclusion — the SAME set as three's loop", worstOver === 0,
    `worst +${(worstOver * 100).toFixed(1)}%`);
  check("2f: most drawn cells were copied whole", st.cellsInside > 0 && st.membersTested < st.slotsCovered,
    `inside=${st.cellsInside}/${st.cellsDrawn} tested=${st.membersTested} covered=${st.slotsCovered}`);
  check("2d: the run cache was built once for 12 moving frames", st.builds === 1 && st.walks === 12,
    `builds=${st.builds} walks=${st.walks}`);
  check("2e: cells are coarser than slots", st.cellsTested / st.walks < 600, `cells/walk=${st.cellsTested / st.walks}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. no duplicate draws, every live slot reachable --");
{
  resetRuns("off", "on");
  const { bm } = makeBucket(opaqueMat(), 300, 2);
  // a camera far above looking down with a wide frustum sees the whole patch
  const cam = new THREE.PerspectiveCamera(120, 1, 1, 5000);
  cam.position.set(0, 600, 0.001); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert(); cam.updateProjectionMatrix();
  threeBuild(bm, cam);
  const exact = snapshot(bm);
  memoBuild(bm, cam);
  const runs = snapshot(bm);
  check("3a: whole patch in view -> identical id SET", runs.n === exact.n && subset(ids(exact), ids(runs)),
    `${runs.n} vs ${exact.n}`);
  check("3b: no id emitted twice", ids(runs).size === runs.n);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. invalidation: visibility and membership --");
{
  resetRuns("off", "on");
  const { bm, scene3d } = makeBucket(opaqueMat(), 200, 2);
  const cam = new THREE.PerspectiveCamera(120, 1, 1, 5000);
  cam.position.set(0, 600, 0.001); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert(); cam.updateProjectionMatrix();
  memoBuild(bm, cam);
  const before = snapshot(bm);
  const victim = before.indirect[5];
  bm.setVisibleAt(victim, false);
  memoBuild(bm, cam);
  const after = snapshot(bm);
  check("4a: setVisibleAt(false) drops the slot on the next walk", !ids(after).has(victim) && after.n === before.n - 1);
  bm.setVisibleAt(victim, true);
  memoBuild(bm, cam);
  check("4b: ...and setVisibleAt(true) restores it", ids(snapshot(bm)).has(victim));
  const buildsBefore = M.getStatBatchXStats().walk.runs.builds;
  // A second feed into the same bucket (same material, same LB) moves the epoch.
  // From a NEIGHBOURING landblock, so the same 3x3 region bucket is fed (a
  // same-LB re-feed replaces the LB's rows instead).
  const nb = (LB + 0x00010000) >>> 0;
  const extra = [];
  for (let i = 0; i < 20; i++) extra.push(singleton(0x08000001, i * 3, -i * 3, nb, triGeom(1), bm.material));
  M.consolidateStaticSingletonsCrossLb(extra, scene3d, nb);
  scene3d.staticsGroup.updateMatrixWorld(true);
  memoBuild(bm, cam);
  const fed = snapshot(bm);
  threeBuild(bm, cam);
  const exactFed = snapshot(bm);
  check("4c: a feed rebuilds the runs and draws the new placements",
    M.getStatBatchXStats().walk.runs.builds > buildsBefore && subset(ids(exactFed), ids(fed)),
    `fed=${fed.n} exact=${exactFed.n}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. slack tier: the cached runs stay a superset inside the validity region --");
{
  resetRuns("slack", "on");
  const { bm } = makeBucket(opaqueMat(), 600, 3);
  const cam = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
  memoBuild(bm, cam); // miss -> dilated runs build
  const cached = snapshot(bm);
  let ok = true, hits = 0;
  for (let step = 0; step < 6; step++) {
    moveCam(cam, 1, 0, 0.5, 0.008); // inside 8 m / 3 deg
    const callsBefore = M.getStatBatchXStats().walk.hitsSlack;
    memoBuild(bm, cam);
    if (M.getStatBatchXStats().walk.hitsSlack > callsBefore) hits++;
    const reused = snapshot(bm);
    threeBuild(bm, cam);
    const exact = snapshot(bm);
    if (!subset(ids(exact), ids(reused))) ok = false;
    // restore the reused arrays (threeBuild overwrote them) so the next hit reads them
    bm._multiDrawStarts.set(reused.starts); bm._multiDrawCounts.set(reused.counts);
    bm._indirectTexture.image.data.set(reused.indirect); bm._multiDrawCount = reused.n;
  }
  check("5a: slack hits served from the dilated runs", hits >= 1, `hits=${hits}`);
  check("5b: exact set at every later pose is inside the cached set", ok);
  check("5c: the first miss went through runs, not the slack loop",
    M.getStatBatchXStats().walk.runs.walks >= 1 && cached.n > 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. off is inert; sorted buckets fall through --");
{
  resetRuns("off", "off");
  const { bm } = makeBucket(opaqueMat(), 100, 2);
  check("6a: all flags off -> no override installed", !Object.prototype.hasOwnProperty.call(bm, "onBeforeRender"));
  resetRuns("off", "on");
  const { bm: tb } = makeBucket(translucentMat(), 100, 2);
  const cam = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
  memoBuild(tb, cam);
  const r = M.getStatBatchXStats().walk.runs;
  check("6b: a sorted (translucent) bucket is ineligible", tb.sortObjects === true && r.walks === 0 && r.ineligible >= 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. bench (informational; every arm warmed first) --");
{
  for (const n of [60, 200, 2000, 200, 60]) {
    resetRuns("off", "on");
    const { bm } = makeBucket(opaqueMat(), n, 3);
    const cam = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
    const iters = 400;
    memoBuild(bm, cam);
    let t = performance.now();
    for (let i = 0; i < iters; i++) { moveCam(cam, 0.01, 0, 0, 0.001); memoBuild(bm, cam); }
    const runsUs = ((performance.now() - t) * 1000) / iters;
    M.__setStatBatchRunsForTest("off");
    M.__setStatBatchSphereForTest("on");
    memoBuild(bm, cam);
    t = performance.now();
    for (let i = 0; i < iters; i++) { moveCam(cam, 0.01, 0, 0, 0.001); memoBuild(bm, cam); }
    const sphUs = ((performance.now() - t) * 1000) / iters;
    t = performance.now();
    for (let i = 0; i < iters; i++) { moveCam(cam, 0.01, 0, 0, 0.001); threeBuild(bm, cam); }
    const threeUs = ((performance.now() - t) * 1000) / iters;
    console.log(`  n=${n}: runs ${runsUs.toFixed(1)} us · sphere cache ${sphUs.toFixed(1)} us · three ${threeUs.toFixed(1)} us per moving rebuild`);
  }
}

console.log("=========================");
console.log(`stat-batch-runs test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
