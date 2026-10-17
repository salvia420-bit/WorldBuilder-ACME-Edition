// tests/far_fog_fence.test.mjs — ?farFogFence (2026-10-17, default ON).
//
// The horizon-sky fog probe read back through three's readRenderTargetPixels
// Async, whose getBufferSubData blocked the main thread in a GPU-process
// round-trip (1070 trace: ImplementationBase::WaitForCmd 1.0-4.7 ms, 4x/s).
// The fenced path: one persistent pixel-pack buffer, fenceSync after the
// readPixels, one non-blocking status poll per frame, the read only after the
// fence is observed SIGNALED on a later frame. Locks (mock WebGL2):
//   1. issue: readPixels into the PBO, PBO unbound before returning, fence +
//      flush, no read in the issuing frame;
//   2. never read before SIGNALED; the read lands the sample (fog colour lags
//      only while the fence is pending); PBO unbound after;
//   3. the buffer is created once and reused;
//   4. a fence that never signals fails after the timeout (sticky fallback
//      after three); a readPixels that wrote nothing fails on the sentinel;
//   5. `?farFogFence=off` → three's readRenderTargetPixelsAsync, as before.
//
// Run from apps/holtburger-web/:  node tests/far_fog_fence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};
// loop.js pulls in play_effect_vfx.js, which polls 30 s for a plugin client.
globalThis.window.__playEffectVfxBound = true;

let now = 10000;
Object.defineProperty(globalThis.performance, "now", { value: () => now, configurable: true, writable: true });

const THREE = await import("three");
const LOOP = await import("../scene3d/loop.js");

const HALF_0_5 = 0x3800; // binary16 0.5

function mockGl({ writes = true } = {}) {
  const log = [];
  const gl = {
    PIXEL_PACK_BUFFER: 0x88eb, STREAM_READ: 0x88e1, RGBA: 0x1908, HALF_FLOAT: 0x140b,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, SYNC_STATUS: 0x9114, SIGNALED: 0x9119, UNSIGNALED: 0x9118,
    packBound: null, stores: new Map(), syncs: [], log, created: 0,
    createBuffer() { this.created += 1; const b = { id: this.created }; this.stores.set(b, new Uint16Array(256)); return b; },
    bindBuffer(t, b) { if (t === this.PIXEL_PACK_BUFFER) this.packBound = b; log.push(["bind", b ? b.id : null]); },
    bufferData(t, n) { log.push(["bufferData", n]); },
    bufferSubData(t, off, src) { this.stores.get(this.packBound).set(src); log.push(["bufferSubData"]); },
    readPixels(x, y, w, h, f, ty, off) {
      log.push(["readPixels", this.packBound ? this.packBound.id : null, f, ty, off]);
      if (writes && this.packBound) this.stores.get(this.packBound).fill(HALF_0_5);
    },
    fenceSync() { const s = { signaled: false, deleted: false }; this.syncs.push(s); log.push(["fence"]); return s; },
    flush() { log.push(["flush"]); },
    getSyncParameter(s, p) { return s.signaled ? this.SIGNALED : this.UNSIGNALED; },
    deleteSync(s) { s.deleted = true; },
    getBufferSubData(t, off, dst) {
      const sync = this.syncs[this.syncs.length - 1];
      log.push(["getBufferSubData", sync && sync.signaled]);
      dst.set(this.stores.get(this.packBound));
    },
  };
  return gl;
}

function scene3dWith(gl, { asyncCalls } = {}) {
  const skyScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  skyScene.add(quad);
  const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);
  let target = null;
  const renderer = {
    autoClear: true,
    capabilities: { textureFormatReadable: () => true, textureTypeReadable: () => true },
    getContext: () => gl,
    getRenderTarget: () => target,
    setRenderTarget: (t) => { target = t; },
    render: () => {},
    readRenderTargetPixelsAsync: async (...a) => { asyncCalls?.push(a); return a[5]; },
    readRenderTargetPixels: () => {},
  };
  return { renderer, camera, skyDome: { skyScene, _lastIsIndoor: false }, atmosphereSky: { skyMesh: quad },
    terrainBakedLbs: new Set([1]) };
}

const reads = (gl) => gl.log.filter((e) => e[0] === "getBufferSubData");

test("1-3. issue, poll, read only after SIGNALED, buffer reused", () => {
  LOOP.__fogProbeStateForTest(true);
  const gl = mockGl();
  const s3 = scene3dWith(gl);
  assert.equal(LOOP.__fogProbeForTest(s3), null, "issuing frame returns null");
  const rp = gl.log.find((e) => e[0] === "readPixels");
  assert.ok(rp && rp[1] === 1 && rp[2] === gl.RGBA && rp[3] === gl.HALF_FLOAT && rp[4] === 0, "readPixels into the PBO at offset 0");
  assert.equal(gl.packBound, null, "PBO unbound before returning to the frame");
  assert.ok(gl.log.findIndex((e) => e[0] === "fence") > gl.log.findIndex((e) => e[0] === "readPixels"), "fence after the read");
  assert.ok(gl.log.some((e) => e[0] === "flush"));
  assert.equal(reads(gl).length, 0, "no read in the issuing frame");
  assert.equal(LOOP.__fogProbeStateForTest().pending, true);

  now += 16; assert.equal(LOOP.__fogProbeForTest(s3), null, "pending frame");
  now += 16; assert.equal(LOOP.__fogProbeForTest(s3), null);
  assert.equal(reads(gl).length, 0, "never read while unsignaled");

  gl.syncs[0].signaled = true;
  now += 16;
  const sample = LOOP.__fogProbeForTest(s3);
  assert.ok(sample && Math.abs(sample.r - 0.5) < 1e-6 && Math.abs(sample.g - 0.5) < 1e-6, "the read lands the sample");
  assert.deepEqual(reads(gl).map((e) => e[1]), [true], "exactly one read, after SIGNALED");
  assert.equal(gl.packBound, null, "PBO unbound after the read");
  assert.equal(gl.syncs[0].deleted, true);
  const st = LOOP.__fogProbeStateForTest();
  assert.equal(st.last, sample);
  assert.equal(st.inFlight, false);
  assert.equal(st.stats.lastPolls, 3, "read on the third poll");

  now += 16; assert.equal(LOOP.__fogProbeForTest(s3), null, "throttled (4 Hz): no new issue");
  assert.equal(gl.syncs.length, 1);
  now += 300; LOOP.__fogProbeForTest(s3);
  assert.equal(gl.syncs.length, 2, "next probe issued after the throttle");
  assert.equal(gl.created, 1, "the pixel-pack buffer is created once and reused");
});

test("4. timeout and sentinel failures; three in a row = sticky fallback", () => {
  LOOP.__fogProbeStateForTest(true);
  const gl = mockGl();
  const s3 = scene3dWith(gl);
  LOOP.__fogProbeForTest(s3);
  now += 2100;
  assert.equal(LOOP.__fogProbeForTest(s3), null);
  let st = LOOP.__fogProbeStateForTest();
  assert.equal(st.stats.timeouts, 1);
  assert.equal(st.inFlight, false);
  assert.equal(st.fails, 1);
  assert.equal(reads(gl).length, 0, "a fence that never signalled is never read");

  LOOP.__fogProbeStateForTest(true);
  const dead = mockGl({ writes: false });
  const s4 = scene3dWith(dead);
  for (let i = 0; i < 3; i++) {
    now += 300;
    LOOP.__fogProbeForTest(s4);
    dead.syncs[dead.syncs.length - 1].signaled = true;
    now += 16;
    assert.equal(LOOP.__fogProbeForTest(s4), null, "sentinel survived → failure, not black fog");
  }
  st = LOOP.__fogProbeStateForTest();
  assert.equal(st.dead, true, "three failures → sticky authored-hex fallback");
  assert.equal(st.last, null);
});

test("5. ?farFogFence=off uses three's async readback", async () => {
  LOOP.__fogProbeStateForTest(true);
  window.location = { search: "?farFogFence=off" };
  // far_terrain_flags caches per page; a fresh module instance reads the URL.
  const FLAGS = await import("../scene3d/far_terrain_flags.js?fenceoff");
  assert.equal(FLAGS.farFogFenceEnabled(), false, "reader honours =off");
  window.location = { search: "" };
  const src = (await import("node:fs")).readFileSync(new URL("../scene3d/loop.js", import.meta.url), "utf8");
  const gate = src.indexOf("if (farFogFenceEnabled()) {");
  const three = src.indexOf("renderer.readRenderTargetPixelsAsync(");
  assert.ok(gate > 0 && three > gate, "the three path follows the fence gate (flag off / fallback)");
});
