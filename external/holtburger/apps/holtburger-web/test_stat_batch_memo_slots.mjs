// ?statBatchMemoSlots (perf T2, OpenAC comparison 2026-10-04) — one memo slot
// per camera for the static batch walk, so shadow cascades and the colour pass
// stop evicting each other's answer. Fixtures and loader are shared with
// test_stat_batch_runs.mjs / test_stat_batch_walk.mjs (copied so the suites
// stay independent).
//
// The load-bearing property: with N slots, the arrays the bucket hands the
// renderer for camera C are EXACTLY what three's own loop computes for C (exact
// tier) or a superset of it (slack tier), no matter which camera ran last.
//
// Run: cd apps/holtburger-web/ && node test_stat_batch_memo_slots.mjs

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
  console.log("stat-batch-memo-slots test: SKIP (three not located).");
  console.log("  This suite is the ONLY check that the ?statBatchMemo=slack loop still");
  console.log("  matches three's own; run `npm i three@0.184.0` in apps/holtburger-web/.");
  process.exit(0);
}
const THREE = await import("file://" + tp);
console.log("?statBatchMemoSlots — one memo slot per camera");
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
    "statBatchSphereMode, __setStatBatchSphereForTest, statBatchRunsMode, __setStatBatchRunsForTest, " +
    "statBatchMemoSlots, __setStatBatchMemoSlotsForTest };"
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

const resetSlots = (memo, n) => {
  reset(memo, memo === "slack" ? { transM: 8, rotDeg: 3 } : undefined, false, "off");
  M.__setStatBatchRunsForTest("off", 48);
  M.__setStatBatchMemoSlotsForTest(n);
};

/** A shadow-cascade-like camera: orthographic, looking straight down. */
function makeShadowCam(px, pz, half) {
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 2000);
  cam.position.set(px, 800, pz + 0.001);
  cam.lookAt(px, 0, pz);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  return cam;
}

/** memo call then three's own call for the same camera; returns both answers. */
function both(bm, cam) {
  memoBuild(bm, cam);
  const got = snapshot(bm);
  threeBuild(bm, cam);
  return { got, exact: snapshot(bm) };
}

// ---------------------------------------------------------------------------
console.log("\n-- 1. flag reader (default 1 = off; 2..8 opt-in) --");
{
  const _l = globalThis.location;
  for (const [search, want] of [
    ["", 1], ["?statBatchMemoSlots=1", 1], ["?statBatchMemoSlots=2", 2], ["?statBatchMemoSlots=8", 8],
    ["?statBatchMemoSlots=9", 1], ["?statBatchMemoSlots=on", 1], ["?statBatchMemoSlots=3x", 1],
  ]) {
    globalThis.location = { search };
    M.__setStatBatchMemoSlotsForTest(undefined);
    const got = M.statBatchMemoSlots();
    check(`1.${search || "(absent)"} -> ${want}`, got === want, String(got));
  }
  if (_l === undefined) delete globalThis.location; else globalThis.location = _l;
  M.__setStatBatchMemoSlotsForTest(1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. two cameras alternating, standing still (exact tier) --");
{
  const run = (n) => {
    resetSlots("exact", n);
    const { bm } = makeBucket(opaqueMat(), 600, 3);
    const main = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
    const shadow = makeShadowCam(40, 20, 120);
    let identical = true;
    const before = { ...M.getStatBatchXStats().walk };
    for (let f = 0; f < 10; f++) {
      for (const cam of [main, shadow]) {
        memoBuild(bm, cam);
        const got = snapshot(bm);
        // three's loop on a fresh clone of the call would overwrite the arrays;
        // compare against it and then put the memo's view back by re-calling.
        threeBuild(bm, cam);
        if (!sameSnapshot(got, snapshot(bm))) identical = false;
      }
    }
    const w = M.getStatBatchXStats().walk;
    return { identical, hits: w.hitsExact - before.hitsExact, rebuilds: w.rebuilds - before.rebuilds,
      restores: w.slotRestores, bytes: w.slotBytes };
  };
  const one = run(1);
  check("2a: one slot: every call rebuilds (the thrash this fixes)", one.hits === 0 && one.rebuilds === 20,
    `hits=${one.hits} rebuilds=${one.rebuilds}`);
  check("2b: one slot takes no copies", one.restores === 0 && one.bytes === 0);
  const two = run(2);
  check("2c: two slots: only the first call per camera rebuilds", two.rebuilds === 2 && two.hits === 18,
    `hits=${two.hits} rebuilds=${two.rebuilds}`);
  check("2d: two slots: every answer byte-identical to three's for that camera", two.identical);
  check("2e: alternating cameras restore each other's arrays", two.restores === 18, `restores=${two.restores}`);
  check("2f: one-slot answers byte-identical too", one.identical);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. back-to-back calls with one camera skip the copy --");
{
  resetSlots("exact", 3);
  const { bm } = makeBucket(opaqueMat(), 200, 2);
  const main = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
  memoBuild(bm, main);
  bm._indirectTexture.needsUpdate = false;
  const v0 = bm._indirectTexture.version;
  memoBuild(bm, main);
  memoBuild(bm, main);
  const w = M.getStatBatchXStats().walk;
  check("3a: live slot hits copy nothing", w.slotRestores === 0 && w.hitsExact === 2, `restores=${w.slotRestores}`);
  check("3b: ...and do not re-upload the indirect texture", bm._indirectTexture.version === v0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. slack tier, both cameras moving: still a superset per camera --");
{
  resetSlots("slack", 4);
  const { bm } = makeBucket(opaqueMat(), 600, 3);
  const main = makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60));
  const shadow = makeShadowCam(40, 20, 120);
  let allSuper = true;
  for (let f = 0; f < 24; f++) {
    moveCam(main, 0.6, 0, -0.4, 0.004);
    shadow.position.x += 0.6; shadow.position.z -= 0.4;
    shadow.updateMatrixWorld(true); shadow.matrixWorldInverse.copy(shadow.matrixWorld).invert();
    for (const cam of [main, shadow]) {
      const { got, exact } = both(bm, cam);
      if (!subset(ids(exact), ids(got))) allSuper = false;
    }
  }
  const w = M.getStatBatchXStats().walk;
  check("4a: no camera ever lost a visible instance", allSuper);
  check("4b: slack hits happen for both cameras", w.hitsSlack > 24, `hitsSlack=${w.hitsSlack} rebuilds=${w.rebuildsSlack}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. invalidation reaches the slots that did not see it --");
{
  resetSlots("exact", 2);
  const { bm, scene3d } = makeBucket(opaqueMat(), 200, 2);
  const wide = new THREE.PerspectiveCamera(120, 1, 1, 5000);
  wide.position.set(0, 600, 0.001); wide.lookAt(0, 0, 0); wide.updateMatrixWorld(true);
  wide.matrixWorldInverse.copy(wide.matrixWorld).invert(); wide.updateProjectionMatrix();
  const shadow = makeShadowCam(0, 0, 400);
  memoBuild(bm, wide); memoBuild(bm, shadow);
  const victim = snapshot(bm).indirect[3];
  bm.setVisibleAt(victim, false);
  memoBuild(bm, wide);                 // consumes three's _visibilityChanged
  const s = snapshot(bm);
  memoBuild(bm, shadow);               // must NOT reuse its pre-change answer
  const t = snapshot(bm);
  check("5a: the camera that consumed the flag drops the slot", !ids(s).has(victim));
  check("5b: the OTHER camera's slot sees it too", !ids(t).has(victim));
  bm.setVisibleAt(victim, true);
  const nb = (LB + 0x00010000) >>> 0;
  const extra = [];
  for (let i = 0; i < 20; i++) extra.push(singleton(0x08000001, i * 3, -i * 3, nb, triGeom(1), bm.material));
  memoBuild(bm, wide);
  M.consolidateStaticSingletonsCrossLb(extra, scene3d, nb);
  scene3d.staticsGroup.updateMatrixWorld(true);
  const a = both(bm, wide);
  const b = both(bm, shadow);
  check("5c: a feed (epoch move) invalidates every slot",
    sameSnapshot(a.got, a.exact) && sameSnapshot(b.got, b.exact) && a.got.n > s.n,
    `wide ${a.got.n}/${a.exact.n} shadow ${b.got.n}/${b.exact.n}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. more cameras than slots: LRU, still correct --");
{
  resetSlots("exact", 2);
  const { bm } = makeBucket(opaqueMat(), 300, 3);
  const cams = [
    makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60)),
    makeShadowCam(40, 20, 120),
    makeShadowCam(-60, 10, 200),
  ];
  let identical = true;
  for (let f = 0; f < 6; f++) {
    for (const cam of cams) {
      const { got, exact } = both(bm, cam);
      if (!sameSnapshot(got, exact)) identical = false;
    }
  }
  const w = M.getStatBatchXStats().walk;
  check("6a: answers stay byte-identical under slot eviction", identical);
  check("6b: evictions are counted", w.slotEvicts > 0, `evicts=${w.slotEvicts}`);
  check("6c: no errors", w.errors === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. reaping a bucket returns its copy bytes --");
{
  resetSlots("exact", 3);
  const { bm } = makeBucket(opaqueMat(), 120, 2);
  memoBuild(bm, makeCamera(0, 30, 0, new THREE.Vector3(150, 0, 60)));
  memoBuild(bm, makeShadowCam(0, 0, 300));
  const held = M.getStatBatchXStats().walk.slotBytes;
  M.evictStaticBatchXForLb(LB);
  const after = M.getStatBatchXStats().walk.slotBytes;
  check("7a: copies were held while live", held > 0, `${held} B`);
  check("7b: back to zero after the bucket is reaped", after === 0, `${after} B`);
}

console.log("=========================");
console.log(`stat-batch-memo-slots test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
