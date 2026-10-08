// 2026-10-07 — ?bmIndirectPerCamera (scene3d/batched_indirect_per_camera.js).
//
// One BatchedMesh indirect texture per camera, re-uploaded only when that
// camera's ids changed. No WebGL here: a tiny GPU model applies three r184's
// upload gate (setTexture2D: `texture.version > 0 && __version !== version` ->
// upload the whole array) at every simulated draw, and the suite asserts the one
// invariant that matters — THE TEXTURE A DRAW SAMPLES HOLDS, AT EVERY INDEX THE
// SHADER READS (< _multiDrawCount), THE IDS THAT DRAW'S REBUILD PRODUCED — plus
// the upload counts the change exists for.
//
// Run:
//   cd apps/holtburger-web/
//   node test_bm_indirect_per_camera.mjs

import * as THREE from "three";
import {
  installBatchedIndirectPerCamera, uninstallBatchedIndirectPerCamera,
  getBatchedIndirectPerCameraStats, __setBmIndirectPerCameraOffForTest,
  wrapOnBeforeRenderPerCamera, MAX_CAMERAS,
} from "./scene3d/batched_indirect_per_camera.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

const ORIG_OBR = THREE.BatchedMesh.prototype.onBeforeRender;
const ORIG_DISPOSE = THREE.BatchedMesh.prototype.dispose;
check("installs", installBatchedIndirectPerCamera(THREE, { force: true }) === true);
check("idempotent", installBatchedIndirectPerCamera(THREE, { force: true }) === true
  && THREE.BatchedMesh.prototype.__hbIndirectPerCam.origOBR === ORIG_OBR);

// --- GPU model ---------------------------------------------------------------
const gpu = new Map(); // texture -> { ver, data }
let uploads = 0;
let violations = 0;
let lastViolation = "";
let disposedTex = 0;
function track(tex) {
  if (tex.__tracked) return;
  tex.__tracked = true;
  tex.addEventListener("dispose", () => { disposedTex++; gpu.delete(tex); });
}
/** three's setTexture2D gate + the invariant check. */
function draw(bm, label) {
  const tex = bm._indirectTexture;
  track(tex);
  const g = gpu.get(tex);
  if (tex.version > 0 && (!g || g.ver !== tex.version)) {
    gpu.set(tex, { ver: tex.version, data: tex.image.data.slice() });
    uploads++;
  }
  const n = bm._multiDrawCount | 0;
  const onGpu = gpu.get(tex);
  if (n === 0) return;
  if (!onGpu) { violations++; lastViolation = `${label}: drew ${n} ids from a never-uploaded texture`; return; }
  const cpu = tex.image.data;
  for (let i = 0; i < n; i++) {
    if (onGpu.data[i] !== cpu[i]) {
      violations++;
      lastViolation = `${label}: id[${i}] gpu=${onGpu.data[i]} cpu=${cpu[i]}`;
      return;
    }
  }
}

// --- fixtures ----------------------------------------------------------------
function triGeom(k) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([0, 0, 0, 1 + k, 0, 0, 0, 1 + k, 0]);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}
/** n instances spread over a 400x400 patch (deterministic). */
function makeBatch(n = 300, { sort = false, culled = true } = {}) {
  const bm = new THREE.BatchedMesh(n, n * 3, 0, new THREE.MeshBasicMaterial());
  const gids = [0, 1, 2].map((k) => bm.addGeometry(triGeom(k)));
  let s = 4242;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const id = bm.addInstance(gids[i % 3]);
    bm.setMatrixAt(id, m.makeTranslation((rnd() - 0.5) * 400, 0, (rnd() - 0.5) * 400));
  }
  bm.sortObjects = sort;
  bm.perObjectFrustumCulled = culled;
  bm.updateMatrixWorld(true);
  return bm;
}
function persp(px, py, pz, tx, tz) {
  const c = new THREE.PerspectiveCamera(60, 1.6, 0.1, 600);
  c.position.set(px, py, pz); c.lookAt(tx, 0, tz);
  c.updateMatrixWorld(true); c.matrixWorldInverse.copy(c.matrixWorld).invert();
  c.updateProjectionMatrix();
  return c;
}
function ortho(px, pz, half) {
  const c = new THREE.OrthographicCamera(-half, half, half, -half, 1, 2000);
  c.position.set(px, 800, pz + 0.001); c.lookAt(px, 0, pz);
  c.updateMatrixWorld(true); c.matrixWorldInverse.copy(c.matrixWorld).invert();
  c.updateProjectionMatrix();
  return c;
}
function moveCam(c, dx, dz) {
  c.position.x += dx; c.position.z += dz;
  c.updateMatrixWorld(true); c.matrixWorldInverse.copy(c.matrixWorld).invert();
}
const callObr = (bm, cam) => bm.onBeforeRender(null, null, cam, bm.geometry, bm.material, null);
// three's shadow pass hands every plain caster ONE shared depth material
// (WebGLShadowMap `_depthMaterial`); a fresh one per call would also defeat the
// memo, which records the material identity.
const DEPTH_MAT = new THREE.MeshDepthMaterial();
const callShadow = (bm, cam, main) =>
  bm.onBeforeShadow(null, bm, main, cam, bm.geometry, DEPTH_MAT, null);
/** the ids three's own rebuild produces for `cam` (and the material the call
 *  saw — a sorted bucket sorts by `material.transparent`), on an untouched twin. */
function reference(twin, cam, material = twin.material) {
  ORIG_OBR.call(twin, null, null, cam, twin.geometry, material, null);
  return Array.from(twin._indirectTexture.image.data.slice(0, twin._multiDrawCount));
}
const idsOf = (bm) => Array.from(bm._indirectTexture.image.data.slice(0, bm._multiDrawCount));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function frameCams() {
  // colour camera + 3 CSM-like cascades of growing extent
  return { main: persp(0, 30, 0, 150, 60), c1: ortho(20, 10, 30), c2: ortho(60, 30, 100), c3: ortho(120, 60, 300) };
}

// -----------------------------------------------------------------------------
console.log("\n-- 1. four cameras alternating, standing still (atlas-style bucket, three's rebuild) --");
{
  const bm = makeBatch(300), twin = makeBatch(300);
  const { main, c1, c2, c3 } = frameCams();
  uploads = 0; violations = 0;
  let mismatch = 0;
  const perFrame = [];
  for (let f = 0; f < 12; f++) {
    const u0 = uploads;
    for (const cam of [c1, c2, c3]) {
      callShadow(bm, cam, main); draw(bm, `f${f} shadow`);
      if (!eq(idsOf(bm), reference(twin, cam))) mismatch++;
    }
    callObr(bm, main); draw(bm, `f${f} main`);
    if (!eq(idsOf(bm), reference(twin, main))) mismatch++;
    perFrame.push(uploads - u0);
  }
  check("1a: every call's ids equal three's own answer for that camera", mismatch === 0, `mismatch=${mismatch}`);
  check("1b: every draw samples exactly its own ids (GPU model)", violations === 0, lastViolation);
  check("1c: frame 0 uploads once per camera (4)", perFrame[0] === 4, `perFrame=${perFrame.join(",")}`);
  check("1d: frames 1..11 upload NOTHING (was 4/frame)", perFrame.slice(1).every((x) => x === 0), perFrame.join(","));
  check("1e: four distinct textures, one per camera", new Set([c1, c2, c3, main].map((cam) => {
    callObr(bm, cam); return bm._indirectTexture;
  })).size === 4);
}

// -----------------------------------------------------------------------------
console.log("\n-- 2. same, flag seam OFF: the old behaviour (one texture, 4 uploads/frame) --");
{
  __setBmIndirectPerCameraOffForTest(true);
  const bm = makeBatch(300);
  const { main, c1, c2, c3 } = frameCams();
  const tex0 = bm._indirectTexture;
  uploads = 0; violations = 0;
  for (let f = 0; f < 5; f++) {
    for (const cam of [c1, c2, c3]) { callShadow(bm, cam, main); draw(bm, "off shadow"); }
    callObr(bm, main); draw(bm, "off main");
  }
  check("2a: off = one texture throughout", bm._indirectTexture === tex0);
  check("2b: off = 4 uploads per frame (the cost being removed)", uploads === 20, `uploads=${uploads}`);
  check("2c: off draws are still correct", violations === 0, lastViolation);
  __setBmIndirectPerCameraOffForTest(false);
}

// -----------------------------------------------------------------------------
console.log("\n-- 3. moving colour camera: uploads only when ITS answer changes --");
{
  const bm = makeBatch(400), twin = makeBatch(400);
  const { main, c1, c2, c3 } = frameCams();
  uploads = 0; violations = 0;
  let mismatch = 0, mainChanges = 0, prevMain = null;
  const s0 = getBatchedIndirectPerCameraStats();
  for (let f = 0; f < 40; f++) {
    moveCam(main, 0.7, 0.3); // ~0.75 m/frame
    for (const cam of [c1, c2, c3]) { callShadow(bm, cam, main); draw(bm, `m${f}`); }
    callObr(bm, main); draw(bm, `m${f} main`);
    const ids = idsOf(bm);
    if (!eq(ids, reference(twin, main))) mismatch++;
    if (prevMain === null || !eq(ids, prevMain)) mainChanges++;
    prevMain = ids;
  }
  const s1 = getBatchedIndirectPerCameraStats();
  check("3a: ids equal three's for every moving-camera call", mismatch === 0, `mismatch=${mismatch}`);
  check("3b: GPU model clean", violations === 0, lastViolation);
  check("3c: uploads == 3 cascade first-uploads + one per main-answer change",
    uploads === 3 + mainChanges, `uploads=${uploads} mainChanges=${mainChanges}`);
  check("3d: the walk stays live (some frames changed, some did not)", mainChanges > 1 && mainChanges < 40, `changes=${mainChanges}`);
  check("3e: stats count the skips", s1.skipped - s0.skipped === 160 - uploads, `skipped=${s1.skipped - s0.skipped}`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 4. sorted (transparent) bucket: order changes ARE uploads, correctness holds --");
{
  const bm = makeBatch(200, { sort: true }), twin = makeBatch(200, { sort: true });
  bm.material.transparent = true; twin.material.transparent = true;
  const { main, c1 } = frameCams();
  uploads = 0; violations = 0;
  let mismatch = 0;
  for (let f = 0; f < 15; f++) {
    moveCam(main, 3, -2);
    callShadow(bm, c1, main); draw(bm, "sort c1");
    if (!eq(idsOf(bm), reference(twin, c1, DEPTH_MAT))) mismatch++;
    callObr(bm, main); draw(bm, "sort main");
    if (!eq(idsOf(bm), reference(twin, main))) mismatch++;
  }
  check("4a: sorted ids equal three's", mismatch === 0, `mismatch=${mismatch}`);
  check("4b: GPU model clean", violations === 0, lastViolation);
  check("4c: fewer uploads than draws (static cascade once, moving main per order change)", uploads >= 2 && uploads < 30, `uploads=${uploads} of 30 draws`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 5. camera-independent bucket (not culled, not sorted): never swapped --");
{
  const bm = makeBatch(100, { culled: false, sort: false });
  const { main, c1, c2 } = frameCams();
  const tex0 = bm._indirectTexture;
  uploads = 0; violations = 0;
  for (let f = 0; f < 4; f++) {
    for (const cam of [c1, c2, main]) { callObr(bm, cam); draw(bm, "indep"); }
  }
  check("5a: one texture (three only rewrites it on _visibilityChanged)", bm._indirectTexture === tex0);
  check("5b: uploaded once, all ids drawn", uploads === 1 && bm._multiDrawCount === 100, `uploads=${uploads} n=${bm._multiDrawCount}`);
  check("5c: GPU model clean", violations === 0, lastViolation);
  bm.setVisibleAt(3, false); // _visibilityChanged -> one rewrite for whichever camera is next
  for (const cam of [c1, c2, main]) { callObr(bm, cam); draw(bm, "indep vis"); }
  check("5d: a visibility change still reaches every camera", bm._multiDrawCount === 99 && violations === 0,
    `n=${bm._multiDrawCount} ${lastViolation}`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 6. memo-style own override: slot restore (rewrite + bump) and live hit (no write) --");
{
  // Mimics static_batch_x's `_memoOnBeforeRender` with N slots: a per-camera
  // remembered answer is copied back with `needsUpdate` when the camera's slot
  // is not the live one, and a hit on the live slot touches nothing.
  const snaps = new Map(); let live = null;
  function memoLike(renderer, scene, camera, geometry, material, group) {
    const snap = snaps.get(camera);
    if (snap) {
      if (live === camera) return; // live-slot hit: zero work
      this._indirectTexture.image.data.set(snap.ids);
      this._multiDrawStarts.set(snap.starts); this._multiDrawCounts.set(snap.counts);
      this._multiDrawCount = snap.ids.length;
      this._indirectTexture.needsUpdate = true;
      live = camera;
      return;
    }
    THREE.BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group); // miss
    const n = this._multiDrawCount;
    snaps.set(camera, { ids: this._indirectTexture.image.data.slice(0, n),
      starts: this._multiDrawStarts.slice(0, n), counts: this._multiDrawCounts.slice(0, n) });
    live = camera;
  }
  const bm = makeBatch(300), twin = makeBatch(300);
  bm.onBeforeRender = wrapOnBeforeRenderPerCamera(memoLike);
  const { main, c1, c2, c3 } = frameCams();
  uploads = 0; violations = 0;
  let mismatch = 0;
  const s0 = getBatchedIndirectPerCameraStats();
  for (let f = 0; f < 10; f++) {
    for (const cam of [c1, c2, c3]) {
      callShadow(bm, cam, main); draw(bm, `memo ${f}`);
      if (!eq(idsOf(bm), reference(twin, cam))) mismatch++;
    }
    callObr(bm, main); draw(bm, `memo ${f} main`);
    callObr(bm, main); draw(bm, `memo ${f} main again`); // a second pass, same camera = live hit
    if (!eq(idsOf(bm), reference(twin, main))) mismatch++;
  }
  const s1 = getBatchedIndirectPerCameraStats();
  check("6a: answers equal three's", mismatch === 0, `mismatch=${mismatch}`);
  check("6b: GPU model clean (restores + live hits)", violations === 0, lastViolation);
  check("6c: 4 uploads total — restores no longer re-upload", uploads === 4, `uploads=${uploads}`);
  check("6d: re-entry into the prototype did not swap twice", s1.passthrough - s0.passthrough === 4,
    `passthrough=${s1.passthrough - s0.passthrough} (the 4 misses' inner prototype calls)`);
  check("6e: live-slot hits were seen as no-writes", s1.noWrite - s0.noWrite === 10, `noWrite=${s1.noWrite - s0.noWrite}`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 7. setInstanceCount (three replaces the texture) mid-session --");
{
  const bm = makeBatch(120), twin = makeBatch(120);
  const { main, c1, c2, c3 } = frameCams();
  uploads = 0; violations = 0; disposedTex = 0;
  for (let f = 0; f < 3; f++) for (const cam of [c1, c2, c3, main]) { callObr(bm, cam); draw(bm, "pre"); }
  const s0 = getBatchedIndirectPerCameraStats();
  bm.setInstanceCount(400); twin.setInstanceCount(400);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 50; i++) {
    const id = bm.addInstance(i % 3); bm.setMatrixAt(id, m.makeTranslation(i * 2, 0, i));
    const id2 = twin.addInstance(i % 3); twin.setMatrixAt(id2, m.makeTranslation(i * 2, 0, i));
  }
  let mismatch = 0;
  for (let f = 0; f < 4; f++) {
    for (const cam of [c1, c2, c3, main]) {
      callObr(bm, cam); draw(bm, `post ${f}`);
      if (!eq(idsOf(bm), reference(twin, cam))) mismatch++;
    }
  }
  const s1 = getBatchedIndirectPerCameraStats();
  check("7a: one reset", s1.resets - s0.resets === 1, `resets=${s1.resets - s0.resets}`);
  check("7b: answers equal three's after the resize", mismatch === 0, `mismatch=${mismatch}`);
  check("7c: GPU model clean after the resize", violations === 0, lastViolation);
  check("7d: the textures three did not dispose were disposed by the reset", disposedTex >= 3, `disposed=${disposedTex}`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 8. LRU cap + dispose() frees every per-camera texture --");
{
  const bm = makeBatch(150);
  const cams = [];
  for (let i = 0; i < MAX_CAMERAS + 3; i++) cams.push(ortho(i * 15, i * 7, 40 + i * 10));
  uploads = 0; violations = 0; disposedTex = 0;
  const seen = new Set();
  for (let f = 0; f < 3; f++) for (const cam of cams) { callObr(bm, cam); seen.add(bm._indirectTexture); draw(bm, "lru"); }
  check("8a: draws stay correct while cameras churn past the cap", violations === 0, lastViolation);
  const alive = [...seen].filter((t) => gpu.has(t)).length;
  check(`8b: at most ${MAX_CAMERAS} textures alive`, alive <= MAX_CAMERAS, `alive=${alive} seen=${seen.size}`);
  const before = disposedTex;
  bm.dispose();
  const leaked = [...seen].filter((t) => gpu.has(t)).length;
  check("8c: dispose() leaves no per-camera texture alive", leaked === 0, `leaked=${leaked} disposedByDispose=${disposedTex - before}`);
}

// -----------------------------------------------------------------------------
console.log("\n-- 9. a foreign bump between calls is never rolled back --");
{
  const bm = makeBatch(100);
  const { main } = frameCams();
  uploads = 0; violations = 0;
  callObr(bm, main); draw(bm, "f0");
  // someone else rewrites the camera's ids out of band and asks for an upload
  const tex = bm._indirectTexture;
  tex.image.data[0] = 99; tex.needsUpdate = true;
  draw(bm, "foreign");               // three would upload here
  callObr(bm, main); draw(bm, "f1"); // rebuild restores the true ids: must upload
  check("9a: the rebuild after a foreign write uploads", uploads === 3, `uploads=${uploads}`);
  check("9b: GPU model clean", violations === 0, lastViolation);
}

// -----------------------------------------------------------------------------
console.log("\n-- 10. the real ?statBatchMemo (4 slots) under 4 cameras --");
{
  const M = await import("./scene3d/static_batch_x.js");
  M.__resetStatBatchXForTest();
  M.__setStatBatchMemoForTest("exact");
  M.__setStatBatchMemoSlotsForTest(4);
  const scene3d = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshStandardMaterial();
  const geoms = [0, 1, 2].map((k) => triGeom(k));
  const nodes = [];
  let s = 777;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const m = new THREE.Mesh(geoms[i % 3], mat);
    m.position.set((rnd() - 0.5) * 400, 0, (rnd() - 0.5) * 400);
    m.userData = { surfaceDid: 0x08000001, landblockId: 0x96960000 };
    nodes.push(m);
  }
  const r = M.consolidateStaticSingletonsCrossLb(nodes, scene3d, 0x96960000);
  const bm = scene3d.staticsGroup.children.find((c) => c.isBatchedMesh);
  scene3d.staticsGroup.updateMatrixWorld(true);
  check("10a: a memo bucket was built and owns a wrapped override", !!r && !!bm
    && Object.prototype.hasOwnProperty.call(bm, "onBeforeRender"));
  const { main, c1, c2, c3 } = frameCams();
  uploads = 0; violations = 0;
  const perFrame = [];
  for (let f = 0; f < 10; f++) {
    const u0 = uploads;
    for (const cam of [c1, c2, c3]) { callShadow(bm, cam, main); draw(bm, `x${f}`); }
    callObr(bm, main); draw(bm, `x${f} main`);
    perFrame.push(uploads - u0);
  }
  const w = M.getStatBatchXStats().walk;
  check("10b: memo slots restore every call after frame 0 (each was an upload before)", w.slotRestores >= 36, `slotRestores=${w.slotRestores}`);
  check("10c: GPU model clean through real memo restores", violations === 0, lastViolation);
  check("10d: only the first frame uploads", perFrame[0] <= 4 && perFrame.slice(1).every((x) => x === 0), perFrame.join(","));
  M.__resetStatBatchXForTest();
}

uninstallBatchedIndirectPerCamera(THREE);
check("uninstall restores three", THREE.BatchedMesh.prototype.onBeforeRender === ORIG_OBR
  && THREE.BatchedMesh.prototype.dispose === ORIG_DISPOSE);
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
