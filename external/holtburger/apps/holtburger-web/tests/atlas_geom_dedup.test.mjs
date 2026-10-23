// 2026-10-22 — P1a / finding F2 (`?atlasGeomDedup`, scene3d/static_atlas.js):
// the cross-LB statics atlas keys each bucket's geometry by (normalized
// content, layer) with refcounts, so repeated placements share ONE gid and
// `?batchedRuns` can draw them as instanced runs instead of one ANGLE draw per
// placement (docs/HANDOFF-gpu-resident-statics-2026-10-22.md §5 F2, §7 P1a).
//
// What is pinned here, without a GPU (real three r184 BatchedMesh, CPU side):
//   PART 1  same model twice (two LBs, two geometry OBJECTS, same bytes) → one
//           gid, refs 2, both instances drawn; batchedRuns folds them into one
//           run; the matrix carries the placement (geometry is model space).
//   PART 2  evict one LB → gid kept; evict both → gid deleted, dead-vertex
//           accounting right.
//   PART 3  exactness: one vertex different, a -0 normal, a different texture
//           (layer) → never shared; a planted hash collision and a stale key
//           are caught by the byte compare.
//   PART 4  `=off` is the pre-P1a path: one gid per member, no ledger, per-gid
//           delete on evict, batchedRuns noGain.
//   PART 5  CPU pixel-equivalence: the (vertex bytes, matrix) pairs the run
//           draw reaches equal the pairs the `=off` multidraw draws.
//   PART 6  rollbacks: addInstance failure on a joined gid and on a new gid,
//           addGeometry failure, and the blanket catch after a commit — the
//           shared gid and the other member's instance survive every one.
//   PART 7  ST5 re-home (`_atlasRefeedImpl`) and Phase 9a park/unpark.
//   PART 8  optimize() compaction, X7 layer growth, T5 pages, NRA drain.
//   PART 9  bucket eligibility (sorted / blended / opaque / alpha-tested),
//           flag grammar, `window.__atlasStats()` counters, projection helper.
//   PART 10 a coincident pair of different gids: the run draw reorders it
//           (the accepted equal-depth-tie difference) but draws the same pairs.
//   PART 11 the submitted sampler's disarm removes only its own hook.
// The GPU half (the real array material drawing identical pixels with runs <
// instances) is harness/glsl_smoke/atlas_geom_dedup_smoke.mjs (headless
// Chromium, run under `capped-build`; not part of the node gate).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/atlas_geom_dedup.test.mjs

import * as THREE from "three";

// `window.__atlasStats` is installed at module load only when `window` exists,
// so stub it BEFORE the import (location.search empty ⇒ every flag default).
globalThis.window = { location: { search: "" } };
const atlas = await import("../scene3d/static_atlas.js");
const runsMod = await import("../scene3d/batched_runs.js");
const bc7 = await import("../scene3d/bc7_textures.js");
const {
  addSingletonsToCrossLbAtlas, evictStaticAtlasForLb, parkStaticAtlasForLb, unparkStaticAtlasForLb,
  atlasInstancesForLb, tickStatAtlasOptimize, _atlasRefeedImpl, atlasGeomDedupEnabled,
  _resetStatAtlasForTest, _statAtlasBucketsForTest, _statAtlasStatsForTest,
  _atlasStartLayersFor, _layerCapacityFor, projectStatMergeBuckets,
  armStatMergeSubmittedSampler, disarmStatMergeSubmittedSampler,
} = atlas;
const { prepareRunDraw } = runsMod;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const TW = 64, TH = 64;
function makeTex(seed) {
  const data = new Uint8Array(TW * TH * 4);
  data.fill(seed & 0xff);
  data[0] = seed & 0xff;
  data[1] = (seed >> 8) & 0xff;
  const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
const QUAD_P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
const QUAD_N = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
/** A FRESH non-indexed quad each call (per-LB decode ⇒ distinct objects, same bytes). */
function quad(edit) {
  const p = QUAD_P.slice(), n = QUAD_N.slice(), uv = QUAD_UV.slice();
  if (edit) edit(p, n, uv);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  return g;
}
/** A fresh INDEXED box (the feed's toNonIndexed path) — a second model. */
const box = () => new THREE.BoxGeometry(1, 1, 1);
let _mid = 0;
function makeNode(geom, tex, lb, x = 0, y = 0, matOpts = {}) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, ...matOpts });
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, 0);
  m.rotation.z = 0.1 * (++_mid);
  m.userData.landblockId = lb >>> 0;
  return m;
}
const scene3d = { staticsGroup: new THREE.Group() };
const buckets = () => [..._statAtlasBucketsForTest().values()];
const onlyBm = () => { const b = buckets(); return b.length === 1 ? b[0].bm : null; };
const stats = () => _statAtlasStatsForTest();
const LB_A = 0x11110000, LB_B = 0x22220000, LB_C = 0x33330000, LB_D = 0x44440000;

const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
cam.position.set(0, 0, 80);
cam.lookAt(0, 0, 0);
cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();

/** Build the bucket's multidraw list the way three does before a draw. */
function multidraw(bm) {
  bm.updateMatrixWorld(true);
  bm._visibilityChanged = true;
  bm.onBeforeRender(null, null, cam, bm.geometry, bm.material);
  const n = bm._multiDrawCount | 0;
  const ids = bm._indirectTexture.image.data;
  const out = [];
  for (let k = 0; k < n; k++) out.push({ start: bm._multiDrawStarts[k], count: bm._multiDrawCounts[k], id: ids[k] });
  return out;
}
/** What one (range, instance) pair puts on screen: the vertex BYTES of every
 *  batch attribute over the range, and the instance matrix. */
function pairContent(bm, start, count, id) {
  const parts = [];
  for (const name of ["position", "normal", "uv", "aLayer"]) {
    const a = bm.geometry.attributes[name];
    const k = a.itemSize, B = a.array.BYTES_PER_ELEMENT;
    parts.push(Buffer.from(a.array.buffer, a.array.byteOffset + start * k * B, count * k * B).toString("base64"));
  }
  const m = new THREE.Matrix4();
  bm.getMatrixAt(id, m);
  return Array.from(m.elements).join(",") + "#" + parts.join("|");
}
/** The pairs batchedRuns' patched shader reaches for a run draw (layout emulation). */
function runPairs(st) {
  const buf = st.buf, L = buf.layout, out = [];
  for (let r = 0; r < buf.r; r++) {
    for (let i = 0; i < buf.inst[r]; i++) out.push({ start: buf.starts[r], count: buf.counts[r], id: L[L[1 + r] + i] });
  }
  return out;
}
const sorted = (a) => a.slice().sort();
const sameList = (a, b) => a.length === b.length && sorted(a).every((v, i) => v === sorted(b)[i]);

// ---------------------------------------------------------------------------
console.log("PART 1 — same model twice → one gid, refs 2, both drawn, one run");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ geomDedup: true });
  const tex = makeTex(1);
  const a = makeNode(quad(), tex, LB_A, -3, 0);
  const b = makeNode(quad(), tex, LB_B, 3, 0);
  check("the two members carry DISTINCT geometry objects (per-LB decode)", a.geometry !== b.geometry);
  const r = addSingletonsToCrossLbAtlas([a, b], scene3d);
  const bm = onlyBm();
  const ud = bm.userData;
  check("both atlased, no passthrough", r.passthrough.length === 0 && stats().atlased === 2);
  check("the bucket has a ledger (opaque, unsorted)", ud.gidRefs instanceof Map && ud.geomByContent instanceof Map);
  check("ONE gid", ud.gidVerts.size === 1 && ud.gidRefs.size === 1, `gids=${ud.gidVerts.size}`);
  const [gid, rec] = [...ud.gidRefs.entries()][0];
  check("refs 2, keyed", rec.refs === 2 && typeof rec.key === "string" && ud.geomByContent.get(rec.key) === gid);
  check("two instances on that gid", bm.instanceCount === 2 &&
    bm._instanceInfo.every((i) => i.active && i.geometryIndex === gid));
  check("counters: 1 add, 1 hit", stats().geomAdds === 1 && stats().geomDedupHits === 1);
  check("vertex extent counts the shared range once", ud.usedVerts === 6 && ud.deadVerts === 0);
  const md = multidraw(bm);
  check("both instances are drawn, from the SAME range", md.length === 2 && md[0].start === md[1].start);
  const st = prepareRunDraw(bm);
  check("batchedRuns: the bucket now GAINS (1 run for 2 ranges)", !!st && st.buf.r === 1 && st.buf.inst[0] === 2);
  // Placement lives in the matrix; the batch holds model-space bytes.
  a.updateMatrix(); b.updateMatrix();
  const m0 = new THREE.Matrix4(), m1 = new THREE.Matrix4();
  bm.getMatrixAt(0, m0); bm.getMatrixAt(1, m1);
  // The batch keeps matrices in a Float32 texture: compare at f32.
  const f32 = (m) => Array.from(Float32Array.from(m.elements)).join();
  check("instance matrices are the nodes' placements",
    f32(m0) === f32(a.matrix) && f32(m1) === f32(b.matrix) && f32(m0) !== f32(m1));
  const pos = bm.geometry.attributes.position.array.subarray(0, 18);
  check("the shared range is the MODEL-space geometry (not pre-transformed)",
    Buffer.compare(Buffer.from(pos.buffer, pos.byteOffset, 72), Buffer.from(new Float32Array(QUAD_P).buffer)) === 0);
  const al = bm.geometry.attributes.aLayer.array;
  check("aLayer stamped with the member's layer", al[0] === ud.layerOf.get(tex.uuid).layer);
  const ws = window.__atlasStats();
  check("__atlasStats: geomDedup on, liveGeometries 1 vs liveInstances 2",
    ws.geomDedup === true && ws.liveGeometries === 1 && ws.liveInstances === 2 && ws.dedupBuckets === 1,
    `geoms=${ws.liveGeometries} inst=${ws.liveInstances}`);
  check("__atlasStats per-bucket row", ws.buckets[0].geomDedup === true && ws.buckets[0].geoms === 1 && ws.buckets[0].inst === 2);
  check("instances counted per LB", atlasInstancesForLb(LB_A)[0] === 1 && atlasInstancesForLb(LB_B)[0] === 1);
}

// ---------------------------------------------------------------------------
console.log("PART 2 — evict one LB → gid kept; evict both → gid deleted");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ geomDedup: true });
  const tex = makeTex(2);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, -3), makeNode(quad(), tex, LB_B, 3)], scene3d);
  const bm = onlyBm(), ud = bm.userData;
  const gid = [...ud.gidRefs.keys()][0];
  evictStaticAtlasForLb(LB_A);
  check("after LB A: gid live, refs 1", ud.gidRefs.get(gid)?.refs === 1 && bm._geometryInfo[gid].active === true);
  check("...A's instance gone, B's kept", bm.instanceCount === 1 &&
    atlasInstancesForLb(LB_A)[0] === 0 && atlasInstancesForLb(LB_B)[0] === 1);
  check("...no dead vertices (the range is still drawn)", ud.deadVerts === 0 && ud.gidVerts.size === 1);
  check("...texture layer still referenced once", ud.layerOf.get(tex.uuid)?.refs === 1);
  check("...B still drawn", multidraw(bm).length === 1);
  evictStaticAtlasForLb(LB_B);
  check("after LB B: gid deleted", bm._geometryInfo[gid].active === false && ud.gidRefs.size === 0 &&
    ud.geomByContent.size === 0 && ud.gidVerts.size === 0);
  check("...its vertices counted dead once", ud.deadVerts === 6 && stats().geomFreed === 1);
  check("...layer freed, nothing drawn", ud.layerOf.size === 0 && bm.instanceCount === 0 && multidraw(bm).length === 0);
  // Re-entry re-feeds the same content into a fresh gid.
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, -3), makeNode(quad(), tex, LB_B, 3)], scene3d);
  check("re-entry: one gid again, refs 2", ud.gidRefs.size === 1 && [...ud.gidRefs.values()][0].refs === 2);
}

// ---------------------------------------------------------------------------
console.log("PART 3 — exactness: differing bytes never share");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ geomDedup: true });
  const tex = makeTex(3);
  const base = makeNode(quad(), tex, LB_A, 0);
  const oneVert = makeNode(quad((p) => { p[4] += 1e-6; }), tex, LB_B, 2);
  const negZero = makeNode(quad((p, n) => { n[0] = -0; }), tex, LB_C, 4);
  const otherTex = makeNode(quad(), makeTex(33), LB_D, 6);
  addSingletonsToCrossLbAtlas([base, oneVert, negZero, otherTex], scene3d);
  const bm = onlyBm(), ud = bm.userData;
  check("four members, four gids (one vertex / -0 normal / other layer)", ud.gidVerts.size === 4 && stats().geomDedupHits === 0,
    `gids=${ud.gidVerts.size} hits=${stats().geomDedupHits}`);
  check("no collision counted (distinct keys)", stats().geomDedupCollisions === 0);
  const md = multidraw(bm);
  check("four ranges, none repeated ⇒ batchedRuns noGain", md.length === 4 && new Set(md.map((e) => e.start)).size === 4 &&
    prepareRunDraw(bm) === null);
  const same = makeNode(quad(), tex, LB_A, 8);
  addSingletonsToCrossLbAtlas([same], scene3d);
  check("an exact repeat of `base` joins base's gid", ud.gidVerts.size === 4 && stats().geomDedupHits === 1);

  // Planted collision: map ANOTHER content's key to base's gid. The byte
  // compare must refuse it, count it, and give the member a private gid.
  _resetStatAtlasForTest({ geomDedup: true });
  const t2 = makeTex(4);
  addSingletonsToCrossLbAtlas([makeNode(quad(), t2, LB_A, 0)], scene3d);
  const bm2 = onlyBm(), ud2 = bm2.userData;
  const gidBase = [...ud2.gidRefs.keys()][0];
  const keyBase = ud2.gidRefs.get(gidBase).key;
  // The key text is internal, so the collision is planted at the lookup: for
  // the next feed, ANY other key resolves to gidBase.
  const realGet = ud2.geomByContent.get.bind(ud2.geomByContent);
  ud2.geomByContent.get = (k) => (k === keyBase ? realGet(k) : gidBase);
  const shifted = makeNode(quad((p) => { p[1] += 0.5; }), t2, LB_B, 2);
  const r = addSingletonsToCrossLbAtlas([shifted], scene3d);
  delete ud2.geomByContent.get;
  check("planted collision: counted, not shared", stats().geomDedupCollisions === 1 && r.passthrough.length === 0 &&
    ud2.gidVerts.size === 2 && ud2.gidRefs.get(gidBase).refs === 1);
  const gidShift = [...ud2.gidRefs.keys()].find((g) => g !== gidBase);
  check("...the collided member is UNKEYED (never re-registered over the base)",
    ud2.gidRefs.get(gidShift).key === null && ud2.geomByContent.get(keyBase) === gidBase && ud2.geomByContent.size === 1);
  evictStaticAtlasForLb(LB_B);
  check("...evicting it deletes only its own gid", bm2._geometryInfo[gidShift].active === false &&
    bm2._geometryInfo[gidBase].active === true && ud2.geomByContent.get(keyBase) === gidBase);
  // Stale key: point base's key at a dead gid; the next repeat must re-add.
  evictStaticAtlasForLb(LB_A);
  addSingletonsToCrossLbAtlas([makeNode(quad(), t2, LB_A, 0)], scene3d);
  const live = [...ud2.gidRefs.keys()][0];
  const k = ud2.gidRefs.get(live).key;
  const dead = live === gidShift ? gidBase : gidShift; // whichever id three left free
  check("stale setup: the planted gid is dead", bm2._geometryInfo[dead].active === false);
  ud2.geomByContent.set(k, dead);
  ud2.gidRefs.get(live).key = null;   // emulate the lost back-link a stale entry implies
  addSingletonsToCrossLbAtlas([makeNode(quad(), t2, LB_C, 4)], scene3d);
  const g2 = ud2.geomByContent.get(k);
  check("stale key: counted, and the member re-added (fresh live gid, refs 1, keyed)",
    stats().geomDedupStale === 1 && g2 !== undefined && g2 !== live && bm2._geometryInfo[g2].active === true &&
    ud2.gidRefs.get(g2)?.refs === 1 && ud2.gidRefs.get(g2).key === k && ud2.gidRefs.size === 2,
    `g2=${g2} live=${live}`);
}

// ---------------------------------------------------------------------------
console.log("PART 4 — `=off` is the pre-P1a path");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ geomDedup: false });
  check("flag pinned off", atlasGeomDedupEnabled() === false);
  const tex = makeTex(5);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, -3), makeNode(quad(), tex, LB_B, 3)], scene3d);
  const bm = onlyBm(), ud = bm.userData;
  check("no ledger on the bucket", ud.gidRefs === null && ud.geomByContent === null);
  check("one gid per member (2 gids, 2 instances)", ud.gidVerts.size === 2 && bm.instanceCount === 2);
  check("counters: 2 adds, 0 hits", stats().geomAdds === 2 && stats().geomDedupHits === 0);
  check("used extent counts both copies", ud.usedVerts === 12);
  const md = multidraw(bm);
  check("two ranges, distinct starts ⇒ batchedRuns noGain (today's F2)", md.length === 2 && md[0].start !== md[1].start &&
    prepareRunDraw(bm) === null);
  const gids = [...ud.gidVerts.keys()];
  evictStaticAtlasForLb(LB_A);
  check("evict A: A's gid deleted outright (per-gid delete), B's kept",
    bm._geometryInfo[gids[0]].active === false && bm._geometryInfo[gids[1]].active === true &&
    ud.deadVerts === 6 && ud.gidVerts.size === 1);
  const ws = window.__atlasStats();
  check("__atlasStats off arm: geomDedup false, geometries === instances",
    ws.geomDedup === false && ws.liveGeometries === 1 && ws.liveInstances === 1 && ws.dedupBuckets === 0);
}

// ---------------------------------------------------------------------------
console.log("PART 5 — CPU pixel-equivalence: run draw == `=off` multidraw");
// ---------------------------------------------------------------------------
{
  // Same feed, both arms: 2 models × 3 textures × several LBs, plus a
  // one-vertex variant. Order and data identical ⇒ identical layer indices.
  const feed = () => {
    _mid = 0;
    const texs = [makeTex(10), makeTex(11), makeTex(12)];
    const nodes = [];
    const spec = [
      [quad, 0, LB_A], [quad, 0, LB_B], [box, 1, LB_A], [quad, 0, LB_C], [box, 1, LB_B],
      [box, 2, LB_C], [quad, 1, LB_D], [box, 1, LB_D], [quad, 0, LB_D], [box, 2, LB_A],
    ];
    spec.forEach(([f, t, lb], i) => nodes.push(makeNode(f(), texs[t], lb, (i % 5) * 3 - 6, Math.floor(i / 5) * 3)));
    nodes.push(makeNode(quad((p) => { p[0] = 0.25; }), texs[0], LB_B, 9, 9));
    addSingletonsToCrossLbAtlas(nodes, scene3d);
    return onlyBm();
  };
  _resetStatAtlasForTest({ geomDedup: false });
  const bmOff = feed();
  const offPairs = multidraw(bmOff).map((e) => pairContent(bmOff, e.start, e.count, e.id));
  _resetStatAtlasForTest({ geomDedup: true });
  const bmOn = feed();
  const canon = multidraw(bmOn);
  const onCanon = canon.map((e) => pairContent(bmOn, e.start, e.count, e.id));
  const st = prepareRunDraw(bmOn);
  check("off arm: 11 gids for 11 members", bmOff.userData.gidVerts.size === 11 && offPairs.length === 11);
  check("on arm: 5 gids (quad×t0 ×4, box×t1 ×3, box×t2 ×2, quad×t1, quad'×t0)", bmOn.userData.gidVerts.size === 5,
    `gids=${bmOn.userData.gidVerts.size}`);
  check("on arm: batchedRuns gains, 5 runs for 11 ranges", !!st && st.buf.r === 5 && canon.length === 11,
    `runs=${st && st.buf.r} ranges=${canon.length}`);
  const runPairsContent = st ? runPairs(st).map((e) => pairContent(bmOn, e.start, e.count, e.id)) : [];
  check("run layout reaches exactly the canonical (range, instance) pairs",
    sameList(runPairsContent, onCanon));
  check("the drawn (vertex bytes, matrix) multiset equals the =off arm's", sameList(runPairsContent, offPairs));
}

// ---------------------------------------------------------------------------
console.log("PART 6 — rollbacks keep refcounts and buffer accounting right");
// ---------------------------------------------------------------------------
{
  // (a) addInstance fails for a member JOINING a live gid.
  _resetStatAtlasForTest({ geomDedup: true });
  const tex = makeTex(20);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, 0)], scene3d);
  const bm = onlyBm(), ud = bm.userData;
  const gid = [...ud.gidRefs.keys()][0];
  bm.addInstance = () => { throw new Error("full"); };
  bm.setInstanceCount = () => { throw new Error("no grow"); };
  const r1 = addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_B, 3)], scene3d);
  delete bm.addInstance; delete bm.setInstanceCount;
  check("(a) joined member that cannot get an instance → passthrough", r1.passthrough.length === 1 && stats().ptInstFail === 1);
  check("(a) shared gid untouched: refs 1, live, first instance live", ud.gidRefs.get(gid).refs === 1 &&
    bm._geometryInfo[gid].active && bm.instanceCount === 1 && bm._instanceInfo[0].active);
  check("(a) layer ref rolled back, no hit counted", ud.layerOf.get(tex.uuid).refs === 1 && stats().geomDedupHits === 0);

  // (b) addInstance fails for a member that ADDED a new gid.
  bm.addInstance = () => { throw new Error("full"); };
  bm.setInstanceCount = () => { throw new Error("no grow"); };
  const r2 = addSingletonsToCrossLbAtlas([makeNode(box(), tex, LB_B, 3)], scene3d);
  delete bm.addInstance; delete bm.setInstanceCount;
  check("(b) new gid released at refs 0", r2.passthrough.length === 1 && ud.gidRefs.size === 1 &&
    ud.geomByContent.size === 1 && ud.gidVerts.size === 1 && stats().geomFreed === 1);
  check("(b) its vertices are dead (appended, then deleted)", ud.deadVerts === 36 && ud.usedVerts === 42);
  check("(b) the original member still drawn", multidraw(bm).length === 1);

  // (c) addGeometry fails: a NEW content member passes through; a REPEAT
  // still joins (a hit never calls addGeometry).
  bm.addGeometry = () => { throw new Error("no room"); };
  const r3 = addSingletonsToCrossLbAtlas([makeNode(box(), makeTex(21), LB_C, 6)], scene3d);
  const r4 = addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_C, 9)], scene3d);
  delete bm.addGeometry;
  check("(c) new content: ptGeomFail, no ledger entry, its new layer freed", r3.passthrough.length === 1 &&
    stats().ptGeomFail === 1 && ud.gidRefs.size === 1 && ud.layerOf.size === 1);
  check("(c) repeat: joined without addGeometry", r4.passthrough.length === 0 && ud.gidRefs.get(gid).refs === 2);

  // (d) a throw AFTER the commit (setMatrixAt) on a JOINED member: the blanket
  // catch must drop that member's instance only — never deleteGeometry the
  // shared gid (which would cascade to every member).
  const before = bm.instanceCount;
  bm.setMatrixAt = () => { throw new Error("boom"); };
  const r5 = addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_D, 12)], scene3d);
  delete bm.setMatrixAt;
  check("(d) unwound: ptError + ptErrorUnwound, node passes through", stats().ptError === 1 &&
    stats().ptErrorUnwound === 1 && r5.passthrough.length === 1);
  check("(d) shared gid survives with its two members drawn", ud.gidRefs.get(gid).refs === 2 &&
    bm._geometryInfo[gid].active && bm.instanceCount === before && multidraw(bm).length === 2);
  check("(d) layer refs back to the two members", ud.layerOf.get(tex.uuid).refs === 2);

  // (e) the same throw on a member that ADDED its gid: that gid goes, dead-counted.
  const dead0 = ud.deadVerts;
  bm.setMatrixAt = () => { throw new Error("boom"); };
  addSingletonsToCrossLbAtlas([makeNode(box(), tex, LB_D, 12)], scene3d);
  delete bm.setMatrixAt;
  check("(e) new gid unwound and dead-counted", ud.gidRefs.size === 1 && ud.deadVerts === dead0 + 36 &&
    bm.instanceCount === before);

  // (f) the =off arm's blanket catch is the pre-P1a one (deletes the member's own gid).
  _resetStatAtlasForTest({ geomDedup: false });
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, 0)], scene3d);
  const bmO = onlyBm();
  bmO.setMatrixAt = () => { throw new Error("boom"); };
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_B, 3)], scene3d);
  delete bmO.setMatrixAt;
  check("(f) =off unwind: own gid deleted, first member intact", bmO.instanceCount === 1 &&
    bmO._geometryInfo[0].active === true && bmO._geometryInfo[1].active === false && stats().ptErrorUnwound === 1);
}

// ---------------------------------------------------------------------------
console.log("PART 7 — ST5 re-home and Phase 9a park/unpark");
// ---------------------------------------------------------------------------
{
  // Arm the compressed-only re-home exactly as harness/test_tex_compressed_only.mjs does.
  const RS = 0x06002222;
  const hbc7 = (w, h, seed) => {
    const levels = [];
    let lw = w, lh = h;
    for (;;) {
      levels.push(bc7.bc7LevelBytes(lw, lh));
      if (lw === 1 && lh === 1) break;
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
    }
    const buf = new Uint8Array(bc7.HBC7_HEADER_BYTES + levels.reduce((a, b) => a + b, 0));
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x37434248, true); dv.setUint32(4, w, true); dv.setUint32(8, h, true);
    dv.setUint32(12, Math.ceil(w / 4), true); dv.setUint32(16, Math.ceil(h / 4), true);
    let off = bc7.HBC7_HEADER_BYTES;
    levels.forEach((n, i) => { buf.fill((seed + i + 1) & 0xff, off, off + n); off += n; });
    return bc7.makeBc7Texture(bc7.parseHbc7(buf));
  };
  bc7._resetBc7ForTest();
  bc7._resetTexCompressedOnlyForTest();
  window.location = { search: "?texCompressedOnly=on" };
  bc7._setBc7SupportForTest(true);
  bc7.initTexCompressedOnly({
    wasmNs: { surface_meta_sync: () => "", pack_pvw_blocks: () => new Uint8Array(0), pack_texref: () => -1 },
    controller: { armed: true },
  });
  check("compressed-only arm is live (re-home reachable)", bc7.texCompressedOnlyActive() === true);
  _resetStatAtlasForTest({ geomDedup: true });
  const pvw = hbc7(16, 16, 0x10);
  const pending = (lb, x) => {
    const mat = new THREE.MeshStandardMaterial({ map: pvw });
    mat.userData = { __pvwRsId: RS, __texFullPending: true, surfaceDid: 0x08000007 };
    const n = new THREE.Mesh(quad(), mat);
    n.position.set(x, 0, 0);
    n.userData = { landblockId: lb };
    return n;
  };
  const settled = (lb, x) => {
    const n = new THREE.Mesh(quad(), new THREE.MeshStandardMaterial({ map: pvw }));
    n.position.set(x, 0, 0);
    n.userData = { landblockId: lb };
    return n;
  };
  const nA = pending(LB_A, 0), nB = settled(LB_B, 3);
  addSingletonsToCrossLbAtlas([nA, nB], scene3d);
  const pre = buckets()[0];
  const preUd = pre.bm.userData;
  const preGid = [...preUd.gidRefs.keys()][0];
  check("preview bucket: the pending and the settled member share one gid", preUd.gidRefs.size === 1 &&
    preUd.gidRefs.get(preGid).refs === 2 && pre.bm.instanceCount === 2);
  // Full tier lands for A only.
  nA.material.map = hbc7(32, 32, 0x20);
  delete nA.material.userData.__texFullPending;
  nA.material.userData.__bc7RsId = RS;
  const moved = _atlasRefeedImpl(RS);
  check("re-home moved 1 member", moved === 1 && stats().rehomedNodes === 1);
  check("preview gid KEPT for the settled member (refs 1, its instance live)",
    preUd.gidRefs.get(preGid)?.refs === 1 && pre.bm._geometryInfo[preGid].active && pre.bm.instanceCount === 1 &&
    atlasInstancesForLb(LB_B)[0] === 1);
  const full = buckets().find((b) => b.w === 32);
  check("A re-fed into the full-dim bucket with its own gid", !!full && full.bm.userData.gidRefs.size === 1 &&
    full.bm.instanceCount === 1 && atlasInstancesForLb(LB_A)[0] === 1);
  evictStaticAtlasForLb(LB_A);
  check("evicting A afterwards touches only the full bucket", full.bm.userData.gidRefs.size === 0 &&
    preUd.gidRefs.get(preGid)?.refs === 1);
  evictStaticAtlasForLb(LB_B);
  check("evicting B frees the preview gid", preUd.gidRefs.size === 0 && pre.bm._geometryInfo[preGid].active === false);
  tickStatAtlasOptimize();
  check("both emptied buckets are GC'd", _statAtlasBucketsForTest().size === 0 && stats().emptyBucketsGCd === 2);

  // Two pending repeats re-home TOGETHER and share again in the full bucket.
  _resetStatAtlasForTest({ geomDedup: true });
  const p1 = pending(LB_A, 0), p2 = pending(LB_B, 3);
  p2.material = p1.material; // one material, one rsId — the usual shape
  addSingletonsToCrossLbAtlas([p1, p2], scene3d);
  const preB = buckets()[0];
  p1.material.map = hbc7(32, 32, 0x30);
  delete p1.material.userData.__texFullPending;
  _atlasRefeedImpl(RS);
  const fullB = buckets().find((b) => b.w === 32);
  check("both excised from the preview bucket (its gid deleted)", preB.bm.userData.gidRefs.size === 0 &&
    preB.bm.instanceCount === 0);
  check("...and sharing one gid in the full bucket (refs 2)", !!fullB && fullB.bm.userData.gidRefs.size === 1 &&
    [...fullB.bm.userData.gidRefs.values()][0].refs === 2);

  bc7._resetBc7ForTest();
  bc7._resetTexCompressedOnlyForTest();
  window.location = { search: "" };

  // Park / unpark: per-instance visibility on a shared gid.
  _resetStatAtlasForTest({ geomDedup: true });
  const tex = makeTex(40);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tex, LB_A, 0), makeNode(quad(), tex, LB_B, 3)], scene3d);
  const bm = onlyBm(), ud = bm.userData;
  check("park A hides 1", parkStaticAtlasForLb(LB_A) === 1);
  check("...A [active 1, visible 0], B [1, 1]", atlasInstancesForLb(LB_A).join() === "1,0" &&
    atlasInstancesForLb(LB_B).join() === "1,1");
  check("...the shared gid is untouched, nothing dirtied", [...ud.gidRefs.values()][0].refs === 2 && ud.deadVerts === 0);
  check("...only B is drawn", multidraw(bm).length === 1);
  check("unpark A shows 1, both drawn as one run", unparkStaticAtlasForLb(LB_A) === 1 && multidraw(bm).length === 2 &&
    prepareRunDraw(bm)?.buf.r === 1);
}

// ---------------------------------------------------------------------------
console.log("PART 8 — optimize(), X7 growth, T5 pages, NRA drain");
// ---------------------------------------------------------------------------
{
  // optimize(): a freed range ahead of a shared one is compacted away; the
  // ledger's gid still names the moved range and a later repeat still joins.
  _resetStatAtlasForTest({ geomDedup: true });
  const tX = makeTex(50), tY = makeTex(51);
  addSingletonsToCrossLbAtlas([makeNode(box(), tX, LB_A, 0)], scene3d);         // 36 verts @0
  addSingletonsToCrossLbAtlas([makeNode(quad(), tY, LB_B, 3), makeNode(quad(), tY, LB_C, 6)], scene3d); // 6 @36
  const bm = onlyBm(), ud = bm.userData;
  const gidY = [...ud.gidRefs.entries()].find(([, r]) => r.refs === 2)[0];
  check("before: Y's shared range starts at 36", bm._geometryInfo[gidY].vertexStart === 36);
  evictStaticAtlasForLb(LB_A);
  tickStatAtlasOptimize();
  check("optimize ran (dead 36/42 > 30%)", ud.deadVerts === 0 && ud.usedVerts === 6);
  check("...Y kept its gid, its range moved to 0", bm._geometryInfo[gidY].active && bm._geometryInfo[gidY].vertexStart === 0);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tY, LB_D, 9)], scene3d);
  check("a repeat after compaction joins the MOVED range (compare reads it live)",
    ud.gidRefs.get(gidY).refs === 3 && ud.gidVerts.size === 1 && stats().geomDedupHits === 2);
  const md = multidraw(bm);
  check("all three drawn from vertexStart 0", md.length === 3 && md.every((e) => e.start === 0));

  // X7 growth (pages off): a repeat of an early member still joins after the
  // arrays were reallocated deeper — growth moves texels, never aLayer.
  _resetStatAtlasForTest({ geomDedup: true, grow: true, nra: true, pages: false });
  const texs = [];
  for (let i = 0; i < 6; i++) texs.push(makeTex(60 + i));
  addSingletonsToCrossLbAtlas(texs.map((t, i) => makeNode(quad(), t, LB_A, i)), scene3d);
  const bmG = onlyBm(), udG = bmG.userData;
  check("the bucket grew", stats().layerGrows > 0 && udG.allocLayers > 4);
  addSingletonsToCrossLbAtlas([makeNode(quad(), texs[0], LB_B, 20)], scene3d);
  const l0 = udG.layerOf.get(texs[0].uuid).layer;
  const shared = [...udG.gidRefs.entries()].find(([, r]) => r.refs === 2);
  check("after growth a repeat joins its layer's gid", !!shared && udG.gidVerts.size === 6);
  const vs = shared ? bmG._geometryInfo[shared[0]].vertexStart : -1;
  check("...whose aLayer still names that layer", vs >= 0 && bmG.geometry.attributes.aLayer.array[vs] === l0);

  // T5 pages: dedup is per page; a family-wide texture hit lands on its page
  // and joins that page's gid (the PART 3 shape of test_static_atlas_pages).
  _resetStatAtlasForTest({ geomDedup: true, grow: true, nra: true, pages: true });
  const start = _atlasStartLayersFor(TW, TH, false, _layerCapacityFor(TW, TH, false));
  const sharedTex = makeTex(70);
  const nodes = [makeNode(quad(), sharedTex, LB_A, 0)];
  for (let i = 1; i < start; i++) nodes.push(makeNode(quad(), makeTex(70 + i), LB_A, i));
  nodes.push(makeNode(quad(), makeTex(99), LB_A, 30)); // opens page 1
  addSingletonsToCrossLbAtlas(nodes, scene3d);
  const page0 = buckets()[0].bm;
  addSingletonsToCrossLbAtlas([makeNode(quad(), sharedTex, LB_B, 40)], scene3d);
  check("pages: the repeat joined page 0's gid (start gids, start+1 instances)",
    buckets().length === 2 && page0.userData.gidVerts.size === start && page0.instanceCount === start + 1,
    `gids=${page0.userData.gidVerts.size} inst=${page0.instanceCount} start=${start}`);

  // NRA drain: pending re-packs are per LAYER; a repeat adds no entry and the
  // drain never touches the ledger.
  _resetStatAtlasForTest({ geomDedup: true, nra: true });
  const tN = makeTex(80);
  addSingletonsToCrossLbAtlas([makeNode(quad(), tN, LB_A, 0)], scene3d);
  const pend = window.__atlasStats().nraPending;
  addSingletonsToCrossLbAtlas([makeNode(quad(), tN, LB_B, 3)], scene3d);
  check("nra: the repeat queued no second re-pack", window.__atlasStats().nraPending === pend && pend === 1);
  const udN = onlyBm().userData;
  const refsBefore = [...udN.gidRefs.values()][0].refs;
  tickStatAtlasOptimize();
  check("nra: draining leaves the ledger alone", [...udN.gidRefs.values()][0].refs === refsBefore && refsBefore === 2);
}

// ---------------------------------------------------------------------------
console.log("PART 9 — eligibility, flag grammar, diag seams");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ geomDedup: true });
  const s9 = { staticsGroup: new THREE.Group() }; // fresh: earlier buckets self-added to `scene3d`
  const t = makeTex(90);
  const sortedT = makeTex(91), blendedT = makeTex(92), clipT = makeTex(93);
  addSingletonsToCrossLbAtlas([
    makeNode(quad(), t, LB_A, 0), makeNode(quad(), t, LB_B, 1),
    makeNode(quad(), sortedT, LB_A, 2, 0, { transparent: true }),
    makeNode(quad(), sortedT, LB_B, 3, 0, { transparent: true }),
    makeNode(quad(), blendedT, LB_A, 4, 0, { transparent: true, alphaTest: 0.5, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
    makeNode(quad(), blendedT, LB_B, 5, 0, { transparent: true, alphaTest: 0.5, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }),
    makeNode(quad(), clipT, LB_A, 6, 0, { alphaTest: 200 / 255 }),
    makeNode(quad(), clipT, LB_B, 7, 0, { alphaTest: 200 / 255 }),
  ], s9);
  const by = (pred) => buckets().find((b) => pred(b.bm));
  const opaque = by((bm) => !bm.material.transparent && !(bm.material.alphaTest > 0));
  const srt = by((bm) => bm.sortObjects === true);
  const bl = by((bm) => bm.material.blending === THREE.CustomBlending);
  const clip = by((bm) => !bm.material.transparent && bm.material.alphaTest > 0);
  check("opaque bucket: ledger, 1 gid for 2", !!opaque?.bm.userData.gidRefs && opaque.bm.userData.gidVerts.size === 1);
  check("alpha-tested opaque (?clipMapOpaque) bucket: ledger, 1 gid for 2",
    !!clip?.bm.userData.gidRefs && clip.bm.userData.gidVerts.size === 1);
  check("sorted (translucent) bucket: NO ledger, 2 gids", srt && srt.bm.userData.gidRefs === null && srt.bm.userData.gidVerts.size === 2);
  check("unsorted BLENDED bucket (?clipMapOpaque=off shape): NO ledger, 2 gids",
    bl && bl.bm.sortObjects === false && bl.bm.userData.gidRefs === null && bl.bm.userData.gidVerts.size === 2);
  const proj = projectStatMergeBuckets(s9.staticsGroup);
  check("projection helper still counts atlas buckets separately", proj.atlasBuckets === 4 && proj.batchBuckets === 0,
    `atlas=${proj.atlasBuckets}`);

  // Flag grammar (memo cleared by the reset; re-resolved from window.location).
  const withSearch = (search) => {
    window.location = { search };
    _resetStatAtlasForTest();
    const v = atlasGeomDedupEnabled();
    window.location = { search: "" };
    return v;
  };
  check("absent ⇒ ARMED", withSearch("") === true);
  check("garbage ⇒ ARMED", withSearch("?atlasGeomDedup=banana") === true);
  check("=on ⇒ ARMED", withSearch("?atlasGeomDedup=on") === true);
  for (const off of ["off", "0", "false", "no", "OFF"]) {
    check(`?atlasGeomDedup=${off} disarms`, withSearch(`?atlasGeomDedup=${off}`) === false);
  }
  // The URL path end to end: `=off` from the address bar builds no ledger.
  window.location = { search: "?atlasGeomDedup=off" };
  _resetStatAtlasForTest();
  addSingletonsToCrossLbAtlas([makeNode(quad(), t, LB_A, 0), makeNode(quad(), t, LB_B, 1)], s9);
  window.location = { search: "" };
  const bm = onlyBm();
  check("?atlasGeomDedup=off (URL): no ledger, one gid per member", bm.userData.gidRefs === null &&
    bm.userData.gidVerts.size === 2 && window.__atlasStats().geomDedup === false);
  _resetStatAtlasForTest();
}

// ---------------------------------------------------------------------------
console.log("PART 10 — coincident members of different gids: order-only difference");
// ---------------------------------------------------------------------------
// 2026-10-23 review (atlas-dedup-2). Regrouping draws runs in first-seen-range
// order. Feed Y (tex B) at P0, then X (tex A) and Y at P1, X and Y coincident:
// `=off` draws iid 0,1,2 (Y wins an exactly-equal-depth tie under LessEqual);
// the run draw is Y's run (0,2) then X's (1), so X wins it. The static_atlas.js
// header (WHICH BUCKETS) ACCEPTS that as order-only — the `=off` winner is
// instance-slot order, not a scene property. Pinned here: that it IS only order
// (the same (vertex bytes, matrix) pairs reach the GPU), and the reorder itself,
// so a builder change that removes or widens it has to revisit the header.
{
  const arm = (geomDedup) => {
    _mid = 0; // same rotations in both arms (makeNode's counter), as PART 5
    _resetStatAtlasForTest({ geomDedup });
    const s10 = { staticsGroup: new THREE.Group() };
    const tA = makeTex(100), tB = makeTex(101);
    const y0 = makeNode(quad(), tB, LB_A, -5);
    const x = makeNode(quad(), tA, LB_B, 3), y = makeNode(quad(), tB, LB_B, 3);
    x.rotation.z = 0; y.rotation.z = 0; // coincident: same position bytes, same matrix
    addSingletonsToCrossLbAtlas([y0, x, y], s10);
    const bm = onlyBm();
    const canon = multidraw(bm);
    const st = prepareRunDraw(bm);
    const seq = st ? runPairs(st) : canon;
    return {
      gids: bm.userData.gidVerts.size, run: !!st, ids: seq.map((e) => e.id),
      pairs: seq.map((e) => pairContent(bm, e.start, e.count, e.id)),
    };
  };
  const off = arm(false), on = arm(true);
  check("=off: 3 gids, three's multidraw in iid order 0,1,2", off.gids === 3 && !off.run &&
    off.ids.join() === "0,1,2", `ids=${off.ids}`);
  check("on: Y's two placements share a gid, batchedRuns draws runs", on.gids === 2 && on.run, `gids=${on.gids}`);
  check("on: the coincident pair's draw order flips (0,2,1) — the accepted tie difference",
    on.ids.join() === "0,2,1", `ids=${on.ids}`);
  check("...and ONLY the order: the drawn (vertex bytes, matrix) multiset equals =off's",
    on.pairs.length === 3 && sameList(on.pairs, off.pairs));
  _resetStatAtlasForTest();
}

// ---------------------------------------------------------------------------
console.log("PART 11 — the submitted sampler's disarm removes only its own hook");
// ---------------------------------------------------------------------------
// 2026-10-23 review (atlas-dedup-1). `disarmStatMergeSubmittedSampler` used to
// delete the own `onBeforeRender` of EVERY BatchedMesh it traversed, while
// `arm` skips a bucket that already owns one — so the chunk buckets' memo /
// sphere override (static_batch_x.js `_installMemo`) and any unrelated hook
// were stripped by the documented arm → project → disarm sequence.
{
  _resetStatAtlasForTest({ geomDedup: true });
  const s11 = { staticsGroup: new THREE.Group() };
  addSingletonsToCrossLbAtlas([makeNode(quad(), makeTex(110), LB_A, 0),
    makeNode(quad(), makeTex(110), LB_B, 2)], s11);
  const atl = onlyBm();
  const proto = THREE.BatchedMesh.prototype.onBeforeRender;
  // A static_batch_x chunk bucket carrying its memo override (stand-in function).
  const chunk = new THREE.BatchedMesh(4, 16, 32, new THREE.MeshStandardMaterial());
  chunk.userData = { __staticBatchCrossLb: true, instances: 1 };
  const memoHook = function memoStandIn() {};
  chunk.onBeforeRender = memoHook;
  // A BatchedMesh that is no statics bucket at all, with a hook of its own.
  const other = new THREE.BatchedMesh(4, 16, 32, new THREE.MeshStandardMaterial());
  const otherHook = function otherStandIn() {};
  other.onBeforeRender = otherHook;
  s11.staticsGroup.add(chunk, other);
  const owns = (o) => Object.prototype.hasOwnProperty.call(o, "onBeforeRender");

  check("arm: the atlas bucket and the chunk bucket count as armed", armStatMergeSubmittedSampler(s11.staticsGroup).armed === 2);
  check("arm: the chunk's own override is left alone (never double-wrapped)", chunk.onBeforeRender === memoHook);
  check("arm: the atlas bucket is wrapped", owns(atl) && atl.onBeforeRender !== proto);
  const md = multidraw(atl);
  check("the wrapper counts the frame and delegates to three's rebuild",
    atl.userData.__projSubmitFrames === 1 && md.length === 2, `frames=${atl.userData.__projSubmitFrames} draws=${md.length}`);
  check("re-arming resets the count instead of wrapping twice",
    armStatMergeSubmittedSampler(s11.staticsGroup).armed === 2 && atl.userData.__projSubmitFrames === 0);
  const d = disarmStatMergeSubmittedSampler(s11.staticsGroup);
  check("disarm: only the hook the sampler installed is removed", d.disarmed === 1, `disarmed=${d.disarmed}`);
  check("disarm: the atlas bucket is back on the prototype method", !owns(atl) && atl.onBeforeRender === proto &&
    atl.userData.__projSubmitOrig === undefined);
  check("disarm: the chunk bucket KEEPS its memo/sphere override", owns(chunk) && chunk.onBeforeRender === memoHook);
  check("disarm: an unrelated BatchedMesh keeps its own hook", owns(other) && other.onBeforeRender === otherHook);
  check("a second disarm finds nothing of ours", disarmStatMergeSubmittedSampler(s11.staticsGroup).disarmed === 0 &&
    chunk.onBeforeRender === memoHook && other.onBeforeRender === otherHook);
  _resetStatAtlasForTest();
}

console.log(`\natlas_geom_dedup: ${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
