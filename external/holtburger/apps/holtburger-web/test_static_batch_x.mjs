// ?statBatchCrossLb (2026-07-02) — headless test for
// consolidateStaticSingletonsCrossLb / evictStaticBatchXForLb /
// tickStatBatchXOptimize in scene3d/static_batch_x.js. Proves the cross-LB
// per-material consolidation: >=2-per-material groups from MULTIPLE landblocks
// land in ONE persistent BatchedMesh per material (geometry deduped, instances
// per placement, matrices carried), lone singletons + LOD wrappers pass
// through untouched (same population split as the per-LB consolidator), per-LB
// eviction excises exactly that LB's gids (other LBs' instances survive),
// re-feed after evict works, and the lazy optimize() compacts dead space.
//
// Run: cd apps/holtburger-web/ && node test_static_batch_x.mjs
// (needs `three` resolvable or THREE_PATH=/path/to/three.module.js)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok?"OK":"FAIL"}] ${n}${d?" — "+d:""}`); ok?passed++:failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
if (!tp) { console.log("static-batch-x test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);
console.log("?statBatchCrossLb — cross-LB static batch consolidation test");
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
    "\n; return { statBatchChunkEnabled, __setStatBatchChunkForTest, __resetStatBatchXForTest, " +
    "statGeomDedupEnabled, __setStatGeomDedupForTest, stampStaticContentKeys, " +
    "consolidateStaticSingletonsCrossLb, evictStaticBatchXForLb, tickStatBatchXOptimize, getStatBatchXStats };"
);
const M = factory(THREE);

// ---- mock singleton nodes (mirrors test_static_batch.mjs) ----
// Statics singleton geometries are NON-indexed {position, uv, normal} (adapter.js
// meshToGeometryGroups) — model that exactly.
function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) { pos.set([0,0,0, 1,0,0, 0,1,0], i * 9); }
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
const LB1 = 0x96960000 >>> 0, LB2 = 0x97970000 >>> 0; // (150,150) & (151,151) -> SAME 3x3 region (50,50)
const LB3 = 0xCCDD0000 >>> 0; // (204,221) -> region (68,73), FAR

// ===== 1. flag default =====
check("0: flag defaults ON (v2 chunked, 1070-proven 2026-07-03; =off escapes)", M.statBatchChunkEnabled() === true);
M.__setStatBatchChunkForTest(true);

// ===== 2. LB1 feed: grouping parity with the per-LB consolidator =====
const matA = new THREE.MeshBasicMaterial(), matB = new THREE.MeshBasicMaterial();
const geomA = triGeom(2), geomB = triGeom(3); // shared per (model,surface) within an LB
const nodes1 = [];
for (let i = 0; i < 5; i++) nodes1.push(singleton(0x0A00, i, LB1, geomA, matA)); // surf A ×5, ONE geometry
for (let i = 0; i < 3; i++) nodes1.push(singleton(0x0B00, i, LB1, triGeom(1), matB)); // surf B ×3, per-node geoms
const lone = singleton(0x0C00, 99, LB1, triGeom(1), new THREE.MeshBasicMaterial()); nodes1.push(lone);
const lod = new THREE.LOD(); lod.userData = { surfaceDid: 0x0D00, landblockId: LB1 }; nodes1.push(lod);

const r1 = M.consolidateStaticSingletonsCrossLb(nodes1, scene3d, LB1);
check("1: feed returns a result (consumed)", !!r1, r1 ? `bucketsTouched=${r1.bucketsTouched}` : "null");
check("2: lone singleton + LOD pass through (out = 2, identity preserved)",
  r1 && r1.out.length === 2 && r1.out.includes(lone) && r1.out.includes(lod), `out=${r1 && r1.out.length}`);
check("3: 2 buckets created and self-added to staticsGroup",
  scene3d.staticsGroup.children.filter((c) => c.isBatchedMesh).length === 2,
  `children=${scene3d.staticsGroup.children.length}`);
const bmA = scene3d.staticsGroup.children.find((c) => c.material === matA);
const bmB = scene3d.staticsGroup.children.find((c) => c.material === matB);
check("4: buckets keep their surface material + carry NO landblockId + named static-batch-x-*",
  bmA && bmB && bmA.userData.landblockId === undefined && /^static-batch-c-r50x50-s00000a00/.test(bmA.name),
  `nameA=${bmA && bmA.name}`);
check("5: surf-A bucket holds 5 instances over ONE deduped geometry",
  bmA && bmA.userData.instances === 5 && bmA.userData.gidVerts.size === 1,
  `instances=${bmA && bmA.userData.instances}, gids=${bmA && bmA.userData.gidVerts.size}`);
check("6: surf-B bucket holds 3 instances over 3 geometries",
  bmB && bmB.userData.instances === 3 && bmB.userData.gidVerts.size === 3,
  `instances=${bmB && bmB.userData.instances}, gids=${bmB && bmB.userData.gidVerts.size}`);
check("7: three.js instanceCount agrees (5 + 3)",
  bmA && bmB && bmA.instanceCount === 5 && bmB.instanceCount === 3,
  `A=${bmA && bmA.instanceCount} B=${bmB && bmB.instanceCount}`);
// matrices carried: surf-A instance 0 at x=0, instance 4 at x=4
{
  const m0 = new THREE.Matrix4(), m4 = new THREE.Matrix4();
  bmA.getMatrixAt(0, m0); bmA.getMatrixAt(4, m4);
  check("8: per-instance matrices carried (x=0 .. x=4)",
    Math.abs(m0.elements[12] - 0) < 1e-6 && Math.abs(m4.elements[12] - 4) < 1e-6,
    `x0=${m0.elements[12]}, x4=${m4.elements[12]}`);
}
check("9: eviction hook installed on scene3d",
  typeof scene3d._evictStaticBatchXForLb === "function");

// ===== 3. LB2 feed: SAME materials reuse the SAME buckets (the cross-LB win) =====
const geomA2 = triGeom(2); // a different LB decodes its own geometry object
const nodes2 = [];
for (let i = 0; i < 4; i++) nodes2.push(singleton(0x0A00, 100 + i, LB2, geomA2, matA));
const r2 = M.consolidateStaticSingletonsCrossLb(nodes2, scene3d, LB2);
check("10: same-region second LB consumed into the SAME chunk bucket (no new BatchedMesh)",
  r2 && r2.out.length === 0 && scene3d.staticsGroup.children.filter((c) => c.isBatchedMesh).length === 2,
  `children=${scene3d.staticsGroup.children.length}`);
check("11: surf-A bucket now 9 instances over 2 gids (per-LB geometry identity)",
  bmA.userData.instances === 9 && bmA.userData.gidVerts.size === 2,
  `instances=${bmA.userData.instances}, gids=${bmA.userData.gidVerts.size}`);

// ===== 3b. FAR LB (different 3x3 region): NEW chunk bucket, not the LB1 one =====
{
  const nodesFar = [];
  const gF = triGeom(1);
  for (let i = 0; i < 2; i++) nodesFar.push(singleton(0x0A00, 300 + i, LB3, gF, matA));
  const rF = M.consolidateStaticSingletonsCrossLb(nodesFar, scene3d, LB3);
  const bms = scene3d.staticsGroup.children.filter((c) => c.isBatchedMesh);
  const far = bms.find((c) => /^static-batch-c-r68x73-/.test(c.name));
  check("11b: far LB lands in its OWN region chunk (3 buckets, r68x73 exists, LB1 bucket untouched)",
    rF && bms.length === 3 && !!far && far.material === matA && bmA.userData.instances === 9,
    `buckets=${bms.length} far=${far && far.name}`);
  check("11c: chunk bounds invalidated on feed (boundingSphere === null, three recomputes at cull)",
    bmA.boundingSphere === null && far.boundingSphere === null);
  M.consolidateStaticSingletonsCrossLb([], scene3d, LB3); // no-op feed safe
  scene3d._evictStaticBatchXForLb(LB3); // clean up so downstream counts hold
}

// ===== 4. per-LB eviction: LB1's gids go, LB2's instances survive =====
scene3d._evictStaticBatchXForLb(LB1);
check("12: evict(LB1) drops LB1's instances from BOTH buckets (A: 9→4, B: 3→0)",
  bmA.userData.instances === 4 && bmB.userData.instances === 0,
  `A=${bmA.userData.instances} B=${bmB.userData.instances}`);
check("13: three.js agrees (active instances A=4, B=0)",
  bmA.instanceCount === 4 && bmB.instanceCount === 0,
  `A=${bmA.instanceCount} B=${bmB.instanceCount}`);
check("14: LB2 survivor matrices intact (x=100..103)", (() => {
  // the 4 survivors are LB2's — their matrices must still decode to x=100..103
  const xs = [];
  const mtmp = new THREE.Matrix4();
  const info = bmA._instanceInfo;
  for (let i = 0; i < info.length; i++) {
    if (info[i] && info[i].active) { bmA.getMatrixAt(i, mtmp); xs.push(Math.round(mtmp.elements[12])); }
  }
  xs.sort((a, b) => a - b);
  return xs.length === 4 && xs[0] === 100 && xs[3] === 103;
})());
// 2026-08-03 — EXPECTATION UPDATED. This used to assert that BOTH buckets stay
// in the scene graph forever ("never disposed per-LB"). Half of that is still
// right and is the important half: a bucket that still holds another LB's
// geometry must NOT be torn down by one LB's eviction (bmA keeps LB2). But
// bucket B held ONLY LB1's contribution, so after this eviction it is empty —
// and keeping empty buckets was a real leak: buckets are keyed by (3x3 region,
// material) over an 86x86 region space and each one holds ~0.65 MB of GPU
// buffers, so a long roam grew `staticsGroup` with regions VISITED rather than
// regions RESIDENT. Empty buckets are now reaped at the eviction that empties
// them.
check("15a: a bucket that still holds geometry survives one LB's eviction",
  scene3d.staticsGroup.children.includes(bmA) && bmA.userData.gidVerts.size > 0,
  `gids=${bmA.userData.gidVerts.size}`);
check("15b: a bucket emptied by that eviction is reaped from the scene graph",
  !scene3d.staticsGroup.children.includes(bmB) && bmB.userData.gidVerts.size === 0,
  `stillChild=${scene3d.staticsGroup.children.includes(bmB)} gids=${bmB.userData.gidVerts.size}`);
check("15c: the reaped bucket is gone from the module's bucket registry",
  M.getStatBatchXStats().detail.every((d) => d.name !== bmB.name));
check("15d: bucket lifecycle counters balance (created - reaped === live)", (() => {
  const s = M.getStatBatchXStats();
  return s.bucketsCreated - s.bucketsReaped === s.buckets && s.bucketsReaped >= 1;
})(), JSON.stringify({ ...M.getStatBatchXStats(), detail: undefined, dedup: undefined }));
check("16: dead-space accounted for optimize (A deadVerts = LB1's 6 verts)",
  bmA.userData.deadVerts === 6 && bmB.userData.deadVerts === 9,
  `A=${bmA.userData.deadVerts} B=${bmB.userData.deadVerts}`);

// ===== 5. lazy optimize compacts once >30% of the used extent is dead =====
const usedBeforeOpt = bmA.userData.usedVerts; // 6 (LB1) + 6 (LB2) = 12, 50% dead
M.tickStatBatchXOptimize();
check("17: optimize() compacts the fragmented bucket (usedVerts 12→6, dead 0)",
  bmA.userData.usedVerts === 6 && bmA.userData.deadVerts === 0,
  `before=${usedBeforeOpt} after=${bmA.userData.usedVerts}`);
check("18: survivors still render-valid after optimize (instanceCount 4, matrices intact)", (() => {
  if (bmA.instanceCount !== 4) return false;
  const mtmp = new THREE.Matrix4();
  const info = bmA._instanceInfo;
  const xs = [];
  for (let i = 0; i < info.length; i++) {
    if (info[i] && info[i].active) { bmA.getMatrixAt(i, mtmp); xs.push(Math.round(mtmp.elements[12])); }
  }
  xs.sort((a, b) => a - b);
  return xs[0] === 100 && xs[3] === 103;
})());

// ===== 6. re-feed of an evicted LB gets fresh gids (no orphan/duplicate) =====
const nodes3 = [];
const geomA3 = triGeom(2);
for (let i = 0; i < 2; i++) nodes3.push(singleton(0x0A00, 200 + i, LB1, geomA3, matA));
const r3 = M.consolidateStaticSingletonsCrossLb(nodes3, scene3d, LB1);
check("19: re-feed after evict lands in the same bucket (instances 4→6)",
  r3 && bmA.userData.instances === 6 && bmA.instanceCount === 6,
  `instances=${bmA.userData.instances}`);

// ===== 7. nothing-consumed → null (caller falls back to the per-LB path) =====
const loneOnly = [singleton(0x0F00, 1, LB1, triGeom(1), new THREE.MeshBasicMaterial())];
const r4 = M.consolidateStaticSingletonsCrossLb(loneOnly, scene3d, LB1);
check("20: all-lone feed returns null (legacy per-LB fallback, no double-render)", r4 === null);

// ===== 8. instance-capacity growth past _INIT_INST (512) =====
M.__resetStatBatchXForTest();
{
  const s2 = { staticsGroup: new THREE.Group() };
  const matBig = new THREE.MeshBasicMaterial();
  const gBig = triGeom(1);
  const many = [];
  for (let i = 0; i < 600; i++) many.push(singleton(0x1111, i, LB1, gBig, matBig));
  const rBig = M.consolidateStaticSingletonsCrossLb(many, s2, LB1);
  const bm = s2.staticsGroup.children[0];
  check("21: 600 instances grow past the 512 init capacity (setInstanceCount doubling)",
    rBig && bm && bm.userData.instances === 600 && bm.instanceCount === 600 && bm.userData.maxInst >= 1024,
    `instances=${bm && bm.userData.instances}, maxInst=${bm && bm.userData.maxInst}`);
  const s = M.getStatBatchXStats();
  check("22: stats surface agrees (1 bucket, 600 instances)",
    s.buckets === 1 && s.instances === 600, JSON.stringify({ buckets: s.buckets, instances: s.instances }));
}

// ===== 9. render-path flags =====
{
  const s3 = { staticsGroup: new THREE.Group() };
  const matOpaque = new THREE.MeshBasicMaterial();
  const matTrans = new THREE.MeshBasicMaterial({ transparent: true });
  const g = triGeom(1);
  M.consolidateStaticSingletonsCrossLb(
    [singleton(1, 0, LB1, g, matOpaque), singleton(1, 1, LB1, g, matOpaque),
     singleton(2, 0, LB1, triGeom(1), matTrans), singleton(2, 1, LB1, triGeom(1), matTrans)],
    s3, LB1);
  const bO = s3.staticsGroup.children.find((c) => c.material === matOpaque);
  const bT = s3.staticsGroup.children.find((c) => c.material === matTrans);
  check("23: opaque bucket skips instance sort; transparent keeps it; chunk node IS frustum-culled",
    bO && bT && bO.sortObjects === false && bT.sortObjects === true &&
    bO.perObjectFrustumCulled === true && bO.frustumCulled === true &&
    bO.boundingSphere === null);
}

console.log("=========================");

// ===== RE-FEED IDEMPOTENCE (2026-07-03 regression fix) =====
// A re-bake of an already-fed LB must REPLACE its contribution, not append.
{
  M.__resetStatBatchXForTest();
  const sc = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const mk = () => { const g = triGeom(1); return [singleton(0x0E00, 0, LB1, g, mat), singleton(0x0E00, 1, LB1, g, mat), singleton(0x0E00, 2, LB1, g, mat)]; };
  const ra = M.consolidateStaticSingletonsCrossLb(mk(), sc, LB1);
  const s1 = M.getStatBatchXStats();
  const rb = M.consolidateStaticSingletonsCrossLb(mk(), sc, LB1); // re-bake, NO evict between
  const s2 = M.getStatBatchXStats();
  check("24: re-feeding the same LB does not duplicate (instances stable)",
    !!ra && !!rb && s1.instances === 3 && s2.instances === 3 && s2.lbsFed === 1,
    `after1=${s1.instances} after2=${s2.instances} lbsFed=${s2.lbsFed}`);
  const rc = M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0E00, 5, LB1, triGeom(1), mat), singleton(0x0E00, 6, LB1, triGeom(1), mat)], sc, LB1);
  const s3 = M.getStatBatchXStats();
  check("25: re-feed with DIFFERENT content replaces (2 instances, not 5)",
    !!rc && s3.instances === 2, `instances=${s3.instances}`);
}

// ===== BUCKET REAPING ON A MULTI-REGION ROAM (2026-08-03 leak fix) =====
// THE LEAK: buckets are keyed by (3x3-LB region, material) and nothing ever
// removed one, so `staticsGroup` and GPU memory grew with regions VISITED, not
// regions RESIDENT — over an 86x86 region space, at ~0.65 MB of vertex+index
// buffers per bucket. This walks 12 distinct regions, evicts each landblock
// behind the player, and asserts the live bucket population returns to zero.
{
  M.__resetStatBatchXForTest();
  const sc = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const visited = [];
  let peakChildren = 0;
  for (let r = 0; r < 12; r += 1) {
    // Region key is (lbX/3 | 0) x (lbY/3 | 0) — step 3 landblocks to land in a
    // fresh region every iteration.
    const lbId = ((((10 + r * 3) & 0xff) << 24) | ((20 & 0xff) << 16)) >>> 0;
    const g = triGeom(1);
    M.consolidateStaticSingletonsCrossLb(
      [singleton(0x0F00, 0, lbId, g, mat), singleton(0x0F00, 1, lbId, g, mat)], sc, lbId);
    visited.push(lbId);
    peakChildren = Math.max(peakChildren, sc.staticsGroup.children.length);
  }
  const midway = M.getStatBatchXStats();
  check("26: the roam really did create one bucket per region",
    midway.buckets === 12 && peakChildren === 12,
    `buckets=${midway.buckets} peakChildren=${peakChildren}`);

  for (const lbId of visited) M.evictStaticBatchXForLb(lbId);
  const after = M.getStatBatchXStats();
  check("27: every bucket is reaped once its region has no resident landblock",
    after.buckets === 0, `buckets=${after.buckets}`);
  check("28: reaped buckets left the scene graph (no orphan staticsGroup children)",
    sc.staticsGroup.children.length === 0, `children=${sc.staticsGroup.children.length}`);
  check("29: created/reaped counters balance across the whole roam",
    after.bucketsCreated === 12 && after.bucketsReaped === 12,
    `created=${after.bucketsCreated} reaped=${after.bucketsReaped}`);

  // Re-approaching a reaped region must rebuild cleanly (no stale registry
  // entry pointing at a disposed BatchedMesh).
  const back = visited[0];
  const g2 = triGeom(1);
  const rr = M.consolidateStaticSingletonsCrossLb(
    [singleton(0x0F00, 0, back, g2, mat), singleton(0x0F00, 1, back, g2, mat)], sc, back);
  const re = M.getStatBatchXStats();
  check("30: re-approaching a reaped region rebuilds its bucket",
    !!rr && re.buckets === 1 && sc.staticsGroup.children.length === 1 && re.instances === 2,
    `buckets=${re.buckets} children=${sc.staticsGroup.children.length} instances=${re.instances}`);
  check("31: the rebuilt bucket is a LIVE object (its geometry accepts reads)",
    sc.staticsGroup.children[0].isBatchedMesh
      && sc.staticsGroup.children[0].userData.gidVerts.size === 1);
}

// ===== ?statGeomDedup DEGRADATION IS ANNOUNCED, NOT SILENT =====
// `_gidLive` reads three's private `_geometryInfo`. If a three upgrade removes
// it, dedup silently becomes a no-op that copies each geometry in again while
// `stats().dedup.enabled` still reports true. It must announce instead.
{
  M.__resetStatBatchXForTest();
  M.__setStatGeomDedupForTest(true);
  const sc = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const LBa = 0x40400000 >>> 0, LBb = 0x41400000 >>> 0; // same 3x3 region
  const mkStamped = (lbId) => {
    const g = triGeom(1);
    g.userData = { __statContentKey: "deadbeef|0a00|0|3|0|1234" };
    return [singleton(0x1000, 0, lbId, g, mat), singleton(0x1000, 1, lbId, g, mat)];
  };
  M.consolidateStaticSingletonsCrossLb(mkStamped(LBa), sc, LBa);
  const bm = sc.staticsGroup.children[0];
  const healthy = M.getStatBatchXStats();
  check("32: dedup reports healthy while the three internal is present",
    healthy.dedup.enabled === true && healthy.dedup.degraded === false
      && healthy.dedup.probeFailures === 0);

  // Simulate the three upgrade that removes the internal.
  const realInfo = bm._geometryInfo;
  Object.defineProperty(bm, "_geometryInfo", { value: undefined, configurable: true });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  M.consolidateStaticSingletonsCrossLb(mkStamped(LBb), sc, LBb);
  M.consolidateStaticSingletonsCrossLb(mkStamped(LBb), sc, LBb); // second pass
  console.warn = realWarn;
  Object.defineProperty(bm, "_geometryInfo", { value: realInfo, configurable: true });

  const degraded = M.getStatBatchXStats();
  check("33: the probe failure is COUNTED, not swallowed",
    degraded.dedup.probeFailures > 0 && degraded.dedup.degraded === true,
    `probeFailures=${degraded.dedup.probeFailures}`);
  check("34: it warns, and warns exactly once despite repeated feeds",
    warns.filter((w) => w.includes("_geometryInfo")).length === 1,
    `warns=${warns.length}`);
}

console.log(`static-batch-x test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
