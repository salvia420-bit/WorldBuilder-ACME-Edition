// ?statArrayMerge (2026-08-06) — headless test for the GLOBAL array-texture
// layer pools (scene3d/static_array_pool.js) and the merged-bucket path in
// scene3d/static_batch_x.js.
//
// WHAT THIS DEFENDS. The batcher keys its region buckets by the MATERIAL
// OBJECT, so every distinct surface in a 3x3-LB region is its own draw. Measured
// at Nanto with a SUBMITTED-scale sampler (`__statMergeArmSubmitted`, which
// shadows `onBeforeRender`; every earlier figure counted a RESIDENT population
// and was ~3x too generous — do not quote 2.9 ms):
//
//     submitted BatchedMesh nodes: 128   (mergeable 60 + deformed 68)
//     MERGEABLE  60 -> regionStrict 35   = +1.00 ms
//     DEFORMED   68 -> regionStrict 43   = +1.00 ms
//     COMBINED  128 -> 78                = +2.00 ms
//
// This suite is about whether that collapse can be had without the ways it can
// go wrong — a prop wearing another surface's pixels, and a tree that stops
// swaying with nothing logged:
//
//   PART 1 — flag grammar, and OFF is byte-identical (nothing merges, no pool).
//   PART 2 — admission. Every rule that must reject falls back to today's
//            per-material bucket rather than losing the prop.
//   PART 3 — the collapse itself: many materials of one (tile, state, format)
//            in one region become ONE bucket with ONE shared material, and the
//            before/after census reports it.
//   PART 4 — pool keying fragments where it must: tile size, sidedness, depth
//            bias, opacity, emissive, shadow flags. Each of those is an image
//            difference if flattened (G10-G13 of the design study).
//   PART 5 — `aLayer`. The layer index reaches the batch's own buffer, distinct
//            surfaces get distinct layers, and the SHARED source geometry is
//            left byte-identical afterwards (no stray attribute for the legacy
//            batch / atlas / passthrough render to trip over).
//   PART 6 — **THE EVICTION PATH**, which is where this design lives or dies.
//            Geometry refcounts and layer refcounts are entangled: a layer may
//            outlive the landblock that supplied it and a geometry may be shared
//            across landblocks. One acquire, one release, released by the same
//            record that drops the geometry — so a layer can never be recycled
//            to another surface while a live geometry's `aLayer` addresses it.
//            Get this wrong and props render with someone else's pixels.
//   PART 7 — overflow and pool lifecycle: a full layer pool spills to a
//            per-material bucket (never a vanished prop), and a pool whose last
//            layer AND last bucket are gone is disposed.
//   PART 8 — the DEFORMED half, which is the LARGER half (68 of 128 submitted
//            buckets at Nanto). A pool material REPLACES its members', so a
//            windSwayGpu variant can only merge if its component set is
//            reproduced on the pool material. The set token is in the pool KEY,
//            so membership and material are ONE decision — the only shape that
//            cannot repeat the 2026-07-02 "trunk sways, foliage frozen" split.
//  PART 10 — growth. A pool doubles its layer depth in place (X7 semantics),
//            carries the live prefix AND its sampler state, and re-marks every
//            carried layer for upload — three uploads ONLY `layerUpdates` on a
//            fresh array, so an unmarked carried layer is GPU garbage.
//   PART 9 — the COMPOSITION PROOF, against the real `makeArrayMaterial` and the
//            real `windSwayGpu` component: chaining the VFX patch onto the array
//            material keeps BOTH the sampler2DArray injection and the sway, and
//            neither anchor is eaten by the other. This is the one that would
//            catch a silent freeze.
//
// Run:
//   cd apps/holtburger-web/
//   node test_stat_array_merge.mjs
// (needs `three` resolvable or THREE_PATH=/path/to/three.module.js)

import * as THREE from "three";
import {
  consolidateStaticSingletonsCrossLb,
  evictStaticBatchXForLb,
  getStatBatchXStats,
  setStatArrayMergeProvider,
  __setStatBatchChunkForTest,
  __setStatGeomDedupForTest,
  __resetStatBatchXForTest,
  stampStaticContentKeys,
} from "./scene3d/static_batch_x.js";
import {
  STAT_ARRAY_MERGE_PROVIDER,
  admitToArrayPool,
  statArrayMergeEnabled,
  __setStatArrayMergeForTest,
  __setStatArrayVfxHookForTest,
  _resetStatArrayPoolForTest,
  _statArrayPoolsForTest,
  getStatArrayPoolStats,
} from "./scene3d/static_array_pool.js";
import { makeArrayMaterial, _stateKeyOf } from "./scene3d/static_atlas.js";
import { installVfxComponentPatch, VFX_GLOBALS } from "./scene3d/materials.js";
import { windSwayGpu } from "./scene3d/vfx/components/windSwayGpu.js";

let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

console.log("?statArrayMerge — global array-pool merge of the cross-LB statics batcher");
console.log("=========================");

// --- fixtures --------------------------------------------------------------
// Statics singleton geometries are NON-indexed {position, normal, uv}
// (adapter.js meshToGeometryGroups) — model that exactly.
function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) pos.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
let _texSeq = 0;
function surfaceTex(w = 8, h = 8) {
  const t = new THREE.DataTexture(new Uint8Array(w * h * 4).fill(++_texSeq & 0xff), w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
function surfaceMat(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ metalness: 0 });
  m.map = opts.map || surfaceTex(opts.w ?? 8, opts.h ?? 8);
  m.userData.surfaceDid = opts.did ?? (0x08000000 + _texSeq);
  if (opts.apply) opts.apply(m);
  return m;
}
function node(mat, geom, lbId, x = 0, opts = {}) {
  const n = new THREE.Mesh(geom, mat);
  n.position.set(x, 0, 0);
  n.castShadow = opts.castShadow ?? false;
  n.receiveShadow = opts.receiveShadow ?? false;
  n.userData = { surfaceDid: mat.userData.surfaceDid, landblockId: lbId >>> 0 };
  return n;
}
const LB1 = 0x96960000 >>> 0, LB2 = 0x97970000 >>> 0; // (150,150) & (151,151) -> SAME 3x3 region
const LB3 = 0xccdd0000 >>> 0;                          // far region
const LB4 = 0x98980000 >>> 0;                          // (152,152) -> SAME 3x3 region as LB1/LB2

function freshScene() {
  __resetStatBatchXForTest();
  _resetStatArrayPoolForTest();
  return { staticsGroup: new THREE.Group() };
}
/** One LB feed of `n` distinct materials x 2 placements each (>=2 = batched). */
function feed(scene3d, lbId, mats, geomFor) {
  const nodes = [];
  for (let i = 0; i < mats.length; i++) {
    const g = geomFor ? geomFor(i) : triGeom(2);
    nodes.push(node(mats[i], g, lbId, i * 10));
    nodes.push(node(mats[i], g, lbId, i * 10 + 1));
  }
  return consolidateStaticSingletonsCrossLb(nodes, scene3d, lbId);
}
const mergedBuckets = (scene3d) => scene3d.staticsGroup.children.filter((c) => c.userData?.__statArrayMerged);
const legacyBuckets = (scene3d) => scene3d.staticsGroup.children.filter((c) => c.userData?.__staticBatchCrossLb && !c.userData?.__statArrayMerged);

__setStatBatchChunkForTest(true);

// ===========================================================================
console.log("\nPART 1 — flag grammar, and OFF is the untouched path");
// ===========================================================================
{
  __setStatArrayMergeForTest(undefined);
  check("1: bare (no ?statArrayMerge) reads OFF — this is too large to ship unmeasured",
    statArrayMergeEnabled() === false, `enabled=${statArrayMergeEnabled()}`);
  __setStatArrayMergeForTest(false);
  check("2: `admit` returns null when the flag is off, whatever the material",
    admitToArrayPool(surfaceMat(), node(surfaceMat(), triGeom(), LB1)) === null);

  const s = freshScene();
  setStatArrayMergeProvider(STAT_ARRAY_MERGE_PROVIDER);
  __setStatArrayMergeForTest(false);
  feed(s, LB1, [surfaceMat(), surfaceMat(), surfaceMat()]);
  check("3: flag OFF ⇒ three materials, three per-material buckets (legacy shape)",
    legacyBuckets(s).length === 3 && mergedBuckets(s).length === 0,
    `legacy=${legacyBuckets(s).length} merged=${mergedBuckets(s).length}`);
  check("4: flag OFF ⇒ not one pool allocated", _statArrayPoolsForTest().size === 0);
  const st = getStatBatchXStats();
  check("5: the census reports before === after when nothing merged",
    st.arrayMerge.all.before === 3 && st.arrayMerge.all.after === 3,
    `${st.arrayMerge.all.before} -> ${st.arrayMerge.all.after}`);
  check("6: `armed` says whether the provider is installed at all (0 ≠ 'nothing to merge')",
    st.arrayMerge.armed === true);
}

// ===========================================================================
console.log("\nPART 2 — admission: every rejection keeps today's bucket, never loses the prop");
// ===========================================================================
{
  __setStatArrayMergeForTest(true);
  const ok = surfaceMat();
  check("7: a plain textured MeshStandardMaterial is admitted",
    admitToArrayPool(ok, node(ok, triGeom(), LB1)) !== null);

  const cases = [
    ["a MeshBasic (wireframe mode routes here deliberately)", () => {
      const m = new THREE.MeshBasicMaterial(); m.map = surfaceTex(); m.userData = {}; return m;
    }],
    ["no map at all", () => { const m = new THREE.MeshStandardMaterial(); m.userData = {}; return m; }],
    ["a windSwayGpu DEFORMATION variant (the array material would freeze the sway)",
      () => surfaceMat({ apply: (m) => { m.userData.__vfxSetKey = "deformation.windSwayGpu"; } })],
    ["an emissiveMap (luminous surfaces carry their OWN diffuse map here — per-surface)",
      () => surfaceMat({ apply: (m) => { m.emissiveMap = m.map; } })],
    ["metalness > 0 (the array material fixes metalness 0; no free nra channel)",
      () => surfaceMat({ apply: (m) => { m.metalness = 0.5; } })],
    ["vertexColors", () => surfaceMat({ apply: (m) => { m.vertexColors = true; } })],
    ["flatShading", () => surfaceMat({ apply: (m) => { m.flatShading = true; } })],
    ["fog = false (additive parity; `fog` is program-affecting)",
      () => surfaceMat({ apply: (m) => { m.fog = false; } })],
    ["depthTest = false", () => surfaceMat({ apply: (m) => { m.depthTest = false; } })],
    ["an alphaMap", () => surfaceMat({ apply: (m) => { m.alphaMap = m.map; } })],
    ["a lightMap", () => surfaceMat({ apply: (m) => { m.lightMap = m.map; } })],
    ["a non-identity map repeat (three's map transform is a per-MATERIAL uniform)",
      () => surfaceMat({ apply: (m) => { m.map.repeat.set(2, 2); } })],
    ["a LINEAR map (the arrays decode sRGB in hardware — double decode otherwise)",
      () => surfaceMat({ apply: (m) => { m.map.colorSpace = THREE.NoColorSpace; } })],
    ["an aoMap whose intensity disagrees with the baked-in literal",
      () => surfaceMat({ apply: (m) => { m.aoMap = m.map; m.aoMapIntensity = 0.1; } })],
  ];
  let n = 8;
  for (const [why, make] of cases) {
    const m = make();
    check(`${n++}: rejected — ${why}`, admitToArrayPool(m, node(m, triGeom(), LB1)) === null);
  }

  // The rejection has to be a FALLBACK, not a drop.
  const s = freshScene();
  const good1 = surfaceMat(), good2 = surfaceMat();
  const bad = surfaceMat({ apply: (m) => { m.emissiveMap = m.map; } });
  feed(s, LB1, [good1, good2, bad]);
  check("22: an unadmitted material still gets its own per-material bucket",
    mergedBuckets(s).length === 1 && legacyBuckets(s).length === 1,
    `merged=${mergedBuckets(s).length} legacy=${legacyBuckets(s).length}`);
  const inst = s.staticsGroup.children.reduce((a, c) => a + (c.userData?.instances | 0), 0);
  check("23: and every placement is still submitted — 3 materials x 2 = 6 instances",
    inst === 6, `instances=${inst}`);
}

// ===========================================================================
console.log("\nPART 3 — the collapse, and the census that reports it");
// ===========================================================================
{
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  const mats = [surfaceMat(), surfaceMat(), surfaceMat(), surfaceMat(), surfaceMat()];
  feed(s, LB1, mats);
  check("24: five distinct surfaces of one (tile, state, format) ⇒ ONE merged bucket",
    mergedBuckets(s).length === 1 && legacyBuckets(s).length === 0,
    `merged=${mergedBuckets(s).length}`);
  check("25: ONE global pool, five layers", _statArrayPoolsForTest().size === 1 &&
    getStatArrayPoolStats().layers === 5, `pools=${_statArrayPoolsForTest().size} layers=${getStatArrayPoolStats().layers}`);
  const bm = mergedBuckets(s)[0];
  check("26: the bucket's material is the pool's shared array material",
    bm.material.userData.__statArrayPool === true && bm.material.userData.__statAtlasMat === true);
  const st = getStatBatchXStats();
  check("27: census — 5 buckets before, 1 after", st.arrayMerge.all.before === 5 && st.arrayMerge.all.after === 1,
    `${st.arrayMerge.all.before} -> ${st.arrayMerge.all.after}`);
  check("28: the same collapse over the DRAWN population (the one that pays)",
    st.arrayMerge.drawn.before === 5 && st.arrayMerge.drawn.after === 1,
    `${st.arrayMerge.drawn.before} -> ${st.arrayMerge.drawn.after}`);
  check("29: the pool census reports layer bytes — the global-vs-regional memory argument",
    typeof st.arrayMerge.pool.layerMB === "number" && st.arrayMerge.pool.layers === 5);
  check("30: instances submitted are UNCHANGED by merging — 5 x 2 placements",
    bm.userData.instances === 10, `instances=${bm.userData.instances}`);

  // The region key is KEPT: coarsening it measured 0.00 ms and was 1.1 ms WORSE
  // at div=12, because a merged bucket then straddles visible and invisible space.
  feed(s, LB3, [mats[0], mats[1]]);
  check("31: a FAR region gets its own BatchedMesh (the 3x3 region key is kept)",
    mergedBuckets(s).length === 2, `merged=${mergedBuckets(s).length}`);
  check("32: ...but shares the ONE global layer pool — arrays are never region-scoped",
    _statArrayPoolsForTest().size === 1 && getStatArrayPoolStats().layers === 5,
    `pools=${_statArrayPoolsForTest().size} layers=${getStatArrayPoolStats().layers}`);
  check("33: and shares its material, so the two region buckets sort adjacent",
    mergedBuckets(s)[0].material === mergedBuckets(s)[1].material);
  check("34: same LB feeding the same region again reuses the bucket, not a new one",
    (feed(s, LB2, [surfaceMat()]), mergedBuckets(s).length === 2), `merged=${mergedBuckets(s).length}`);
}

// ===========================================================================
console.log("\nPART 4 — the key fragments exactly where flattening would change the image");
// ===========================================================================
{
  const axes = [
    ["tile size (texStorage3D fixes w,h,depth at allocation)", () => surfaceMat({ w: 16, h: 16 })],
    ["sidedness (`?perPolyCull` splits it deliberately)", () => surfaceMat({ apply: (m) => { m.side = THREE.DoubleSide; } })],
    ["depth bias (staticBias/floorBias exist for nothing else — flattening is z-fighting)",
      () => surfaceMat({ apply: (m) => { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -1; } })],
    ["opacity (per-surface translucency; absent from `_stateKeyOf`)",
      () => surfaceMat({ apply: (m) => { m.opacity = 0.5; m.transparent = true; } })],
    ["emissive (the Luminosity term the atlas material drops)",
      () => surfaceMat({ apply: (m) => { m.emissive.setHex(0x223344); } })],
    ["diffuse tint", () => surfaceMat({ apply: (m) => { m.color.setHex(0x884422); } })],
    ["alphaTest ref (retail's per-format ClipMap ref, verbatim)",
      () => surfaceMat({ apply: (m) => { m.alphaTest = 100 / 255; } })],
    ["wrap mode (a WRAP member in a CLAMP bucket samples the wrong texels)",
      () => surfaceMat({ apply: (m) => { m.map.wrapS = THREE.RepeatWrapping; } })],
  ];
  let n = 35;
  for (const [why, make] of axes) {
    const s = freshScene();
    __setStatArrayMergeForTest(true);
    feed(s, LB1, [surfaceMat(), make()]);
    check(`${n++}: splits on ${why}`, mergedBuckets(s).length === 2,
      `merged=${mergedBuckets(s).length}`);
  }
  // Node-level flags, not material properties — but they are per-BUCKET in three
  // and the depth-only shadow pass ignores opacity, so flattening changes the image.
  {
    const s = freshScene();
    __setStatArrayMergeForTest(true);
    const a = surfaceMat(), b = surfaceMat();
    const g = triGeom(2);
    const nodes = [
      node(a, g, LB1, 0), node(a, g, LB1, 1),
      node(b, g, LB1, 2, { castShadow: true }), node(b, g, LB1, 3, { castShadow: true }),
    ];
    consolidateStaticSingletonsCrossLb(nodes, s, LB1);
    check(`${n++}: splits on castShadow`, mergedBuckets(s).length === 2,
      `merged=${mergedBuckets(s).length}`);
    check(`${n++}: ...and each bucket carries its own flag`,
      mergedBuckets(s).some((x) => x.castShadow) && mergedBuckets(s).some((x) => !x.castShadow));
  }
}

// ===========================================================================
console.log("\nPART 5 — `aLayer`: it reaches the batch, it is distinct, it does not linger");
// ===========================================================================
{
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  const g1 = triGeom(2), g2 = triGeom(2);
  const m1 = surfaceMat(), m2 = surfaceMat();
  consolidateStaticSingletonsCrossLb(
    [node(m1, g1, LB1, 0), node(m1, g1, LB1, 1), node(m2, g2, LB1, 2), node(m2, g2, LB1, 3)], s, LB1);
  const bm = mergedBuckets(s)[0];
  const aL = bm.geometry.getAttribute("aLayer");
  check("47: the merged BatchedMesh's own buffer carries an aLayer attribute", !!aL && aL.itemSize === 1);
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(aL.array[i]);
  check("48: the two surfaces landed on DIFFERENT layers", seen.size === 2, `layers=${[...seen].join(",")}`);
  check("49: layer 0 and layer 1 — allocated in feed order from the pool",
    seen.has(0) && seen.has(1));
  check("50: the SHARED source geometry is left byte-identical — no stray aLayer for the legacy batch / atlas / passthrough render to trip over",
    !g1.getAttribute("aLayer") && !g2.getAttribute("aLayer"));
  check("51: ...and its position/normal/uv are untouched",
    g1.attributes.position.count === 6 && Object.keys(g1.attributes).length === 3);
}

// ===========================================================================
console.log("\nPART 6 — EVICTION: geometry refcounts and layer refcounts, entangled");
// ===========================================================================
{
  // 6a — a layer OUTLIVES the landblock that supplied it.
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  __setStatGeomDedupForTest(false);
  const shared = surfaceMat();
  const only1 = surfaceMat();
  const keeper = surfaceMat();
  feed(s, LB1, [shared, only1]);
  feed(s, LB2, [shared, keeper]);    // same region, same pool, SAME surface
  check("52: one pool, three layers over two LBs (the shared surface is deduped)",
    getStatArrayPoolStats().layers === 3, `layers=${getStatArrayPoolStats().layers}`);
  const poolA = [..._statArrayPoolsForTest().values()][0];
  const sharedLayer = poolA.layerOf.get(shared.map.uuid).layer;
  check("53: the shared surface's layer is refcounted across landblocks — refs=2",
    poolA.layerOf.get(shared.map.uuid).refs === 2);

  evictStaticBatchXForLb(LB1);
  check("54: LB1 leaves — the shared layer SURVIVES on LB2's reference",
    poolA.layerOf.has(shared.map.uuid) && poolA.layerOf.get(shared.map.uuid).refs === 1);
  check("55: ...and LB1's own surface's layer is freed and recycled",
    !poolA.layerOf.has(only1.map.uuid) && poolA.freeLayers.length === 1,
    `free=${poolA.freeLayers.length}`);
  check("56: the layer index the batch's live aLayer still addresses was NOT recycled",
    !poolA.freeLayers.includes(sharedLayer), `sharedLayer=${sharedLayer} free=[${poolA.freeLayers}]`);

  // A NEW surface must take the RECYCLED index, not the live one. Fed into a
  // DIFFERENT region so LB2's own membership is not re-fed — the pool is global,
  // the buckets are not, and this is the case that proves it.
  const fresh = surfaceMat();
  const recycled = poolA.freeLayers[0];
  feed(s, LB3, [fresh]);
  check("57: a new surface in another region takes the recycled index — the GLOBAL pool does not grow",
    poolA.layerOf.get(fresh.map.uuid)?.layer === recycled &&
    getStatArrayPoolStats().layers === 3,
    `fresh=${poolA.layerOf.get(fresh.map.uuid)?.layer} recycled=${recycled} live=${sharedLayer}`);

  evictStaticBatchXForLb(LB3);
  evictStaticBatchXForLb(LB2);
  const st = getStatBatchXStats();
  check("58: every LB gone ⇒ every layer ref released — held === released",
    st.arrayMerge.layerRefsHeld === st.arrayMerge.layerRefsReleased &&
    st.arrayMerge.layerRefsHeld > 0,
    `held=${st.arrayMerge.layerRefsHeld} released=${st.arrayMerge.layerRefsReleased}`);
  check("59: ...the pool is empty and disposed, and the buckets are reaped",
    _statArrayPoolsForTest().size === 0 && mergedBuckets(s).length === 0,
    `pools=${_statArrayPoolsForTest().size} buckets=${mergedBuckets(s).length}`);
}
{
  // 6b — THE HARD CASE. ?statGeomDedup shares ONE geometry across landblocks;
  // its `aLayer` is baked into the batch's buffer once. The layer must not be
  // recycled while the geometry lives, even though the LB that first added both
  // has gone.
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  __setStatGeomDedupForTest(true);
  const mat = surfaceMat();
  const other = surfaceMat();
  // Two landblocks in ONE region, each with its OWN decode of the same model —
  // which is exactly what the content key exists to recognise.
  const mk = () => { const g = triGeom(2); stampStaticContentKeys(0x0100, [{ geometry: g, surfaceDid: mat.userData.surfaceDid, doubleSided: false }]); return g; };
  const gA = mk(), gB = mk();
  consolidateStaticSingletonsCrossLb([node(mat, gA, LB1, 0), node(mat, gA, LB1, 1), node(other, triGeom(2), LB1, 2), node(other, triGeom(2), LB1, 3)], s, LB1);
  consolidateStaticSingletonsCrossLb([node(mat, gB, LB2, 4), node(mat, gB, LB2, 5)], s, LB2);
  const pool = [..._statArrayPoolsForTest().values()][0];
  const bm = mergedBuckets(s)[0];
  // LB1 contributed three geometry ids (gA plus `other`'s two unstamped decodes);
  // LB2's gB is a content-key HIT, so it adds none.
  check("60: the second LB's decode reused the FIRST LB's geometry id (content-key dedup)",
    bm.userData.dedupGids.size === 1 && bm.userData.gidVerts.size === 3,
    `dedup=${bm.userData.dedupGids.size} gids=${bm.userData.gidVerts.size}`);
  const layer = pool.layerOf.get(mat.map.uuid).layer;
  check("61: and it took a SECOND layer reference even though it added no geometry",
    pool.layerOf.get(mat.map.uuid).refs === 2, `refs=${pool.layerOf.get(mat.map.uuid).refs}`);

  evictStaticBatchXForLb(LB1);
  check("62: LB1 leaves — the shared GEOMETRY survives on LB2's reference (its own two go)",
    bm.userData.dedupGids.size === 1 && bm.userData.gidVerts.size === 1,
    `dedup=${bm.userData.dedupGids.size} gids=${bm.userData.gidVerts.size}`);
  check("63: ...and so does the layer its vertices address (refs 2 -> 1, not freed)",
    pool.layerOf.has(mat.map.uuid) && pool.layerOf.get(mat.map.uuid).refs === 1 &&
    !pool.freeLayers.includes(layer),
    `refs=${pool.layerOf.get(mat.map.uuid)?.refs} free=[${pool.freeLayers}]`);
  check("64: `other`'s layer WAS freed with LB1 — so there is a recycled index on offer",
    pool.freeLayers.length === 1, `free=[${pool.freeLayers}]`);
  // THE failure this rules out: a new surface stealing the live geometry's layer.
  // Fed from a THIRD landblock in the SAME region (LB4 -> (152,152) -> region
  // 50x50, like LB1/LB2) so LB2's own membership is not re-fed out from under it.
  const intruder = surfaceMat();
  consolidateStaticSingletonsCrossLb([node(intruder, triGeom(2), LB4, 6), node(intruder, triGeom(2), LB4, 7)], s, LB4);
  check("65: a NEW surface cannot be handed the layer a live geometry still addresses — the 'props wear another surface's pixels' failure",
    pool.layerOf.get(intruder.map.uuid)?.layer !== layer,
    `intruder=${pool.layerOf.get(intruder.map.uuid)?.layer} live=${layer}`);
  check("66: ...it took the RECYCLED index instead, and the pool did not grow",
    pool.nextLayer === 2 && pool.freeLayers.length === 0,
    `nextLayer=${pool.nextLayer} free=[${pool.freeLayers}]`);

  evictStaticBatchXForLb(LB2);
  evictStaticBatchXForLb(LB4);
  const st2 = getStatBatchXStats();
  check("67: after the last LB, geometry and layers release together — held === released",
    st2.arrayMerge.layerRefsHeld === st2.arrayMerge.layerRefsReleased,
    `held=${st2.arrayMerge.layerRefsHeld} released=${st2.arrayMerge.layerRefsReleased}`);
  check("68: ...pool disposed, buckets reaped, nothing left resident",
    _statArrayPoolsForTest().size === 0 && mergedBuckets(s).length === 0);
  __setStatGeomDedupForTest(false);
}
{
  // 6c — re-feed idempotence. A re-bake of an already-fed LB excises its previous
  // contribution first; the layer refs must go with it or they ratchet.
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  const mats = [surfaceMat(), surfaceMat()];
  for (let i = 0; i < 5; i++) feed(s, LB1, mats);
  const pool = [..._statArrayPoolsForTest().values()][0];
  check("69: five re-feeds of one LB leave two layers, not ten",
    getStatArrayPoolStats().layers === 2, `layers=${getStatArrayPoolStats().layers}`);
  check("70: ...and the refcounts do not ratchet",
    [...pool.layerOf.values()].every((e) => e.refs === 1),
    `refs=[${[...pool.layerOf.values()].map((e) => e.refs)}]`);
  check("71: ...and instances do not duplicate — 2 surfaces x 2 placements",
    mergedBuckets(s)[0].userData.instances === 4, `instances=${mergedBuckets(s)[0].userData.instances}`);
  evictStaticBatchXForLb(LB1);
  check("72: the pool drains to empty", _statArrayPoolsForTest().size === 0);
}

// ===========================================================================
console.log("\nPART 7 — overflow and pool lifecycle: fail-soft, never a vanished prop");
// ===========================================================================
{
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  // `_layerCapacityFor` caps a pool at `_ATLAS_NRA_MAX_LAYERS` (128 with the nra
  // twin live). Feed more distinct surfaces of one class than that and watch the
  // overflow land on today's path rather than on the floor.
  const N = 140;
  const mats = [];
  for (let i = 0; i < N; i++) mats.push(surfaceMat());
  feed(s, LB1, mats);
  const pool = [..._statArrayPoolsForTest().values()][0];
  const cap = pool.capacity;
  const ps = getStatArrayPoolStats();
  check("73: the pool stopped at its byte-budgeted CEILING, it did not grow past it",
    ps.layers === cap && cap < N, `layers=${ps.layers} capacity=${cap}`);
  check("74: the overflow SPILLED rather than being lost", ps.spillLayerFull === N - cap,
    `spillLayerFull=${ps.spillLayerFull}`);
  check("75: every spilled surface kept its own per-material bucket",
    legacyBuckets(s).length === N - cap, `legacy=${legacyBuckets(s).length}`);
  const inst = s.staticsGroup.children.reduce((a, c) => a + (c.userData?.instances | 0), 0);
  check(`76: and every single placement is still submitted — ${N} x 2`, inst === N * 2, `instances=${inst}`);

  evictStaticBatchXForLb(LB1);
  check("77: eviction drains both populations — no bucket, no pool, no leak",
    s.staticsGroup.children.filter((c) => c.userData?.__staticBatchCrossLb).length === 0 &&
    _statArrayPoolsForTest().size === 0);
  const st = getStatBatchXStats();
  check("78: bucketsCreated - bucketsReaped === 0 (the 2026-08-03 leak shape)",
    st.bucketsCreated - st.bucketsReaped === 0, `${st.bucketsCreated} - ${st.bucketsReaped}`);
  check("79: layer refs balance after the whole session",
    st.arrayMerge.layerRefsHeld === st.arrayMerge.layerRefsReleased,
    `held=${st.arrayMerge.layerRefsHeld} released=${st.arrayMerge.layerRefsReleased}`);
}
{
  // A pool must NOT be disposed while a region still holds a bucket on it, even
  // with zero live layers — that is the transient between a last release and a reap.
  const s = freshScene();
  __setStatArrayMergeForTest(true);
  feed(s, LB1, [surfaceMat(), surfaceMat()]);
  const pool = [..._statArrayPoolsForTest().values()][0];
  check("80: the pool tracks its region buckets", pool.buckets.size === 1);
  feed(s, LB3, [surfaceMat()]);
  check("81: a second region attaches to the SAME pool", pool.buckets.size === 2);
  evictStaticBatchXForLb(LB3);
  check("82: one region leaves — the pool survives for the other",
    _statArrayPoolsForTest().size === 1 && pool.buckets.size === 1);
  evictStaticBatchXForLb(LB1);
  check("83: the last region leaves — the pool disposes its arrays and material",
    _statArrayPoolsForTest().size === 0);
}

// ===========================================================================
console.log("\nPART 8 — the DEFORMED half: a variant material merges only if its set is reproduced");
// ===========================================================================
{
  const swayMat = (extra) => surfaceMat({ apply: (m) => { m.userData.__vfxSetKey = "deformation.windSwayGpu"; if (extra) extra(m); } });

  // No hook installed => exactly the atlas's `ptDeformed` behaviour: keep out.
  {
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest(null);
    feed(sc, LB1, [swayMat(), swayMat()]);
    check("84: no VFX hook installed ⇒ a variant material is REJECTED, not merged blind",
      mergedBuckets(sc).length === 0 && legacyBuckets(sc).length === 2,
      `merged=${mergedBuckets(sc).length} legacy=${legacyBuckets(sc).length}`);
    check("85: ...and the reason is counted as a VFX reject, not as a mystery",
      getStatArrayPoolStats().rejectVfxUnsafe === 2, `rejectVfxUnsafe=${getStatArrayPoolStats().rejectVfxUnsafe}`);
  }

  // A hook that CAN reproduce the set: the population merges.
  let decorated = 0;
  const goodHook = {
    tokenFor: (m) => {
      const k = m.userData?.__vfxSetKey;
      if (typeof k !== "string" || k === "") return null;
      return { token: k + "#cfg0", setKey: k, entries: [] };
    },
    decorate: (poolMat, token) => {
      decorated += 1;
      poolMat.userData.__vfxSetKey = token.setKey;
      // Stand-in for the real chained inject: what is under test here is that
      // the pool material ends up carrying the set and that its program key
      // says so. The chaining itself is materials.js `_chainBeforeCompile`.
      return true;
    },
  };
  {
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest(goodHook);
    decorated = 0;
    feed(sc, LB1, [swayMat(), swayMat(), swayMat()]);
    check("86: three sway surfaces of one class ⇒ ONE merged bucket (the larger half of the prize)",
      mergedBuckets(sc).length === 1 && legacyBuckets(sc).length === 0,
      `merged=${mergedBuckets(sc).length} legacy=${legacyBuckets(sc).length}`);
    check("87: the set was installed on the pool material EXACTLY once — per pool, not per member",
      decorated === 1 && getStatArrayPoolStats().vfxPools === 1, `decorated=${decorated}`);
    const bm = mergedBuckets(sc)[0];
    check("88: the pool material carries the set — which is also what keeps three's depth material off our onBeforeCompile (vfx/shadow_guard)",
      bm.material.userData.__vfxSetKey === "deformation.windSwayGpu");
    check("89: the program-cache key composes BOTH discriminators — the array variant AND the set",
      /statAtlasArrayMat/.test(bm.material.customProgramCacheKey()) &&
      bm.material.customProgramCacheKey().includes("|vdeformation.windSwayGpu"),
      bm.material.customProgramCacheKey());
  }

  // THE INVARIANT: a bucket can never hold a member whose variant its material
  // does not carry, because the set is in the key.
  {
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest(goodHook);
    feed(sc, LB1, [swayMat(), surfaceMat()]);
    check("90: a sway surface and a PLAIN surface of the same class never share a bucket",
      mergedBuckets(sc).length === 2, `merged=${mergedBuckets(sc).length}`);
    check("91: ...and they are two pools with two materials, not one material two ways",
      _statArrayPoolsForTest().size === 2 &&
      mergedBuckets(sc)[0].material !== mergedBuckets(sc)[1].material);
  }
  {
    // Same set, DIFFERENT config: component config rides UNIFORMS bound at
    // compile time from whichever member built the pool, so it must split too.
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest({
      tokenFor: (m) => {
        const k = m.userData?.__vfxSetKey;
        if (typeof k !== "string" || k === "") return null;
        return { token: k + "#" + (m.userData.__cfg ?? "a"), setKey: k, entries: [] };
      },
      decorate: (poolMat, token) => { poolMat.userData.__vfxSetKey = token.setKey; return true; },
    });
    feed(sc, LB1, [swayMat(), swayMat((m) => { m.userData.__cfg = "b"; })]);
    check("92: the same set with a DIFFERENT config splits — config is bound per material, not per instance",
      mergedBuckets(sc).length === 2, `merged=${mergedBuckets(sc).length}`);
  }

  // A set the hook refuses (e.g. a "frag" component whose fragment seam the
  // array material has already consumed) must keep its own bucket.
  {
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest({ tokenFor: () => false, decorate: () => true });
    feed(sc, LB1, [swayMat(), swayMat()]);
    check("93: a set the hook cannot reproduce (frag seam consumed) is REJECTED, never merged inert",
      mergedBuckets(sc).length === 0 && legacyBuckets(sc).length === 2,
      `merged=${mergedBuckets(sc).length} legacy=${legacyBuckets(sc).length}`);
  }

  // Decoration failing AFTER the pool starts must tear the pool down. A
  // sway-less pool would render its members frozen with nothing logged.
  {
    const sc = freshScene();
    __setStatArrayMergeForTest(true);
    __setStatArrayVfxHookForTest({
      tokenFor: (m) => (m.userData?.__vfxSetKey ? { token: "t", setKey: m.userData.__vfxSetKey, entries: [] } : null),
      decorate: () => false,
    });
    feed(sc, LB1, [swayMat(), swayMat()]);
    check("94: a FAILED decoration tears the half-built pool down — a sway-less pool must never ship",
      _statArrayPoolsForTest().size === 0 && mergedBuckets(sc).length === 0 &&
      legacyBuckets(sc).length === 2,
      `pools=${_statArrayPoolsForTest().size} legacy=${legacyBuckets(sc).length}`);
    const ps = getStatArrayPoolStats();
    // Once per GROUP that tried (two materials here) — a failed pool is never
    // cached, so each group re-attempts and each attempt is counted.
    check("95: ...and it is counted, not silent", ps.vfxDecorateFailed === 2 && ps.spillGrowFail === 2,
      `failed=${ps.vfxDecorateFailed} spill=${ps.spillGrowFail}`);
  }
  __setStatArrayVfxHookForTest(null);
}

// ===========================================================================
console.log("\nPART 9 — composition proof: the REAL array material + the REAL windSwayGpu");
// ===========================================================================
{
  // The MeshStandard vertex/fragment seams `makeArrayMaterial` and a MECH-B
  // component both splice, in the order three presents them to onBeforeCompile
  // (i.e. BEFORE #include resolution — which is why makeArrayMaterial swaps at
  // the directive level and not on expanded source).
  const fakeShader = () => ({
    uniforms: {},
    vertexShader: [
      "#include <common>",
      "void main() {",
      "#include <uv_vertex>",
      "#include <begin_vertex>",
      "#include <project_vertex>",
      "}",
    ].join("\n"),
    fragmentShader: [
      "#include <common>",
      "void main() {",
      "#include <map_fragment>",
      "#include <roughnessmap_fragment>",
      "#include <normal_fragment_maps>",
      "#include <aomap_fragment>",
      "}",
    ].join("\n"),
  });

  const plainMat = new THREE.MeshStandardMaterial();
  plainMat.map = surfaceTex();
  const stateKey = _stateKeyOf(plainMat);
  const diff = { isTexture: true }, nra = { isTexture: true };

  // 9a — array material alone.
  {
    const m = makeArrayMaterial(diff, stateKey, nra, { diff, nra });
    const sh = fakeShader();
    m.onBeforeCompile.call(m, sh);
    check("96: the array material injects the layer attribute and the sampler2DArray",
      sh.vertexShader.includes("attribute float aLayer") &&
      sh.fragmentShader.includes("uniform sampler2DArray uDiffuseArray"));
    check("97: ...and it LEAVES `#include <begin_vertex>` intact — the only anchor a MECH-B component needs",
      sh.vertexShader.includes("#include <begin_vertex>"));
    check("98: ...and `#include <common>` too, which is where a component declares its uniforms",
      sh.vertexShader.includes("#include <common>"));
    check("99: ...while it CONSUMES four FRAGMENT includes — the reason a 'frag' component cannot ride along",
      !sh.fragmentShader.includes("#include <map_fragment>") &&
      !sh.fragmentShader.includes("#include <roughnessmap_fragment>") &&
      !sh.fragmentShader.includes("#include <normal_fragment_maps>") &&
      !sh.fragmentShader.includes("#include <aomap_fragment>"));
  }

  // 9b — array material + the real windSwayGpu, chained exactly as statics.js
  // installs it. BOTH effects must be present in the ONE compiled shader.
  {
    const m = makeArrayMaterial(diff, stateKey, nra, { diff, nra });
    const arrayKey = m.customProgramCacheKey();
    installVfxComponentPatch(m, windSwayGpu, windSwayGpu.defaults, VFX_GLOBALS);
    const sh = fakeShader();
    m.onBeforeCompile.call(m, sh);
    check("100: the array sampler SURVIVED the chain — the batch still reads its layer",
      sh.vertexShader.includes("attribute float aLayer") &&
      sh.fragmentShader.includes("uniform sampler2DArray uDiffuseArray") &&
      sh.fragmentShader.includes("textureGrad( uDiffuseArray"));
    check("101: ...and so did the SWAY — `transformed` is displaced in the same vertex shader",
      sh.vertexShader.includes("transformed.x += _wsDisp.x") &&
      sh.vertexShader.includes("transformed.y += _wsDisp.y"),
      "the silent-freeze failure this whole gate exists to prevent");
    check("102: the sway reads the per-instance hash under three's BATCHING define — sway survives batching",
      /USE_BATCHING/.test(sh.vertexShader) && sh.vertexShader.includes("vVfxHash"));
    check("103: the component's uniforms were bound, and the shared VFX clock is bound BY REFERENCE",
      sh.uniforms.uWindAmp !== undefined && sh.uniforms.uTime === VFX_GLOBALS.uTime);
    check("104: the array uniform is bound alongside them — one material, both jobs",
      sh.uniforms.uDiffuseArray?.value === diff && sh.uniforms.uNraArray?.value === nra);
    // `_chainBeforeCompile` OVERWRITES customProgramCacheKey with materials.js's
    // own patch-set key, which knows nothing about the array variant. Left alone,
    // the wrap and clamp array programs would collapse onto one another.
    check("105: chaining CLOBBERS the array variant's program key — which is why the pool re-composes it",
      m.customProgramCacheKey() !== arrayKey,
      `${arrayKey} -> ${m.customProgramCacheKey()}`);
    m.userData.__vfxSetKey = windSwayGpu.id;
    const composed = `${arrayKey}|v${m.userData.__vfxSetKey}`;
    check("106: ...and the re-composed key separates BOTH axes (array variant x VFX set)",
      composed.includes("statAtlasArrayMat") && composed.includes("|vdeformation.windSwayGpu"),
      composed);
  }

  // 9c — the recompile case. three re-runs onBeforeCompile whenever the program
  // cache key changes (a light-count change is enough); the injection must be
  // idempotent or the second pass would double-splice the sway.
  {
    const m = makeArrayMaterial(diff, stateKey, nra, { diff, nra });
    installVfxComponentPatch(m, windSwayGpu, windSwayGpu.defaults, VFX_GLOBALS);
    const sh = fakeShader();
    m.onBeforeCompile.call(m, sh);
    const once = sh.vertexShader;
    const sh2 = fakeShader();
    m.onBeforeCompile.call(m, sh2);
    check("107: a RECOMPILE produces the same vertex shader — the splice is idempotent",
      sh2.vertexShader === once);
  }
}

// ===========================================================================
console.log("\nPART 10 — growth: the live prefix, the sampler state, and the re-mark");
// ===========================================================================
{
  const sc = freshScene();
  __setStatArrayMergeForTest(true);
  __setStatArrayVfxHookForTest(null);
  // Anisotropy is in the strict key, so it must also be REPLICATED — otherwise a
  // surface authored at 16 goes blurry the moment it joins a shared array.
  const first = surfaceMat({ apply: (m) => { m.map.anisotropy = 8; m.map.magFilter = THREE.NearestFilter; } });
  const rest = [];
  for (let i = 0; i < 9; i++) rest.push(surfaceMat({ apply: (m) => { m.map.anisotropy = 8; m.map.magFilter = THREE.NearestFilter; } }));
  feed(sc, LB1, [first]);
  const pool = [..._statArrayPoolsForTest().values()][0];
  const startAlloc = pool.allocLayers;
  check("108: the pool replicated the member's sampler state onto its array",
    pool.diffArray.anisotropy === 8 && pool.diffArray.magFilter === THREE.NearestFilter,
    `aniso=${pool.diffArray.anisotropy} mag=${pool.diffArray.magFilter}`);
  check("109: X7 semantics — it allocated a handful of layers, not its whole ceiling",
    startAlloc < pool.capacity, `alloc=${startAlloc} capacity=${pool.capacity}`);
  // Record the first layer's bytes so the growth copy can be checked byte-for-byte.
  const stride = pool.w * pool.h * 4;
  const before = pool.diffArray.image.data.slice(0, stride);

  feed(sc, LB2, rest);
  check("110: it GREW rather than spilling — the ceiling was never the constraint",
    pool.allocLayers > startAlloc && getStatArrayPoolStats().layers === 10 &&
    getStatArrayPoolStats().spillLayerFull === 0,
    `alloc=${startAlloc} -> ${pool.allocLayers} layers=${getStatArrayPoolStats().layers}`);
  check("111: the first surface's texels survived the reallocation byte for byte",
    Buffer.from(pool.diffArray.image.data.slice(0, stride)).equals(Buffer.from(before)));
  check("112: ...and the sampler state came with them (a pool must not go blurry when it gets busy)",
    pool.diffArray.anisotropy === 8 && pool.diffArray.magFilter === THREE.NearestFilter,
    `aniso=${pool.diffArray.anisotropy} mag=${pool.diffArray.magFilter}`);
  check("113: every carried-over layer is RE-MARKED — three uploads only `layerUpdates` on a fresh array",
    pool.diffArray.layerUpdates instanceof Set && pool.diffArray.layerUpdates.size === 10,
    `marked=${pool.diffArray.layerUpdates?.size}`);
  check("114: the nra twin grew in lockstep — one layer index addresses both arrays",
    pool.nraArray && pool.nraArray.image.depth === pool.diffArray.image.depth,
    `diff=${pool.diffArray.image.depth} nra=${pool.nraArray?.image?.depth}`);
  check("115: the pool material's array uniforms were re-pointed at the NEW arrays",
    pool.arrays.diff === pool.diffArray && pool.arrays.nra === pool.nraArray);
  check("116: the growth is counted, and nothing was refused",
    getStatArrayPoolStats().layerGrows > 0 && getStatArrayPoolStats().layerGrowFails === 0,
    `grows=${getStatArrayPoolStats().layerGrows}`);

  evictStaticBatchXForLb(LB1);
  evictStaticBatchXForLb(LB2);
  const st = getStatBatchXStats();
  check("117: and it all drains — pool gone, refs balanced",
    _statArrayPoolsForTest().size === 0 &&
    st.arrayMerge.layerRefsHeld === st.arrayMerge.layerRefsReleased,
    `held=${st.arrayMerge.layerRefsHeld} released=${st.arrayMerge.layerRefsReleased}`);
}

// ===========================================================================
console.log("\n=========================");
console.log(`?statArrayMerge: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
