// 2026-08-06 — X7 `?statAtlasGrow`: grow-on-demand layer depth for the
// cross-LB statics-atlas buckets.
//
// THE FINDING this defends (measured live on a GTX 1070 after a four-town
// route — docs/RESULTS-atlas-occupancy-2026-08-05.json, §11 of
// docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md):
//
//     29 buckets   1,941 layers ALLOCATED   112 layers USED
//                  551.1 MB allocated       123 MB occupied
//
// 428 MB of nra layers nothing had ever written to, on a page whose renderer
// OOM-crashes at ~2,800 MB. Buckets allocated their full `_layerCapacityFor`
// depth at creation and never revisited it.
//
// What must hold:
//   PART 1 — the sizing arithmetic. The CEILING (`_layerCapacityFor`) is
//            unchanged — it still reproduces the 29 measured caps exactly —
//            and the new start/grow functions are bounded by it, so a grown
//            bucket can NEVER hold more layers than the pre-X7 code allocated
//            on day one.
//   PART 2 — replayed against the 29 measured buckets, the allocation drops
//            from 1,941 layers to a number that still covers every bucket's
//            measured live use.
//   PART 3 — the live feed grows, and the carried-over layers survive the
//            reallocation byte for byte AND are re-marked for upload (three
//            uploads ONLY `layerUpdates` on a fresh array — an unmarked
//            carried-over layer is GPU garbage, not a warning).
//   PART 4 — the material samples the NEW array: both the post-compile uniform
//            rebind and the RECOMPILE path (the closure must read the holder,
//            not a captured array object).
//   PART 5 — overflow past the ceiling still fails soft to an unbatched
//            singleton (`ptLayerFull`), never a vanished prop.
//   PART 6 — flag grammar, and `?statAtlasGrow=off` allocating exactly what
//            HEAD allocated.
//
// Run:
//   cd apps/holtburger-web/
//   node test_static_atlas_growth.mjs

import * as THREE from "three";
import {
  _layerCapacityFor,
  _atlasStartLayersFor,
  _atlasGrowTargetFor,
  _resetStatAtlasForTest,
  _statAtlasBucketsForTest,
  _statAtlasStatsForTest,
  statAtlasGrowEnabled,
  addSingletonsToCrossLbAtlas,
} from "./scene3d/static_atlas.js";
import { _setBc7SupportForTest, bc7LevelBytes } from "./scene3d/bc7_textures.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// The 29 buckets exactly as `__atlasStats()` reported them on the 1070
// (docs/RESULTS-atlas-occupancy-2026-08-05.json). `bc7` is not in the JSON but
// is recoverable: only one of the two `_layerCapacityFor` arms reproduces each
// row's cap, which PART 1 asserts.
const MEASURED = [
  [512, 1024, 12, 3], [512, 512, 25, 25], [256, 256, 102, 14], [512, 512, 25, 1],
  [1024, 1024, 6, 6], [1024, 1024, 6, 1], [2048, 2048, 4, 2], [32, 32, 128, 1],
  [32, 32, 128, 1], [128, 128, 128, 18], [256, 256, 102, 5], [128, 256, 128, 8],
  [256, 256, 64, 1], [128, 128, 128, 2], [256, 512, 51, 6], [1024, 1024, 6, 1],
  [1024, 1024, 6, 1], [256, 512, 32, 1], [512, 256, 51, 2], [512, 512, 25, 1],
  [256, 128, 128, 3], [64, 64, 128, 1], [32, 32, 128, 2], [1024, 2048, 4, 1],
  [256, 256, 64, 1], [512, 512, 25, 1], [16, 16, 128, 1], [256, 512, 51, 1],
  [64, 256, 128, 1],
];

// ---------------------------------------------------------------------------
console.log("PART 1 — sizing arithmetic (the ceiling is untouched)");
// ---------------------------------------------------------------------------
_resetStatAtlasForTest(); // armed defaults: nra ON, grow ON (no window under node)
{
  let matched = 0, capL = 0, usedL = 0;
  const kinds = [];
  for (const [w, h, cap, used] of MEASURED) {
    const isBc7 = _layerCapacityFor(w, h, true) === cap
      ? true
      : (_layerCapacityFor(w, h, false) === cap ? false : null);
    if (isBc7 !== null) matched++;
    kinds.push(isBc7);
    capL += cap;
    usedL += used;
  }
  check("every measured bucket cap is reproduced by _layerCapacityFor",
        matched === MEASURED.length, `${matched}/${MEASURED.length}`);
  check("...summing to the reported 1,941 allocated / 112 used layers",
        capL === 1941 && usedL === 112, `capL=${capL} usedL=${usedL}`);

  // The start depth: bounded above by 4, by the ceiling, and by bytes.
  for (const [w, h, cap] of MEASURED) {
    const isBc7 = _layerCapacityFor(w, h, true) === cap;
    const s = _atlasStartLayersFor(w, h, isBc7, cap);
    if (s < 1 || s > 4 || s > cap) {
      check(`start depth in range for ${w}x${h}`, false, `start=${s} cap=${cap}`);
    }
  }
  check("start depth is always 1..min(4, capacity)", true, "all 29 buckets");
  check("a huge tile starts at 1 layer, not 4 (the byte cap, not the count)",
        _atlasStartLayersFor(2048, 2048, true, 4) === 1,
        `2048x2048 bc7 → ${_atlasStartLayersFor(2048, 2048, true, 4)}`);
  check("a small tile starts at the flat 4",
        _atlasStartLayersFor(128, 128, true, 128) === 4);
  check("start never exceeds a tiny ceiling",
        _atlasStartLayersFor(64, 64, false, 2) === 2);

  // Growth: doubling, clamped to the ceiling, and never short of `needed`.
  check("doubles", _atlasGrowTargetFor(4, 5, 128) === 8);
  check("takes `needed` when doubling is not enough",
        _atlasGrowTargetFor(1, 3, 128) === 3);
  check("clamps to the ceiling", _atlasGrowTargetFor(16, 17, 25) === 25);
  check("returns <= alloc at the ceiling (caller passthroughs)",
        _atlasGrowTargetFor(25, 26, 25) === 25);
  check("NEVER exceeds the pre-X7 allocation, for any (alloc, needed)", (() => {
    for (const [w, h, cap] of MEASURED) {
      let a = _atlasStartLayersFor(w, h, true, cap);
      for (let i = 0; i < 64; i++) {
        a = _atlasGrowTargetFor(a, a + 1, cap);
        if (a > cap) return false;
      }
    }
    return true;
  })());
}

// ---------------------------------------------------------------------------
console.log("PART 2 — replayed against the measured route");
// ---------------------------------------------------------------------------
{
  const MB = 1048576;
  let allocL = 0, capL = 0, grows = 0, covers = true, neverWorse = true;
  let nraAllocB = 0, nraCapB = 0;
  for (const [w, h, cap, used] of MEASURED) {
    const isBc7 = _layerCapacityFor(w, h, true) === cap;
    let a = _atlasStartLayersFor(w, h, isBc7, cap);
    while (a < used) { a = _atlasGrowTargetFor(a, a + 1, cap); grows++; }
    if (a < used) covers = false;      // the working set must still fit
    if (a > cap) neverWorse = false;   // and never above what HEAD allocated
    allocL += a;
    capL += cap;
    nraAllocB += a * w * h * 4;
    nraCapB += cap * w * h * 4;
  }
  check("every bucket's measured live use still fits its grown depth", covers);
  check("no bucket allocates more than HEAD did", neverWorse);
  check("allocated layers collapse 1,941 → ~166",
        allocL < 250 && allocL >= 112, `${capL} → ${allocL} layers`);
  check("the nra arrays collapse 551.1 MB → ~131 MB",
        nraCapB / MB > 550 && nraCapB / MB < 552 && nraAllocB / MB < 160,
        `${(nraCapB / MB).toFixed(1)} MB → ${(nraAllocB / MB).toFixed(1)} MB ` +
        `(saves ${((nraCapB - nraAllocB) / MB).toFixed(1)} MB)`);
  check("the whole route costs a bounded handful of reallocations",
        grows < 40, `${grows} across 29 buckets`);
}

// ---------------------------------------------------------------------------
// Live-feed harness. 64x64 RGBA8 keeps the whole test under ~10 MB while still
// reaching the real 128-layer ceiling (`_ATLAS_NRA_MAX_LAYERS`).
// ---------------------------------------------------------------------------
const TW = 64, TH = 64;
const STRIDE = TW * TH * 4;

function makeTex(seed) {
  const data = new Uint8Array(STRIDE);
  data.fill(seed & 0xff);
  data[0] = seed & 0xff;
  data[1] = (seed >> 8) & 0xff;
  const tex = new THREE.DataTexture(data, TW, TH, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** `texOverride` shares ONE texture across nodes, which is how the refcounted
 *  layer dedup (`layerOf`) is reached — a fresh DataTexture has a fresh uuid. */
function makeNode(seed, lb = 0xaabb0000, texOverride) {
  const tex = texOverride || makeTex(seed);
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(
    new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  const m = new THREE.Mesh(geom, mat);
  m.userData.landblockId = lb;
  return m;
}

const fakeScene3d = { staticsGroup: { add() {} } };

/** A three-shaped `shader` object with the include directives the injected
 *  chunks target, so `onBeforeCompile` runs its real replaces. */
function fakeShader() {
  return {
    uniforms: {},
    vertexShader: "#include <common>\n#include <uv_vertex>\n",
    fragmentShader:
      "#include <common>\n#include <map_fragment>\n" +
      "#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n" +
      "#include <aomap_fragment>\n",
  };
}

function onlyBucket() {
  const buckets = _statAtlasBucketsForTest();
  check("exactly one bucket was created", buckets.size === 1, `size=${buckets.size}`);
  return [...buckets.values()][0];
}

// ---------------------------------------------------------------------------
console.log("PART 3 — the live feed grows, and carries its layers over intact");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true });
  // First feed: fewer nodes than the start depth ⇒ no growth at all.
  let r = addSingletonsToCrossLbAtlas([makeNode(1), makeNode(2)], fakeScene3d);
  const b = onlyBucket();
  const ud = b.bm.userData;
  check("a fresh bucket allocates the START depth, not the ceiling",
        ud.allocLayers === _atlasStartLayersFor(TW, TH, false, ud.capacity) &&
        ud.allocLayers < ud.capacity,
        `alloc=${ud.allocLayers} capacity=${ud.capacity}`);
  check("the arrays are allocated at that depth",
        ud.diffArray.image.depth === ud.allocLayers &&
        ud.nraArray.image.depth === ud.allocLayers,
        `diff=${ud.diffArray.image.depth} nra=${ud.nraArray.image.depth}`);
  check("nothing passed through", r.passthrough.length === 0);

  // Snapshot layer 0 so the copy can be proven byte-exact across reallocation.
  const layer0Diff = ud.diffArray.image.data.slice(0, STRIDE);
  const layer0Nra = ud.nraArray.image.data.slice(0, STRIDE);
  const oldDiff = ud.diffArray, oldNra = ud.nraArray;

  // Second feed: enough unique surfaces to force several doublings.
  const more = [];
  for (let i = 3; i <= 40; i++) more.push(makeNode(i));
  r = addSingletonsToCrossLbAtlas(more, fakeScene3d);
  check("the bucket grew past its start depth",
        ud.allocLayers >= 40 && ud.allocLayers <= ud.capacity,
        `alloc=${ud.allocLayers} capacity=${ud.capacity}`);
  check("the array objects were REPLACED (a depth change cannot be in-place)",
        ud.diffArray !== oldDiff && ud.nraArray !== oldNra);
  check("both arrays grew together — one layer index addresses both",
        ud.diffArray.image.depth === ud.allocLayers &&
        ud.nraArray.image.depth === ud.allocLayers,
        `diff=${ud.diffArray.image.depth} nra=${ud.nraArray.image.depth}`);
  check("no node fell back to an unbatched singleton",
        r.passthrough.length === 0 && ud.layerOf.size === 40,
        `passthrough=${r.passthrough.length} layers=${ud.layerOf.size}`);

  const newL0d = ud.diffArray.image.data.subarray(0, STRIDE);
  const newL0n = ud.nraArray.image.data.subarray(0, STRIDE);
  check("layer 0's DIFFUSE texels survived every reallocation byte for byte",
        Buffer.compare(Buffer.from(layer0Diff), Buffer.from(newL0d)) === 0);
  check("layer 0's NRA texels survived too",
        Buffer.compare(Buffer.from(layer0Nra), Buffer.from(newL0n)) === 0);

  // THE load-bearing bit: three's first upload of a fresh array texture runs
  // texStorage3D (contents undefined) and then uploads ONLY `layerUpdates`
  // (three.module.js:12160-12195). A carried-over layer that is not re-marked
  // is GPU garbage — silently, and only on a real context.
  let allMarked = true;
  for (let i = 0; i < ud.nextLayer; i++) {
    if (!ud.diffArray.layerUpdates.has(i) || !ud.nraArray.layerUpdates.has(i)) allMarked = false;
  }
  check("every carried-over layer is re-marked for upload on the new arrays",
        allMarked, `nextLayer=${ud.nextLayer} marked=${ud.diffArray.layerUpdates.size}`);

  const st = _statAtlasStatsForTest();
  check("growth is bounded (log2-ish of the depth), not per-layer",
        st.layerGrows > 0 && st.layerGrows <= 8, `layerGrows=${st.layerGrows}`);
  check("no growth was refused", st.layerGrowFails === 0, `layerGrowFails=${st.layerGrowFails}`);
  check("no prop was ever routed to the fail-soft overflow",
        st.ptLayerFull === 0 && st.ptLayerWriteFail === 0);
}

// ---------------------------------------------------------------------------
console.log("PART 4 — the material samples the NEW array");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true });
  addSingletonsToCrossLbAtlas([makeNode(1), makeNode(2)], fakeScene3d);
  const b = onlyBucket();
  const ud = b.bm.userData;
  const mat = b.bm.material;

  // Emulate three's first compile.
  const sh1 = fakeShader();
  mat.onBeforeCompile(sh1);
  check("compile binds the bucket's current arrays",
        sh1.uniforms.uDiffuseArray.value === ud.diffArray &&
        sh1.uniforms.uNraArray.value === ud.nraArray);
  check("...and stamps the rebind seam",
        mat.userData._statArrayUniforms === sh1.uniforms);

  const beforeDiff = ud.diffArray, beforeNra = ud.nraArray;
  const keyBeforeGrowth = mat.customProgramCacheKey();
  const more = [];
  for (let i = 3; i <= 20; i++) more.push(makeNode(i));
  addSingletonsToCrossLbAtlas(more, fakeScene3d);
  check("the growth actually swapped the arrays",
        ud.diffArray !== beforeDiff && ud.nraArray !== beforeNra);

  // (a) the ALREADY-COMPILED program's uniforms were re-pointed in place.
  check("the compiled program's uniform now points at the NEW diffuse array",
        sh1.uniforms.uDiffuseArray.value === ud.diffArray);
  check("...and at the NEW nra array",
        sh1.uniforms.uNraArray.value === ud.nraArray);
  check("...not at the disposed one",
        sh1.uniforms.uDiffuseArray.value !== beforeDiff);

  // (b) a RECOMPILE (three re-runs onBeforeCompile whenever the program cache
  //     key changes — a light-count change is enough) must not resurrect the
  //     disposed array. This is what the mutable holder exists for: a closure
  //     over `diffArray` would bind `beforeDiff` here.
  const sh2 = fakeShader();
  mat.onBeforeCompile(sh2);
  check("a RECOMPILE binds the current arrays, not the captured originals",
        sh2.uniforms.uDiffuseArray.value === ud.diffArray &&
        sh2.uniforms.uNraArray.value === ud.nraArray,
        sh2.uniforms.uDiffuseArray.value === beforeDiff ? "bound the DISPOSED array" : "");
  check("...and re-stamps the seam so later swaps write the live uniforms",
        mat.userData._statArrayUniforms === sh2.uniforms);

  // (c) a swap after the recompile reaches the new uniform set.
  const beforeDiff2 = ud.diffArray;
  const more2 = [];
  for (let i = 21; i <= 60; i++) more2.push(makeNode(i));
  addSingletonsToCrossLbAtlas(more2, fakeScene3d);
  check("a post-recompile growth re-points the CURRENT uniform set",
        ud.diffArray !== beforeDiff2 && sh2.uniforms.uDiffuseArray.value === ud.diffArray);

  // The shader SOURCE and the program cache key must be unchanged by any of
  // this — the injected chunks are a function of nra presence and the wrap
  // bucket, never of the array depth. If growth could touch either, every
  // reallocation would be a program relink (the #1 cold-load cost).
  const sh3 = fakeShader();
  mat.onBeforeCompile(sh3);
  check("the injected shader source is identical across compiles (no depth in it)",
        sh3.fragmentShader === sh2.fragmentShader && sh3.vertexShader === sh2.vertexShader);
  check("the program cache key is unchanged by growth",
        mat.customProgramCacheKey() === keyBeforeGrowth, mat.customProgramCacheKey());
}

// ---------------------------------------------------------------------------
console.log("PART 5 — overflow past the CEILING still fails soft");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true });
  const cap = _layerCapacityFor(TW, TH, false);
  const shared = makeTex(1);
  const nodes = [makeNode(1, 0xaabb0000, shared)];
  for (let i = 2; i <= cap + 5; i++) nodes.push(makeNode(i));
  const r = addSingletonsToCrossLbAtlas(nodes, fakeScene3d);
  const b = onlyBucket();
  const ud = b.bm.userData;
  const st = _statAtlasStatsForTest();
  check("growth stops at the ceiling", ud.allocLayers === cap, `alloc=${ud.allocLayers} cap=${cap}`);
  check("the ceiling is still the pre-X7 ceiling", ud.capacity === cap);
  check("the surplus props are handed back as passthrough, never dropped",
        r.passthrough.length === 5 && st.ptLayerFull === 5, `passthrough=${r.passthrough.length}`);
  check("...and every fed node is accounted for exactly once",
        ud.layerOf.size + r.passthrough.length === cap + 5,
        `${ud.layerOf.size} + ${r.passthrough.length}`);
  check("...and the overflow is the LAYER pool, not a growth failure",
        st.layerGrowFails === 0);

  // A repeat of a resident surface must take the refcount path, never grow.
  const allocAfterFill = ud.allocLayers;
  const r2 = addSingletonsToCrossLbAtlas(
    [makeNode(1, 0xaabb0000, shared)], fakeScene3d);
  check("a duplicate surface takes the refcount path, no growth",
        ud.allocLayers === allocAfterFill && r2.passthrough.length === 0 &&
        st.layerHits > 0, `layerHits=${st.layerHits}`);
}

// ---------------------------------------------------------------------------
console.log("PART 6 — flag grammar, and `off` is the pre-X7 allocation");
// ---------------------------------------------------------------------------
{
  const withSearch = (search) => {
    globalThis.window = { location: { search } };
    _resetStatAtlasForTest();          // clears the memo; re-resolves from window
    const v = statAtlasGrowEnabled();
    delete globalThis.window;
    return v;
  };
  check("absent ⇒ ARMED", withSearch("") === true);
  check("garbage ⇒ ARMED, never disarmed by a typo",
        withSearch("?statAtlasGrow=banana") === true);
  check("?statAtlasGrow=on ⇒ ARMED", withSearch("?statAtlasGrow=on") === true);
  for (const off of ["off", "0", "false", "no"]) {
    check(`?statAtlasGrow=${off} disarms`, withSearch(`?statAtlasGrow=${off}`) === false);
  }
  check("case-insensitive off-form", withSearch("?statAtlasGrow=OFF") === false);

  // Disarmed: allocate at the ceiling, exactly as HEAD did.
  _resetStatAtlasForTest({ grow: false, nra: true });
  addSingletonsToCrossLbAtlas([makeNode(1), makeNode(2)], fakeScene3d);
  const b = onlyBucket();
  const ud = b.bm.userData;
  const cap = _layerCapacityFor(TW, TH, false);
  check("disarmed allocates the full capacity up front",
        ud.allocLayers === cap && ud.capacity === cap, `alloc=${ud.allocLayers} cap=${cap}`);
  check("...at the ceiling depth in BOTH arrays",
        ud.diffArray.image.depth === cap && ud.nraArray.image.depth === cap);
  check("...with the diffuse array zero-filled and the nra array flat-filled",
        ud.diffArray.image.data.length === cap * STRIDE &&
        ud.nraArray.image.data[(cap - 1) * STRIDE] === 128 &&
        ud.nraArray.image.data[(cap - 1) * STRIDE + 2] === 255 &&
        ud.nraArray.image.data[(cap - 1) * STRIDE + 3] === 255);

  const diff0 = ud.diffArray, nra0 = ud.nraArray;
  const more = [];
  for (let i = 3; i <= cap; i++) more.push(makeNode(i));
  const r = addSingletonsToCrossLbAtlas(more, fakeScene3d);
  check("filling the bucket to the ceiling never reallocates when disarmed",
        ud.diffArray === diff0 && ud.nraArray === nra0 && ud.allocLayers === cap);
  check("...and still batches everything", r.passthrough.length === 0);
  const overflow = addSingletonsToCrossLbAtlas([makeNode(9999)], fakeScene3d);
  check("...with the same fail-soft overflow as HEAD", overflow.passthrough.length === 1);
}

// ---------------------------------------------------------------------------
console.log("PART 7 — the BC7 arm grows too, with no bc7_textures.js change");
// ---------------------------------------------------------------------------
{
  // A `CompressedArrayTexture` keeps its WHOLE payload in `mipmaps[0].data`
  // (`makeBc7ArrayTexture` allocates it, `writeBc7ArrayLayer` writes into it),
  // so the carried-over blocks come from the array's own CPU mirror. Nothing is
  // re-fetched and no per-layer source reference is retained — which is what
  // lets the compressed bucket grow from static_atlas.js alone.
  _setBc7SupportForTest(true, "forced (growth test)");
  _resetStatAtlasForTest({ grow: true, nra: true });
  const LAYER_BYTES = bc7LevelBytes(TW, TH);

  const makeBc7Node = (seed) => {
    const data = new Uint8Array(LAYER_BYTES);
    data.fill(seed & 0xff);
    data[0] = seed & 0xff;
    data[1] = (seed >> 8) & 0xff;
    const tex = new THREE.CompressedTexture(
      [{ data, width: TW, height: TH }], TW, TH,
      THREE.RGBA_BPTC_Format, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    return makeNode(seed, 0xccdd0000, tex);
  };

  addSingletonsToCrossLbAtlas([makeBc7Node(1), makeBc7Node(2)], fakeScene3d);
  const b = onlyBucket();
  const ud = b.bm.userData;
  check("the bucket is a BC7 one (CompressedArrayTexture diffuse)",
        ud.bc7 === true && ud.diffArray.isCompressedArrayTexture === true);
  check("it starts at the START depth, not the ceiling",
        ud.allocLayers === _atlasStartLayersFor(TW, TH, true, ud.capacity) &&
        ud.allocLayers < ud.capacity, `alloc=${ud.allocLayers} cap=${ud.capacity}`);
  check("the compressed payload is sized for exactly that depth",
        ud.diffArray.mipmaps[0].data.length === ud.allocLayers * LAYER_BYTES &&
        ud.diffArray.image.depth === ud.allocLayers);

  const layer0 = ud.diffArray.mipmaps[0].data.slice(0, LAYER_BYTES);
  const oldDiff = ud.diffArray;
  const more = [];
  for (let i = 3; i <= 20; i++) more.push(makeBc7Node(i));
  const r = addSingletonsToCrossLbAtlas(more, fakeScene3d);
  const st = _statAtlasStatsForTest();
  check("the compressed array was reallocated deeper",
        ud.diffArray !== oldDiff && ud.allocLayers >= 20 &&
        ud.diffArray.mipmaps[0].data.length === ud.allocLayers * LAYER_BYTES,
        `alloc=${ud.allocLayers}`);
  check("its RGBA8 nra twin grew in lockstep (one layer index, two arrays)",
        ud.nraArray.image.depth === ud.allocLayers);
  check("layer 0's BC7 blocks survived byte for byte",
        Buffer.compare(Buffer.from(layer0),
                       Buffer.from(ud.diffArray.mipmaps[0].data.subarray(0, LAYER_BYTES))) === 0);
  let allMarked = true;
  for (let i = 0; i < ud.nextLayer; i++) if (!ud.diffArray.layerUpdates.has(i)) allMarked = false;
  check("every carried-over compressed layer is re-marked for compressedTexSubImage3D",
        allMarked, `nextLayer=${ud.nextLayer} marked=${ud.diffArray.layerUpdates.size}`);
  check("no BC7 node fell back to an unbatched singleton",
        r.passthrough.length === 0 && st.ptLayerWriteFail === 0 && st.layerGrowFails === 0);

  _setBc7SupportForTest(false, "restored (growth test)");
  _resetStatAtlasForTest();
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
