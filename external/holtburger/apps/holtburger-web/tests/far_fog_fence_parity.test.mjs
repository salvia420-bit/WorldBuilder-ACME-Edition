// tests/far_fog_fence_parity.test.mjs — round 3 R3-2 `farFogAsync` audit
// (2026-10-30). The plan's `?farFogAsync` ("PBO + fenceSync instead of the
// synchronous 1 Hz readback") is the shipped `?farFogFence` (default ON since
// 2026-10-17, scene3d/loop.js `_issueFogFence` / `_harvestFogFence`); no new
// flag. This suite adds what tests/far_fog_fence.test.mjs (mock GL, state
// machine) does not cover, on the REAL three r184 renderer over
// tests/helpers/fake_webgl2.mjs with readPixels / pixel-pack buffers / fences
// emulated:
//
//   F1  the fenced path end to end: the issue frame renders the sky quad into
//       the 8x8 HalfFloat probe target and reads THAT framebuffer into the
//       persistent PBO (offset 0, rect 0,0,8,8, RGBA / HALF_FLOAT), returns
//       null with the PBO unbound; no read before SIGNALED; the harvest frame
//       returns the sample with the PBO unbound; one buffer, reused.
//   F2  same colour as the synchronous path: identical texels give the
//       identical {r, g, b} through three's `readRenderTargetPixels`, and both
//       equal an independent float64 average of the finite texels (the 0xFFFF
//       / NaN / Inf texels excluded).
//   F3  falls back to the synchronous read when fences are unavailable (a
//       context without fenceSync, a renderer without
//       readRenderTargetPixelsAsync): one probe, sample on the issue frame,
//       `fallbacks` counted, nothing left bound.
//   F4  the fence never signals ⇒ timeout failure, never a read.
//
// Run from apps/holtburger-web/:  node tests/far_fog_fence_parity.test.mjs

globalThis.window ??= {};
globalThis.window.location ??= { search: "?farFogSkyHz=4" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};
globalThis.window.__playEffectVfxBound = true;
globalThis.location ??= globalThis.window.location;

let now = 10000;
Object.defineProperty(globalThis.performance, "now", { value: () => now, configurable: true, writable: true });

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const LOOP = await import("../scene3d/loop.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const PX = 8;
// binary16 encode (round-to-nearest-even) for the texel source.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) return sign; // tiny values flush (not used here)
  let h = sign | (e << 10) | (m >>> 13);
  const rest = m & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h += 1;
  return h;
}
function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return s * f * 5.9604644775390625e-8;
  if (e === 0x1f) return f ? NaN : s * Infinity;
  return s * (f + 1024) * Math.pow(2, e - 25);
}
// The "rendered" 8x8 sky: a gradient, plus one NaN, one +Inf and one 0xFFFF texel.
const TEXELS = (() => {
  const t = new Uint16Array(PX * PX * 4);
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const i = (y * PX + x) * 4;
      t[i] = toHalf(0.21 + 0.013 * x + 0.004 * y);
      t[i + 1] = toHalf(0.33 + 0.002 * x + 0.011 * y);
      t[i + 2] = toHalf(0.52 + 0.007 * (x ^ y));
      t[i + 3] = toHalf(1);
    }
  }
  t[(2 * PX + 3) * 4 + 1] = 0x7e00; // NaN in G ⇒ the whole texel is excluded
  t[(5 * PX + 6) * 4 + 0] = 0x7c00; // +Inf in R
  t.fill(0xffff, (7 * PX + 7) * 4, (7 * PX + 7) * 4 + 3);
  return t;
})();
const EXPECT = (() => {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0; i < TEXELS.length; i += 4) {
    const pr = halfToFloat(TEXELS[i]); const pg = halfToFloat(TEXELS[i + 1]); const pb = halfToFloat(TEXELS[i + 2]);
    if (!Number.isFinite(pr) || !Number.isFinite(pg) || !Number.isFinite(pb)) continue;
    r += pr; g += pg; b += pb; n++;
  }
  return { r: r / n, g: g / n, b: b / n, n };
})();

/**
 * Real three over the fake GL, with readPixels / PBO / fence emulation.
 * `fences: false` hides fenceSync (the fallback arm).
 */
function rig({ fences = true, signal = true } = {}) {
  const raw = createFakeWebGL2({ width: 800, height: 600 });
  const PACK = raw.PIXEL_PACK_BUFFER;
  const st = { readFb: null, drawFb: null, pack: null, stores: new Map(), syncs: [], log: [] };
  const over = {
    __isFakeGL: true,
    bindFramebuffer(t, f) {
      if (t === raw.FRAMEBUFFER || t === raw.READ_FRAMEBUFFER) st.readFb = f || null;
      return raw.bindFramebuffer(t, f);
    },
    bindBuffer(t, b) { if (t === PACK) st.pack = b || null; return raw.bindBuffer(t, b); },
    createBuffer() { const b = raw.createBuffer(); st.stores.set(b, new Uint16Array(PX * PX * 4)); return b; },
    bufferData(t, sizeOrData, usage) {
      if (t === PACK && st.pack) st.log.push(["bufferData", st.pack.__id, sizeOrData, usage]);
      return raw.bufferData(t, sizeOrData, usage);
    },
    bufferSubData(t, off, src) {
      if (t === PACK && st.pack) st.stores.get(st.pack).set(src, off / 2);
      return raw.bufferSubData(t, off, src);
    },
    readPixels(x, y, w, h, fmt, type, dst) {
      st.log.push(["readPixels", st.readFb ? st.readFb.__id : null, x, y, w, h, fmt, type,
        typeof dst === "number" ? dst : "array", st.pack ? st.pack.__id : null]);
      if (st.pack) { st.stores.get(st.pack).set(TEXELS, (dst | 0) / 2); return undefined; }
      if (dst && dst.set) dst.set(TEXELS);
      return undefined;
    },
    getBufferSubData(t, off, dst) {
      st.log.push(["getBufferSubData", st.pack ? st.pack.__id : null, st.syncs.length ? st.syncs[st.syncs.length - 1].signaled : null]);
      dst.set(st.stores.get(st.pack));
    },
    fenceSync() { const s = { __kind: "sync", signaled: signal === "now", deleted: false }; st.syncs.push(s); st.log.push(["fenceSync"]); return s; },
    getSyncParameter(s, p) { return s.signaled ? raw.SIGNALED : raw.UNSIGNALED; },
    clientWaitSync(s) { return s.signaled ? raw.ALREADY_SIGNALED : raw.TIMEOUT_EXPIRED; },
    deleteSync(s) { s.deleted = true; },
    flush() { st.log.push(["flush"]); },
  };
  const gl = new Proxy(raw, {
    get(t, p) {
      if (!fences && (p === "fenceSync" || p === "clientWaitSync")) return undefined;
      return p in over ? over[p] : t[p];
    },
  });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, 800, 600), context: gl });
  renderer.setSize(800, 600, false);
  if (!fences) renderer.readRenderTargetPixelsAsync = undefined;
  const skyScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x8899aa }));
  skyScene.add(quad);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);
  const s3 = { renderer, camera, skyDome: { skyScene, _lastIsIndoor: false }, atmosphereSky: { skyMesh: quad },
    terrainBakedLbs: new Set([1]) };
  return { raw, gl, st, renderer, s3, PACK };
}
const exactly = (a, b) => a && b && a.r === b.r && a.g === b.g && a.b === b.b;
const near = (a, b) => a && b && Math.abs(a.r - b.r) < 1e-12 && Math.abs(a.g - b.g) < 1e-12 && Math.abs(a.b - b.b) < 1e-12;

// ---------------------------------------------------------------------------
console.log("-- F1 fenced path end to end ----------------------------------------");
let fenced = null;
{
  LOOP.__fogProbeStateForTest(true);
  const R = rig();
  now += 1000;
  const r0 = LOOP.__fogProbeForTest(R.s3);
  check("issue frame returns null (the read is in flight)", r0 === null);
  const rp = R.st.log.filter((e) => e[0] === "readPixels");
  check("exactly one readPixels on the issue frame", rp.length === 1, JSON.stringify(rp));
  check("…of a render-target framebuffer (the probe target, not the canvas)", rp.length === 1 && rp[0][1] !== null,
    JSON.stringify(rp[0]));
  check("…rect 0,0,8,8 RGBA / HALF_FLOAT into the PBO at offset 0",
    rp.length === 1 && rp[0][2] === 0 && rp[0][3] === 0 && rp[0][4] === PX && rp[0][5] === PX &&
    rp[0][6] === R.raw.RGBA && rp[0][7] === R.raw.HALF_FLOAT && rp[0][8] === 0 && rp[0][9] !== null, JSON.stringify(rp[0]));
  const bd = R.st.log.find((e) => e[0] === "bufferData");
  check("the PBO is STREAM_READ, sized for the 8x8 RGBA16F read", bd && bd[2] === PX * PX * 4 * 2 && bd[3] === R.raw.STREAM_READ,
    JSON.stringify(bd));
  check("fence after the read, then flush", R.st.log.findIndex((e) => e[0] === "fenceSync") >
    R.st.log.findIndex((e) => e[0] === "readPixels") && R.st.log.some((e) => e[0] === "flush"));
  check("PBO unbound on return to the frame", R.st.pack === null);
  check("no read in the issue frame", !R.st.log.some((e) => e[0] === "getBufferSubData"));
  now += 16;
  check("pending frame returns null, no read", LOOP.__fogProbeForTest(R.s3) === null &&
    !R.st.log.some((e) => e[0] === "getBufferSubData"));
  R.st.syncs[0].signaled = true;
  now += 16;
  fenced = LOOP.__fogProbeForTest(R.s3);
  const reads = R.st.log.filter((e) => e[0] === "getBufferSubData");
  check("harvest after SIGNALED returns the sample", !!fenced && reads.length === 1 && reads[0][2] === true,
    JSON.stringify(reads));
  check("PBO unbound after the harvest", R.st.pack === null);
  check("the sync is deleted after the harvest", R.st.syncs[0].deleted === true);
  now += 300;
  LOOP.__fogProbeForTest(R.s3);
  const created = new Set(R.st.log.filter((e) => e[0] === "readPixels").map((e) => e[9]));
  check("the next probe reuses the same PBO", created.size === 1 && R.st.syncs.length === 2);
  check("fenced sample = the float64 average of the finite texels", near(fenced, EXPECT),
    JSON.stringify({ fenced, EXPECT }));
  check("…which excluded the NaN / Inf / 0xFFFF texels (61 of 64)", EXPECT.n === 61, String(EXPECT.n));
}

// ---------------------------------------------------------------------------
console.log("-- F2/F3 the synchronous fallback, same colour --------------------------");
{
  LOOP.__fogProbeStateForTest(true);
  const R = rig({ fences: false });
  now += 1000;
  const sync = LOOP.__fogProbeForTest(R.s3);
  const st = LOOP.__fogProbeStateForTest();
  check("no fences ⇒ the sample lands on the issue frame (synchronous readRenderTargetPixels)", !!sync);
  check("…through readPixels into a client array, no PBO bound",
    R.st.log.filter((e) => e[0] === "readPixels").every((e) => e[8] === "array" && e[9] === null) &&
    R.st.log.filter((e) => e[0] === "readPixels").length === 1, JSON.stringify(R.st.log));
  check("…counted as a fence fallback", st.stats.fallbacks === 1 && st.stats.issued === 0, JSON.stringify(st.stats));
  check("…nothing left pending or bound", st.pending === false && st.inFlight === false && R.st.pack === null);
  check("F2 same colour as the fenced path, exactly", exactly(sync, fenced), JSON.stringify({ sync, fenced }));
  check("F2 the sync read targets the same framebuffer shape (8x8 RGBA / HALF_FLOAT)",
    R.st.log.filter((e) => e[0] === "readPixels").every((e) => e[4] === PX && e[5] === PX &&
      e[6] === R.raw.RGBA && e[7] === R.raw.HALF_FLOAT));
}

// ---------------------------------------------------------------------------
console.log("-- F4 a fence that never signals ------------------------------------");
{
  LOOP.__fogProbeStateForTest(true);
  const R = rig({ signal: false });
  now += 1000;
  LOOP.__fogProbeForTest(R.s3);
  now += 2100;
  const r = LOOP.__fogProbeForTest(R.s3);
  const st = LOOP.__fogProbeStateForTest();
  check("timeout ⇒ null, counted, never read", r === null && st.stats.timeouts === 1 &&
    !R.st.log.some((e) => e[0] === "getBufferSubData"), JSON.stringify(st.stats));
  check("…the dropped sync is deleted and nothing stays bound", R.st.syncs[0].deleted === true && R.st.pack === null);
}

LOOP.__fogProbeStateForTest(true);
console.log(`\nfar_fog_fence_parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
