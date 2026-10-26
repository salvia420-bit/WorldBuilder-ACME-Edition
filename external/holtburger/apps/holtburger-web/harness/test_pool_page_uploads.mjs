// harness/test_pool_page_uploads.mjs — POOL-PAGE-UPLOAD (2026-10-25): every write into a pool class
// page reaches the GPU.
//
// WHY THIS SUITE EXISTS
// ---------------------
// A pool class page is one DataArrayTexture / CompressedArrayTexture per (class, tier). `admit` and
// `refeedRsId` wrote a member's layer and marked it with `addLayerUpdate`, but nothing ever set
// `needsUpdate` again after the page's first upload — and three uploads a layer only on a version
// change. Measured on the 1070 (Holtburg, chain default): diffuse layers sat written-but-unsent for
// the whole session (10 with every pending hold-out admitted), so a member admitted after its page
// first drew sampled whatever the GPU held for that layer, and a full tier landing on a pooled member
// (`refeedRsId`) never reached the screen. The atlas has always flushed (`touchedDiff`/`touchedNra`
// → `needsUpdate`, static_atlas.js). The nra layer was also packed only at admit, so a preview-born
// member whose full tier brought its normal map kept a flat nra layer for the session.
//
// WHAT MUST HOLD:
//   PART 1 — a layer admitted after the page's first upload is marked: the version moves and the
//            layer sits in `layerUpdates` (diffuse AND nra).
//   PART 2 — a refeed rewrite is marked the same way, and repacks the nra layer from the upgraded
//            material (its normal map now reaches the page).
//   PART 3 — the refused refeeds (dims / format mismatch) still touch nothing.
//
// Run:  cd apps/holtburger-web && node harness/test_pool_page_uploads.mjs

import * as THREE from "three";
import { ClassMaterialRegistry } from "../scene3d/pool_material.js";
import { axisRecordOf, classKeyOf } from "../scene3d/pool_class_key.js";

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

/** What three does after it sends a texture: the GPU copy is current, the layer list is spent. */
function markUploaded(t) {
  const v = t.version;
  if (typeof t.clearLayerUpdates === "function") t.clearLayerUpdates();
  return v;
}

const RS_A = 0x06009001, RS_B = 0x06009002;
const mk = (tex, rs, did) => {
  const m = new THREE.MeshStandardMaterial({ map: tex });
  m.userData = { surfaceDid: did, __texRsId: rs };
  return m;
};
const axes = (m) => axisRecordOf(m, { domain: "st", castShadow: false, receiveShadow: false });

// ===========================================================================
console.log("PART 1 — a layer admitted after the first upload is marked for upload");
// ===========================================================================
const cm = new ClassMaterialRegistry({ warn: () => {} });
const mA = mk(pageTex(256, 10), RS_A, 0x08000091);
const key = classKeyOf(axes(mA));
const ra = cm.admit(key, mA, axes(mA));
check("member A admitted", ra.ok === true, JSON.stringify(ra));
const c = [...cm.classes.values()][0];
check("the page carries an nra array (statNra default ON)", !!c.arrays.nra);
const diffV = markUploaded(c.arrays.diff);
const nraV = c.arrays.nra ? markUploaded(c.arrays.nra) : 0;
const mB = mk(pageTex(256, 20), RS_B, 0x08000092);
const rb = cm.admit(classKeyOf(axes(mB)), mB, axes(mB));
check("member B admitted into the same page", rb.ok === true && cm.classes.size === 1, JSON.stringify(rb));
check("diffuse: the version moved after the first upload", c.arrays.diff.version > diffV,
  `${c.arrays.diff.version} vs ${diffV}`);
check("diffuse: B's layer is queued", c.arrays.diff.layerUpdates.has(rb.layer), JSON.stringify([...c.arrays.diff.layerUpdates]));
check("nra: the version moved", !c.arrays.nra || c.arrays.nra.version > nraV);
check("nra: B's layer is queued", !c.arrays.nra || c.arrays.nra.layerUpdates.has(rb.layer));

// ===========================================================================
console.log("PART 2 — a refeed rewrite is marked, and repacks nra from the upgraded material");
// ===========================================================================
{
  const dV = markUploaded(c.arrays.diff);
  const nraBefore = c.arrays.nra;
  const nV = c.arrays.nra ? markUploaded(c.arrays.nra) : 0;
  // The full tier lands: same page dims, new pixels, and now a real normal map.
  mA.map = pageTex(256, 77);
  const n = new THREE.DataTexture(new Uint8Array(256 * 256 * 4).fill(0), 256, 256, THREE.RGBAFormat);
  for (let i = 0; i < 256 * 256; i++) { n.image.data[i * 4] = 220; n.image.data[i * 4 + 1] = 40; n.image.data[i * 4 + 2] = 200; n.image.data[i * 4 + 3] = 255; }
  mA.normalMap = n;
  check("the refeed rewrites A's layer", cm.refeedRsId(RS_A) === 1);
  check("diffuse: the version moved", c.arrays.diff.version > dV);
  check("diffuse: A's layer is queued", c.arrays.diff.layerUpdates.has(ra.layer));
  check("diffuse: the new pixels are in the page", c.arrays.diff.image.data[ra.layer * 256 * 256 * 4] === 77);
  if (c.arrays.nra) {
    const px = 256 * 256 * 4;
    const r = c.arrays.nra.image.data[ra.layer * px], g = c.arrays.nra.image.data[ra.layer * px + 1];
    check("nra: repacked from the upgraded normal map (no longer the flat 128/128)", r !== 128 || g !== 128, `r=${r} g=${g}`);
    // POOL-NRA-SOURCE-RES: A and B were flat, so the page started at 1x1 and A's 256² normal grew
    // it — a NEW texture, which three sends in full on first use.
    check("nra: sent — the version moved, or the page was re-allocated",
      c.arrays.nra !== nraBefore || c.arrays.nra.version > nV);
    check("nra: A's layer is queued", c.arrays.nra.layerUpdates.has(ra.layer));
  }
}

// ===========================================================================
console.log("PART 3 — refused refeeds touch nothing");
// ===========================================================================
{
  const dV = markUploaded(c.arrays.diff);
  mA.map = pageTex(512, 5); // a different page tier
  check("a dims-mismatched refeed is refused", cm.refeedRsId(RS_A) === 0);
  check("…and nothing was queued", c.arrays.diff.version === dV && c.arrays.diff.layerUpdates.size === 0);
}
cm.dispose();

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "POOL-PAGE-UPLOADS ✅" : "POOL-PAGE-UPLOADS ❌");
process.exit(failed === 0 ? 0 : 1);
