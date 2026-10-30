// scripts/perf-worker/layer-mip-probe.eval.js — the R3-1 LAYER-MIP READBACK PROBE (R3-3 precondition).
// Page-side; written 2026-10-30 (lane H); harness only, never ships.
//
// WHY. R3-3's array pages admit an RGBA8 surface texture as a layer like this (plan §3 R3-3 item 1):
// upload to a scratch 2D texture of the same size and internal format, `gl.generateMipmap` it (the same
// ANGLE/D3D11 path three uses today: scene3d/adapter.js surfacePixelsToTexture sets generateMipmaps),
// then copy each level GPU-side into (layer, level) with framebufferTexture2D + copyTexSubImage3D.
// Rule R4 wants the array layers BYTE-EQUAL on the 1070 readback to today's per-surface 2D textures,
// level by level — on the real driver, not only SwiftShader (plan §6 risk row "Array-layer mips").
//
// WHAT. For up to `maxTextures` live surface textures (THREE.DataTexture, RGBA / UnsignedByte,
// generateMipmaps, uploaded, pixels still on the texture), spread over the sizes present:
//   three   the texture three uploaded (renderer.properties.get(tex).__webglTexture);
//   scratch texStorage2D(levels, same internal format: SRGB8_ALPHA8 for sRGB colour space, else RGBA8)
//           + texSubImage2D(level 0, the same bytes) + generateMipmap;
//   copyA   scratch levels copied into layer `layer` of a TEXTURE_2D_ARRAY with copyTexSubImage3D;
//   blitB   the same with blitFramebuffer into framebufferTextureLayer (the alternative admit path).
// Each level of each is read back with readPixels(RGBA, UNSIGNED_BYTE) from a framebuffer that has
// the level (or layer, level) attached, and compared byte for byte with three's level.
// SENSITIVITY CONTROL (per internal format, SRGB8_ALPHA8 and RGBA8): a 4x4 texture whose RGB bytes are
// DARK (2..5: an sRGB->linear decode maps every one of them to linear byte 0) is uploaded twice, the
// second copy with one byte changed by 1 LSB in each of R, G, B and A. The control passes only if
// each upload reads back EXACTLY its own bytes and the two differ in exactly those four bytes. A
// readback that decoded sRGB (or quantised in any other way) would collapse the dark RGB values and
// fail it, so a passing control shows readPixels returns the raw stored bytes of every channel, and
// byte equality below is real byte equality. FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING is recorded next
// to it. Compressed (BC7 / S3TC) surfaces are counted, not tested: their admit path
// copies the baked bytes with compressedTexSubImage3D, no driver mips involved.
// RESTORES: deletes everything it created, then renderer.resetState() so three re-binds its state.
//
// FORMAT: the BODY of an async function (`node scripts/perf-worker/hbsess.mjs eval layer-mip-probe.eval.js`).
// Options: window.__hbEvalOpts / window.__layerMipOpts: {maxTextures: 24, layer: 1, minSize: 4,
// selfTest: false}. `selfTest: true` touches nothing and returns the pure helpers' results on
// synthetic data (tests/hb_v2.test.mjs).

const W = typeof window !== "undefined" ? window : globalThis;
const OPTS = Object.assign({ maxTextures: 24, layer: 1, minSize: 4, selfTest: false }, W.__layerMipOpts || {}, W.__hbEvalOpts || {});
const SCHEMA = "hb-layer-mip-probe-v1";

const mipLevels = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;
const levelSize = (n, l) => Math.max(1, n >> l);
/** null when equal, else {at, a, b, count, maxAbs} over the whole buffer. */
function firstDiff(a, b) {
  if (a.length !== b.length) return { at: -1, lengthA: a.length, lengthB: b.length };
  let at = -1, count = 0, maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { if (at < 0) at = i; count++; const d = Math.abs(a[i] - b[i]); if (d > maxAbs) maxAbs = d; }
  }
  return at < 0 ? null : { at, texel: at >> 2, channel: at & 3, a: a[at], b: b[at], count, maxAbs };
}
/** The control pair (see the header): dark RGB, distinct alpha, and one 1-LSB change per channel. */
function controlData() {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { a[i * 4] = 2 + (i % 4); a[i * 4 + 1] = 3; a[i * 4 + 2] = 4; a[i * 4 + 3] = 200 + i; }
  const b = new Uint8Array(a);
  const at = [0, 5, 10, 15]; // texel 0 R, texel 1 G, texel 2 B, texel 3 A
  for (const k of at) b[k] += 1;
  return { w, h, a, b, at };
}
/** Control verdict from the two read-backs: raw (each equals its upload) and sensitive (exactly the four changed bytes differ). */
function controlVerdict(c, ra, rb) {
  const rawA = !!ra && firstDiff(c.a, ra) === null, rawB = !!rb && firstDiff(c.b, rb) === null;
  const diffAt = [];
  if (ra && rb && ra.length === rb.length) for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) diffAt.push(i);
  const sensitive = diffAt.length === c.at.length && diffAt.every((x, i) => x === c.at[i]);
  return { raw: rawA && rawB, sensitive, detected: rawA && rawB && sensitive, diffAt: diffAt.slice(0, 8) };
}
/** What an sRGB-decoding readback would return (RGB through sRGB->linear, 8-bit; alpha kept): the self-test's negative case. */
function srgbDecodedReadback(buf) {
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    if ((i & 3) === 3) { out[i] = buf[i]; continue; }
    const v = buf[i] / 255;
    out[i] = Math.round(255 * (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  }
  return out;
}
/** Pick up to n items spread over the sorted sizes (largest, smallest and evenly between). */
function spread(items, n) {
  if (items.length <= n) return items.slice();
  const s = items.slice().sort((x, y) => x.w * x.h - y.w * y.h);
  const out = [];
  for (let i = 0; i < n; i++) out.push(s[Math.round((i * (s.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

if (OPTS.selfTest) {
  const cd = controlData();
  const alphaOnly = new Uint8Array(cd.a); alphaOnly[3] += 1; // the old control: one alpha byte
  return {
    schema: SCHEMA, selfTest: true,
    control: {
      at: cd.at, darkRgb: [cd.a[0], cd.a[1], cd.a[2]],
      raw: controlVerdict(cd, cd.a, cd.b),                                              // a raw readback passes
      decoded: controlVerdict(cd, srgbDecodedReadback(cd.a), srgbDecodedReadback(cd.b)), // an sRGB-decoding one fails
      alphaOnlyDecoded: firstDiff(srgbDecodedReadback(cd.a), srgbDecodedReadback(alphaOnly)) !== null, // why alpha alone proves nothing about RGB
    },
    levels: [mipLevels(256, 256), mipLevels(256, 64), mipLevels(1, 1), mipLevels(300, 20)],
    sizes: [levelSize(256, 3), levelSize(64, 7), levelSize(5, 1)],
    equal: firstDiff(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4])),
    diff: firstDiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), new Uint8Array([1, 2, 3, 4, 5, 6, 9, 8])),
    spread: spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((w) => ({ w, h: 1 })), 3).map((x) => x.w),
  };
}

const L = W.liveScene3d;
if (!L || !L.renderer || !L.scene) return { schema: SCHEMA, error: "no liveScene3d (not booted?)" };
const r = L.renderer, gl = r.getContext();
if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return { schema: SCHEMA, error: "not a WebGL2 context" };
const props = r.properties;
const RGBA = 1023, UBYTE = 1009, LMML = 1008; // THREE.RGBAFormat, UnsignedByteType, LinearMipmapLinearFilter
const out = { schema: SCHEMA, at: new Date().toISOString(), opts: OPTS, adapter: null, candidates: 0, compressedSeen: 0, textures: [], summary: null, errors: [] };
try { const e = gl.getExtension("WEBGL_debug_renderer_info"); out.adapter = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; } catch (_) { /* no ext */ }

// 1. candidates: every live surface texture three has uploaded and still holds the pixels of
const seen = new Set(), cands = [];
L.scene.traverse((o) => {
  const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  for (const m of mats) {
    for (const k in m) {
      const t = m[k];
      if (!t || t.isTexture !== true || seen.has(t)) continue;
      seen.add(t);
      if (t.isCompressedTexture) { out.compressedSeen++; continue; }
      if (!t.isDataTexture || t.format !== RGBA || t.type !== UBYTE || !t.generateMipmaps || t.minFilter !== LMML) continue;
      const img = t.image;
      if (!img || !img.data || !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)) continue;
      if (img.width < OPTS.minSize || img.height < OPTS.minSize || img.data.length < img.width * img.height * 4) continue;
      const p = props.get(t);
      if (!p || !p.__webglTexture) continue;
      cands.push({ t, w: img.width, h: img.height, gl: p.__webglTexture });
    }
  }
});
out.candidates = cands.length;

const made = { tex: [], fb: [] };
const mk = (kind) => { const x = kind === "fb" ? gl.createFramebuffer() : gl.createTexture(); made[kind].push(x); return x; };
const fbR = mk("fb"), fbD = mk("fb");
const read2D = (tex, level, w, h) => {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbR);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level);
  const st = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) return { status: st };
  const enc = gl.getFramebufferAttachmentParameter(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING);
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf, enc };
};
const readLayer = (tex, level, layer, w, h) => {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbR);
  gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, level, layer);
  const st = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) return { status: st };
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return { buf };
};
const upload = (IF, w, h, levels, data, mips) => {
  const t = mk("tex");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, levels, IF, w, h);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
};
let sensitivity = null;
const enc = new Set();
const tally = { scratchVsThree: [0, 0], copyTexSubImage3D: [0, 0], blitFramebuffer: [0, 0] };
try {
  // sensitivity control first, for both internal formats the candidates can use
  const controls = {};
  for (const [name, IF] of [["SRGB8_ALPHA8", gl.SRGB8_ALPHA8], ["RGBA8", gl.RGBA8]]) {
    const cd = controlData();
    const ta = upload(IF, cd.w, cd.h, 1, cd.a, false), tb = upload(IF, cd.w, cd.h, 1, cd.b, false);
    const ra = read2D(ta, 0, cd.w, cd.h), rb = read2D(tb, 0, cd.w, cd.h);
    controls[name] = { ...controlVerdict(cd, ra.buf, rb.buf), encoding: ra.enc === 0x8c40 ? "SRGB" : ra.enc === 0x2601 ? "LINEAR" : ra.enc ?? ra.status };
  }
  sensitivity = { detected: Object.values(controls).every((x) => x.detected), controls };
  for (const c of spread(cands, OPTS.maxTextures)) {
    const t = c.t, w = c.w, h = c.h;
    const srgb = t.colorSpace === "srgb";
    const IF = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    const levels = mipLevels(w, h);
    const data = t.image.data instanceof Uint8Array ? t.image.data.subarray(0, w * h * 4) : new Uint8Array(t.image.data.buffer, t.image.data.byteOffset, w * h * 4);
    let alpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { alpha = true; break; }
    const rec = { name: t.name || null, w, h, srgb, levels, alpha, levelsChecked: 0, scratchVsThree: [], copyTexSubImage3D: [], blitFramebuffer: [], glErrors: [] };
    const scratch = upload(IF, w, h, levels, data, true);
    const layers = OPTS.layer + 1;
    const arrA = mk("tex"), arrB = mk("tex");
    for (const a of [arrA, arrB]) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, a); gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, IF, w, h, layers); }
    for (let l = 0; l < levels; l++) {
      const lw = levelSize(w, l), lh = levelSize(h, l);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbR);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scratch, l);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrA);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, l, 0, 0, OPTS.layer, 0, 0, lw, lh);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbD);
      gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, arrB, l, OPTS.layer);
      gl.blitFramebuffer(0, 0, lw, lh, 0, 0, lw, lh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      const e = gl.getError(); if (e) rec.glErrors.push({ level: l, error: e });
    }
    for (let l = 0; l < levels; l++) {
      const lw = levelSize(w, l), lh = levelSize(h, l);
      const a = read2D(c.gl, l, lw, lh);
      if (!a.buf) { rec.scratchVsThree.push({ level: l, status: a.status }); continue; }
      enc.add(a.enc);
      const s = read2D(scratch, l, lw, lh), x = readLayer(arrA, l, OPTS.layer, lw, lh), y = readLayer(arrB, l, OPTS.layer, lw, lh);
      const cmp = (k, other) => {
        const d = other.buf ? firstDiff(a.buf, other.buf) : { status: other.status };
        rec[k].push({ level: l, equal: d === null, diff: d });
        tally[k][d === null ? 0 : 1]++;
      };
      cmp("scratchVsThree", s); cmp("copyTexSubImage3D", x); cmp("blitFramebuffer", y);
      rec.levelsChecked++;
    }
    // keep the result compact: only the levels that differ carry their diff
    for (const k of ["scratchVsThree", "copyTexSubImage3D", "blitFramebuffer"]) rec[k] = { allEqual: rec[k].every((x) => x.equal), differing: rec[k].filter((x) => !x.equal) };
    out.textures.push(rec);
  }
} catch (e) {
  out.errors.push(String((e && e.stack) || e).slice(0, 400));
} finally {
  try { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); } catch (_) { /* lost */ }
  for (const t of made.tex) { try { gl.deleteTexture(t); } catch (_) { /* lost */ } }
  for (const f of made.fb) { try { gl.deleteFramebuffer(f); } catch (_) { /* lost */ } }
  try { r.resetState(); } catch (_) { /* best effort */ }
}
const all = (k) => out.textures.length > 0 && out.textures.every((t) => t[k].allEqual);
out.summary = {
  tested: out.textures.length, levels: out.textures.reduce((a, t) => a + t.levelsChecked, 0),
  allEqual: { scratchVsThree: all("scratchVsThree"), copyTexSubImage3D: all("copyTexSubImage3D"), blitFramebuffer: all("blitFramebuffer") },
  levelCounts: Object.fromEntries(Object.entries(tally).map(([k, [eq, ne]]) => [k, { equal: eq, differ: ne }])),
  readEncoding: [...enc].map((e) => (e === 0x8c40 ? "SRGB" : e === 0x2601 ? "LINEAR" : e)),
  sensitivity,
  verdict: !sensitivity || !sensitivity.detected ? "READBACK NOT RAW (the sensitivity control failed: dark RGB / 1-LSB changes not read back exactly): byte equality below proves nothing"
    : !out.textures.length ? "NO CANDIDATES (boot at Holtburg, settled, before running)"
    : all("copyTexSubImage3D") ? "PASS: copyTexSubImage3D layers byte-equal to today's textures, every level" : all("blitFramebuffer") ? "copyTexSubImage3D differs; blitFramebuffer is byte-equal: R3-3 must admit with blitFramebuffer"
      : "FAIL: neither admit path is byte-equal: R3-3's admit path changes before K1 ships",
};
return out;
