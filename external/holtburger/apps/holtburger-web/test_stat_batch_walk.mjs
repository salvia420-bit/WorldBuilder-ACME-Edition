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
// Run: cd apps/holtburger-web/ && node test_stat_batch_walk.mjs

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
console.log("?statBatchNoSort / ?statBatchMemo — the per-instance walk");
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
    "statBatchSphereMode, __setStatBatchSphereForTest };"
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

// ---------------------------------------------------------------------------
console.log("\n-- 1. flag readers (default OFF; exact-match opt-in) --");
// The readers memoise, so they are exercised through the test seams plus one
// direct read of the un-set state.
M.__setStatBatchNoSortForTest(undefined);
M.__setStatBatchMemoForTest(undefined);
check("1: ?statBatchNoSort defaults OFF with no location.search", M.statBatchNoSortEnabled() === false);
// DEFAULT FLIPPED 2026-08-06: `?statBatchMemo` ships "slack" (-4.00 ms parked
// on the 1070, control spread 2.30 ms; ktris +7.3%; errors 0). `=off` escapes.
M.__setStatBatchMemoForTest(undefined);
check("2: ?statBatchMemo defaults to \"slack\" (DEFAULT-ON 2026-08-06)", M.statBatchMemoMode() === "slack");
// The escape is the revert path for the one thing not measured (the moving
// case), so it gets its own row rather than riding on the default assertion.
{
  const _w = globalThis.window; const _l = globalThis.location;
  for (const [search, want] of [
    ["?statBatchMemo=off", "off"],
    ["?statBatchMemo=0", "off"],
    ["?statBatchMemo=false", "off"],
    ["?statBatchMemo=on", "exact"],
    ["?statBatchMemo=exact", "exact"],
    ["?statBatchMemo=slack", "slack"],
    ["?statBatchMemo=wat", "slack"],   // a typo must not silently cost 4 ms
    ["", "slack"],
  ]) {
    globalThis.window = { location: { search } };
    globalThis.location = { search };   // the reader uses globalThis.location, not window.location
    M.__setStatBatchMemoForTest(undefined);
    check(`2.${search || "(absent)"}: -> ${want}`, M.statBatchMemoMode() === want);
  }
  if (_w === undefined) delete globalThis.window; else globalThis.window = _w;
  if (_l === undefined) delete globalThis.location; else globalThis.location = _l;
  M.__setStatBatchMemoForTest(undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. ?statBatchNoSort — sortObjects follows the blend, not the flag bit --");
{
  reset("off", null, false);
  const a = makeBucket(opaqueMat(), 8);
  const b = makeBucket(clipMapMat(), 8);
  const c = makeBucket(translucentMat(), 8);
  const d = makeBucket(additiveMat(), 8);
  check("3: flag OFF is byte-identical to `!!mat.transparent`",
    a.bm.sortObjects === false && b.bm.sortObjects === true && c.bm.sortObjects === true && d.bm.sortObjects === true,
    `opaque=${a.bm.sortObjects} clipmap=${b.bm.sortObjects} translucent=${c.bm.sortObjects} additive=${d.bm.sortObjects}`);

  reset("off", null, true);
  const a2 = makeBucket(opaqueMat(), 8);
  const b2 = makeBucket(clipMapMat(), 8);
  const c2 = makeBucket(translucentMat(), 8);
  const d2 = makeBucket(additiveMat(), 8);
  check("4: flag ON drops the sort for a depth-writing alpha MASK (ClipMap)", b2.bm.sortObjects === false);
  check("5: flag ON drops the sort for ADDITIVE (addition commutes)", d2.bm.sortObjects === false);
  check("6: flag ON KEEPS the sort for a true translucent (depthWrite false, normal blend)", c2.bm.sortObjects === true);
  check("7: opaque is unaffected either way", a2.bm.sortObjects === false);

  // `_reseatSurfaceState` case: the material's blend state is rewritten after
  // the bucket was built, in the direction that RE-ARMS the sort.
  reset("off", null, true);
  const mat = clipMapMat();
  const e = makeBucket(mat, 8);
  check("8: bucket starts unsorted (ClipMap)", e.bm.sortObjects === false);
  mat.depthWrite = false; mat.blending = THREE.NormalBlending;
  M.tickStatBatchXOptimize();
  check("9: the ~10 Hz tick RE-DERIVES it after a reseat (unsorted -> sorted)", e.bm.sortObjects === true);
  mat.depthWrite = true;
  M.tickStatBatchXOptimize();
  check("10: and back again — the re-derive runs in BOTH directions", e.bm.sortObjects === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. ?statBatchMemo install / no-install --");
{
  reset("off", null, false);
  const { bm } = makeBucket(opaqueMat(), 8);
  check("11: mode off installs NO override (prototype is untouched)",
    !Object.prototype.hasOwnProperty.call(bm, "onBeforeRender") && bm.userData.__memo === undefined);

  reset("exact", null, false);
  const b2 = makeBucket(opaqueMat(), 8);
  check("12: mode exact installs an OWN-property override on the bucket only",
    Object.prototype.hasOwnProperty.call(b2.bm, "onBeforeRender")
    && typeof b2.bm.onBeforeRender === "function"
    && THREE.BatchedMesh.prototype.onBeforeRender !== b2.bm.onBeforeRender);
  check("13: the prototype itself is NOT patched (nothing else in the tree changes)",
    !Object.prototype.hasOwnProperty.call(new THREE.BatchedMesh(4, 64, 128, opaqueMat()), "onBeforeRender"));
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. THE IDENTITY: slack loop with zero margins == three's own loop --");
{
  for (const [name, matFn, n] of [
    ["opaque/240", opaqueMat, 240],
    ["opaque/1 geometry", opaqueMat, 17],
  ]) {
    reset("slack", { transM: 0, rotDeg: 0 }, false);
    const { bm } = makeBucket(matFn(), n);
    const cam = makeCamera(60, 30, 60);
    threeBuild(bm, cam);
    const want = snapshot(bm);
    // wipe the arrays so a no-op would fail loudly, then build ours
    bm._multiDrawCount = 0;
    bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
    bm._indirectTexture.image.data.fill(0xffff);
    bm._visibilityChanged = true;   // force a rebuild, not a hit
    bm.userData.__memo.valid = false;
    memoBuild(bm, cam);
    const got = snapshot(bm);
    check(`14 (${name}): multidraw arrays byte-identical to three's`, sameSnapshot(want, got),
      `three n=${want.n} ours n=${got.n}`);
    check(`15 (${name}): and it actually culled something (the test is not vacuous)`,
      want.n > 0 && want.n < bm._instanceInfo.length,
      `drawn=${want.n} of ${bm._instanceInfo.length}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. exact tier: a still camera is reused, a moved one is not --");
{
  reset("exact", null, false);
  const { bm } = makeBucket(opaqueMat(), 200);
  const cam = makeCamera(60, 30, 60);
  memoBuild(bm, cam);
  const first = snapshot(bm);
  let s = M.getStatBatchXStats().walk;
  check("16: first call is a rebuild", s.rebuilds === 1 && s.hitsExact === 0 && s.hitsSlack === 0);
  memoBuild(bm, cam);
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("17: the next two calls are EXACT hits", s.hitsExact === 2 && s.rebuilds === 1, JSON.stringify({ hitsExact: s.hitsExact, rebuilds: s.rebuilds }));
  check("18: a hit leaves the arrays exactly as they were", sameSnapshot(first, snapshot(bm)));
  check("19: instancesSkipped counts the SLOTS a hit did not visit",
    s.instancesSkipped === 2 * bm._instanceInfo.length, `${s.instancesSkipped} vs ${2 * bm._instanceInfo.length}`);

  // a camera that moved by any amount at all must NOT hit in exact mode
  const cam2 = makeCamera(60.0001, 30, 60);
  memoBuild(bm, cam2);
  s = M.getStatBatchXStats().walk;
  check("20: a camera moved by 0.1 mm forces a rebuild in exact mode", s.rebuilds === 2);

  // projection change (fov / render scale) invalidates too
  memoBuild(bm, cam2);
  cam2.fov = 75; cam2.updateProjectionMatrix();
  memoBuild(bm, cam2);
  s = M.getStatBatchXStats().walk;
  check("21: a projectionMatrix change invalidates the cache", s.rebuilds === 3);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. invalidation: feed, evict, optimize --");
{
  reset("exact", null, false);
  const scene3d = { staticsGroup: new THREE.Group() };
  const mat = opaqueMat();
  const g = triGeom(1);
  const feed = (lb, count, xoff) => {
    const nodes = [];
    for (let i = 0; i < count; i++) nodes.push(singleton(0x08000001, xoff + i, 0, lb, g, mat));
    M.consolidateStaticSingletonsCrossLb(nodes, scene3d, lb);
    scene3d.staticsGroup.updateMatrixWorld(true);
  };
  feed(0x96960000, 6, 0);
  const bm = scene3d.staticsGroup.children.find((c) => c.isBatchedMesh);
  const cam = makeCamera(0, 20, 40);
  memoBuild(bm, cam);
  memoBuild(bm, cam);
  check("22: settled bucket hits", M.getStatBatchXStats().walk.hitsExact === 1);
  feed(0x97970000, 6, 100);   // same 3x3 region -> same bucket
  memoBuild(bm, cam);
  check("23: a FEED into the bucket forces a rebuild (setMatrixAt is not flagged by three)",
    M.getStatBatchXStats().walk.rebuilds === 2);
  memoBuild(bm, cam);
  check("24: and it settles again", M.getStatBatchXStats().walk.hitsExact === 2);
  M.evictStaticBatchXForLb(0x97970000);
  memoBuild(bm, cam);
  check("25: an EVICT forces a rebuild", M.getStatBatchXStats().walk.rebuilds === 3);
  memoBuild(bm, cam);
  const beforeOpt = M.getStatBatchXStats().walk.rebuilds;
  M.tickStatBatchXOptimize();   // >30% dead -> optimize() rewrites every start
  memoBuild(bm, cam);
  check("26: optimize() invalidates even though the instance SET did not change",
    M.getStatBatchXStats().walk.rebuilds === beforeOpt + 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. THE SUPERSET GUARANTEE under camera motion --");
{
  const TRANS = 8, ROTDEG = 3;
  reset("slack", { transM: TRANS, rotDeg: ROTDEG }, false);
  const { bm } = makeBucket(opaqueMat(), 400);
  const cam0 = makeCamera(80, 25, 80);
  memoBuild(bm, cam0);
  const cached = snapshot(bm);
  let s = M.getStatBatchXStats().walk;
  check("27: the slack build ran through OUR loop", s.rebuildsSlack === 1 && s.rebuilds === 0);
  check("28: dilation admits MORE than the exact set (the margin is doing something)",
    (() => {
      bm._visibilityChanged = true; bm.userData.__memo.valid = false;
      M.__setStatBatchMemoForTest("slack", { transM: 0, rotDeg: 0 });
      memoBuild(bm, cam0);
      const exact = snapshot(bm);
      M.__setStatBatchMemoForTest("slack", { transM: TRANS, rotDeg: ROTDEG });
      return cached.n > exact.n;
    })(), `dilated=${cached.n}`);

  // Re-establish the dilated cache, then probe poses inside the region.
  reset("slack", { transM: TRANS, rotDeg: ROTDEG }, false);
  const fx = makeBucket(opaqueMat(), 400);
  memoBuild(fx.bm, cam0);
  const cachedSet = new Set(snapshot(fx.bm).indirect);
  let worstMissing = 0;
  let probes = 0;
  const rot = (deg) => (deg * Math.PI) / 180;
  for (const [dx, dy, dz, yaw] of [
    [TRANS, 0, 0, 0], [-TRANS, 0, 0, 0], [0, 0, TRANS, 0], [0, TRANS * 0.5, -TRANS * 0.5, 0],
    [0, 0, 0, rot(ROTDEG)], [0, 0, 0, -rot(ROTDEG)],
    [TRANS * 0.7, 0, TRANS * 0.7, rot(ROTDEG)], [-TRANS * 0.7, 0, -TRANS * 0.7, -rot(ROTDEG)],
  ]) {
    // exact set at the probed pose, computed by THREE, not by us
    const probe = new THREE.PerspectiveCamera(60, 1.6, 0.1, 600);
    probe.position.set(80 + dx, 25 + dy, 80 + dz);
    probe.lookAt(0, 0, 0);
    probe.rotateY(yaw);
    probe.updateMatrixWorld(true);
    probe.matrixWorldInverse.copy(probe.matrixWorld).invert();
    probe.updateProjectionMatrix();
    const probeBucket = (() => {
      // a second identical bucket so computing the exact set cannot disturb
      // the cached one
      M.__setStatBatchMemoForTest("off");
      const b = makeBucket(opaqueMat(), 400);
      M.__setStatBatchMemoForTest("slack", { transM: TRANS, rotDeg: ROTDEG });
      return b.bm;
    })();
    threeBuild(probeBucket, probe);
    const exact = snapshot(probeBucket);
    let missing = 0;
    for (const id of exact.indirect) if (!cachedSet.has(id)) missing++;
    if (missing > worstMissing) worstMissing = missing;
    probes++;
  }
  check(`29: over ${probes} poses on the boundary of the validity region, the cached set is a SUPERSET of every exact set`,
    worstMissing === 0, `worst miss = ${worstMissing} instances`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 8. slack tier: hits inside the region, rebuilds outside --");
{
  const TRANS = 10, ROTDEG = 4;
  reset("slack", { transM: TRANS, rotDeg: ROTDEG }, false);
  const { bm } = makeBucket(opaqueMat(), 300);
  const cam = makeCamera(80, 25, 80);
  memoBuild(bm, cam);
  const cached = snapshot(bm);
  moveCam(cam, TRANS * 0.5, 0, 0, 0);
  memoBuild(bm, cam);
  let s = M.getStatBatchXStats().walk;
  check("30: a camera inside the region takes a SLACK hit", s.hitsSlack === 1,
    JSON.stringify({ hitsSlack: s.hitsSlack, rebuildsSlack: s.rebuildsSlack }));
  check("31: the slack hit leaves the arrays untouched", sameSnapshot(cached, snapshot(bm)));

  moveCam(cam, TRANS * 1.0, 0, 0, 0);   // now 1.5 * TRANS from the build pose
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("32: a camera past the translation slack rebuilds", s.rebuildsSlack === 2 && s.hitsSlack === 1);

  // rotation past the slack, from a standing start
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("33: standing still after that rebuild hits again", s.hitsExact === 1);
  moveCam(cam, 0, 0, 0, (ROTDEG * 3 * Math.PI) / 180);
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("34: a camera rotated past the rotation slack rebuilds", s.rebuildsSlack === 3);
  // ...and a rotation INSIDE it does not
  memoBuild(bm, cam);
  moveCam(cam, 0, 0, 0, (ROTDEG * 0.4 * Math.PI) / 180);
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("35: a small rotation inside the slack is a hit", s.hitsSlack === 2, JSON.stringify({ hitsSlack: s.hitsSlack }));
}

// ---------------------------------------------------------------------------
console.log("\n-- 9. sorted buckets fall back to three, and still memoise exactly --");
{
  reset("slack", { transM: 10, rotDeg: 4 }, false);
  const { bm } = makeBucket(translucentMat(), 120);
  check("36: the bucket really is sorted", bm.sortObjects === true);
  const cam = makeCamera(60, 30, 60);
  memoBuild(bm, cam);
  let s = M.getStatBatchXStats().walk;
  check("37: a sorted bucket is rebuilt by THREE's loop, never ours (we do not re-implement its sort)",
    s.rebuilds === 1 && s.rebuildsSlack === 0);
  const want = snapshot(bm);
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("38: but a still camera still takes an exact hit on it", s.hitsExact === 1 && s.hitsSlack === 0);
  check("39: with the sort order preserved verbatim", sameSnapshot(want, snapshot(bm)));

  // a moved camera must NOT slack-hit a sorted bucket: its z-order changed
  moveCam(cam, 1, 0, 0, 0);
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("40: a 1 m camera move re-sorts it rather than reusing a stale order",
    s.hitsSlack === 0 && s.rebuilds === 2);
}

// ---------------------------------------------------------------------------
console.log("\n-- 10. fail-soft --");
{
  // Zero margins so "our loop" and "three's loop" must agree exactly — this
  // section is about WHICH loop ran, not about dilation.
  reset("slack", { transM: 0, rotDeg: 0 }, false);
  const { bm } = makeBucket(opaqueMat(), 60);
  const cam = makeCamera(60, 30, 60);
  threeBuild(bm, cam);
  const want = snapshot(bm);

  // A bucket the dilated loop is not allowed to touch (here: per-instance
  // culling turned off, which changes what the loop MEANS) must take three's
  // path and produce three's picture. Note there is deliberately no test for
  // "three's internals moved but three still works" — every internal our loop
  // reads, three's loop reads too, so that scenario cannot exist; the honest
  // fallbacks are the eligibility gate and the exception guard below.
  bm.perObjectFrustumCulled = false;
  bm._visibilityChanged = true; bm.userData.__memo.valid = false;
  memoBuild(bm, cam);
  let s = M.getStatBatchXStats().walk;
  check("41: an ineligible bucket falls back to three's own loop", s.rebuilds === 1 && s.rebuildsSlack === 0);
  bm.perObjectFrustumCulled = true;
  bm._visibilityChanged = true; bm.userData.__memo.valid = false;
  memoBuild(bm, cam);
  check("42: and re-arming it reproduces three's picture exactly", sameSnapshot(want, snapshot(bm)));

  // An exception raised while DECIDING must be caught, counted, and answered
  // with a rebuild — never with a stale reuse.
  const st = bm.userData.__memo;
  const goodProj = st.proj;
  st.proj = null;                    // _elemsEqual(null, ...) throws
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk;
  check("43: an exception in the decision is COUNTED and answered with a rebuild",
    s.errors >= 1 && s.rebuildsSlack === 2, JSON.stringify({ errors: s.errors, rebuildsSlack: s.rebuildsSlack }));
  check("44: the picture is still three's", sameSnapshot(want, snapshot(bm)));
  st.proj = goodProj;

  // A bucket with nothing in frustum must walk to zero draws without throwing,
  // and must still be reusable next frame. (A bucket whose LAST geometry is
  // evicted is REAPED and disposed — `_reapBucketIfEmpty` — so it leaves the
  // scene graph and is never submitted; that is not a case this path sees.)
  reset("slack", { transM: 8, rotDeg: 3 }, false);
  const away = makeBucket(opaqueMat(), 60).bm;
  const awayCam = makeCamera(4000, 30, 4000, new THREE.Vector3(9000, 30, 9000));
  let threw = false;
  try { memoBuild(away, awayCam); memoBuild(away, awayCam); } catch (_) { threw = true; }
  const s2 = M.getStatBatchXStats().walk;
  check("45: an all-culled bucket walks to zero draws, without throwing, and still memoises",
    threw === false && (away._multiDrawCount | 0) === 0 && s2.hitsExact >= 1,
    JSON.stringify({ threw, n: away._multiDrawCount, hitsExact: s2.hitsExact }));
}

// ---------------------------------------------------------------------------
console.log("\n-- 11. the census the 1070 will be scored on --");
{
  reset("slack", { transM: 8, rotDeg: 3 }, true);
  const { bm } = makeBucket(clipMapMat(), 150);
  const cam = makeCamera(60, 30, 60);
  memoBuild(bm, cam);
  memoBuild(bm, cam);
  const st = M.getStatBatchXStats();
  const w = st.walk;
  check("46: walk.mode / walk.noSort report the live flag state", w.mode === "slack" && w.noSort === true);
  check("47: walk.slots.all is the SLOT count three walks, not the live instance count",
    w.slots.all === bm._instanceInfo.length && w.slots.all >= st.instances,
    `slots=${w.slots.all} instances=${st.instances}`);
  check("48: a ?statBatchNoSort bucket is counted as unsorted",
    w.sortedBuckets === 0 && w.slots.sorted === 0);
  check("49: per-bucket detail carries slots + sorted", st.detail[0].slots === w.slots.all && st.detail[0].sorted === false);
  check("50: slack margins are reported so a sweep can be attributed",
    w.slackTransM === 8 && Math.abs(w.slackRotDeg - 3) < 1e-9);
  check("51: hit/rebuild counters are consistent with the call count",
    w.calls === w.hitsExact + w.hitsSlack + w.rebuilds + w.rebuildsSlack,
    JSON.stringify({ calls: w.calls, hitsExact: w.hitsExact, hitsSlack: w.hitsSlack, rebuilds: w.rebuilds, rebuildsSlack: w.rebuildsSlack }));
  check("52: no fail-soft fallbacks fired on the happy path", w.errors === 0);

  reset("off", null, false);
  const off = M.getStatBatchXStats().walk;
  check("53: with both flags off the census still reports the population (mode off, zero calls)",
    off.mode === "off" && off.noSort === false && off.calls === 0 && off.installed === 0);
}

// ---------------------------------------------------------------------------
// ?statBatchSphere — the per-instance sphere cache.
//
// The load-bearing assertion is the same one section 4 makes for the slack
// loop, and for the same reason: this walk is a TRANSCRIPTION of three's, and a
// transcription that has drifted writes another geometry's byte range. So the
// central check is byte-identity against the real r0.184.0 build — here across a
// camera that MOVES (the case the memo cannot serve) and across an epoch bump.
// ---------------------------------------------------------------------------
console.log("\n-- 12. ?statBatchSphere: flag, install, and the identity under motion --");
{
  M.__setStatBatchSphereForTest(undefined);
  check("54: ?statBatchSphere defaults to \"off\"", M.statBatchSphereMode() === "off");

  reset("off", null, false, "off");
  const plain = makeBucket(opaqueMat(), 8).bm;
  check("55: off installs NO override and NO cache state",
    !Object.prototype.hasOwnProperty.call(plain, "onBeforeRender")
    && plain.userData.__memo === undefined && plain.userData.__sphereCache === undefined);

  reset("off", null, false, "on");
  const armed = makeBucket(opaqueMat(), 8).bm;
  check("56: on (with memo off) installs an own-property override plus the epoch state",
    Object.prototype.hasOwnProperty.call(armed, "onBeforeRender")
    && armed.onBeforeRender !== THREE.BatchedMesh.prototype.onBeforeRender
    && armed.userData.__memo !== undefined);
  check("57: the prototype itself is still NOT patched",
    !Object.prototype.hasOwnProperty.call(new THREE.BatchedMesh(4, 64, 128, opaqueMat()), "onBeforeRender"));

  // THE IDENTITY, over four poses of a moving camera. Each iteration builds
  // three's answer first, wipes the arrays so a no-op fails loudly, then builds
  // ours from the cache — which is NOT rebuilt between poses, since the camera
  // does not bump the epoch. That is the whole property being tested.
  reset("off", null, false, "on");
  const { bm } = makeBucket(opaqueMat(), 300);
  const cam = makeCamera(70, 28, 70);
  let allSame = true;
  let culledSomething = false;
  for (let step = 0; step < 4; step++) {
    threeBuild(bm, cam);
    const want = snapshot(bm);
    if (want.n > 0 && want.n < bm._instanceInfo.length) culledSomething = true;
    bm._multiDrawCount = 0;
    bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
    bm._indirectTexture.image.data.fill(0xffff);
    memoBuild(bm, cam);
    if (!sameSnapshot(want, snapshot(bm))) allSame = false;
    moveCam(cam, -9, 1, -7, 0.09);
  }
  check("58: cached build is byte-identical to three's at every pose of a MOVING camera", allSame);
  check("59: and it actually culled something (the identity is not vacuous)", culledSomething);

  const s = M.getStatBatchXStats().walk.sphere;
  check("60: the cache was built ONCE for four frames — a moving camera does not invalidate it",
    s.builds === 1 && s.calls === 4,
    JSON.stringify({ builds: s.builds, calls: s.calls, slotsWalked: s.slotsWalked }));
  check("61: no fail-soft fallbacks and nothing ineligible on the happy path",
    s.errors === 0 && s.ineligible === 0);
  check("62: bytes reports the live Float64 cache (4 doubles per slot)",
    s.bytes >= bm._instanceInfo.length * 32, `bytes=${s.bytes} slots=${bm._instanceInfo.length}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 13. ?statBatchSphere: invalidation, growth, and eligibility --");
{
  // A second feed into the same region runs `setMatrixAt` on the SAME bucket —
  // the change three does not flag via `_visibilityChanged`, and the exact hole
  // `_memoInvalidate` exists to close. If the epoch did not carry to the sphere
  // cache, the new instances would be culled against stale (or absent) spheres.
  reset("off", null, false, "on");
  const scene3d = { staticsGroup: new THREE.Group() };
  const geom = triGeom(1);
  const mat = opaqueMat();
  const mk = (n, off) => {
    const out = [];
    let s = 999 + off;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n; i++) out.push(singleton(0x08000001, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400, LB, geom, mat));
    return out;
  };
  M.consolidateStaticSingletonsCrossLb(mk(40, 0), scene3d, LB);
  const bm = scene3d.staticsGroup.children.find((c) => c.isBatchedMesh);
  scene3d.staticsGroup.updateMatrixWorld(true);
  const cam = makeCamera(60, 30, 60);
  memoBuild(bm, cam);
  const slotsBefore = bm._instanceInfo.length;
  const buildsBefore = M.getStatBatchXStats().walk.sphere.builds;

  // grow past the first allocation, from a NEIGHBOURING landblock so the same
  // 3x3 region bucket is reused rather than a new one created
  M.consolidateStaticSingletonsCrossLb(mk(260, 7), scene3d, (LB + 0x00010000) >>> 0);
  scene3d.staticsGroup.updateMatrixWorld(true);
  const grew = bm._instanceInfo.length > slotsBefore;

  threeBuild(bm, cam);
  const want = snapshot(bm);
  bm._multiDrawCount = 0;
  bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
  bm._indirectTexture.image.data.fill(0xffff);
  memoBuild(bm, cam);
  const s = M.getStatBatchXStats().walk.sphere;
  check("63: the feed grew the bucket (the growth path is actually exercised)", grew,
    `slots ${slotsBefore} -> ${bm._instanceInfo.length}`);
  check("64: a setMatrixAt feed invalidates the cache and it is REBUILT", s.builds > buildsBefore,
    JSON.stringify({ before: buildsBefore, after: s.builds }));
  check("65: and the rebuilt answer is still byte-identical to three's", sameSnapshot(want, snapshot(bm)),
    `three n=${want.n} ours n=${snapshot(bm).n}`);

  // Sorted buckets are ineligible by construction — three's sorted branch needs
  // its module-private `_renderList`, so the cache must decline, not improvise.
  reset("off", null, false, "on");
  const sorted = makeBucket(translucentMat(), 60).bm;
  check("66: a sorted bucket really is sorted", sorted.sortObjects === true);
  const cam2 = makeCamera(60, 30, 60);
  memoBuild(sorted, cam2);
  const want2 = snapshot(sorted);
  threeBuild(sorted, cam2);
  const s2 = M.getStatBatchXStats().walk.sphere;
  check("67: a sorted bucket is declined and falls through to three's own loop",
    s2.ineligible === 1 && s2.builds === 0 && sameSnapshot(want2, snapshot(sorted)));

  // The eviction accounting: a reaped bucket hands its cache bytes back.
  reset("off", null, false, "on");
  const sc = { staticsGroup: new THREE.Group() };
  M.consolidateStaticSingletonsCrossLb(mk(30, 3), sc, LB);
  const doomed = sc.staticsGroup.children.find((c) => c.isBatchedMesh);
  sc.staticsGroup.updateMatrixWorld(true);
  memoBuild(doomed, makeCamera(60, 30, 60));
  const held = M.getStatBatchXStats().walk.sphere.bytes;
  M.evictStaticBatchXForLb(LB);
  check("68: cache bytes are held while the bucket lives and returned when it is reaped",
    held > 0 && M.getStatBatchXStats().walk.sphere.bytes === 0,
    JSON.stringify({ held, after: M.getStatBatchXStats().walk.sphere.bytes }));
}

// ---------------------------------------------------------------------------
// `=verify` is the tier that makes a stale sphere findable on the 1070 rather
// than arguable. A verifier that cannot fail is not a verifier, so this asserts
// BOTH directions: clean on the happy path, and loud on a corrupted cache.
// ---------------------------------------------------------------------------
console.log("\n-- 14. ?statBatchSphere=verify catches a stale cache --");
{
  reset("off", null, false, "verify");
  const { bm } = makeBucket(opaqueMat(), 120);
  const cam = makeCamera(60, 30, 60);
  memoBuild(bm, cam);
  let s = M.getStatBatchXStats().walk.sphere;
  check("69: verify mode checks every visible slot and finds nothing wrong",
    s.mode === "verify" && s.verifyChecked > 0 && s.verifyFails === 0,
    JSON.stringify({ checked: s.verifyChecked, fails: s.verifyFails }));

  // Corrupt one entry the way a missed invalidation would: the placement moved,
  // the cache did not.
  bm.userData.__sphereCache.arr[0] += 1234.5;
  memoBuild(bm, cam);
  s = M.getStatBatchXStats().walk.sphere;
  check("70: a hand-corrupted entry is reported (the verifier can fail)", s.verifyFails >= 1,
    JSON.stringify({ fails: s.verifyFails }));
}

// ---------------------------------------------------------------------------
// The two flags share one `onBeforeRender` seam, so "both on" is a distinct
// code path and not a free composition. With both on the memo owns the seam and
// routes its MISSES through the cache — which must still be three's answer.
// ---------------------------------------------------------------------------
console.log("\n-- 15. ?statBatchMemo + ?statBatchSphere compose on one seam --");
{
  reset("exact", null, false, "on");
  const { bm } = makeBucket(opaqueMat(), 200);
  const cam = makeCamera(65, 30, 65);
  memoBuild(bm, cam);                    // miss -> cached rebuild
  memoBuild(bm, cam);                    // still camera -> exact memo hit
  let w = M.getStatBatchXStats().walk;
  check("71: the memo owns the seam and still hits on a still camera",
    w.hitsExact === 1 && w.rebuilds === 0 && w.rebuildsSlack === 1,
    JSON.stringify({ hitsExact: w.hitsExact, rebuilds: w.rebuilds, rebuildsSlack: w.rebuildsSlack }));
  check("72: the miss was served by the sphere cache, not three's loop",
    w.sphere.builds === 1 && w.sphere.errors === 0 && w.sphere.ineligible === 0,
    JSON.stringify(w.sphere));

  moveCam(cam, -14, 0, -11, 0.12);       // memo miss -> cached rebuild again
  threeBuild(bm, cam);
  const want = snapshot(bm);
  bm._multiDrawCount = 0;
  bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
  bm._indirectTexture.image.data.fill(0xffff);
  bm.userData.__memo.valid = false;      // force the miss, not a hit
  memoBuild(bm, cam);
  w = M.getStatBatchXStats().walk;
  check("73: a memo MISS rebuilt through the cache is byte-identical to three's",
    sameSnapshot(want, snapshot(bm)), `three n=${want.n} ours n=${snapshot(bm).n}`);
  check("74: and the cache was NOT rebuilt for the camera move (still one build)",
    w.sphere.builds === 1, JSON.stringify({ builds: w.sphere.builds }));
}

// ---------------------------------------------------------------------------
// The self-heal. A slot that goes live WITHOUT the epoch moving would otherwise
// be silently dropped — a placement that simply is not drawn, with nothing in
// any counter to say so. Every `addInstance` path ends in `_memoDirtyBounds`, so
// this should be unreachable; it is guarded anyway because a silently missing
// prop is the worst failure this change could have, and simulated here by
// stamping the sentinel by hand on a slot that IS live.
// ---------------------------------------------------------------------------
console.log("\n-- 16. a slot that goes live without an epoch bump is healed, not dropped --");
{
  reset("off", null, false, "on");
  const { bm } = makeBucket(opaqueMat(), 120);
  const cam = makeCamera(60, 30, 60);
  threeBuild(bm, cam);
  const want = snapshot(bm);
  memoBuild(bm, cam);                          // builds the cache
  const before = M.getStatBatchXStats().walk.sphere.lateActivations;

  // Forge the hazard: sentinel a live slot without touching the epoch.
  const live = bm._instanceInfo.findIndex((inf) => inf && inf.active && inf.visible);
  bm.userData.__sphereCache.arr[live * 4 + 3] = -1;

  bm._multiDrawCount = 0;
  bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
  bm._indirectTexture.image.data.fill(0xffff);
  memoBuild(bm, cam);
  const s = M.getStatBatchXStats().walk.sphere;
  check("75: the sentinelled live slot is recomputed in place and COUNTED",
    s.lateActivations === before + 1, JSON.stringify({ before, after: s.lateActivations }));
  check("76: and the answer is still byte-identical to three's — nothing was dropped",
    sameSnapshot(want, snapshot(bm)), `three n=${want.n} ours n=${snapshot(bm).n}`);
  check("77: the heal is sticky — a second walk does not re-heal the same slot",
    (memoBuild(bm, cam), M.getStatBatchXStats().walk.sphere.lateActivations === before + 1));
}

// ---------------------------------------------------------------------------
// THE MOTION CLAIM, TESTED RATHER THAN TRUSTED (2026-08-06, second pass).
//
// `?statBatchSphere` exists for ONE reason: `?statBatchMemo` is worth ~4 ms
// parked and +0.5 ms WORSE moving, so something has to carry the moving case.
// The claim is that this cache is invalidated by PLACEMENT changes and not by
// the camera. §13-§16 covered invalidation and identity but every one of them
// walks a STILL camera or a single hop, so none of them can show the claim.
//
// The camera path below is driven by the FRAME INDEX, exactly as
// `harness/moving-bench.mjs` drives the live one, and for the same reason: a
// wall-clock path makes each run cover a different arc, which is what made the
// live moving numbers unusable (control spread 6.60 ms against a 6.10 ms
// effect). Here it also means the A and B arms visit provably identical poses,
// so a byte-comparison of their multidraw output is meaningful.
// ---------------------------------------------------------------------------
console.log("\n-- 17. ?statBatchSphere under MOTION: no camera input in the key --");
const MOTION_POSES = 24;
/** Frame-indexed camera path. Pure function of k — no clock, no randomness. */
function motionPose(k) {
  const az = (k * 2 * Math.PI) / MOTION_POSES;
  return [Math.cos(az) * 90, 30 + 8 * Math.sin(2 * az), Math.sin(az) * 90];
}
function placeCam(cam, k) {
  const p = motionPose(k);
  cam.position.set(p[0], p[1], p[2]);
  cam.lookAt(new THREE.Vector3(0, 0, 0));
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return cam;
}
{
  // Arm A — sphere ON, memo OFF. The cache is then the ONLY thing between the
  // walk and three's loop, so its behaviour is not confounded by memo hits.
  reset("off", null, false, "on");
  const a = makeBucket(opaqueMat(), 200);
  const camA = makeCamera(...motionPose(0));
  const got = [];
  for (let k = 0; k < MOTION_POSES; k++) { placeCam(camA, k); memoBuild(a.bm, camA); got.push(snapshot(a.bm)); }
  const sA = M.getStatBatchXStats().walk.sphere;
  check("78: 24 distinct camera poses cost exactly ONE cache build — a moving camera does not invalidate",
    sA.builds === 1 && sA.walks === MOTION_POSES && sA.lateActivations === 0 && sA.errors === 0,
    JSON.stringify({ builds: sA.builds, walks: sA.walks, slotsWalked: sA.slotsWalked, late: sA.lateActivations }));
  // A path that culled the same set at every pose would pass 78 vacuously.
  const distinct = new Set(got.map((g) => g.n));
  check("79: the path really moved the answer (the test is not vacuous)", distinct.size > 3,
    `distinct draw counts: ${[...distinct].sort((x, y) => x - y).join(",")}`);

  // Arm B — everything off, three's own loop, the identical pose sequence.
  // `makeBucket` is seeded, so this bucket is the same bucket.
  reset("off", null, false, "off");
  const b = makeBucket(opaqueMat(), 200);
  const camB = makeCamera(...motionPose(0));
  let allSame = true, firstBad = -1;
  for (let k = 0; k < MOTION_POSES; k++) {
    placeCam(camB, k);
    threeBuild(b.bm, camB);
    if (!sameSnapshot(got[k], snapshot(b.bm))) { allSame = false; if (firstBad < 0) firstBad = k; }
  }
  check("80: and the cached answer is byte-identical to three's at EVERY pose on the path",
    allSame, allSame ? `${MOTION_POSES} poses` : `first divergence at pose ${firstBad}`);

  // The cache lives in the mesh's LOCAL frame, so it is camera-INDEPENDENT, not
  // merely camera-insensitive. `?statBatchMemo` cannot say this: its state is a
  // single slot keyed on `st.camera === camera`, so a shadow cascade alternating
  // with the colour pass misses on every call (see `_memoOnBeforeRender`'s note).
  reset("off", null, false, "on");
  const { bm: two } = makeBucket(opaqueMat(), 150);
  const c1 = makeCamera(70, 30, 70);
  const c2 = makeCamera(-70, 55, 10);
  for (let i = 0; i < 6; i++) { memoBuild(two, c1); memoBuild(two, c2); }
  const sTwo = M.getStatBatchXStats().walk.sphere;
  check("81: TWO alternating cameras are served from ONE build (the key holds no camera at all)",
    sTwo.builds === 1 && sTwo.walks === 12,
    JSON.stringify({ builds: sTwo.builds, walks: sTwo.walks }));
}

// ---------------------------------------------------------------------------
// REGRESSION PIN for the bug that made the whole flag moot.
//
// `?statBatchMemo` DEFAULTS to "slack". Until this was fixed, the slack tier
// rebuilt through `_memoBuildSlack` — which recomputes every sphere from
// scratch — and `_trySphereBuild` was only reachable from the `!built`
// fallthrough, which then declined for the very eligibility reason that had
// sent the call down the slack branch. So in the configuration that SHIPS,
// `?statBatchSphere=on` did no work whatsoever:
//     memo=slack  sphere{builds:0, slotsWalked:0, walks:0}
// The flag that has to carry the moving case was inert unless you also gave up
// the 4.00 ms parked win with `?statBatchMemo=off`. §18 fails loudly if that
// ever comes back.
// ---------------------------------------------------------------------------
console.log("\n-- 18. ?statBatchSphere composes with the SHIPPED default (?statBatchMemo=slack) --");
{
  // 20 m per step is past the 8 m default translation slack, so every call is a
  // slack MISS and therefore a rebuild — which is the path under test.
  const STEPS = 8;
  const stepCam = (cam, k) => {
    cam.position.set(70 + k * 20, 30, 70);
    cam.lookAt(new THREE.Vector3(0, 0, 0));
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    return cam;
  };

  reset("slack", null, false, "on");
  const withCache = [];
  const on = makeBucket(opaqueMat(), 200);
  const camOn = makeCamera(70, 30, 70);
  for (let k = 0; k < STEPS; k++) { stepCam(camOn, k); memoBuild(on.bm, camOn); withCache.push(snapshot(on.bm)); }
  const wOn = M.getStatBatchXStats().walk;
  check("82: under memo=slack the sphere cache is BUILT AND READ (it used to be dead code)",
    wOn.sphere.builds === 1 && wOn.sphere.walks === STEPS && wOn.rebuildsSlack === STEPS,
    JSON.stringify({ builds: wOn.sphere.builds, walks: wOn.sphere.walks, rebuildsSlack: wOn.rebuildsSlack }));
  // The diagnostic trap, pinned so nobody reads `calls: 0` as "never ran": the
  // sphere-only override is not installed while the memo owns the seam.
  check("83: `sphere.calls` is 0 while the memo owns the seam — read `walks`, not `calls`",
    wOn.sphere.calls === 0 && wOn.sphere.walks > 0,
    JSON.stringify({ calls: wOn.sphere.calls, walks: wOn.sphere.walks }));

  // Same path, same margins, cache OFF: `_memoBuildSlack`'s own answer.
  reset("slack", null, false, "off");
  const off = makeBucket(opaqueMat(), 200);
  const camOff = makeCamera(70, 30, 70);
  let same = true, bad = -1;
  for (let k = 0; k < STEPS; k++) {
    stepCam(camOff, k);
    memoBuild(off.bm, camOff);
    if (!sameSnapshot(withCache[k], snapshot(off.bm))) { same = false; if (bad < 0) bad = k; }
  }
  check("84: the DILATED answer through the cache is byte-identical to _memoBuildSlack's",
    same, same ? `${STEPS} dilated rebuilds` : `first divergence at step ${bad}`);
}

// ---------------------------------------------------------------------------
// THE HONEST LIMIT: streaming, which is exactly what accompanies motion.
//
// "A moving camera does not invalidate the cache" is true and is §17. It is
// also not the whole moving case, because a moving player STREAMS, and a feed
// or an evict does invalidate — at BUCKET granularity. Buckets are region-
// scoped and span many landblocks, so one landblock's feed re-walks every slot
// in the bucket, not the slots it added. State the SCALE: the cost of an
// invalidation is the bucket's RESIDENT slot count.
// ---------------------------------------------------------------------------
console.log("\n-- 19. streaming under motion: an invalidation costs the WHOLE bucket --");
{
  const geoms = [triGeom(1), triGeom(2), triGeom(3)];
  const feedNodes = (n, lb, mat) => {
    const out = [];
    let s = 999;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n; i++) out.push(singleton(0x08000001, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400, lb, geoms[i % 3], mat));
    return out;
  };

  reset("off", null, false, "on");
  const mat = opaqueMat();
  const { scene3d, bm } = makeBucket(mat, 200);
  const cam = makeCamera(70, 30, 70);
  memoBuild(bm, cam);
  const settled0 = M.getStatBatchXStats().walk.sphere;
  const residentSlots = bm._instanceInfo.length;

  // Settled: many walks, one build. This is the case the flag was priced on.
  for (let k = 0; k < 12; k++) { placeCam(cam, k); memoBuild(bm, cam); }
  const settled = M.getStatBatchXStats().walk.sphere;
  const settledPayback = settled.slotsWalked / settled.slotsBuilt;
  check("85: settled, the cache pays back many times over (slotsWalked / slotsBuilt)",
    settledPayback > 5 && settled.builds === 1,
    `payback ${settledPayback.toFixed(1)}x over ${settled.walks} walks, ${settled.builds} build`);

  // ONE neighbouring landblock arrives with 20 placements. The 3x3 region bucket
  // is reused (same argument as §13's growth case), so the epoch moves and the
  // NEXT walk rebuilds every slot the bucket holds.
  const builtBefore = settled.slotsBuilt;
  M.consolidateStaticSingletonsCrossLb(feedNodes(20, (LB + 0x00010000) >>> 0, mat), scene3d, (LB + 0x00010000) >>> 0);
  scene3d.staticsGroup.updateMatrixWorld(true);
  memoBuild(bm, cam);
  const afterFeed = M.getStatBatchXStats().walk.sphere;
  const rebuiltSlots = afterFeed.slotsBuilt - builtBefore;
  check("86: a 20-placement feed re-walks the WHOLE bucket, not the 20 new slots",
    rebuiltSlots >= residentSlots && rebuiltSlots > 20 * 4,
    `${rebuiltSlots} slots rebuilt for 20 new placements (bucket held ${residentSlots})`);
  check("87: and the post-feed answer is still byte-identical to three's",
    (() => {
      threeBuild(bm, cam);
      const want = snapshot(bm);
      bm._multiDrawCount = 0;
      bm._multiDrawStarts.fill(-1); bm._multiDrawCounts.fill(-1);
      bm._indirectTexture.image.data.fill(0xffff);
      memoBuild(bm, cam);
      return sameSnapshot(want, snapshot(bm));
    })());

  // The LOSS case, measured rather than argued: a bucket fed EVERY frame never
  // amortises its rebuild, so payback collapses toward 1 — the cache then costs
  // a full extra walk per frame and buys nothing. This is what `--mode=hop` in
  // `harness/moving-bench.mjs` is for; do not quote a settled ms figure and
  // assume it survives streaming.
  reset("off", null, false, "on");
  const churn = makeBucket(mat, 200);
  const camC = makeCamera(70, 30, 70);
  memoBuild(churn.bm, camC);
  const c0 = M.getStatBatchXStats().walk.sphere;
  for (let k = 0; k < 8; k++) {
    // Both neighbours stay inside THIS bucket's 3x3 region (`_regionKeyOfId`
    // divides the LB bytes by 3): 0x96/0x97/0x98 all map to region 50x50. Step
    // one further and the feed lands in a DIFFERENT bucket, the epoch here
    // never moves, and the test silently measures a settled cache instead —
    // which is exactly what the first cut of this row did (2 rebuilds, not 8).
    const lb = (LB + (((k % 2) + 1) << 16)) >>> 0;
    M.consolidateStaticSingletonsCrossLb(feedNodes(5, lb, mat), churn.scene3d, lb);
    churn.scene3d.staticsGroup.updateMatrixWorld(true);
    placeCam(camC, k);
    memoBuild(churn.bm, camC);
  }
  const c1 = M.getStatBatchXStats().walk.sphere;
  const churnPayback = (c1.slotsWalked - c0.slotsWalked) / (c1.slotsBuilt - c0.slotsBuilt);
  check("88: fed every frame, payback collapses to ~1 — the cache is a LOSS while a bucket streams",
    churnPayback < 1.5 && c1.builds - c0.builds === 8,
    `payback ${churnPayback.toFixed(2)}x over 8 fed frames (${c1.builds - c0.builds} rebuilds)`);
}

console.log("=========================");
console.log(`stat-batch-walk test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
