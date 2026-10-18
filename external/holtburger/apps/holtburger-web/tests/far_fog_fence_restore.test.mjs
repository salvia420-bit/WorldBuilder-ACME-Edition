// tests/far_fog_fence_restore.test.mjs — the ?farFogFence horizon probe across a
// WebGL context loss + restore, and the sticky fallback it can end in (review
// 2026-10-18, RENDER-4 + the loop.js fog-colour extra).
//
// A restore keeps the same WebGL2RenderingContext object, so `f.gl !== gl`
// never sees it, but the persistent pixel-pack buffer and any pending sync are
// dead. Chrome does not throw on them: getSyncParameter answers null,
// bindBuffer(dead) binds nothing, readPixels(..., 0) with no PIXEL_PACK_BUFFER
// fails, and getBufferSubData leaves the 0xFFFF sentinel. Three probes later
// the probe latched its sticky fallback for the session. The mock below models
// that, and the restore fires the canvas listener the probe registers.
// Also locked: once the probe HAS latched, the fog takes the authored hex (the
// caller's `?? _fogProbeLast` must not keep the last sample frozen forever).
//
// Run from apps/holtburger-web/:  node tests/far_fog_fence_restore.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
// Step the clock in 4 Hz periods (300 ms gaps), as tests/far_fog_fence.test.mjs does.
globalThis.window.location ??= { search: "?farFogSkyHz=4" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};
// loop.js pulls in play_effect_vfx.js, which polls 30 s for a plugin client.
globalThis.window.__playEffectVfxBound = true;

let now = 10000;
Object.defineProperty(globalThis.performance, "now", { value: () => now, configurable: true, writable: true });

const THREE = await import("three");
const LOOP = await import("../scene3d/loop.js");

const HALF_0_5 = 0x3800; // binary16 0.5

/** Mock WebGL2 with a context generation: objects from an older one are dead. */
function mockGl({ writes = true } = {}) {
  const gl = {
    PIXEL_PACK_BUFFER: 0x88eb, STREAM_READ: 0x88e1, RGBA: 0x1908, HALF_FLOAT: 0x140b,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, SYNC_STATUS: 0x9114, SIGNALED: 0x9119, UNSIGNALED: 0x9118,
    gen: 0, packBound: null, stores: new Map(), syncs: [], created: 0, writes,
    live(o) { return !!o && o.gen === this.gen; },
    createBuffer() { this.created += 1; const b = { id: this.created, gen: this.gen }; this.stores.set(b, new Uint16Array(256)); return b; },
    bindBuffer(t, b) { if (t !== this.PIXEL_PACK_BUFFER) return; if (b && !this.live(b)) return; /* INVALID_OPERATION */ this.packBound = b; },
    bufferData() {},
    bufferSubData(t, off, src) { if (this.packBound) this.stores.get(this.packBound).set(src); },
    readPixels() { if (this.packBound && this.writes) this.stores.get(this.packBound).fill(HALF_0_5); },
    fenceSync() { const s = { signaled: false, gen: this.gen }; this.syncs.push(s); return s; },
    flush() {},
    getSyncParameter(s) { if (!this.live(s)) return null; return s.signaled ? this.SIGNALED : this.UNSIGNALED; },
    deleteSync() {},
    getBufferSubData(t, off, dst) { if (this.packBound) dst.set(this.stores.get(this.packBound)); },
  };
  return gl;
}

function scene3dWith(gl) {
  const skyScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  skyScene.add(quad);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);
  const listeners = [];
  const canvas = {
    addEventListener(t, f) { if (t === "webglcontextrestored") listeners.push(f); },
    removeEventListener() {},
  };
  let target = null;
  const renderer = {
    autoClear: true,
    domElement: canvas,
    capabilities: { textureFormatReadable: () => true, textureTypeReadable: () => true },
    getContext: () => gl,
    getRenderTarget: () => target,
    setRenderTarget: (t) => { target = t; },
    render: () => {},
    readRenderTargetPixelsAsync: async (...a) => a[5],
    readRenderTargetPixels: () => {},
  };
  const restore = () => { gl.gen += 1; gl.packBound = null; for (const f of [...listeners]) f({}); };
  return { s3: { renderer, camera, skyDome: { skyScene, _lastIsIndoor: false }, atmosphereSky: { skyMesh: quad },
    terrainBakedLbs: new Set([1]) }, restore, listeners };
}

/** One probe cycle: issue (after the throttle), the GPU signals, harvest. */
function cycle(gl, s3) {
  now += 300;
  LOOP.__fogProbeForTest(s3);
  const s = gl.syncs[gl.syncs.length - 1];
  if (s) s.signaled = true;
  now += 16;
  return LOOP.__fogProbeForTest(s3);
}

test("a restore mid-read: the probe rebuilds its buffer instead of latching the fallback", () => {
  LOOP.__fogProbeStateForTest(true);
  const gl = mockGl();
  const { s3, restore, listeners } = scene3dWith(gl);
  const first = cycle(gl, s3);
  assert.ok(first && Math.abs(first.r - 0.5) < 1e-6, "a sample lands before the loss");
  assert.equal(listeners.length, 1, "the probe listens for the restore");
  now += 300;
  LOOP.__fogProbeForTest(s3); // a read in flight at loss time
  assert.equal(LOOP.__fogProbeStateForTest().pending, true);

  restore();
  let st = LOOP.__fogProbeStateForTest();
  assert.equal(st.pending, false, "the dead sync is dropped on restore");
  assert.equal(st.inFlight, false);

  for (let i = 0; i < 4; i++) {
    const sample = cycle(gl, s3);
    assert.ok(sample && Math.abs(sample.g - 0.5) < 1e-6, `probe ${i + 1} after the restore reads a real sample`);
  }
  st = LOOP.__fogProbeStateForTest();
  assert.equal(st.dead, false, "not latched");
  assert.equal(st.fails, 0);
  assert.equal(gl.created, 2, "one new pixel-pack buffer for the restored context");
  assert.equal(listeners.length, 1, "the listener is registered once per canvas");
});

test("a restore gives an already-latched probe a fresh start", () => {
  LOOP.__fogProbeStateForTest(true);
  const gl = mockGl({ writes: false });
  const { s3, restore } = scene3dWith(gl);
  for (let i = 0; i < 3; i++) cycle(gl, s3);
  assert.equal(LOOP.__fogProbeStateForTest().dead, true, "three sentinel failures latch the fallback");
  gl.writes = true;
  restore();
  const sample = cycle(gl, s3);
  assert.ok(sample && Math.abs(sample.b - 0.5) < 1e-6, "the restored context probes again");
});

test("once latched, the fog falls back to the authored hex, not the last sample", () => {
  LOOP.__fogProbeStateForTest(true);
  const gl = mockGl();
  const { s3 } = scene3dWith(gl);
  const good = cycle(gl, s3);
  assert.ok(good, "a good sample first");
  assert.equal(LOOP.__fogProbeStateForTest().last, good);
  gl.writes = false; // every later read leaves the sentinel
  for (let i = 0; i < 3; i++) assert.equal(cycle(gl, s3), null);
  const st = LOOP.__fogProbeStateForTest();
  assert.equal(st.dead, true);
  // tickDistanceFogColor uses `sampleHorizonSkyRadiance(scene3d) ?? _fogProbeLast`.
  assert.equal(LOOP.__fogProbeForTest(s3), null, "the dead probe samples nothing");
  assert.equal(st.last, null, "and the stale sample is dropped, so the fallback is the authored hex");
});
