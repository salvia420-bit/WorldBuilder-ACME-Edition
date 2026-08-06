// ?skipDeadBatch (2026-08-06) — headless test for the statics half of the
// invisible-draw skip. Four things have to hold, and each one is a way the
// change could be wrong rather than merely unmeasured:
//
//   1. THE PREDICATE STILL PROVES PERMANENCE, AND STILL ONLY THAT.
//      `materialRendersNothing` is UNCHANGED — this flag is a second caller,
//      not a loosening. So the negative cases are the real content: additive
//      blending and `depthWrite === true` must still fail, and a material at
//      opacity 0 with NO `__baseTranslucency` must still fail (that is the
//      mid-fade material the permanence clause exists to protect).
//   2. THE STAMP EXISTS ON THE DEFAULT DECODER PATH. The bug was that
//      `_materialFromFlags`'s legacy ladder — the path taken when
//      `?surfaceUnified` is off, i.e. always — set `opacity = 1 - T` and never
//      stamped `__baseTranslucency`, so every cache material and every bucket
//      built from one failed clause 5 while sitting at opacity 0.
//   3. A BUCKET IS HIDDEN ONLY WHEN EVERY MEMBER IS INVISIBLE. Proven
//      structurally (buckets are keyed by the material OBJECT), so the test
//      asserts the structure: a mixed feed must produce SEPARATE buckets, and
//      the visible one must keep rendering.
//   4. THE LIFECYCLE CONVERGES BOTH WAYS. A material that stops qualifying
//      (`_reseatSurfaceState` re-seating a variant clone) must un-hide its
//      bucket on the next optimize tick, and a bucket that becomes invisible
//      later must hide.
//
// Plus the interaction that would silently undo all of it: `cullStaticsGroup`
// force-restores `visible = true` on every BatchedMesh every frame, so the
// hide has to survive a cull pass.
//
// Run: cd apps/holtburger-web/ && node test_dead_batch_skip.mjs
// (needs `three` resolvable or THREE_PATH=/path/to/three.module.js)

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
if (!tp) { console.log("dead-batch-skip test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);
console.log("?skipDeadBatch — invisible statics bucket skip");
console.log("=========================");

// ---------------------------------------------------------------------------
// 1. The predicate itself, lifted verbatim out of materials.js.
//
// materials.js cannot be imported under node (quality/suite_assets/wasm), and
// re-typing the predicate here would test a COPY rather than the shipped code —
// exactly the failure mode that lets a predicate drift. So extract the real
// source text of `materialRendersNothing` + `skipDeadAlphaEnabled` +
// `skipDeadBatchEnabled` and eval THOSE. A rename or a body change in
// materials.js fails this test at extraction time, loudly.
// ---------------------------------------------------------------------------
const matSrc = readFileSync(resolvePath(__dirname, "scene3d/materials.js"), "utf8");
function extractFn(name) {
  const i = matSrc.indexOf(`export function ${name}(`);
  if (i < 0) return null;
  // Brace-match from the first `{` after the signature.
  let j = matSrc.indexOf("{", i);
  let depth = 0;
  for (let k = j; k < matSrc.length; k++) {
    if (matSrc[k] === "{") depth++;
    else if (matSrc[k] === "}") { depth--; if (depth === 0) return matSrc.slice(i, k + 1).replace(/^export\s+/, ""); }
  }
  return null;
}
const srcSkipAlpha = extractFn("skipDeadAlphaEnabled");
const srcSkipBatch = extractFn("skipDeadBatchEnabled");
const srcPredicate = extractFn("materialRendersNothing");
check("P0: materials.js still exports skipDeadAlphaEnabled / skipDeadBatchEnabled / materialRendersNothing",
  !!srcSkipAlpha && !!srcSkipBatch && !!srcPredicate);
if (!srcSkipAlpha || !srcSkipBatch || !srcPredicate) {
  console.log("=========================");
  console.log(`dead-batch-skip test: ${passed} passed, ${failed} failed (extraction failed — cannot continue)`);
  process.exit(1);
}
const matFactory = new Function(
  "THREE",
  // The memo vars the two flag readers close over.
  "let _skipDeadAlphaFlag, _skipDeadBatchFlag;\n" +
  srcSkipAlpha + "\n" + srcSkipBatch + "\n" + srcPredicate +
  "\n; return { skipDeadAlphaEnabled, skipDeadBatchEnabled, materialRendersNothing };"
);
const MAT = matFactory(THREE);

check("P1: both flags read DEFAULT-ON with no query string",
  MAT.skipDeadAlphaEnabled() === true && MAT.skipDeadBatchEnabled() === true);

// ---- material fixtures, each built the way _materialFromFlags builds it ----
/** Translucent surface with T = 1 → opacity 0, stamped. THE case. */
function deadMaterial(t = 1.0) {
  const m = new THREE.MeshStandardMaterial({ transparent: true, opacity: Math.max(0, 1 - t), depthWrite: false });
  m.userData = { __baseTranslucency: t };
  return m;
}
/** Same numbers, NO stamp — the pre-fix bucket material, and also every
 *  mid-fade material a Transparent(20) hook has ramped to 0 this instant. */
function unstampedMaterial() {
  return new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false });
}
/** Opaque, visible. */
function liveMaterial() { return new THREE.MeshStandardMaterial(); }

check("P2: a stamped translucency-1 material renders nothing", MAT.materialRendersNothing(deadMaterial()) === true);
check("P3: NEGATIVE — the same material WITHOUT the stamp does not (the pre-fix bucket, and any mid-fade material)",
  MAT.materialRendersNothing(unstampedMaterial()) === false);
check("P4: NEGATIVE — an ADDITIVE material at opacity 0 does not (srcFactor ONE lights the pixel regardless of alpha)",
  MAT.materialRendersNothing(Object.assign(deadMaterial(), { blending: THREE.AdditiveBlending })) === false);
check("P5: NEGATIVE — depthWrite === true does not (an invisible depth-writer still occludes)",
  MAT.materialRendersNothing(Object.assign(deadMaterial(), { depthWrite: true })) === false);
check("P6: NEGATIVE — a partially translucent surface (T = 0.5, opacity 0.5) does not",
  MAT.materialRendersNothing(deadMaterial(0.5)) === false);
check("P7: NEGATIVE — an opaque material does not", MAT.materialRendersNothing(liveMaterial()) === false);
check("P8: NEGATIVE — a MIXED material array does not (every member must qualify)",
  MAT.materialRendersNothing([deadMaterial(), liveMaterial()]) === false);

// ---------------------------------------------------------------------------
// 2. The stamp is on the DEFAULT decoder path. Source-level: the legacy ladder
//    in `_materialFromFlags` must now stamp `__baseTranslucency` under
//    `!useUnifiedDecoder`, gated by the flag. This is the whole root cause, and
//    it is invisible to a runtime test that cannot construct a MaterialCache.
// ---------------------------------------------------------------------------
const stampRe = /!useUnifiedDecoder\s*&&\s*isTranslucent\s*&&\s*sfTranslucency\s*>\s*0\s*&&\s*skipDeadBatchEnabled\(\)/;
check("S1: _materialFromFlags stamps __baseTranslucency on the LEGACY (default, ?surfaceUnified-off) ladder",
  stampRe.test(matSrc) && /__baseTranslucency: sfTranslucency/.test(matSrc));
check("S2: the stamp is gated by ?skipDeadBatch, so =off is a complete restore",
  stampRe.test(matSrc));

// ---------------------------------------------------------------------------
// 3 + 4. The batcher: bucket keying, hiding, and lifecycle.
// ---------------------------------------------------------------------------
let bxSrc = readFileSync(resolvePath(__dirname, "scene3d/static_batch_x.js"), "utf8");
bxSrc = bxSrc.replace(/^\s*import\s+.*$/gm, "");
const bxStripped = bxSrc
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const BX = new Function(
  "THREE",
  bxStripped +
    "\n; return { setDeadBatchPredicate, __setStatBatchChunkForTest, __resetStatBatchXForTest, " +
    "consolidateStaticSingletonsCrossLb, evictStaticBatchXForLb, tickStatBatchXOptimize, getStatBatchXStats };"
)(THREE);

// statics.js composes the two flags with the predicate and installs it; mirror
// that composition exactly.
const composed = (mat) => MAT.skipDeadBatchEnabled() && MAT.materialRendersNothing(mat);
BX.setDeadBatchPredicate(composed);
BX.__setStatBatchChunkForTest(true);

function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) pos.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
function singleton(surfaceDid, x, lbId, geom, mat) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, 0);
  m.userData = { surfaceDid, landblockId: lbId >>> 0 };
  return m;
}

const scene3d = { staticsGroup: new THREE.Group() };
const LB1 = 0x96960000 >>> 0;
const matDead = deadMaterial();
const matLive = liveMaterial();
const geomDead = triGeom(4), geomLive = triGeom(4);

// A MIXED feed: 3 placements on the invisible surface + 3 on a visible one.
const nodes = [];
for (let i = 0; i < 3; i++) nodes.push(singleton(0x0A00, i, LB1, geomDead, matDead));
for (let i = 0; i < 3; i++) nodes.push(singleton(0x0B00, i, LB1, geomLive, matLive));
const r = BX.consolidateStaticSingletonsCrossLb(nodes, scene3d, LB1);
check("B0: mixed feed consumed", !!r && r.bucketsTouched === 2, r ? `bucketsTouched=${r.bucketsTouched}` : "null");

const bmDead = scene3d.staticsGroup.children.find((c) => c.material === matDead);
const bmLive = scene3d.staticsGroup.children.find((c) => c.material === matLive);
check("B1: the invisible and visible surfaces landed in SEPARATE buckets (buckets are keyed by material OBJECT — a bucket cannot mix)",
  !!bmDead && !!bmLive && bmDead !== bmLive);
check("B2: every member of the invisible bucket carries the bucket's own material (the all-members proof, checked not assumed)",
  nodes.filter((n) => n.material === matDead).every((n) => n.material === bmDead.material));
check("B3: the invisible bucket is hidden and marked", bmDead.visible === false && bmDead.userData.__deadBatch === true);
check("B4: the VISIBLE bucket keeps rendering", bmLive.visible !== false && bmLive.userData.__deadBatch !== true);
check("B5: hiding did not drop geometry — the bucket still holds its 3 instances (visible=false, not evicted)",
  bmDead.userData.instances === 3 && bmDead.userData.gidVerts.size === 1,
  `instances=${bmDead.userData.instances}`);

// The census must SAY which buckets are dead, and must say whether it was even
// armed — a 0 with no predicate installed means "not measured", never "clean".
{
  const st = BX.getStatBatchXStats();
  check("B6: census reports armed + 1 dead bucket + its triangle count",
    st.deadBatch.armed === true && st.deadBatch.buckets === 1 && st.deadBatch.triangles === 4,
    `armed=${st.deadBatch.armed} dead=${st.deadBatch.buckets} tris=${st.deadBatch.triangles}`);
  check("B7: per-bucket rows carry the `dead` flag",
    st.detail.filter((d) => d.dead).length === 1);
}

// ---- the cull-pass interaction (this is what makes or breaks the change) ----
// `cullStaticsGroup` force-restores `visible = true` on every BatchedMesh every
// frame. Replay its BatchedMesh arm verbatim (source-checked below) and confirm
// the hide survives; a bare `visible = false` would not last one frame.
const statSrc = readFileSync(resolvePath(__dirname, "scene3d/statics.js"), "utf8");
check("C0: cullStaticsGroup's isBatchedMesh arm honours __deadBatch BEFORE the unconditional restore",
  /if \(node\.isBatchedMesh\) \{[\s\S]{0,1400}?ud && ud\.__deadBatch === true[\s\S]{0,200}?node\.visible = false[\s\S]{0,400}?if \(node\.visible === false\) node\.visible = true;/.test(statSrc));
function replayCullBatchedArm(group) {
  for (const node of group.children) {
    if (!node || !node.isBatchedMesh) continue;
    const ud = node.userData;
    if (ud && ud.__deadBatch === true) { if (node.visible !== false) node.visible = false; continue; }
    if (node.visible === false) node.visible = true;
  }
}
replayCullBatchedArm(scene3d.staticsGroup);
replayCullBatchedArm(scene3d.staticsGroup);
check("C1: the hide survives two cull passes (marker honoured, not fought)",
  bmDead.visible === false && bmLive.visible === true);

// ---- lifecycle: membership churn cannot change the answer ----
const LB2 = 0x97970000 >>> 0; // same 3x3 region → SAME buckets
const more = [];
for (let i = 0; i < 2; i++) more.push(singleton(0x0A00, 50 + i, LB2, triGeom(4), matDead));
for (let i = 0; i < 2; i++) more.push(singleton(0x0B00, 50 + i, LB2, triGeom(4), matLive));
BX.consolidateStaticSingletonsCrossLb(more, scene3d, LB2);
check("L0: a second LB feeding the SAME buckets leaves both verdicts intact",
  bmDead.userData.__deadBatch === true && bmDead.userData.instances === 5 &&
  bmLive.userData.__deadBatch !== true && bmLive.userData.instances === 5,
  `dead=${bmDead.userData.instances} live=${bmLive.userData.instances}`);
BX.evictStaticBatchXForLb(LB2);
BX.tickStatBatchXOptimize();
check("L1: eviction back to one LB leaves both verdicts intact",
  bmDead.userData.__deadBatch === true && bmDead.visible === false && bmLive.userData.__deadBatch !== true);

// ---- lifecycle: the material itself changing, which IS possible ----
// `_reseatSurfaceState` (materials.js) rewrites transparent/opacity/depthWrite/
// blending on a derived variant clone when the real surface lands after a
// spawn-race fallback — in BOTH directions. Simulate each and tick.
matDead.opacity = 1;
matDead.transparent = false;
matDead.userData = {};
BX.tickStatBatchXOptimize();
check("L2: a bucket whose material STOPPED being invisible is un-hidden on the optimize tick",
  bmDead.visible === true && bmDead.userData.__deadBatch === false);
replayCullBatchedArm(scene3d.staticsGroup);
check("L3: ... and the cull pass then leaves it visible", bmDead.visible === true);

Object.assign(matLive, { transparent: true, opacity: 0, depthWrite: false });
matLive.userData = { __baseTranslucency: 1.0 };
BX.tickStatBatchXOptimize();
check("L4: a bucket whose material BECAME invisible is hidden on the optimize tick",
  bmLive.visible === false && bmLive.userData.__deadBatch === true);
{
  const st = BX.getStatBatchXStats();
  check("L5: the round trip is COUNTED (marked/unmarked transitions), so a churning bucket is visible in the census",
    st.deadBatch.marked === 2 && st.deadBatch.unmarked === 1,
    `marked=${st.deadBatch.marked} unmarked=${st.deadBatch.unmarked}`);
}

// ---- shadows: a shadow-casting bucket is never hidden ----
{
  BX.__resetStatBatchXForTest();
  const g2 = new THREE.Group();
  const s3 = { staticsGroup: g2 };
  const matShadow = deadMaterial();
  const shadowNodes = [];
  for (let i = 0; i < 2; i++) {
    const n = singleton(0x0C00, i, LB1, triGeom(2), matShadow);
    n.castShadow = true; // the depth-only shadow pass ignores opacity
    shadowNodes.push(n);
  }
  BX.consolidateStaticSingletonsCrossLb(shadowNodes, s3, LB1);
  const bmS = g2.children.find((c) => c.material === matShadow);
  check("SH0: a castShadow bucket is NOT hidden even though its colour pass draws nothing",
    !!bmS && bmS.visible !== false && bmS.userData.__deadBatch !== true);
  check("SH1: ... and the skip is COUNTED, not silent",
    BX.getStatBatchXStats().deadBatch.shadowSkipped >= 1);
}

// ---- the escape hatch ----
{
  BX.__resetStatBatchXForTest();
  BX.setDeadBatchPredicate(null); // ≡ ?skipDeadBatch=off / predicate never installed
  const g3 = new THREE.Group();
  const s4 = { staticsGroup: g3 };
  const m4 = deadMaterial();
  const ns4 = [];
  for (let i = 0; i < 2; i++) ns4.push(singleton(0x0D00, i, LB1, triGeom(2), m4));
  BX.consolidateStaticSingletonsCrossLb(ns4, s4, LB1);
  const bm4 = g3.children.find((c) => c.material === m4);
  check("E0: with the predicate uninstalled nothing is hidden (=off restores the old behaviour)",
    !!bm4 && bm4.visible !== false && bm4.userData.__deadBatch === undefined);
  check("E1: ... and the census says so rather than reporting a clean 0",
    BX.getStatBatchXStats().deadBatch.armed === false);
  BX.setDeadBatchPredicate(composed);
}

// ---- the per-LB batcher (the ?statBatchChunk=off arm) takes the same route ----
check("X0: consolidateStaticSingletons marks __deadBatch under the same castShadow guard",
  /if \(!bm\.castShadow && _batchRendersNothing\(mat\)\) \{[\s\S]{0,120}?__deadBatch = true;[\s\S]{0,60}?bm\.visible = false;/.test(statSrc));
check("X1: statics.js composes the predicate with BOTH flags and installs it into static_batch_x.js",
  /function _batchRendersNothing\(mat\) \{\s*return skipDeadBatchEnabled\(\) && materialRendersNothing\(mat\);\s*\}/.test(statSrc) &&
  /setDeadBatchPredicate\(_batchRendersNothing\);/.test(statSrc));

console.log("=========================");
console.log(`dead-batch-skip test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
