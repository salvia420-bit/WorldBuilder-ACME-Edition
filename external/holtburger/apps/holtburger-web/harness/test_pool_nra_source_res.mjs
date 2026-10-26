// harness/test_pool_nra_source_res.mjs — POOL-NRA-SOURCE-RES (2026-10-26): a pool class's nra page
// is sized at its members' PLANES, not at the class's diffuse page.
//
// WHY THIS SUITE EXISTS
// ---------------------
// The atlas has sized its nra layers at the source planes since memory-1 (`?nraSourceRes`, DEFAULT
// ON, owner-approved): the planes `packNraLayer` reads (worker normal = half the x4 BC7 tier, seam
// height and texchan roughness/AO = DAT size) are smaller than the x4 diffuse, and a diffuse-sized
// layer is 2x2 / 4x4 nearest-neighbour copies of every real texel. The pool class pages (the chain's
// drawPools) never got the rule: 198 MiB of nra pages at Holtburg on the 1070, up to 16 MiB per
// 2048² layer sent and re-mipped on every admit once the page uploads worked (POOL-PAGE-UPLOAD).
// A class page has ONE material, so it cannot split by nra size like an atlas bucket; it holds the
// MAX of its members' asks and grows when a larger member arrives.
//
// WHAT MUST HOLD:
//   PART 1 — the page takes the first member's plane size, and the layer is its normal EXACTLY.
//   PART 2 — a larger member grows the page; every live layer is repacked (the smaller one lifted
//            2x2), the live uniform re-pointed, the old page disposed, every layer queued.
//   PART 3 — a smaller member never shrinks the page (it is lifted, as before).
//   PART 4 — a flat first member starts the page at 1x1; flat members never grow it; a texchan
//            plane does.
//   PART 5 — a normal plane only the wasm decode memo holds still counts (the packer reads it).
//   PART 6 — layer growth keeps the nra size and copies the live prefix at the nra stride.
//   PART 7 — a refeed that brings a larger normal grows the page.
//   PART 8 — the census reports the nra size and the smaller bytes.
//   PART 9 — `?nraSourceRes=off`: the page is the diffuse size, byte-identical to the old packer.
//   PART 10 — the ask is clamped to the page.
//
// Run:  cd apps/holtburger-web && node harness/test_pool_nra_source_res.mjs

import * as THREE from "three";
import { ClassMaterialRegistry, _nraAskFor } from "../scene3d/pool_material.js";
import { axisRecordOf, classKeyOf } from "../scene3d/pool_class_key.js";
import { packNraLayer, _resetStatAtlasForTest } from "../scene3d/static_atlas.js";
import { initSurfacePlanes, __resetSurfacePlanesForTests } from "../scene3d/surface_planes.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

function pageTex(edge, fill = 0) {
  const t = new THREE.DataTexture(new Uint8Array(edge * edge * 4).fill(fill), edge, edge, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
/** A normal map whose every texel is distinct enough to prove where it landed. */
function normalTex(edge, seed) {
  const d = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      const o = (y * edge + x) * 4;
      d[o] = (x * 7 + seed) & 255;
      d[o + 1] = (y * 13 + seed * 3) & 255;
      d[o + 2] = 255;
      d[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, edge, edge, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
const mk = (edge, { normal = null, rough = null, did = 0, rs = 0 } = {}) => {
  const m = new THREE.MeshStandardMaterial({ map: pageTex(edge, 10) });
  if (normal) m.normalMap = normal;
  if (rough) m.roughnessMap = rough;
  m.userData = { surfaceDid: did, __texRsId: rs };
  return m;
};
const axes = (m) => axisRecordOf(m, { domain: "st", castShadow: false, receiveShadow: false });
const admit = (cm, m) => cm.admit(classKeyOf(axes(m)), m, axes(m));
const markUploaded = (t) => { if (typeof t.clearLayerUpdates === "function") t.clearLayerUpdates(); return t.version; };

/** Does layer `layer` of `arr` (nw x nh) hold `src`'s R/G, nearest-neighbour lifted? */
function layerMatches(arr, layer, nw, nh, src) {
  const sw = src.image.width, sh = src.image.height, s = src.image.data;
  const d = arr.image.data;
  const base = layer * nw * nh * 4;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(sh - 1, ((y * sh) / nh) | 0);
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(sw - 1, ((x * sw) / nw) | 0);
      const o = base + (y * nw + x) * 4, so = (sy * sw + sx) * 4;
      if (d[o] !== s[so] || d[o + 1] !== s[so + 1]) return `(${x},${y}) got ${d[o]},${d[o + 1]} want ${s[so]},${s[so + 1]}`;
    }
  }
  return true;
}

// ===========================================================================
console.log("PART 1 — the page takes the first member's plane size; the layer is its normal exactly");
// ===========================================================================
const cm = new ClassMaterialRegistry({ warn: () => {} });
const nA = normalTex(128, 1);
const mA = mk(256, { normal: nA, did: 0x08000101, rs: 0x06001001 });
const ra = admit(cm, mA);
check("A admitted", ra.ok === true, JSON.stringify(ra));
const c = [...cm.classes.values()][0];
check("the class page is the diffuse size (256²)", c.w === 256 && c.h === 256);
check("the nra page is the normal's size (128²), not the diffuse's", c.nw === 128 && c.nh === 128 &&
  c.arrays.nra.image.width === 128 && c.arrays.nra.image.height === 128, `${c.nw}x${c.nh}`);
check("nra bytes = 128² x 4 x allocLayers", c.arrays.nra.image.data.length === 128 * 128 * 4 * c.allocLayers);
check("A's layer IS its normal, texel for texel", layerMatches(c.arrays.nra, ra.layer, 128, 128, nA) === true,
  String(layerMatches(c.arrays.nra, ra.layer, 128, 128, nA)));
check("A's layer is queued for upload", c.arrays.nra.layerUpdates.has(ra.layer));
check("no resize for the first member", cm.stats.nraResizes === 0);

// ===========================================================================
console.log("PART 2 — a larger member grows the page; every live layer is repacked");
// ===========================================================================
{
  const before = c.arrays.nra;
  let disposed = false;
  before.addEventListener("dispose", () => { disposed = true; });
  c.material.userData._statArrayUniforms = { uNraArray: { value: before } }; // what a compile stamps
  markUploaded(before);
  const nB = normalTex(256, 2);
  const mB = mk(256, { normal: nB, did: 0x08000102, rs: 0x06001002 });
  const rb = admit(cm, mB);
  check("B admitted into the same page", rb.ok === true && cm.classes.size === 1, JSON.stringify(rb));
  check("the page grew to 256²", c.nw === 256 && c.nh === 256 && c.arrays.nra.image.width === 256);
  check("one resize counted", cm.stats.nraResizes === 1, String(cm.stats.nraResizes));
  check("B's layer is its normal exactly", layerMatches(c.arrays.nra, rb.layer, 256, 256, nB) === true);
  check("A's layer was repacked, lifted 2x2 from its 128² normal",
    layerMatches(c.arrays.nra, ra.layer, 256, 256, nA) === true, String(layerMatches(c.arrays.nra, ra.layer, 256, 256, nA)));
  check("the live uniform points at the new page", c.material.userData._statArrayUniforms.uNraArray.value === c.arrays.nra);
  check("the old page was disposed", disposed === true);
  check("both live layers are queued on the new page",
    c.arrays.nra.layerUpdates.has(ra.layer) && c.arrays.nra.layerUpdates.has(rb.layer));
  check("the new page will upload (version > 0)", c.arrays.nra.version > 0);
}

// ===========================================================================
console.log("PART 3 — a smaller member never shrinks the page");
// ===========================================================================
{
  const nC = normalTex(64, 3);
  const mC = mk(256, { normal: nC, did: 0x08000103, rs: 0x06001003 });
  const before = c.arrays.nra;
  const rc = admit(cm, mC);
  check("C admitted", rc.ok === true);
  check("no resize, same page", cm.stats.nraResizes === 1 && c.arrays.nra === before && c.nw === 256);
  check("C is lifted 4x4 into the 256² page", layerMatches(c.arrays.nra, rc.layer, 256, 256, nC) === true);
}
cm.dispose();

// ===========================================================================
console.log("PART 4 — a flat first member starts at 1x1; flat members never grow it; texchan does");
// ===========================================================================
{
  const cf = new ClassMaterialRegistry({ warn: () => {} });
  const r1 = admit(cf, mk(256, { did: 0x08000201 }));
  const k = [...cf.classes.values()][0];
  check("flat first member admitted", r1.ok === true);
  check("the nra page starts at 1x1", k.nw === 1 && k.nh === 1 && k.arrays.nra.image.width === 1);
  const flat = k.arrays.nra.image.data.subarray(r1.layer * 4, r1.layer * 4 + 4);
  check("the 1x1 layer is the flat texel (128,128,255,255)", flat[0] === 128 && flat[1] === 128 && flat[2] === 255 && flat[3] === 255,
    Array.from(flat).join(","));
  admit(cf, mk(256, { did: 0x08000202 }));
  check("a second flat member does not grow it", k.nw === 1 && cf.stats.nraResizes === 0);
  const rough = new THREE.DataTexture(new Uint8Array(128 * 128 * 4).fill(100), 128, 128, THREE.RGBAFormat);
  const r3 = admit(cf, mk(256, { rough, did: 0x08000203 }));
  check("a 128² texchan roughness plane grows it to 128²", r3.ok && k.nw === 128 && k.nh === 128 && cf.stats.nraResizes === 1);
  const o = (r3.layer * 128 * 128) * 4;
  check("its roughness reached the B channel (100 x roughness 1.0)", k.arrays.nra.image.data[o + 2] === 100,
    String(k.arrays.nra.image.data[o + 2]));
  const o1 = (r1.layer * 128 * 128) * 4;
  check("the flat layers were repacked flat at 128²", k.arrays.nra.image.data[o1] === 128 && k.arrays.nra.image.data[o1 + 2] === 255);
  cf.dispose();
}

// ===========================================================================
console.log("PART 5 — a normal plane only the wasm decode memo holds still counts");
// ===========================================================================
{
  const DID = 0x08000301;
  const plane = normalTex(128, 5).image.data;
  initSurfacePlanes({
    surfacePlanesCached: (did) => (did === DID
      ? { width: 128, height: 128, pixels: new Uint8Array(128 * 128 * 4), normalPixels: plane, heightPixels: new Uint8Array(0), free() {} }
      : null),
  });
  const m = mk(256, { did: DID }); // no normalMap on the material at all
  const ask = _nraAskFor(m, 256, 256);
  check("the ask sees the memo's 128² normal", ask && ask.w === 128 && ask.h === 128, JSON.stringify(ask));
  const cmemo = new ClassMaterialRegistry({ warn: () => {} });
  const r = admit(cmemo, m);
  const k = [...cmemo.classes.values()][0];
  check("the page is 128², not 1x1", r.ok && k.nw === 128 && k.nh === 128, `${k.nw}x${k.nh}`);
  const src = { image: { width: 128, height: 128, data: plane } };
  check("the memo normal landed texel for texel", layerMatches(k.arrays.nra, r.layer, 128, 128, src) === true);
  cmemo.dispose();
  __resetSurfacePlanesForTests();
}

// ===========================================================================
console.log("PART 6 — layer growth keeps the nra size and copies the live prefix");
// ===========================================================================
{
  const cg = new ClassMaterialRegistry({ warn: () => {} });
  const normals = [];
  const results = [];
  for (let i = 0; i < 6; i++) {
    const n = normalTex(128, 10 + i);
    normals.push(n);
    results.push(admit(cg, mk(256, { normal: n, did: 0x08000400 + i })));
  }
  const k = [...cg.classes.values()][0];
  check("all six admitted", results.every((r) => r.ok), JSON.stringify(results));
  check("the page grew in layers", cg.stats.layerGrows >= 1 && k.allocLayers >= 6, `grows=${cg.stats.layerGrows} alloc=${k.allocLayers}`);
  check("…and kept its 128² nra size", k.nw === 128 && k.arrays.nra.image.width === 128 &&
    k.arrays.nra.image.data.length === 128 * 128 * 4 * k.allocLayers);
  check("no nra resize from layer growth", cg.stats.nraResizes === 0);
  let ok = true;
  for (let i = 0; i < 6; i++) if (layerMatches(k.arrays.nra, results[i].layer, 128, 128, normals[i]) !== true) ok = false;
  check("every layer (copied prefix and new) still holds its own normal", ok);
  cg.dispose();
}

// ===========================================================================
console.log("PART 7 — a refeed that brings a larger normal grows the page");
// ===========================================================================
{
  const cr = new ClassMaterialRegistry({ warn: () => {} });
  const RS = 0x06007001;
  const m = mk(256, { normal: normalTex(128, 20), did: 0x08000701, rs: RS });
  const r = admit(cr, m);
  const k = [...cr.classes.values()][0];
  check("admitted at 128²", r.ok && k.nw === 128);
  m.map = pageTex(256, 77);
  const nBig = normalTex(256, 21);
  m.normalMap = nBig;
  check("the refeed rewrites the layer", cr.refeedRsId(RS) === 1);
  check("the page grew to 256²", k.nw === 256 && cr.stats.nraResizes === 1);
  check("the layer is the new normal exactly", layerMatches(k.arrays.nra, r.layer, 256, 256, nBig) === true);
  check("…and is queued", k.arrays.nra.layerUpdates.has(r.layer));
  cr.dispose();
}

// ===========================================================================
console.log("PART 8 — the census reports the nra size and the smaller bytes");
// ===========================================================================
{
  const cc = new ClassMaterialRegistry({ warn: () => {} });
  admit(cc, mk(256, { normal: normalTex(128, 30), did: 0x08000801 }));
  const k = [...cc.classes.values()][0];
  const row = Object.values(cc.census().byClass)[0];
  check("byClass carries nw/nh", row.nw === 128 && row.nh === 128, JSON.stringify(row));
  const want = k.allocLayers * (256 * 256 * 4 + 128 * 128 * 4);
  check("allocated bytes count the nra page at its own size", cc.census().pageBytes.allocated === want,
    `${cc.census().pageBytes.allocated} vs ${want}`);
  cc.dispose();
}

// ===========================================================================
console.log("PART 9 — ?nraSourceRes=off: the diffuse size, byte-identical to the old packer");
// ===========================================================================
{
  _resetStatAtlasForTest({ nraSourceRes: false });
  const co = new ClassMaterialRegistry({ warn: () => {} });
  const n = normalTex(128, 40);
  const m = mk(256, { normal: n, did: 0x08000901 });
  const r = admit(co, m);
  const k = [...co.classes.values()][0];
  check("the nra page is the diffuse size (256²)", r.ok && k.nw === 256 && k.nh === 256 && k.arrays.nra.image.width === 256);
  // The old code: packNraLayer at the page dims into a fresh array.
  const ref = new THREE.DataArrayTexture(new Uint8Array(256 * 256 * 4 * k.allocLayers).fill(0), 256, 256, k.allocLayers);
  ref.image.data.set(k.arrays.nra.image.data);
  packNraLayer(ref, r.layer, m, 256, 256, null);
  const a = k.arrays.nra.image.data, b = ref.image.data;
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  check("the layer is byte-identical to packNraLayer at 256²", same);
  admit(co, mk(256, { normal: normalTex(256, 41), did: 0x08000902 }));
  check("no resize ever", co.stats.nraResizes === 0 && k.nw === 256);
  check("the ask is the page itself", JSON.stringify(_nraAskFor(m, 256, 256)) === JSON.stringify({ w: 256, h: 256 }));
  co.dispose();
  _resetStatAtlasForTest({});
}

// ===========================================================================
console.log("PART 10 — the ask is clamped to the page");
// ===========================================================================
{
  const m = mk(256, { normal: normalTex(512, 50) });
  const ask = _nraAskFor(m, 256, 256);
  check("a 512² normal on a 256² page asks for 256²", ask && ask.w === 256 && ask.h === 256, JSON.stringify(ask));
  check("a material with no planes asks for nothing", _nraAskFor(mk(256), 256, 256) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "POOL-NRA-SOURCE-RES ✅" : "POOL-NRA-SOURCE-RES ❌");
process.exit(failed === 0 ? 0 : 1);
