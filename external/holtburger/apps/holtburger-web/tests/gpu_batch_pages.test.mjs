// tests/gpu_batch_pages.test.mjs — R3-3 K1: texture-array pages
// (scene3d/gpu_batch/page_allocator.js + array_pages.js;
// docs/2026-10-29-round3-gpu-driven.md §R3-3 item 1).
//
// Locks:
//   1. mip / byte arithmetic: the full chain three r184 allocates
//      (log2(max)+1, truncated), per-level sizes, RGBA8 and BC7 layer bytes;
//   2. the page key separates everything GL keeps on the texture object
//      (size, format, levels, colour space, wrap, filters, anisotropy);
//   3. allocator invariants after EVERY operation of a seeded random run
//      (acquire / release / abandon / trim): each layer free, live or idle;
//      refcounts never negative; content map, idle LRU and free lists agree;
//      bytes accounted and under the cap;
//   4. page sizing (4 MiB / layer bytes, clamped; each further page x1.5),
//      free layers before idle eviction before a new page, LRU eviction
//      order, the byte cap refuses instead of over-allocating;
//   5. describeTexture: the textures adapter.js really builds (albedo, normal)
//      and a BC7 CompressedTexture are admissible; anything whose bytes or
//      sampling the page could not reproduce is refused;
//   6. the GL stream of an RGBA8 admit through three r184 + a fake WebGL2:
//      three's OWN upload of the 2D texture (texStorage2D, texSubImage2D,
//      generateMipmap on TEXTURE_2D), then texStorage3D(full chain,
//      SRGB8_ALPHA8) and one framebufferTexture2D + copyTexSubImage3D per
//      level into (layer, level); never generateMipmap / texSubImage3D on the
//      array; READ framebuffer and array binding restored; a resident
//      texture costs no GL; the sampler state is the texture's;
//   7. BC7: one compressedTexSubImage3D per baked level;
//   8. the upload budget gates admits (deferred, nothing allocated);
//   9. a context restore keeps the renderer but swaps renderer.properties
//      (a new GL-context generation): pages made before it are dead even
//      though gl.isContextLost() is false again, so `contextLost()` is true,
//      an admit waits (no GL) until `reset()`, which drops every page
//      without GL calls on the dead objects and starts a new `generation`;
//      kitPages hands back the SAME pages for the same renderer, so a
//      consumer sees the change;
//  10. (K3, 2026-10-30) no GL delete on a dead generation: reset(),
//      dispose() and resetKit() after a restore, or while lost, issue no
//      deleteTexture / deleteFramebuffer on an object made before the loss
//      — whether or not anyone asked contextLost() first (a canvas event,
//      another consumer, the allocator's trim, a scene dispose), also for the
//      copy framebuffer left after a trim — while on a live context they do
//      delete the pages and the copy framebuffer (no leak); admits are timed
//      into the budget (`ms.layer`, S1).
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_pages.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const UB = await import("../scene3d/gpu_batch/upload_budget.js");
const { surfacePixelsToTexture, surfacePixelsToNormalTexture, setAdapterMaxAnisotropy } = await import("../scene3d/adapter.js");
const { makeBc7Texture } = await import("../scene3d/bc7_textures.js");

const rgbaDesc = (w, h, extra = {}) => ({
  format: "rgba8", width: w, height: h, levels: PA.fullMipLevels(w, h), colorSpace: THREE.SRGBColorSpace,
  wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter,
  magFilter: THREE.LinearFilter, anisotropy: 1, ...extra,
});

test("1. mip and byte arithmetic matches three r184", () => {
  // three: texStorage2D(levels = Math.log2(Math.max(w, h)) + 1), GLsizei truncation.
  for (const [w, h] of [[1, 1], [2, 1], [3, 5], [32, 64], [64, 64], [48, 48], [128, 64], [512, 512], [1000, 3]]) {
    assert.equal(PA.fullMipLevels(w, h), Math.trunc(Math.log2(Math.max(w, h)) + 1), `${w}x${h}`);
  }
  assert.deepEqual(PA.levelSize(128, 64, 0), [128, 64]);
  assert.deepEqual(PA.levelSize(128, 64, 6), [2, 1]);
  assert.deepEqual(PA.levelSize(128, 64, 7), [1, 1]);
  // 64x64 RGBA8 full chain: sum 4*(64^2+32^2+...+1)
  let want = 0;
  for (let s = 64; s >= 1; s >>= 1) want += s * s * 4;
  assert.equal(PA.layerBytesOf(rgbaDesc(64, 64)), want);
  // BC7 128x64, 8 levels: ceil(w/4)*ceil(h/4)*16 per level
  let bc = 0;
  for (let l = 0; l < 8; l++) { const [w, h] = PA.levelSize(128, 64, l); bc += Math.ceil(w / 4) * Math.ceil(h / 4) * 16; }
  assert.equal(PA.layerBytesOf({ format: "bc7", width: 128, height: 64, levels: 8 }), bc);
});

test("2. the page key separates every sampler / storage axis", () => {
  const base = rgbaDesc(64, 64);
  const k = PA.pageKeyOf(base);
  assert.equal(PA.pageKeyOf({ ...base }), k, "deterministic");
  for (const [field, v] of [
    ["width", 32], ["height", 32], ["format", "bc7"], ["levels", 1], ["colorSpace", THREE.NoColorSpace],
    ["wrapS", THREE.ClampToEdgeWrapping], ["wrapT", THREE.MirroredRepeatWrapping], ["minFilter", THREE.LinearFilter],
    ["magFilter", THREE.NearestFilter], ["anisotropy", 8],
  ]) {
    assert.notEqual(PA.pageKeyOf({ ...base, [field]: v }), k, field);
  }
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test("3. allocator invariants hold after every operation (seeded random run)", () => {
  const descs = [rgbaDesc(64, 64), rgbaDesc(32, 64), rgbaDesc(16, 16, { wrapS: THREE.ClampToEdgeWrapping }),
    { format: "bc7", width: 128, height: 64, levels: 8, colorSpace: THREE.SRGBColorSpace, wrapS: 1000, wrapT: 1000, minFilter: 1008, magFilter: 1006, anisotropy: 1 }];
  const destroyed = [];
  const evicted = [];
  const A = new PA.PageAllocator({
    pageBytes: 64 * 1024, minLayers: 2, maxLayers: 9, maxBytes: 2 * 1024 * 1024,
    onPageDestroy: (p) => destroyed.push(p.id), onEvict: (ck) => evicted.push(ck),
  });
  const r = rng(0x5eed);
  const held = new Map(); // ck -> refs we hold
  let ops = 0;
  for (let i = 0; i < 4000; i++) {
    const roll = r();
    if (roll < 0.55) {
      const d = descs[Math.floor(r() * descs.length)];
      const ck = `c${Math.floor(r() * 120)}|${PA.pageKeyOf(d)}`;
      const e = A.acquire(d, ck);
      if (e) {
        held.set(ck, (held.get(ck) || 0) + 1);
        assert.equal(e.page.content[e.layer], ck);
        if (e.fresh) assert.equal(e.page.refs[e.layer], 1);
      }
    } else if (roll < 0.93) {
      const keys = [...held.keys()];
      if (keys.length) {
        const ck = keys[Math.floor(r() * keys.length)];
        assert.equal(A.release(ck), true);
        const n = held.get(ck) - 1;
        if (n === 0) held.delete(ck); else held.set(ck, n);
      }
    } else if (roll < 0.97) {
      // abandon a fresh single-ref acquire (failed upload)
      const d = descs[0];
      const ck = `abandon${i}|x`;
      const e = A.acquire(d, ck);
      if (e) { assert.equal(e.fresh, true); assert.equal(A.abandon(ck), true); assert.equal(A.lookup(ck), null); }
    } else {
      A.trim();
    }
    ops++;
    const bad = A.verify();
    assert.deepEqual(bad, [], `op ${i}: ${bad.slice(0, 3).join("; ")}`);
    // Every content we still hold is resident with at least our refs.
    for (const [ck, n] of held) assert.ok(A.refCount(ck) >= n, `${ck} refs ${A.refCount(ck)} < ${n}`);
  }
  assert.ok(ops === 4000 && A.stats.evictions > 0 && A.stats.pagesCreated > 4, JSON.stringify(A.stats));
  assert.equal(A.release("never-acquired"), false, "unknown content");
  // Release everything: all layers idle, then trim frees every page.
  for (const [ck, n] of held) for (let k = 0; k < n; k++) A.release(ck);
  const s = A.summary();
  assert.equal(s.live, 0);
  A.trim();
  assert.equal(A.pages.length, 0);
  assert.equal(A.bytes, 0);
  assert.deepEqual(A.verify(), []);
});

test("4. page sizing, eviction order, byte cap", () => {
  const d = rgbaDesc(64, 64); // 21,844 B / layer
  const lb = PA.layerBytesOf(d);
  const A = new PA.PageAllocator({ pageBytes: 4 * 1024 * 1024, maxLayers: 64 });
  const e0 = A.acquire(d, "a");
  assert.equal(e0.page.capacity, Math.min(64, Math.floor(4 * 1024 * 1024 / lb)), "first page from the byte target, clamped to maxLayers");
  // A small-texture key: a 4 MiB target of 1x1 layers clamps to maxLayers.
  const B = new PA.PageAllocator({ pageBytes: 256 * 1024, minLayers: 4, maxLayers: 2048 });
  const big = rgbaDesc(256, 256); // 349,524 B / layer -> floor(256K / 349K) = 0 -> min 4
  assert.equal(B.acquire(big, "b0").page.capacity, 4, "clamped up to minLayers");
  for (let i = 1; i < 4; i++) B.acquire(big, `b${i}`);
  const p2 = B.acquire(big, "b4").page;
  assert.equal(p2.capacity, 6, "second page of a key = ceil(prev x 1.5)");
  for (let i = 5; i < 10; i++) B.acquire(big, `b${i}`);
  assert.equal(B.acquire(big, "b10").page.capacity, 9, "third page x1.5 again");
  // Free layer first, then oldest idle within the key, then a new page.
  const C = new PA.PageAllocator({ pageBytes: 1, minLayers: 3, maxLayers: 3 });
  const x = C.acquire(d, "x"), y = C.acquire(d, "y"), z = C.acquire(d, "z");
  assert.equal(C.pages.length, 1);
  C.release("y"); C.release("x"); // idle LRU: y (older), x
  const w = C.acquire(d, "w");
  assert.equal(w.page, y.page);
  assert.equal(w.layer, y.layer, "the OLDEST idle layer is evicted first");
  assert.equal(C.lookup("y"), null);
  assert.equal(C.acquire(d, "x").fresh, false, "an idle layer re-acquired costs no upload");
  void z;
  const v = C.acquire(d, "v");
  assert.notEqual(v.page, x.page, "no free or idle layer: a new page");
  assert.equal(C.pages.length, 2);
  assert.deepEqual(C.verify(), []);
  // Byte cap: refuse, never exceed.
  const D = new PA.PageAllocator({ pageBytes: lb * 2, minLayers: 2, maxLayers: 2, maxBytes: lb * 3 });
  assert.ok(D.acquire(d, "1"));
  assert.ok(D.acquire(d, "2"));
  assert.equal(D.acquire(d, "3"), null, "a second 2-layer page would pass the cap");
  assert.equal(D.stats.refused, 1);
  assert.ok(D.bytes <= D.maxBytes);
  assert.deepEqual(D.verify(), []);
});

test("5. describeTexture admits what adapter.js builds and refuses the rest", () => {
  setAdapterMaxAnisotropy(8);
  const px = new Uint8Array(64 * 32 * 4).fill(200);
  const alb = surfacePixelsToTexture(px, 64, 32);
  const d = AP.describeTexture(alb);
  assert.deepEqual({ ...d }, {
    format: "rgba8", levels: 7, width: 64, height: 32, colorSpace: THREE.SRGBColorSpace,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, anisotropy: 8,
  });
  const nrm = surfacePixelsToNormalTexture(new Uint8Array(64 * 32 * 3).fill(128), 64, 32);
  const dn = AP.describeTexture(nrm);
  assert.equal(dn.colorSpace, THREE.NoColorSpace);
  assert.notEqual(PA.pageKeyOf(dn), PA.pageKeyOf(d), "normal maps never share an albedo page (linear vs sRGB)");
  const levels = [];
  for (let s = 128, t = 64; ; s = Math.max(1, s >> 1), t = Math.max(1, t >> 1)) {
    levels.push({ data: new Uint8Array(Math.ceil(s / 4) * Math.ceil(t / 4) * 16), width: s, height: t });
    if (s === 1 && t === 1) break;
  }
  const bc = makeBc7Texture({ width: 128, height: 64, levels }, { anisotropy: 8 });
  const db = AP.describeTexture(bc);
  assert.equal(db.format, "bc7");
  assert.equal(db.levels, 8);
  // Refusals: anything the page would sample differently.
  const flip = surfacePixelsToTexture(px, 64, 32); flip.flipY = true;
  assert.ok(AP.describeTexture(flip), "unpack flags shape three's own upload, which the admit copies: admissible");
  const rep = surfacePixelsToTexture(px, 64, 32); rep.repeat.set(2, 1);
  const offs = surfacePixelsToTexture(px, 64, 32); offs.offset.set(0.5, 0);
  const chan = surfacePixelsToTexture(px, 64, 32); chan.channel = 1;
  const flt = new THREE.DataTexture(new Float32Array(16), 2, 2, THREE.RGBAFormat, THREE.FloatType);
  const shortChain = makeBc7Texture({ width: 128, height: 64, levels: [levels[0], { ...levels[1], data: null }] });
  for (const [name, t] of [["uv repeat", rep], ["uv offset", offs], ["uv channel", chan], ["float", flt],
    ["BC7 level without blocks", shortChain], ["render target", new THREE.WebGLRenderTarget(4, 4).texture], ["null", null]]) {
    assert.equal(AP.describeTexture(t), null, name);
  }
  setAdapterMaxAnisotropy(1);
});

function glRig(opts = {}) {
  const calls = [];
  const gl = createFakeWebGL2({ onCall: (name, args) => calls.push([name, Array.from(args)]) });
  if (opts.events) {
    // three's own canvas listeners, so a test can lose / restore the context.
    const canvas = fakeCanvas(gl);
    const listeners = {};
    canvas.addEventListener = (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); };
    let lost = false;
    gl.isContextLost = () => lost;
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    const fire = (type, ev) => { for (const fn of listeners[type] || []) fn(ev); };
    return {
      gl, calls, renderer,
      loseContext() { lost = true; fire("webglcontextlost", { preventDefault() {} }); },
      restoreContext() { lost = false; fire("webglcontextrestored", {}); },
    };
  }
  if (opts.bptc) {
    const orig = gl.getExtension;
    gl.getExtension = (name) => (name === "EXT_texture_compression_bptc"
      ? { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d,
        COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8e8e, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8e8f }
      : orig(name));
  }
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  return { gl, calls, renderer };
}

test("6. RGBA8 admit: three's own 2D upload + generateMipmap, then a per-level GPU copy into the layer", () => {
  const { gl, calls, renderer } = glRig();
  const pages = new AP.ArrayPages(renderer, { pageBytes: 1, minLayers: 4, maxLayers: 4 });
  const px = new Uint8Array(32 * 64 * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;
  const tex = surfacePixelsToTexture(px, 32, 64);
  calls.length = 0;
  const r = pages.admit(tex);
  assert.ok(r && !r.deferred && r.layer === 0 && r.page.capacity === 4, JSON.stringify(r && { layer: r.layer }));
  const names = calls.map((c) => c[0]);
  // three's upload of the 2D texture, exactly its legacy sequence:
  const s2 = calls.find((c) => c[0] === "texStorage2D");
  assert.ok(s2, "three allocated the 2D texture");
  assert.deepEqual(s2[1], [gl.TEXTURE_2D, 7, gl.SRGB8_ALPHA8, 32, 64], "texStorage2D(TEXTURE_2D, 7 levels, SRGB8_ALPHA8, 32, 64)");
  assert.ok(names.includes("texSubImage2D"), "level 0 uploaded by three");
  const gm = calls.filter((c) => c[0] === "generateMipmap");
  assert.equal(gm.length, 1);
  assert.equal(gm[0][1][0], gl.TEXTURE_2D, "the driver's mips, generated on the 2D texture");
  assert.ok(names.indexOf("generateMipmap") < names.indexOf("copyTexSubImage3D"), "the mips exist before the first copy");
  // The page: immutable storage, the texture's sampler state.
  const s3 = calls.find((c) => c[0] === "texStorage3D");
  assert.deepEqual(s3[1], [gl.TEXTURE_2D_ARRAY, 7, gl.SRGB8_ALPHA8, 32, 64, 4], "the SAME internal format three gave the 2D texture");
  const params = calls.filter((c) => c[0] === "texParameteri" && c[1][0] === gl.TEXTURE_2D_ARRAY).map((c) => [c[1][1], c[1][2]]);
  assert.deepEqual(params, [
    [gl.TEXTURE_WRAP_S, gl.REPEAT], [gl.TEXTURE_WRAP_T, gl.REPEAT], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR],
  ]);
  // ... the same values three set on the 2D texture.
  const params2d = calls.filter((c) => c[0] === "texParameteri" && c[1][0] === gl.TEXTURE_2D).map((c) => [c[1][1], c[1][2]]);
  for (const p of params2d) assert.ok(params.some((q) => q[0] === p[0] && q[1] === p[1]), `2D ${p} mirrored on the page`);
  // One attach + one copy per level, level sizes halving, into layer 0.
  const copies = calls.filter((c) => c[0] === "copyTexSubImage3D").map((c) => c[1]);
  assert.equal(copies.length, 7);
  copies.forEach((a, l) => {
    const [w, h] = PA.levelSize(32, 64, l);
    assert.deepEqual(a, [gl.TEXTURE_2D_ARRAY, l, 0, 0, 0, 0, 0, w, h], `level ${l}`);
  });
  const attaches = calls.filter((c) => c[0] === "framebufferTexture2D").map((c) => c[1]);
  assert.equal(attaches.length, 8, "7 levels + the detach");
  attaches.slice(0, 7).forEach((a, l) => {
    assert.equal(a[0], gl.READ_FRAMEBUFFER);
    assert.equal(a[2], gl.TEXTURE_2D);
    assert.equal(a[4], l, "attached mip level");
  });
  assert.equal(attaches[7][3], null, "detached after the copy");
  // Never the r184 layerUpdates / re-mip path on the array.
  assert.equal(calls.filter((c) => c[0] === "texSubImage3D" || c[0] === "texImage3D").length, 0);
  assert.equal(calls.filter((c) => c[0] === "generateMipmap" && c[1][0] === gl.TEXTURE_2D_ARRAY).length, 0);
  // Bindings restored (READ framebuffer + 2D-array binding).
  const binds = calls.filter((c) => c[0] === "bindFramebuffer" && c[1][0] === gl.READ_FRAMEBUFFER);
  assert.equal(binds.at(-1)[1][1], 0, "READ_FRAMEBUFFER restored to what it was");
  const arrBinds = calls.filter((c) => c[0] === "bindTexture" && c[1][0] === gl.TEXTURE_2D_ARRAY);
  assert.equal(arrBinds.at(-1)[1][1], 0, "TEXTURE_2D_ARRAY binding restored");
  // The page binds as an ExternalTexture over its own GL texture.
  assert.ok(r.page.gl.texture.isExternalTexture && r.page.gl.texture.sourceTexture === r.page.gl.tex);
  // Resident content: no GL at all, refcount 2.
  calls.length = 0;
  const r2 = pages.admit(tex);
  assert.equal(r2.layer, r.layer);
  assert.deepEqual(calls.map((c) => c[0]).filter((n) => n !== "isContextLost"), [], "a resident admit issues no GL (one isContextLost query)");
  assert.equal(pages.alloc.refCount(r.contentKey), 2);
  // A second texture of the same shape: the same page, layer 1, one copy per level.
  const tex2 = surfacePixelsToTexture(px, 32, 64);
  calls.length = 0;
  const r3 = pages.admit(tex2);
  assert.equal(r3.page, r.page);
  assert.equal(r3.layer, 1);
  assert.equal(calls.filter((c) => c[0] === "texStorage3D").length, 0, "no new page");
  assert.ok(calls.filter((c) => c[0] === "copyTexSubImage3D").every((c) => c[1][4] === 1), "into layer 1");
  // A new upload of the source (needsUpdate) is new content.
  tex.needsUpdate = true;
  assert.notEqual(AP.contentKeyOf(tex), r.contentKey);
  pages.dispose();
});

test("6b. admitPixels: a scratch texture configured like surfacePixelsToTexture, disposed after the copy", () => {
  const { gl, calls, renderer } = glRig();
  const pages = new AP.ArrayPages(renderer);
  const px = new Uint8Array(16 * 16 * 4).fill(9);
  calls.length = 0;
  const r = pages.admitPixels(px, 16, 16, { anisotropy: 1 }, "composite:abc");
  assert.ok(r && r.contentKey === "composite:abc");
  assert.equal(calls.filter((c) => c[0] === "generateMipmap" && c[1][0] === gl.TEXTURE_2D).length, 1);
  assert.equal(calls.filter((c) => c[0] === "copyTexSubImage3D").length, 5);
  assert.ok(calls.findIndex((c) => c[0] === "deleteTexture") > calls.findIndex((c) => c[0] === "copyTexSubImage3D"),
    "the scratch 2D texture is released after the copy");
  assert.equal(pages.stats.scratch, 1);
  pages.dispose();
});

test("7. BC7 admit: one compressedTexSubImage3D per baked level", () => {
  const { gl, calls, renderer } = glRig({ bptc: true });
  const pages = new AP.ArrayPages(renderer);
  const levels = [];
  for (let s = 64, t = 32; ; s = Math.max(1, s >> 1), t = Math.max(1, t >> 1)) {
    levels.push({ data: new Uint8Array(Math.ceil(s / 4) * Math.ceil(t / 4) * 16).fill(levels.length), width: s, height: t });
    if (s === 1 && t === 1) break;
  }
  const bc = makeBc7Texture({ width: 64, height: 32, levels });
  calls.length = 0;
  const r = pages.admit(bc);
  assert.ok(r && !r.deferred);
  const s3 = calls.find((c) => c[0] === "texStorage3D");
  assert.deepEqual(s3[1].slice(1, 5), [7, 0x8e8d, 64, 32], "sRGB BPTC storage, full chain");
  const ups = calls.filter((c) => c[0] === "compressedTexSubImage3D").map((c) => c[1]);
  assert.equal(ups.length, 7);
  ups.forEach((a, l) => {
    assert.deepEqual(a.slice(0, 9), [gl.TEXTURE_2D_ARRAY, l, 0, 0, r.layer, levels[l].width, levels[l].height, 1, 0x8e8d]);
    assert.equal(a[9], levels[l].data, "the baked blocks, verbatim");
  });
  assert.equal(calls.filter((c) => c[0] === "copyTexSubImage3D" || c[0] === "generateMipmap").length, 0);
  // Without the extension a BC7 texture is refused (the consumer keeps its 2D texture).
  const plain = glRig();
  const p2 = new AP.ArrayPages(plain.renderer);
  assert.equal(p2.admit(bc), null);
  assert.equal(p2.stats.unsupported, 1);
});

test("8. the upload budget gates admits: deferred means nothing allocated", () => {
  const { calls, renderer } = glRig();
  const pages = new AP.ArrayPages(renderer);
  const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 20, admitsPerFrame: 1 });
  budget.beginFrame(1);
  const a = surfacePixelsToTexture(new Uint8Array(8 * 8 * 4), 8, 8);
  const b = surfacePixelsToTexture(new Uint8Array(8 * 8 * 4), 8, 8);
  assert.ok(pages.admit(a, budget).page, "first admit of the frame");
  calls.length = 0;
  const r = pages.admit(b, budget);
  assert.deepEqual(r, { deferred: true }, "admit cap reached");
  const QUERIES = new Set(["isContextLost", "getParameter", "getExtension"]);
  assert.deepEqual(calls.filter((c) => !QUERIES.has(c[0])).map((c) => c[0]), [], "a deferred admit changes no GL state");
  assert.equal(pages.alloc.lookup(AP.contentKeyOf(b)), null);
  assert.ok(pages.admit(a, budget).page, "a resident layer needs no budget");
  budget.beginFrame(2);
  assert.ok(pages.admit(b, budget).page, "next frame it goes");
  assert.equal(budget.stats.byKind.layer, 2 * PA.layerBytesOf(AP.describeTexture(a)));
});

test("9. a context lost AND restored between two checks: the pages are dead (new generation); admit waits; reset starts over", async () => {
  const KIT = await import("../scene3d/gpu_batch/kit.js");
  KIT.resetKit();
  const rig = glRig({ events: true });
  const { calls, renderer } = rig;
  const pages = KIT.kitPages(renderer);
  assert.equal(pages.generation, 0);
  assert.equal(pages.ctx, AP.glContextGeneration(renderer), "the pages remember the generation they live on");
  const a = surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(9), 16, 16);
  const r0 = pages.admit(a);
  assert.ok(r0 && r0.page, "admitted on the first context");
  const oldTex = r0.page.gl.tex;
  assert.equal(pages.contextLost(), false);
  const props0 = renderer.properties;
  rig.loseContext();
  rig.restoreContext(); // no check in between
  assert.notEqual(renderer.properties, props0, "premise: three swapped renderer.properties (a new generation)");
  assert.equal(renderer.getContext().isContextLost(), false, "premise: not lost any more");
  assert.equal(KIT.kitPages(renderer), pages, "the same renderer: the same pages (a restore is not a new renderer)");
  assert.equal(pages.contextLost(), true, "the pages were made on the lost context");
  calls.length = 0;
  const b = surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(7), 16, 16);
  assert.deepEqual(pages.admit(b), { deferred: true, lost: true }, "nothing goes into a dead page");
  assert.deepEqual(pages.admit(a), { deferred: true, lost: true }, "not even a 'resident' one");
  const QUERIES = new Set(["isContextLost", "getParameter", "getExtension"]);
  assert.deepEqual(calls.filter((c) => !QUERIES.has(c[0])).map((c) => c[0]), [], "and no GL call");
  pages.reset();
  assert.deepEqual(calls.filter((c) => !QUERIES.has(c[0])).map((c) => c[0]), [], "reset drops the dead pages without GL calls on them");
  assert.equal(pages.generation, 1, "a new generation");
  assert.equal(pages.ctx, renderer.properties);
  assert.equal(pages.contextLost(), false);
  assert.equal(pages.alloc.pages.length, 0);
  const r1 = pages.admit(a);
  assert.ok(r1 && r1.page && r1.page.gl.tex !== oldTex, "re-admitted into a new page on the restored context");
  assert.ok(r1.page.gl.tex.__id > oldTex.__id);
  KIT.resetKit();
});

test("10. no GL delete on a dead generation: reset / dispose / resetKit after a loss or restore, asked or not", async () => {
  const KIT = await import("../scene3d/gpu_batch/kit.js");
  const stale = (calls, from, fence) => calls.slice(from)
    .filter(([n, a]) => /^delete/.test(n) && a[0] && typeof a[0].__id === "number" && a[0].__id < fence)
    .map(([n, a]) => `${n}(#${a[0].__id})`);
  const deletes = (calls, from) => calls.slice(from).filter(([n]) => /^delete/.test(n)).map(([n, a]) => `${n}(#${a[0] && a[0].__id})`);
  const make = (v) => surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(v), 16, 16);
  const nrm = (v) => surfacePixelsToNormalTexture(new Uint8Array(16 * 16 * 3).fill(v), 16, 16);
  const HOWS = [
    "reset after restore", "dispose after restore", "resetKit after restore", "reset while lost", "resetKit while lost",
    // Pages destroyed by the allocator's trim (idle layers freed, empty pages
    // dropped) after a restore; and the copy framebuffer left alone after an
    // earlier trim emptied the pages, then a restore, then reset / dispose.
    "trim after restore", "reset after trim, then restore", "dispose after trim, then restore",
  ];
  for (const how of HOWS) {
    KIT.resetKit();
    const rig = glRig({ events: true });
    const pages = KIT.kitPages(rig.renderer);
    const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 20 });
    budget.beginFrame(1);
    // Two pages (sRGB map, linear normal map) and the copy framebuffer.
    const ra = pages.admit(make(5), budget);
    const rb = pages.admit(nrm(9), budget);
    assert.ok(ra.page && rb.page, how);
    assert.equal(pages.alloc.pages.length, 2, `${how}: premise: two pages`);
    assert.ok(pages._fbo, `${how}: premise: the copy framebuffer exists`);
    const timed = budget.stats.timed ? budget.stats.timed.layer : undefined;
    const ms = budget.stats.ms ? budget.stats.ms.layer : undefined;
    if (how.includes("trim")) { pages.release(ra.contentKey); pages.release(rb.contentKey); }
    if (how.includes("after trim, then")) assert.equal(pages.alloc.trim(), 2, `${how}: premise: the live trim drops both pages (the framebuffer stays)`);
    const fence = rig.gl.createTexture().__id; // everything below was made on the first context
    const from = rig.calls.length;
    rig.loseContext();
    if (!how.endsWith("while lost")) rig.restoreContext();
    // Nobody asked pages.contextLost(): the caller is a canvas event, another
    // consumer, the allocator or a scene dispose.
    if (how === "trim after restore") assert.equal(pages.alloc.trim(), 2, `${how}: both pages dropped`);
    else if (how.startsWith("reset ")) pages.reset();
    else if (how.startsWith("dispose")) pages.dispose();
    else KIT.resetKit();
    assert.deepEqual(stale(rig.calls, from, fence), [], `${how}: nothing of the lost context is deleted`);
    assert.equal(pages.alloc.pages.length, 0, `${how}: the pages are dropped all the same`);
    // S1: both admits were timed into the budget.
    assert.equal(timed, 2, `${how}: both admits timed`);
    assert.ok(ms >= 0 && Number.isFinite(ms), `${how}: ms.layer = ${ms}`);
  }
  // On a LIVE context the same calls delete what they drop (nothing leaks).
  for (const how of ["reset", "dispose", "resetKit"]) {
    KIT.resetKit();
    const rig = glRig({ events: true });
    const pages = KIT.kitPages(rig.renderer);
    const t1 = pages.admit(make(3)).page.gl.tex;
    const t2 = pages.admit(nrm(4)).page.gl.tex;
    const fbo = pages._fbo;
    const from = rig.calls.length;
    if (how === "reset") pages.reset(); else if (how === "dispose") pages.dispose(); else KIT.resetKit();
    assert.deepEqual(deletes(rig.calls, from).sort(),
      [`deleteFramebuffer(#${fbo.__id})`, `deleteTexture(#${t1.__id})`, `deleteTexture(#${t2.__id})`].sort(),
      `${how} (live): the page textures and the copy framebuffer are deleted`);
  }
  KIT.resetKit();
});
