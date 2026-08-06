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
    "statBatchMemoMode, __setStatBatchMemoForTest, __setStatGeomDedupForTest };"
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

const reset = (mode, slacks, noSort) => {
  M.__resetStatBatchXForTest();
  M.__setStatGeomDedupForTest(false);
  M.__setStatBatchNoSortForTest(!!noSort);
  M.__setStatBatchMemoForTest(mode, slacks);
};

// ---------------------------------------------------------------------------
console.log("\n-- 1. flag readers (default OFF; exact-match opt-in) --");
// The readers memoise, so they are exercised through the test seams plus one
// direct read of the un-set state.
M.__setStatBatchNoSortForTest(undefined);
M.__setStatBatchMemoForTest(undefined);
check("1: ?statBatchNoSort defaults OFF with no location.search", M.statBatchNoSortEnabled() === false);
M.__setStatBatchMemoForTest(undefined);
check("2: ?statBatchMemo defaults to \"off\"", M.statBatchMemoMode() === "off");

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

console.log("=========================");
console.log(`stat-batch-walk test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
