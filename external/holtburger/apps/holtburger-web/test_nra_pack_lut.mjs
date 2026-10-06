// 2026-10-06 — static_atlas.js packNraLayer per-pixel maps became 256-entry
// tables; the packed bytes must be IDENTICAL to the original float expressions.
//
// Run:
//   cd apps/holtburger-web/
//   node test_nra_pack_lut.mjs

import { packNraLayer, buildNraArray } from "./scene3d/static_atlas.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
const tex = (w, h, stride) => { const d = new Uint8Array(w * h * stride); for (let i = 0; i < d.length; i++) d[i] = rnd(); return { image: { data: d, width: w, height: h } }; };
// The pre-LUT reference, verbatim arithmetic.
function lift(t, ch, w, h) {
  if (!t) return null;
  const { data, width: sw, height: sh } = t.image; const stride = Math.floor(data.length / (sw * sh));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const sy = Math.min(sh - 1, ((y * sh) / h) | 0); for (let x = 0; x < w; x++) { const sx = Math.min(sw - 1, ((x * sw) / w) | 0); out[y * w + x] = data[(sy * sw + sx) * stride + ch]; } }
  return out;
}
function reference(mat, w, h) {
  const px = w * h, dst = new Uint8Array(px * 4);
  let scale = Number(mat.userData?.normalScaleEffective); if (!Number.isFinite(scale)) scale = Number(mat.normalScale?.x); if (!Number.isFinite(scale)) scale = 1.0;
  const nR = lift(mat.normalMap, 0, w, h), nG = nR ? lift(mat.normalMap, 1, w, h) : null, rgh = lift(mat.roughnessMap, 1, w, h), ao = lift(mat.aoMap, 0, w, h);
  const roughScalar = Math.min(1, Math.max(0, Number.isFinite(mat.roughness) ? mat.roughness : 1)), roughFlat = Math.round(roughScalar * 255);
  for (let i = 0; i < px; i++) { const o = i * 4;
    if (nR && nG) { const x = ((nR[i] / 255) * 2 - 1) * scale, y = ((nG[i] / 255) * 2 - 1) * scale;
      dst[o] = Math.max(0, Math.min(255, Math.round((x * 0.5 + 0.5) * 255))); dst[o + 1] = Math.max(0, Math.min(255, Math.round((y * 0.5 + 0.5) * 255))); }
    else { dst[o] = 128; dst[o + 1] = 128; }
    dst[o + 2] = rgh ? Math.round(roughScalar * rgh[i]) : roughFlat;
    dst[o + 3] = ao ? ao[i] : 255; }
  return dst;
}
const cases = [
  ["all channels, same size", { normalMap: tex(64, 64, 4), roughnessMap: tex(64, 64, 4), aoMap: tex(64, 64, 1), roughness: 0.83, userData: { normalScaleEffective: 0.7 } }],
  ["resampled roughness/AO (32→64)", { normalMap: tex(64, 64, 4), roughnessMap: tex(32, 32, 4), aoMap: tex(48, 40, 1), roughness: 0.5, normalScale: { x: 1.6 }, userData: {} }],
  ["normal only, scale > 1 clamps", { normalMap: tex(64, 64, 4), roughness: 1, userData: { normalScaleEffective: 2.5 } }],
  ["no maps at all (flat layer)", { roughness: 0.25, userData: {} }],
];
for (const [name, mat] of cases) {
  const arr = buildNraArray(64, 64, 2);
  packNraLayer(arr, 1, mat, 64, 64, null);
  const got = arr.image.data.subarray(64 * 64 * 4);
  const want = reference(mat, 64, 64);
  let diff = 0; for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) diff++;
  check(name + " — byte-identical", diff === 0, diff ? `${diff} bytes differ` : "");
  const l0 = arr.image.data.subarray(0, 64 * 64 * 4);
  check(name + " — neighbouring layer untouched", l0.every((v, i) => v === [128, 128, 255, 255][i & 3]));
}
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
