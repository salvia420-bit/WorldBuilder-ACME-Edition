// tests/nra_source_res.test.mjs
//
// memory-1 (2026-10-20 improvement hunt, `?nraSourceRes`, DEFAULT-ON, `=off|0|
// false|no` escape) — the statics-atlas nra array (and its static_array_pool.js
// twin) is sized at its member's PLANE resolution, not at the diffuse's.
//
// THE DEFECT. On BPTC hardware `mat.map` is the x4 Remacri BC7 full tier, so a
// DAT-64 surface made a 256² bucket and its nra array was allocated at 256² as
// well, while the planes packed into it (wasm Sobel normal, seam height,
// texchan roughness/AO) are DAT size: `_liftChannel` filled every layer with 16
// nearest-neighbour copies of each real texel. 150.9 MB of nra arrays measured
// on the 1070 at Nanto, ~97% of it in f7 buckets.
//
//   N1  flag grammar (default ON, the family's off-forms disarm, typo = ON).
//   N2  `_nraDimsFor`: max over the planes, clamped to the diffuse; no
//       normal/height plane ⇒ the diffuse dims (the defined key); flag off or
//       nra off ⇒ the diffuse dims.
//   N3  key + arithmetic: the `|n` field is appended only when the sizes
//       differ, LAST; every default-argument call returns the pre-memory-1
//       value (keys, per-layer bytes, capacity, start depth).
//   N4  THE CLAIM: a BC7 bucket with w=256 and a 64² normalMap gets a 64² nra
//       array, 64*64*4 bytes per layer, and every texel equals today's NN
//       layer sampled at the 4x4 block centre (in fact all 16 texels of the
//       block — the NN lift held nothing else).
//   N5  `?nraSourceRes=off` is byte-identical to today: same key, same array
//       dims, depth and bytes, same capacity.
//   N6  growth carries the nra prefix at the nra stride (layer 0 intact,
//       re-marked, array still 64²).
//   N7  the async texchan re-pack (`_drainNraPending`) packs at the nra size.
//   N8  static_array_pool.js twin: pool key, pool nra dims, packed bytes; and
//       `=off` restores the old pool key and dims.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/nra_source_res.test.mjs

import * as THREE from "three";
import {
  _resetStatAtlasForTest,
  _statAtlasBucketsForTest,
  _statAtlasStatsForTest,
  addSingletonsToCrossLbAtlas,
  tickStatAtlasOptimize,
  nraSourceResEnabled,
  _nraDimsFor,
  _bucketKeyFor,
  _nraKeyToken,
  _perLayerBytesFor,
  _layerCapacityFor,
  _atlasStartLayersFor,
  buildNraArray,
  packNraLayer,
  _stateKeyOf,
} from "../scene3d/static_atlas.js";
import { _setBc7SupportForTest, bc7LevelBytes } from "../scene3d/bc7_textures.js";
import {
  __setStatArrayMergeForTest,
  admitToArrayPool,
  acquireArrayPoolLayer,
  _resetStatArrayPoolForTest,
} from "../scene3d/static_array_pool.js";
import { aoMapIntensityValue } from "../scene3d/vfx_flags.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

_setBc7SupportForTest(true); // a BPTC GPU (the 1070), so f7 buckets exist

let seed = 0x1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;

/** RGBA8 (or 1-channel) DataTexture of random bytes — a DAT-size plane. */
function plane(w, h, stride = 4) {
  const d = new Uint8Array(w * h * stride);
  for (let i = 0; i < d.length; i++) d[i] = rnd();
  const t = new THREE.DataTexture(d, w, h, stride === 1 ? THREE.RedFormat : THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** A BC7 full-tier map exactly as `isBc7AtlasTexture` accepts it. */
function bc7Map(w, h) {
  const data = new Uint8Array(bc7LevelBytes(w, h));
  for (let i = 0; i < data.length; i++) data[i] = rnd();
  const t = new THREE.CompressedTexture([{ data, width: w, height: h }], w, h, THREE.RGBA_BPTC_Format);
  t.needsUpdate = true;
  return t;
}

/** The atlased material: x4 BC7 diffuse over DAT-size planes. */
function hdMat(W = 256, N = 64, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ map: bc7Map(W, W) });
  if (opts.normal !== false) mat.normalMap = plane(N, N, 4);
  if (opts.rough !== false) mat.roughnessMap = plane(N, N, 4);
  if (opts.ao !== false) { mat.aoMap = plane(N, N, 1); mat.aoMapIntensity = aoMapIntensityValue(); }
  mat.roughness = 0.8;
  mat.userData.normalScaleEffective = 0.9;
  return mat;
}

function node(mat, lb = 0xaabb0000) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  const m = new THREE.Mesh(geom, mat);
  m.userData.landblockId = lb;
  return m;
}

const fakeScene3d = { staticsGroup: { add() {} } };

/** Today's layer: the SAME `packNraLayer`, at the diffuse size. */
function todayLayer(mat, w, h) {
  const arr = buildNraArray(w, h, 1);
  packNraLayer(arr, 0, mat, w, h, null);
  return arr.image.data;
}

function onlyBucket() {
  const bs = [..._statAtlasBucketsForTest().entries()];
  check("exactly one bucket", bs.length === 1, `n=${bs.length}`);
  return bs[0];
}

// ---------------------------------------------------------------------------
console.log("N1 — flag grammar");
// ---------------------------------------------------------------------------
{
  const withSearch = (search) => {
    globalThis.window = { location: { search } };
    _resetStatAtlasForTest();
    const v = nraSourceResEnabled();
    delete globalThis.window;
    return v;
  };
  check("absent ⇒ ON (default-on)", withSearch("") === true);
  check("?nraSourceRes=on ⇒ ON", withSearch("?nraSourceRes=on") === true);
  check("garbage ⇒ ON (a typo never disarms)", withSearch("?nraSourceRes=banana") === true);
  for (const off of ["off", "0", "false", "no", "OFF"]) {
    check(`?nraSourceRes=${off} ⇒ OFF`, withSearch(`?nraSourceRes=${off}`) === false);
  }
  _resetStatAtlasForTest();
}

// ---------------------------------------------------------------------------
console.log("N2 — _nraDimsFor");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, nraSourceRes: true });
  const m = hdMat(256, 64);
  let d = _nraDimsFor(m, 256, 256);
  check("x4 BC7 over 64² planes ⇒ 64x64", d.w === 64 && d.h === 64, `${d.w}x${d.h}`);

  const big = hdMat(256, 64);
  big.roughnessMap = plane(128, 128, 4);
  d = _nraDimsFor(big, 256, 256);
  check("a larger texchan plane WIDENS the size (no roughness downsample)", d.w === 128 && d.h === 128, `${d.w}x${d.h}`);

  const over = hdMat(64, 256);
  d = _nraDimsFor(over, 64, 64);
  check("planes larger than the diffuse clamp to it (never more bytes than today)", d.w === 64 && d.h === 64, `${d.w}x${d.h}`);

  const flat = hdMat(256, 64, { normal: false });
  d = _nraDimsFor(flat, 256, 256);
  check("no normal/height plane ⇒ the diffuse dims (texchan alone never sizes it)", d.w === 256 && d.h === 256, `${d.w}x${d.h}`);

  const released = hdMat(256, 64);
  released.normalMap.image.data = null; // texture_release.js keeps width/height
  d = _nraDimsFor(released, 256, 256);
  check("a RELEASED normal plane still sizes it (image dims survive the release)", d.w === 64 && d.h === 64, `${d.w}x${d.h}`);

  _resetStatAtlasForTest({ nra: true, nraSourceRes: false });
  d = _nraDimsFor(hdMat(256, 64), 256, 256);
  check("?nraSourceRes=off ⇒ the diffuse dims", d.w === 256 && d.h === 256);
  _resetStatAtlasForTest({ nra: false, nraSourceRes: true });
  d = _nraDimsFor(hdMat(256, 64), 256, 256);
  check("?statNra=off ⇒ the diffuse dims (no nra array to size)", d.w === 256 && d.h === 256);
}

// ---------------------------------------------------------------------------
console.log("N3 — key and arithmetic: defaults are the pre-memory-1 values");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, nraSourceRes: true });
  const sk = "0|0|1|b1|c";
  check("equal sizes ⇒ no key field (old key verbatim)",
        _bucketKeyFor(256, 256, sk, true, 256, 256) === `256x256|${sk}|f7` &&
        _bucketKeyFor(256, 256, sk, true) === `256x256|${sk}|f7`);
  check("smaller nra ⇒ `|n64x64` appended LAST",
        _bucketKeyFor(256, 256, sk, true, 64, 64) === `256x256|${sk}|f7|n64x64`,
        _bucketKeyFor(256, 256, sk, true, 64, 64));
  check("_nraKeyToken is '' without dims", _nraKeyToken(256, 256) === "");

  let same = true;
  for (const bc7 of [true, false]) {
    for (const [w, h] of [[16, 16], [64, 64], [128, 256], [512, 512], [1024, 2048], [2048, 2048]]) {
      const oldPer = bc7 ? Math.max(1, bc7LevelBytes(w, h) + w * h * 4) : Math.max(1, w * h * 4 * 2);
      if (_perLayerBytesFor(w, h, bc7) !== oldPer) same = false;
      if (_perLayerBytesFor(w, h, bc7, w, h) !== oldPer) same = false;
      if (_layerCapacityFor(w, h, bc7) !== _layerCapacityFor(w, h, bc7, w, h)) same = false;
      const cap = _layerCapacityFor(w, h, bc7);
      if (_atlasStartLayersFor(w, h, bc7, cap) !== _atlasStartLayersFor(w, h, bc7, cap, w, h)) same = false;
    }
  }
  check("per-layer bytes / capacity / start depth unchanged at the default (nw, nh)", same);
  check("a 64² nra layer under a 256² BC7 diffuse costs bc7(256²) + 64*64*4",
        _perLayerBytesFor(256, 256, true, 64, 64) === bc7LevelBytes(256, 256) + 64 * 64 * 4);
}

// ---------------------------------------------------------------------------
console.log("N4 — THE CLAIM: 256² BC7 + 64² planes ⇒ a 64² nra layer, = today's NN at block centres");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, grow: true, pages: true, nraSourceRes: true });
  const mat = hdMat(256, 64);
  const today = todayLayer(mat, 256, 256); // packed BEFORE the feed: same inputs
  const r = addSingletonsToCrossLbAtlas([node(mat)], fakeScene3d);
  check("the node was atlased", r.passthrough.length === 0);
  const [key, b] = onlyBucket();
  const ud = b.bm.userData;
  check("bucket key carries the nra size", key.endsWith("|f7|n64x64"), key);
  check("bucket record carries nraW/nraH = 64", ud.nraW === 64 && ud.nraH === 64);
  const img = ud.nraArray.image;
  check("nra array is 64x64", img.width === 64 && img.height === 64, `${img.width}x${img.height}`);
  check("nra array holds 64*64*4 bytes per layer",
        img.data.length === img.depth * 64 * 64 * 4, `${img.data.length} / depth ${img.depth}`);
  check("the diffuse array stays at the BC7 full tier (256²)",
        ud.diffArray.image.width === 256 && ud.diffArray.image.height === 256);

  const layer = ud.layerOf.get(mat.map.uuid).layer;
  const got = img.data.subarray(layer * 64 * 64 * 4, (layer + 1) * 64 * 64 * 4);
  let centreDiff = 0, blockDiff = 0;
  for (let by = 0; by < 64; by++) {
    for (let bx = 0; bx < 64; bx++) {
      const o = (by * 64 + bx) * 4;
      // Block centre of the old 4x4 NN block.
      const c = ((by * 4 + 2) * 256 + (bx * 4 + 2)) * 4;
      for (let k = 0; k < 4; k++) if (got[o + k] !== today[c + k]) centreDiff++;
      // ...and every other texel of that block: the old layer was pure
      // replication, so the native layer loses nothing.
      for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
        const t = ((by * 4 + yy) * 256 + (bx * 4 + xx)) * 4;
        for (let k = 0; k < 4; k++) if (got[o + k] !== today[t + k]) blockDiff++;
      }
    }
  }
  check("every texel equals today's NN layer at the 4x4 block centre", centreDiff === 0, `${centreDiff} bytes differ`);
  check("...and every texel of each old 4x4 block (16 copies of one real texel)", blockDiff === 0, `${blockDiff} bytes differ`);
  const st = _statAtlasStatsForTest();
  check("the native pack is NOT counted as resampled (it was, every x4 layer, before)",
        st.nraLayersPacked === 1 && st.nraResampled === 0,
        `packed=${st.nraLayersPacked} resampled=${st.nraResampled}`);
}

// ---------------------------------------------------------------------------
console.log("N5 — `?nraSourceRes=off` is byte-identical to today");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, grow: true, pages: true, nraSourceRes: false });
  const mat = hdMat(256, 64);
  const today = todayLayer(mat, 256, 256);
  addSingletonsToCrossLbAtlas([node(mat)], fakeScene3d);
  const [key, b] = onlyBucket();
  const ud = b.bm.userData;
  check("key is the pre-memory-1 key (no `|n` field)",
        key === _bucketKeyFor(256, 256, _stateKeyOf(mat), true) && !key.includes("|n"), key);
  const img = ud.nraArray.image;
  check("nra array at the diffuse dims (256²)", img.width === 256 && img.height === 256);
  // Pages (the default) make page 0 its own ceiling at the family's start
  // depth, which prices today's per-layer bytes.
  const cap = _layerCapacityFor(256, 256, true);
  check("page 0 depth is today's start depth",
        ud.allocLayers === _atlasStartLayersFor(256, 256, true, cap) &&
        ud.capacity === ud.allocLayers && img.depth === ud.allocLayers,
        `cap=${ud.capacity} alloc=${ud.allocLayers}`);
  // Whole-array identity against an independent rebuild of today's array.
  const ref = buildNraArray(256, 256, ud.allocLayers);
  const layer = ud.layerOf.get(mat.map.uuid).layer;
  ref.image.data.set(today, layer * 256 * 256 * 4);
  check("the whole nra array is byte-identical to today's",
        Buffer.compare(Buffer.from(img.data), Buffer.from(ref.image.data)) === 0);

  // The X7 single-bucket arm prices the CEILING: today's, too.
  _resetStatAtlasForTest({ nra: true, grow: true, pages: false, nraSourceRes: false });
  addSingletonsToCrossLbAtlas([node(hdMat(256, 64))], fakeScene3d);
  const [, b2] = onlyBucket();
  const ud2 = b2.bm.userData;
  check("=off ceiling is today's _layerCapacityFor(256, 256, bc7)",
        ud2.capacity === cap && ud2.nraArray.image.width === 256, `cap=${ud2.capacity} want ${cap}`);
}

// ---------------------------------------------------------------------------
console.log("N6 — growth copies the nra prefix at the nra stride");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, grow: true, pages: false, nraSourceRes: true });
  const mats = [];
  for (let i = 0; i < 6; i++) mats.push(hdMat(256, 64));
  addSingletonsToCrossLbAtlas([node(mats[0])], fakeScene3d);
  const [, b] = onlyBucket();
  const ud = b.bm.userData;
  const start = ud.allocLayers;
  const l0 = ud.nraArray.image.data.slice(0, 64 * 64 * 4);
  const oldNra = ud.nraArray;
  addSingletonsToCrossLbAtlas(mats.slice(1).map((m) => node(m)), fakeScene3d);
  check("the bucket grew", ud.allocLayers > start && ud.nraArray !== oldNra, `${start} → ${ud.allocLayers}`);
  const img = ud.nraArray.image;
  check("the grown nra array is still 64² at the new depth",
        img.width === 64 && img.height === 64 && img.depth === ud.allocLayers &&
        img.data.length === ud.allocLayers * 64 * 64 * 4);
  check("layer 0's nra bytes survived the reallocation",
        Buffer.compare(Buffer.from(l0), Buffer.from(img.data.subarray(0, 64 * 64 * 4))) === 0);
  let marked = true;
  for (let i = 0; i < ud.nextLayer; i++) if (!ud.nraArray.layerUpdates.has(i)) marked = false;
  check("every carried-over nra layer is re-marked for upload", marked);
  let packedOk = true;
  for (const m of mats) {
    const L = ud.layerOf.get(m.map.uuid).layer;
    const want = buildNraArray(64, 64, 1);
    packNraLayer(want, 0, m, 64, 64, null);
    if (Buffer.compare(Buffer.from(want.image.data),
      Buffer.from(img.data.subarray(L * 64 * 64 * 4, (L + 1) * 64 * 64 * 4))) !== 0) packedOk = false;
  }
  check("every member's layer is its native 64² pack", packedOk);
}

// ---------------------------------------------------------------------------
console.log("N7 — the async texchan re-pack packs at the nra size");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ nra: true, grow: true, pages: true, nraSourceRes: true });
  const mat = hdMat(256, 64, { rough: false, ao: false }); // texchan not landed yet
  addSingletonsToCrossLbAtlas([node(mat)], fakeScene3d);
  const [key, b] = onlyBucket();
  const ud = b.bm.userData;
  check("keyed off the normal plane even before the texchan lands", key.endsWith("|n64x64"), key);
  // The Phase-5 bake lands (materials.js `_resolveRough` is async).
  mat.roughnessMap = plane(64, 64, 4);
  mat.aoMap = plane(64, 64, 1);
  tickStatAtlasOptimize();
  const L = ud.layerOf.get(mat.map.uuid).layer;
  const want = buildNraArray(64, 64, 1);
  packNraLayer(want, 0, mat, 64, 64, null);
  check("the drained re-pack wrote the 64² layer with the late roughness/AO",
        Buffer.compare(Buffer.from(want.image.data),
          Buffer.from(ud.nraArray.image.data.subarray(L * 64 * 64 * 4, (L + 1) * 64 * 64 * 4))) === 0);
  check("...and only that layer is marked", ud.nraArray.layerUpdates.has(L));
}

// ---------------------------------------------------------------------------
console.log("N8 — static_array_pool.js twin");
// ---------------------------------------------------------------------------
{
  __setStatArrayMergeForTest(true);
  const fakeNode = { castShadow: true, receiveShadow: true };

  _resetStatAtlasForTest({ nra: true, grow: true, nraSourceRes: true });
  _resetStatArrayPoolForTest();
  const mat = hdMat(256, 64);
  const h = admitToArrayPool(mat, fakeNode);
  check("admitted", !!h);
  check("pool key carries the nra size BEFORE the VFX token, format last",
        !!h && h.poolKey.includes("|n64x64|x-") && h.poolKey.endsWith("|f7"), h && h.poolKey);
  check("stateStrict (the material's state) is unchanged by it",
        !!h && !h.stateStrict.includes("|n64x64"));
  const ref = h && acquireArrayPoolLayer(h);
  const pool = ref && ref.pool;
  check("pool nra array is 64², diffuse is 256²",
        !!pool && pool.nraArray.image.width === 64 && pool.nraArray.image.height === 64 &&
        pool.diffArray.image.width === 256);
  check("pool capacity prices the 64² nra layer",
        !!pool && pool.capacity === _layerCapacityFor(256, 256, true, 64, 64));
  if (pool) {
    const want = buildNraArray(64, 64, 1);
    packNraLayer(want, 0, mat, 64, 64, null);
    check("the pool layer is the native 64² pack",
      Buffer.compare(Buffer.from(want.image.data),
        Buffer.from(pool.nraArray.image.data.subarray(ref.layer * 64 * 64 * 4, (ref.layer + 1) * 64 * 64 * 4))) === 0);
  }

  _resetStatAtlasForTest({ nra: true, grow: true, nraSourceRes: false });
  _resetStatArrayPoolForTest();
  const mat2 = hdMat(256, 64);
  const h2 = admitToArrayPool(mat2, fakeNode);
  check("=off: the pool key is today's composition",
        !!h2 && h2.poolKey === _bucketKeyFor(256, 256, h2.stateStrict, true), h2 && h2.poolKey);
  const ref2 = h2 && acquireArrayPoolLayer(h2);
  check("=off: the pool nra array is at the diffuse dims, today's bytes",
        !!ref2 && ref2.pool.nraArray.image.width === 256 &&
        Buffer.compare(Buffer.from(todayLayer(mat2, 256, 256)),
          Buffer.from(ref2.pool.nraArray.image.data.subarray(ref2.layer * 256 * 256 * 4, (ref2.layer + 1) * 256 * 256 * 4))) === 0);
  _resetStatArrayPoolForTest();
  __setStatArrayMergeForTest(undefined);
}

_resetStatAtlasForTest();
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
