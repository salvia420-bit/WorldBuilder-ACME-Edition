// tests/gpu_batch_pages_realboot.test.mjs — the kit's texture-array pages
// under the R3-5 laptop real boot's key mix (2026-10-31, SwiftShader,
// Holtburg after @telepoi, quality low, renderScale 0.25, `?interiorBatch=on`;
// /mnt/wbterminal1/tmp/claude-scratch/perf/rust-boot-smoke-r3-ib-maps3/smoke.json
// diag.interiorBatch.kit.pages: pages 40, layers 17944, live 0, idle 229,
// free 17715, bytes 134,004,400 of maxBytes 134,217,728, refused 18,
// gl {admits 429, admitBytes 21.7 MB, copiedLevels 2301, bc7Levels 832}).
// The byte-target pages reserved ~4 MiB for EVERY (format, size, levels,
// sampler) key, ArrayPages raised maxLayers to the GL limit (2048), so the
// reserved bytes hit the 128 MiB cap at ~6 % use and every new key was
// refused (page_allocator.js "DEMAND-SIZED PAGES").
//
// THE REPLAY MIX, derived from the evidence and the REAL portal DAT
// (tools/clip-alpha-gate.mjs openPortalDat: every textured Surface's top-rung
// RenderSurface): 429 admits = 143 members x (map + texchan AO plane +
// texchan roughness plane: extraMaps {} in that boot, every map set
// eligible). Sizes: the real textured-surface dims with a longest side
// <= 128 at their real frequency, plus the 256-side dims at 8 % of theirs
// (interior textures run small; that share puts the bytes per admit on the
// evidence). Maps: BC7 for four in five (the evidence's 832 BC7 levels vs
// 2301 copied levels), sRGB RGBA8 otherwise; AO: R8 (adapter.js
// surfacePixelsToAoTexture); roughness: linear RGBA8 (surfacePixelsTo-
// RoughnessTexture). Every texture is built by the client's own helpers
// (adapter.js, bc7_textures.js makeBc7Texture) and described by
// ArrayPages.describeTexture, so the page keys are the client's.
//
//   B1  premise: the portal DAT is present; the replay's dims are real
//       (each one >= 10 textured surfaces) and its aggregates match the
//       boot's within 10 % (bc7 levels, copied levels, bytes at the
//       pre-change accounting where an R8 texel counted 4 bytes) and its
//       admits exactly (429); > 40 keys;
//   B2  the pre-change sizing (the kit's old options: byte-target pages,
//       maxLayers = the GL limit, reclaim + fit, 128 MiB) on the same mix
//       refuses keys with the cap reserved to the last 1 % and > 20 layer
//       slots per resident layer (the boot's signature) — the contrast;
//   B3  THE KIT'S PAGES (kit.js kitPages over three r184 + the fake WebGL2
//       with BPTC and a 2048-layer limit, admits through ArrayPages.admit):
//       every one of the 429 layers admitted, nothing refused, reserved
//       bytes under the cap and within the demand bound (per key: resident
//       + max(resident, its first page)), well under a quarter of the cap;
//       the GL stream asks texStorage3D for exactly the reserved bytes
//       (R8 one byte a texel);
//   B4  the boot's churn: 18 re-plans of a chunk (release all, re-admit)
//       are idle hits (no upload, no page); a full turnover to a second
//       landblock of the same mix evicts idle layers instead of growing
//       (no new page, nothing refused); a squeezed cap reclaims idle-only
//       pages promptly for a new key;
//   B5  demand invariants over a seeded random run (acquire / release /
//       abandon / trim at a small cap with reclaim + fit): verify() clean
//       after every op (no empty page kept, no page over its ceiling, bytes
//       = the pages'), wouldAcquire === acquire, an abandoned last layer
//       destroys its page at once;
//   B6  the kit's options and honest bytes: demand on, 256 KiB first pages,
//       4 MiB per-page ceiling, reclaim + fit, the 128 MiB stated cap; an R8
//       64x64 layer = 5461 bytes booked and stored; flag-off: nothing exists
//       before a consumer asks.
// B1-B4 and B6 fail on the pre-change tree (no `demand`; R8 counted at 4).
//
// Fixture: ~/ac_base_dats/client_portal.dat (HB_PORTAL_DAT overrides).
// Run from apps/holtburger-web/:  node tests/gpu_batch_pages_realboot.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";
import { openPortalDat, SURFACE } from "../tools/clip-alpha-gate.mjs";

const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const UB = await import("../scene3d/gpu_batch/upload_budget.js");
const adapter = await import("../scene3d/adapter.js");
const { makeBc7Texture } = await import("../scene3d/bc7_textures.js");

const PORTAL_DAT = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
const MiB = 1024 * 1024;
const CAP = 128 * MiB;
/** The boot's diag.interiorBatch.kit.pages (smoke.json, r3-ib-maps3). */
const BOOT = { admits: 429, bc7Levels: 832, copiedLevels: 2301, admitBytes: 21655892, pages: 40, layers: 17944, bytes: 134004400, refused: 18 };
const MEMBERS = BOOT.admits / 3; // map + AO + roughness per member
const SHARE_256 = 0.08;
const GL_MAX_LAYERS = 2048; // Chrome / SwiftShader MAX_ARRAY_TEXTURE_LAYERS

// --- the real dims ---------------------------------------------------------------
/** Textured Surfaces of the portal DAT: their top-rung RenderSurface dims ("WxH" -> count). */
function realDims() {
  const dat = openPortalDat(PORTAL_DAT);
  const dims = new Map();
  let surfaces = 0;
  try {
    for (const id of dat.ids(0x08)) {
      const sb = dat.read(id);
      if (!sb || sb.length < 8) continue;
      const sv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
      if (!(sv.getUint32(0, true) & (SURFACE.Base1Image | SURFACE.Base1ClipMap))) continue;
      const st = dat.read(sv.getUint32(4, true));
      if (!st || st.length < 13) continue;
      const tv = new DataView(st.buffer, st.byteOffset, st.byteLength);
      const count = tv.getInt32(9, true);
      if (count <= 0 || 13 + 4 * count > st.length) continue;
      const rs = dat.read(tv.getUint32(13 + 4 * (count - 1), true));
      if (!rs || rs.length < 24) continue;
      const rv = new DataView(rs.buffer, rs.byteOffset, rs.byteLength);
      const w = rv.getInt32(8, true), h = rv.getInt32(12, true);
      if (!(w > 0 && h > 0)) continue;
      surfaces += 1;
      const k = `${w}x${h}`;
      dims.set(k, (dims.get(k) || 0) + 1);
    }
  } finally { dat.close(); }
  return { dims, surfaces };
}

/** Members per dims: the real frequencies (longest side <= 128; 256-side at SHARE_256), largest remainder to MEMBERS. */
function memberDims(dims) {
  const w = [];
  for (const [k, n] of dims) {
    const [a, b] = k.split("x").map(Number);
    const m = Math.max(a, b);
    if (m <= 128) w.push([k, n]);
    else if (m === 256) w.push([k, n * SHARE_256]);
  }
  w.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const tot = w.reduce((s, [, n]) => s + n, 0);
  const raw = w.map(([k, n]) => [k, (n / tot) * MEMBERS]);
  const out = new Map(raw.map(([k, x]) => [k, Math.floor(x)]));
  let left = MEMBERS - [...out.values()].reduce((s, n) => s + n, 0);
  for (const [k, x] of raw.slice().sort((p, q) => (q[1] % 1) - (p[1] % 1) || (p[0] < q[0] ? -1 : 1))) {
    if (left <= 0) break;
    out.set(k, out.get(k) + 1);
    left -= 1;
  }
  for (const [k, n] of [...out]) if (n === 0) out.delete(k);
  return out;
}

// --- the client's textures -----------------------------------------------------------
function bc7Of(w, h, seed) {
  const levels = [];
  for (let s = w, t = h; ; s = Math.max(1, s >> 1), t = Math.max(1, t >> 1)) {
    levels.push({ data: new Uint8Array(Math.ceil(s / 4) * Math.ceil(t / 4) * 16).fill(seed & 255), width: s, height: t });
    if (s === 1 && t === 1) break;
  }
  return makeBc7Texture({ width: w, height: h, levels });
}

/** The replay: 143 members in plan order (a fixed interleave, not grouped by size), 3 textures each. */
function buildReplay(byDims, tag = "") {
  const flat = [];
  for (const [k, n] of byDims) for (let i = 0; i < n; i += 1) flat.push(k);
  const out = [];
  for (let i = 0; i < flat.length; i += 1) {
    const j = (i * 37) % flat.length; // gcd(37, 143) = 1: a permutation
    const [w, h] = flat[j].split("x").map(Number);
    const seed = j + (tag ? 101 : 0);
    const map = j % 5 === 4
      ? adapter.surfacePixelsToTexture(new Uint8Array(w * h * 4).fill(seed & 255), w, h)
      : bc7Of(w, h, seed);
    const ao = adapter.surfacePixelsToAoTexture(new Uint8Array(w * h).fill(200), w, h);
    const rgh = adapter.surfacePixelsToRoughnessTexture(new Uint8Array(w * h).fill(90), w, h);
    for (const [tex, opts, kind] of [[map, null, "map"], [ao, AP.R8_PLANES, "ao"], [rgh, null, "rgh"]]) {
      const desc = AP.describeTexture(tex, opts);
      out.push({ tex, opts, kind, desc, key: PA.pageKeyOf(desc), ck: AP.contentKeyOf(tex), member: j });
    }
  }
  return out;
}

/** Bytes of a layer at the PRE-CHANGE accounting (R8 at RGBA8's 4 bytes a texel). */
function preChangeBytes(desc) {
  let n = 0;
  for (let l = 0; l < desc.levels; l += 1) {
    const [w, h] = PA.levelSize(desc.width, desc.height, l);
    n += desc.format === "bc7" ? Math.ceil(w / 4) * Math.ceil(h / 4) * 16 : w * h * 4;
  }
  return n;
}

/** three r184 over the fake WebGL2, with BPTC and the 2048-layer GL limit of Chrome / SwiftShader. */
function glRig(opts = {}) {
  const calls = [];
  const gl = createFakeWebGL2(opts.record ? { onCall: (n, a) => calls.push([n, Array.from(a)]) } : {});
  const ge = gl.getExtension;
  gl.getExtension = (name) => (name === "EXT_texture_compression_bptc"
    ? { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d,
      COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8e8e, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8e8f }
    : ge(name));
  const gp = gl.getParameter;
  const MAXL = gl.MAX_ARRAY_TEXTURE_LAYERS;
  gl.getParameter = function (p) { return p === MAXL ? GL_MAX_LAYERS : gp.call(this, p); };
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  return { gl, renderer, calls };
}

/** Per key: { resident layers, reserved bytes, layer bytes }. */
function perKey(alloc) {
  const m = new Map();
  for (const p of alloc.pages) {
    let e = m.get(p.key);
    if (!e) { e = { resident: 0, reserved: 0, lb: p.layerBytes, desc: p.desc }; m.set(p.key, e); }
    e.reserved += p.capacity * p.layerBytes;
    e.resident += p.capacity - p.free.length;
  }
  return m;
}

/** The demand bound: per key, resident + max(resident, the key's first page). */
function demandBound(alloc) {
  let n = 0;
  for (const e of perKey(alloc).values()) {
    const first = Math.min(alloc.pageLayersMax(e.desc), Math.max(alloc.minLayers, Math.floor(alloc.firstPageBytes / e.lb)));
    n += e.resident * e.lb + Math.max(e.resident, first) * e.lb;
  }
  return n;
}

// --- the shared replay -------------------------------------------------------------------
let REAL = null;
let BY_DIMS = null;
let REPLAY = null;

test("B1 premise: the real dims, and a replay whose aggregates are the boot's", () => {
  assert.ok(fs.existsSync(PORTAL_DAT), `fixture missing: ${PORTAL_DAT} (set HB_PORTAL_DAT)`);
  REAL = realDims();
  assert.ok(REAL.surfaces > 5000, `textured surfaces read: ${REAL.surfaces}`);
  BY_DIMS = memberDims(REAL.dims);
  for (const k of BY_DIMS.keys()) assert.ok((REAL.dims.get(k) || 0) >= 10, `${k}: a real size (${REAL.dims.get(k)})`);
  assert.equal([...BY_DIMS.values()].reduce((s, n) => s + n, 0), MEMBERS);
  REPLAY = buildReplay(BY_DIMS);
  assert.equal(REPLAY.length, BOOT.admits, "the boot's 429 admits");
  assert.ok(REPLAY.every((r) => r.desc), "every texture admissible (describeTexture)");
  let bc7Levels = 0, copiedLevels = 0, bytes = 0;
  for (const r of REPLAY) {
    if (r.desc.format === "bc7") bc7Levels += r.desc.levels; else copiedLevels += r.desc.levels;
    bytes += preChangeBytes(r.desc);
  }
  const near = (a, b) => Math.abs(a - b) <= 0.1 * b;
  const keys = new Set(REPLAY.map((r) => r.key)).size;
  console.log(`  replay: members ${JSON.stringify(Object.fromEntries(BY_DIMS))}`);
  console.log(`  replay: keys ${keys}, bc7Levels ${bc7Levels} (boot ${BOOT.bc7Levels}), copiedLevels ${copiedLevels} (boot ${BOOT.copiedLevels}), pre-change bytes ${bytes} (boot ${BOOT.admitBytes})`);
  assert.ok(near(bc7Levels, BOOT.bc7Levels), `bc7 levels ${bc7Levels} vs ${BOOT.bc7Levels}`);
  assert.ok(near(copiedLevels, BOOT.copiedLevels), `copied levels ${copiedLevels} vs ${BOOT.copiedLevels}`);
  assert.ok(near(bytes, BOOT.admitBytes), `bytes ${bytes} vs ${BOOT.admitBytes}`);
  assert.ok(keys > BOOT.pages, `${keys} keys (the boot kept ${BOOT.pages} pages)`);
  const fmts = new Set(REPLAY.map((r) => r.desc.format));
  assert.deepEqual([...fmts].sort(), ["bc7", "r8", "rgba8"]);
});

test("B2 contrast: the pre-change sizing refuses this mix with the cap reserved (the boot's signature)", () => {
  assert.ok(REPLAY, "premise: B1");
  const OLD = new PA.PageAllocator({ maxBytes: CAP, reclaimIdle: true, fitToCap: true, maxLayers: GL_MAX_LAYERS });
  let refused = 0;
  for (const r of REPLAY) if (!OLD.acquire(r.desc, r.ck)) refused += 1;
  const s = OLD.summary();
  console.log(`  pre-change sizing: refused ${refused}, pages ${s.pages}, layers ${s.layers}, live ${s.live}, bytes ${s.bytes}, liveBytes ${s.liveBytes}`);
  assert.ok(refused > 0, "keys refused");
  assert.ok(s.bytes >= 0.99 * CAP, `the cap reserved: ${s.bytes}`);
  assert.ok(s.layers >= 20 * s.live, `${s.layers} slots for ${s.live} layers`);
  assert.deepEqual(OLD.verify(), []);
});

let RIG = null;
test("B3 the kit's pages admit every layer of the boot's mix under the cap, reserved close to resident", () => {
  assert.ok(REPLAY, "premise: B1");
  KIT.resetKit();
  RIG = glRig({ record: true });
  const pages = KIT.kitPages(RIG.renderer);
  const alloc = pages.alloc;
  assert.equal(alloc.maxLayers, GL_MAX_LAYERS, "premise: the GL limit, as on the laptop");
  const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 30, admitsPerFrame: 1 << 20 });
  budget.beginFrame(1);
  const refusedAt = [];
  for (let i = 0; i < REPLAY.length; i += 1) {
    const r = REPLAY[i];
    const got = pages.admit(r.tex, budget, r.opts);
    if (!got || got.deferred) refusedAt.push(`${i}:${r.key}`);
    else r.ref = got;
  }
  const s = alloc.summary();
  console.log(`  kit pages: pages ${s.pages}, keys ${s.keys}, layers ${s.layers}, live ${s.live}, bytes ${s.bytes}, liveBytes ${s.liveBytes}, freeBytes ${s.freeBytes}, growthPages ${s.growthPages}, fitted ${s.fitted}, refused ${refusedAt.length}`);
  assert.deepEqual(refusedAt, [], "every key admitted");
  assert.equal(alloc.stats.refused, 0);
  const bound = demandBound(alloc);
  console.log(`  kit pages: the demand bound ${bound}`);
  assert.equal(s.live, BOOT.admits);
  assert.ok(s.bytes <= CAP);
  assert.ok(s.bytes <= bound, `reserved ${s.bytes} within the demand bound ${bound}`);
  assert.ok(s.bytes <= CAP / 4, `reserved ${s.bytes}: well under the cap`);
  // Bytes are what the cap counts (a small-texture key's 256 KiB first page holds many cheap slots):
  // the boot reserved ~10x its resident bytes (134.0 MB for 13 MB); the demand pages at most ~2x.
  assert.ok(s.bytes <= 2.5 * s.liveBytes, `reserved ${s.bytes} for ${s.liveBytes} resident`);
  assert.deepEqual(alloc.verify(), []);
  // Per key: free slots never more than the key's resident layers or its first page.
  for (const [key, e] of perKey(alloc)) {
    const first = Math.min(alloc.pageLayersMax(e.desc), Math.max(alloc.minLayers, Math.floor(alloc.firstPageBytes / e.lb)));
    const free = e.reserved / e.lb - e.resident;
    assert.ok(free <= Math.max(e.resident, first), `${key}: ${free} free for ${e.resident} resident (first ${first})`);
  }
  // The GL stream: texStorage3D asks for exactly the reserved bytes (R8 one byte a texel).
  const st = RIG.calls.filter((c) => c[0] === "texStorage3D").map((c) => c[1]);
  assert.equal(st.length, s.pagesCreated);
  let glBytes = 0;
  const R8 = RIG.gl.R8; // the fake context's own enum (array_pages.js internalFormatOf reads it off the context)
  const bpt = (ifmt) => (ifmt === R8 ? 1 : 4); // R8 : RGBA8 / SRGB8_ALPHA8
  for (const [, levels, ifmt, w, h, depth] of st) {
    for (let l = 0; l < levels; l += 1) {
      const [lw, lh] = PA.levelSize(w, h, l);
      glBytes += (ifmt === 0x8e8c || ifmt === 0x8e8d ? Math.ceil(lw / 4) * Math.ceil(lh / 4) * 16 : lw * lh * bpt(ifmt)) * depth;
    }
  }
  assert.equal(glBytes, s.bytes, "the cap counts what GL stores");
  assert.ok(st.some((a) => a[2] === R8), "R8 pages");
  assert.ok(st.some((a) => a[2] === 0x8e8d), "BC7 pages");
  assert.equal(budget.stats.byKind.layer, s.liveBytes, "every booked byte is a stored layer");
  RIG.calls.length = 0;
});

test("B4 the boot's churn: re-plans are idle hits; a turnover evicts instead of growing; a squeezed cap reclaims", () => {
  assert.ok(RIG, "premise: B3");
  const pages = KIT.kitPages(RIG.renderer);
  const alloc = pages.alloc;
  const half = REPLAY.slice(REPLAY.length >> 1); // "chunk B"
  const created0 = alloc.stats.pagesCreated;
  const fresh0 = alloc.stats.fresh;
  for (let k = 0; k < BOOT.refused; k += 1) {
    for (const r of half) pages.release(r.ck);
    for (const r of half) { const g = pages.admit(r.tex, null, r.opts); assert.ok(g && !g.deferred, `re-plan ${k}: re-admitted`); }
  }
  assert.equal(alloc.stats.fresh, fresh0, "no upload: every re-admit an idle hit");
  assert.equal(alloc.stats.pagesCreated, created0, "no page");
  // A second landblock of the same mix after the first departed (all idle): idle layers are evicted, nothing grows.
  for (const r of REPLAY) pages.release(r.ck);
  const NEXT = buildReplay(BY_DIMS, "next");
  let refused = 0;
  for (const r of NEXT) { const g = pages.admit(r.tex, null, r.opts); if (!g || g.deferred) refused += 1; }
  assert.equal(refused, 0);
  assert.equal(alloc.stats.pagesCreated, created0, "no page: the departed layers were reused");
  assert.ok(alloc.bytes <= demandBound(alloc));
  assert.deepEqual(alloc.verify(), []);
  // A squeezed cap: everything idle, the cap at the reserved bytes; a NEW key reclaims idle-only pages at once.
  for (const r of NEXT) pages.release(r.ck);
  const cap0 = alloc.maxBytes;
  alloc.maxBytes = alloc.bytes;
  const big = [];
  for (let i = 0; i < 6; i += 1) big.push(bc7Of(512, 512, 200 + i));
  const reclaimed0 = alloc.stats.reclaimedPages;
  for (const t of big) { const g = pages.admit(t, null); assert.ok(g && !g.deferred, "the new key admitted"); }
  assert.ok(alloc.stats.reclaimedPages > reclaimed0, "idle-only pages reclaimed for it");
  assert.ok(alloc.bytes <= alloc.maxBytes);
  assert.deepEqual(alloc.verify(), []);
  alloc.maxBytes = cap0;
  KIT.resetKit();
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test("B5 demand invariants over a seeded run: verify after every op, wouldAcquire = acquire, an empty page goes at once", () => {
  const D = (f, w, h, extra = {}) => ({
    format: f, width: w, height: h, levels: PA.fullMipLevels(w, h), colorSpace: f === "r8" ? "" : THREE.SRGBColorSpace,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 1, ...extra,
  });
  const descs = [D("bc7", 128, 128), D("rgba8", 64, 64), D("r8", 64, 64), D("rgba8", 128, 64), D("bc7", 32, 32), D("rgba8", 256, 256), D("rgba8", 16, 16, { wrapS: THREE.ClampToEdgeWrapping })];
  const destroyed = [];
  const A = new PA.PageAllocator({
    demand: true, reclaimIdle: true, fitToCap: true, firstPageBytes: 64 * 1024, pageBytes: 512 * 1024, maxLayers: GL_MAX_LAYERS,
    maxBytes: 3 * MiB, onPageDestroy: (p) => destroyed.push(p.id),
  });
  const r = rng(0x5eed);
  const held = new Map();
  let grants = 0, refusals = 0, abandons = 0;
  for (let i = 0; i < 4000; i += 1) {
    const x = r();
    if (x < 0.55) {
      const d = descs[Math.floor(r() * descs.length)];
      const ck = `c${Math.floor(r() * 160)}|${PA.pageKeyOf(d)}`;
      const would = A.wouldAcquire(d, ck);
      const e = A.acquire(d, ck);
      assert.equal(!!e, would, `op ${i}: wouldAcquire ${would}, acquire ${!!e}`);
      if (e) {
        grants += 1;
        if (e.fresh && r() < 0.05) { // an upload that failed: abandoned at once
          const p = e.page;
          const last = p.free.length === p.capacity - 1;
          assert.ok(A.abandon(ck));
          abandons += 1;
          if (last) assert.ok(!A.pages.includes(p) && destroyed.includes(p.id), `op ${i}: the emptied page destroyed at once`);
        } else held.set(ck, (held.get(ck) || 0) + 1);
      } else refusals += 1;
    } else if (x < 0.97) {
      const ks = [...held.keys()];
      if (ks.length) {
        const ck = ks[Math.floor(r() * ks.length)];
        A.release(ck);
        const n = held.get(ck) - 1;
        if (n === 0) held.delete(ck); else held.set(ck, n);
      }
    } else A.trim();
    const bad = A.verify();
    assert.deepEqual(bad, [], `op ${i}: ${bad.slice(0, 3).join("; ")}`);
    for (const [ck, n] of held) assert.ok(A.refCount(ck) >= n, `${ck}: a live layer was lost`);
  }
  assert.ok(grants > 0 && refusals > 0 && abandons > 0 && A.stats.reclaimedPages > 0 && A.stats.fitted > 0 && A.stats.growthPages > 0 && A.stats.emptyReclaims > 0,
    JSON.stringify(A.stats));
});

test("B6 the kit's options; honest R8 bytes; flag-off: nothing before a consumer asks", () => {
  KIT.resetKit();
  assert.deepEqual(KIT.kitSummary(), { budget: null, pages: null, stateRows: null }, "nothing exists before a consumer");
  const { gl, renderer, calls } = glRig({ record: true });
  const pages = KIT.kitPages(renderer);
  const a = pages.alloc;
  assert.equal(a.demand, true, "demand-sized pages");
  assert.equal(a.firstPageBytes, 256 * 1024);
  assert.equal(a.pageBytes, 4 * MiB, "the per-page ceiling");
  assert.equal(a.minLayers, 4);
  assert.equal(a.reclaimIdle, true);
  assert.equal(a.fitToCap, true);
  assert.equal(a.maxBytes, CAP, "the stated cap");
  // R8: one byte a texel, booked and stored.
  const ao = adapter.surfacePixelsToAoTexture(new Uint8Array(64 * 64).fill(7), 64, 64);
  const d = AP.describeTexture(ao, AP.R8_PLANES);
  assert.equal(PA.layerBytesOf(d), 4096 + 1024 + 256 + 64 + 16 + 4 + 1);
  const budget = new UB.UploadBudget({ bytesPerFrame: 1 << 20, admitsPerFrame: 4 });
  budget.beginFrame(1);
  calls.length = 0;
  const r = pages.admit(ao, budget, AP.R8_PLANES);
  assert.ok(r && r.page, "admitted");
  assert.equal(budget.stats.byKind.layer, 5461, "booked: one byte a texel");
  const st = calls.find((c) => c[0] === "texStorage3D")[1];
  assert.equal(st[2], gl.R8, "R8 storage");
  assert.equal(r.page.capacity, Math.floor(256 * 1024 / 5461), "a 256 KiB first page");
  assert.equal(a.bytes, r.page.capacity * 5461);
  // An admit the cap refuses says so (array_pages.js lastRefusal), and the probes agree.
  a.maxBytes = a.bytes;
  const rg = adapter.surfacePixelsToRoughnessTexture(new Uint8Array(64 * 64).fill(3), 64, 64);
  assert.equal(pages.wouldAdmit(rg), false);
  assert.equal(pages.neverFits(rg), false, "room could appear");
  assert.equal(pages.admit(rg, budget), null);
  assert.equal(pages.lastRefusal, "cap");
  assert.equal(pages.stats.capRefused, 1);
  const huge = adapter.surfacePixelsToRoughnessTexture(new Uint8Array(1024 * 1024).fill(3), 1024, 1024);
  assert.equal(pages.neverFits(huge), true, "one layer over the whole cap");
  assert.ok(pages.admit(ao, budget, AP.R8_PLANES), "a resident layer still admits");
  assert.equal(pages.lastRefusal, null);
  KIT.resetKit();
});
