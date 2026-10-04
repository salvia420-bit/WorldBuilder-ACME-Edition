// 2026-10-04 — perf T5 from the OpenAC comparison (`?statAtlasPages`): a full
// cross-LB statics-atlas bucket opens a sibling PAGE instead of reallocating
// its arrays deeper (X7 growth = texStorage3D + CPU copy + live-prefix re-upload,
// 20-250 ms per grow on the p99 doc).
//
// What must hold:
//   PART 1 — a full page is never touched again: same array objects, same
//            bytes, nothing re-marked for upload; the next surface lands on a
//            new page keyed `<family>#p<n>`.
//   PART 2 — the family's total allocation follows X7's growth schedule
//            exactly (4, 8, 16, 32 ...), so pages cost no more memory than
//            growth did, and it stops at the `_layerCapacityFor` ceiling with
//            the same fail-soft `ptLayerFull` overflow.
//   PART 3 — layer dedup is FAMILY-wide: a surface resident on page 0 is
//            refcounted there even while a later page is open.
//   PART 4 — eviction frees the right page's layer, and the freed layer is
//            reused before any new page opens.
//   PART 5 — flag grammar; `=off` is X7 growth (one bucket that reallocates).
//
// Run:
//   cd apps/holtburger-web/
//   node test_static_atlas_pages.mjs

import * as THREE from "three";
import {
  _layerCapacityFor,
  _atlasStartLayersFor,
  _atlasGrowTargetFor,
  _resetStatAtlasForTest,
  _statAtlasBucketsForTest,
  _statAtlasStatsForTest,
  statAtlasPagesEnabled,
  addSingletonsToCrossLbAtlas,
  evictStaticAtlasForLb,
} from "./scene3d/static_atlas.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

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

function pages() {
  return [..._statAtlasBucketsForTest().entries()];
}
function familyAlloc() {
  let t = 0;
  for (const [, b] of pages()) t += b.bm.userData.allocLayers;
  return t;
}

// ---------------------------------------------------------------------------
console.log("PART 1 — a full page is never reallocated or re-uploaded");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true, pages: true });
  const cap = _layerCapacityFor(TW, TH, false);
  const start = _atlasStartLayersFor(TW, TH, false, cap);
  const first = [];
  for (let i = 1; i <= start; i++) first.push(makeNode(i));
  addSingletonsToCrossLbAtlas(first, fakeScene3d);
  check("one page at the X7 start depth", pages().length === 1 &&
        pages()[0][1].bm.userData.allocLayers === start, `pages=${pages().length}`);
  const [key0, b0] = pages()[0];
  const ud0 = b0.bm.userData;
  check("page 0 is its own ceiling (growth unreachable)", ud0.capacity === ud0.allocLayers);
  const diff0 = ud0.diffArray, nra0 = ud0.nraArray;
  const snap = ud0.diffArray.image.data.slice();
  // three clears `layerUpdates` after its upload; model that here, so any
  // re-mark the next feed makes on page 0 is visible.
  diff0.clearLayerUpdates?.();
  nra0.clearLayerUpdates?.();

  const r = addSingletonsToCrossLbAtlas([makeNode(1000)], fakeScene3d);
  const st = _statAtlasStatsForTest();
  check("the next surface opens page 1", pages().length === 2 &&
        pages()[1][0] === `${key0}#p1`, pages().map(([k]) => k).join(", "));
  check("page 0 keeps its array objects", ud0.diffArray === diff0 && ud0.nraArray === nra0);
  check("page 0 bytes are untouched",
        Buffer.compare(Buffer.from(snap), Buffer.from(ud0.diffArray.image.data)) === 0);
  check("nothing on page 0 was re-marked for upload",
        diff0.layerUpdates.size === 0 && nra0.layerUpdates.size === 0,
        `diff=${diff0.layerUpdates.size} nra=${nra0.layerUpdates.size}`);
  check("no X7 grow ran", st.layerGrows === 0 && st.layerGrowUploads === 0);
  check("nothing passed through", r.passthrough.length === 0);
  const ud1 = pages()[1][1].bm.userData;
  check("the new surface took layer 0 of page 1, written in full",
        ud1.layerOf.size === 1 && ud1.diffArray.image.data[0] === (1000 & 0xff) &&
        ud1.diffArray.layerUpdates.has(0));
  check("pages are separate draws with their own material",
        pages()[1][1].bm !== b0.bm && pages()[1][1].bm.material !== b0.bm.material);
  check("...sharing ONE program (same customProgramCacheKey)",
        pages()[1][1].bm.material.customProgramCacheKey() === b0.bm.material.customProgramCacheKey());
}

// ---------------------------------------------------------------------------
console.log("PART 2 — family totals follow X7's schedule, and stop at the ceiling");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true, pages: true });
  const cap = _layerCapacityFor(TW, TH, false);
  // What X7 growth would allocate after each step, for comparison.
  const x7 = [_atlasStartLayersFor(TW, TH, false, cap)];
  while (x7[x7.length - 1] < cap) {
    const a = x7[x7.length - 1];
    x7.push(_atlasGrowTargetFor(a, a + 1, cap));
  }
  const seen = [];
  let seed = 1;
  const pt = [];
  for (let i = 0; i < cap + 5; i++) {
    const r = addSingletonsToCrossLbAtlas([makeNode(seed++)], fakeScene3d);
    pt.push(...r.passthrough);
    const t = familyAlloc();
    if (seen[seen.length - 1] !== t) seen.push(t);
  }
  const st = _statAtlasStatsForTest();
  check("every allocated total is one X7 would have held", seen.join() === x7.join(),
        `pages=${seen.join(",")} x7=${x7.join(",")}`);
  check("the family never exceeds the ceiling", familyAlloc() === cap, `alloc=${familyAlloc()} cap=${cap}`);
  check("page count is log-bounded", pages().length === x7.length && pages().length <= 8,
        `pages=${pages().length}`);
  check("surplus props fail soft to passthrough",
        pt.length === 5 && st.ptLayerFull === 5, `passthrough=${pt.length}`);
  let layers = 0;
  for (const [, b] of pages()) layers += b.bm.userData.layerOf.size;
  check("every fed node is accounted for exactly once", layers + pt.length === cap + 5);
  check("no array was ever reallocated", st.layerGrows === 0);
  check("atlasPages counts every page opened", st.atlasPages === pages().length);
}

// ---------------------------------------------------------------------------
console.log("PART 3 — dedup spans the family");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true, pages: true });
  const shared = makeTex(7);
  const start = _atlasStartLayersFor(TW, TH, false, _layerCapacityFor(TW, TH, false));
  const nodes = [makeNode(7, 0xaabb0000, shared)];
  for (let i = 1; i < start; i++) nodes.push(makeNode(100 + i));
  nodes.push(makeNode(500)); // opens page 1
  addSingletonsToCrossLbAtlas(nodes, fakeScene3d);
  const nPages = pages().length;
  const st = _statAtlasStatsForTest();
  const allocsBefore = st.layerAllocs;
  const r = addSingletonsToCrossLbAtlas([makeNode(7, 0xaabb0000, shared)], fakeScene3d);
  const e = pages()[0][1].bm.userData.layerOf.get(shared.uuid);
  check("the repeat surface is refcounted on page 0", e && e.refs === 2, `refs=${e?.refs}`);
  check("...no layer was cut and no page opened",
        st.layerAllocs === allocsBefore && pages().length === nPages && r.passthrough.length === 0);
  check("...and its geometry joined page 0's batch", pages()[0][1].bm.userData.gidVerts.size === start + 1);
}

// ---------------------------------------------------------------------------
console.log("PART 4 — eviction frees a page layer, reused before a new page");
// ---------------------------------------------------------------------------
{
  _resetStatAtlasForTest({ grow: true, nra: true, pages: true });
  const start = _atlasStartLayersFor(TW, TH, false, _layerCapacityFor(TW, TH, false));
  const a = [];
  for (let i = 0; i < start; i++) a.push(makeNode(10 + i, 0x11110000));
  addSingletonsToCrossLbAtlas(a, fakeScene3d);           // fills page 0
  addSingletonsToCrossLbAtlas([makeNode(50, 0x22220000)], fakeScene3d); // page 1
  const [, p1] = pages()[1];
  check("LB B lives on page 1", p1.bm.userData.layerOf.size === 1);
  evictStaticAtlasForLb(0x22220000);
  check("evicting LB B frees page 1's layer", p1.bm.userData.layerOf.size === 0 &&
        p1.bm.userData.freeLayers.length === 1);
  evictStaticAtlasForLb(0x11110000);
  const ud0 = pages()[0][1].bm.userData;
  check("evicting LB A frees page 0's layers", ud0.layerOf.size === 0 &&
        ud0.freeLayers.length === start);
  const n = pages().length;
  addSingletonsToCrossLbAtlas([makeNode(60, 0x33330000)], fakeScene3d);
  check("a new surface reuses page 0 (first open page), no new page",
        pages().length === n && ud0.layerOf.size === 1);
}

// ---------------------------------------------------------------------------
console.log("PART 5 — flag grammar, and `off` is X7 growth");
// ---------------------------------------------------------------------------
{
  const withSearch = (search) => {
    globalThis.window = { location: { search } };
    _resetStatAtlasForTest();
    const v = statAtlasPagesEnabled();
    delete globalThis.window;
    return v;
  };
  check("absent ⇒ ARMED", withSearch("") === true);
  check("garbage ⇒ ARMED", withSearch("?statAtlasPages=banana") === true);
  for (const off of ["off", "0", "false", "no", "OFF"]) {
    check(`?statAtlasPages=${off} disarms`, withSearch(`?statAtlasPages=${off}`) === false);
  }

  _resetStatAtlasForTest({ grow: true, nra: true, pages: false });
  const nodes = [];
  for (let i = 1; i <= 20; i++) nodes.push(makeNode(i));
  addSingletonsToCrossLbAtlas(nodes, fakeScene3d);
  const st = _statAtlasStatsForTest();
  check("disarmed: one bucket that grew, no pages",
        pages().length === 1 && st.layerGrows > 0 && st.atlasPages === 0,
        `buckets=${pages().length} grows=${st.layerGrows}`);
  _resetStatAtlasForTest();
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
