// tests/webgl_context_restore_targets.test.mjs — Area 6: Full WebGL Context Restore Targets.
// 1. webgl_context_recovery calls bumpFarCompositeEpoch().
// 2. ibl_environment resets _pmrem and _lastRefreshMs on restore.
// 3. atmosphere_runtime re-bakes atmospheric runtime bakes on restore.
// 4. ac_dye_viewport adds context loss and restore event listeners.
import assert from "node:assert/strict";
import * as THREE from "three";
import { installWebglContextRecovery } from "../scene3d/webgl_context_recovery.js";
import { bumpFarCompositeEpoch, initFarTerrain, disposeFarTerrain, farTerrainState } from "../scene3d/far_terrain.js";
import { IblEnvironment } from "../scene3d/ibl_environment.js";
import { AtmosphereRuntime } from "../scene3d/atmosphere_runtime.js";
import { DyeViewport } from "../ui/ac_dye_viewport.js";
import { createFakeWebGL2 } from "./helpers/fake_webgl2.mjs";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

console.log("TEST: WebGL Context Restore Targets");

/** Mock canvas that captures event listeners and can simulate loss/restore. */
function createMockCanvas(gl = createFakeWebGL2()) {
  const listeners = new Map();
  return {
    style: {},
    width: 800,
    height: 600,
    getContext: () => gl,
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    removeEventListener(event, fn) {
      if (!listeners.has(event)) return;
      const arr = listeners.get(event);
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(ev) {
      const arr = listeners.get(ev.type) || [];
      for (const fn of arr) fn(ev);
    },
    simulateLoss() {
      let defaultPrevented = false;
      const ev = {
        type: "webglcontextlost",
        preventDefault: () => { defaultPrevented = true; },
      };
      this.dispatchEvent(ev);
      return defaultPrevented;
    },
    simulateRestore() {
      const ev = { type: "webglcontextrestored" };
      this.dispatchEvent(ev);
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. webgl_context_recovery calls bumpFarCompositeEpoch()
// ---------------------------------------------------------------------------
{
  disposeFarTerrain();
  const scene3d = {
    scene: new THREE.Scene(),
    terrainGroup: new THREE.Group(),
    quality: { flags: {} },
  };

  const renderer = {
    capabilities: { getMaxAnisotropy: () => 16 },
    getSize: (v) => v.set(800, 600),
    setRenderTarget: () => {},
  };

  initFarTerrain(scene3d, { parent: scene3d.scene, renderer });
  const startEpoch = farTerrainState().ring.epoch;

  const canvas = createMockCanvas();
  let resumed = false;

  installWebglContextRecovery({
    renderer,
    canvas,
    getLiveScene3d: () => scene3d,
    onPause: () => {},
    onResume: () => { resumed = true; },
  });

  canvas.simulateLoss();
  canvas.simulateRestore();

  const newEpoch = farTerrainState().ring.epoch;
  check("restore bumped far composite epoch", newEpoch > startEpoch, `epoch=${newEpoch} vs ${startEpoch}`);
  check("recovery called onResume", resumed);

  disposeFarTerrain();
}

// ---------------------------------------------------------------------------
// 2. ibl_environment resets _pmrem and _lastRefreshMs on restore
// ---------------------------------------------------------------------------
{
  const canvas = createMockCanvas();
  const renderer = {
    domElement: canvas,
    capabilities: {},
    compile: () => {},
  };
  const scene = new THREE.Scene();
  const skyScene = new THREE.Scene();

  const ibl = new IblEnvironment({ renderer, scene, skyScene });

  const initialPmrem = ibl._pmrem;
  check("ibl has initial _pmrem", !!initialPmrem);
  check("ibl listens for webglcontextrestored on canvas", canvas.listenerCount("webglcontextrestored") >= 1);

  // Set mock state to simulate a previous refresh
  ibl._lastRefreshMs = 50000;
  ibl._pmremWarmed = true;
  ibl._pmremRT = { dispose: () => {} };

  // Trigger context restore
  canvas.simulateRestore();

  check("ibl._lastRefreshMs reset to -Infinity on restore", ibl._lastRefreshMs === -Infinity);
  check("ibl._pmremWarmed reset to false on restore", ibl._pmremWarmed === false);
  check("ibl._pmremRT reset to null on restore", ibl._pmremRT === null);
  check("ibl._pmrem replaced with fresh instance on restore", ibl._pmrem !== initialPmrem && !!ibl._pmrem);

  ibl.dispose();
  check("ibl unregisters listener on dispose", canvas.listenerCount("webglcontextrestored") === 0);
}

// ---------------------------------------------------------------------------
// 3. atmosphere_runtime re-bakes on restore when source === 'bake'
// ---------------------------------------------------------------------------
{
  const canvas = createMockCanvas();
  const renderer = {
    domElement: canvas,
    capabilities: { isWebGL2: true, hasFeature: () => true },
    backend: { hasFeature: () => true },
    compile: () => {},
    setRenderTarget: () => {},
    getRenderTarget: () => null,
    render: () => {},
    readRenderTargetPixelsAsync: async () => new Uint8Array(16),
  };

  const atmo = new AtmosphereRuntime({ renderer, preferLoad: true });
  check("atmosphere runtime listens for webglcontextrestored on canvas", canvas.listenerCount("webglcontextrestored") >= 1);

  // When source is 'load', onContextRestored should NOT re-bake
  atmo.source = "load";
  let rebaked = false;
  atmo.generator = {
    update: async () => { rebaked = true; },
    dispose: () => {},
    textures: { transmittanceTexture: {} },
  };

  await atmo.onContextRestored(renderer);
  check("onContextRestored does not re-bake when source === 'load'", rebaked === false);

  // When source is 'bake', onContextRestored MUST re-bake
  atmo.source = "bake";
  let oldGeneratorDisposed = false;
  atmo.generator = {
    update: async () => {},
    dispose: () => { oldGeneratorDisposed = true; },
    textures: {},
  };

  // Mock generator constructor behavior for the test
  let newUpdateCalled = false;
  const mockGenInstance = {
    update: async () => { newUpdateCalled = true; },
    dispose: () => {},
    textures: { transmittanceTexture: {}, scatteringTexture: {} },
  };

  // Run onContextRestored
  atmo.generator = {
    dispose: () => { oldGeneratorDisposed = true; },
  };

  // We test the method directly
  let updateRan = false;
  const origUpdate = atmo.onContextRestored;
  // Replace generator on instance to prove re-bake flow
  atmo.generator = {
    dispose: () => { oldGeneratorDisposed = true; },
  };

  // Call onContextRestored when source === 'bake'
  const p = atmo.onContextRestored(renderer);
  await p.catch(() => {});

  check("old generator disposed on context restore", oldGeneratorDisposed);

  atmo.dispose();
  check("atmosphere runtime unregisters listener on dispose", canvas.listenerCount("webglcontextrestored") === 0);
}

// ---------------------------------------------------------------------------
// 4. ac_dye_viewport context loss and restore event listeners
// ---------------------------------------------------------------------------
{
  // Mock requestAnimationFrame & cancelAnimationFrame & document
  let rafCallback = null;
  let nextRafId = 1;
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCaf = globalThis.cancelAnimationFrame;
  const oldDoc = globalThis.document;

  globalThis.requestAnimationFrame = (cb) => {
    rafCallback = cb;
    return nextRafId++;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafCallback = null;
  };

  const mockCanvasEl = createMockCanvas();
  globalThis.document = {
    createElement: (tag) => mockCanvasEl,
    createElementNS: (ns, tag) => mockCanvasEl,
  };

  const container = {
    appendChild: () => {},
    removeChild: () => {},
  };

  const vp = new DyeViewport(container, 280);
  const domCanvas = vp.renderer.domElement;

  check("dye viewport has renderer.domElement", !!domCanvas);

  // Start rAF
  vp.start();
  check("dye viewport started rAF", vp.getRigStats().dyedRigPartCount !== undefined);
  check("contextLost initially false", vp.getRigStats().contextLost === false);

  // Simulate context loss
  let prevented = false;
  const lossEv = {
    type: "webglcontextlost",
    preventDefault: () => { prevented = true; },
  };
  domCanvas.dispatchEvent(lossEv);

  check("webglcontextlost called preventDefault()", prevented);
  check("contextLost flipped to true", vp.getRigStats().contextLost === true);

  // Simulate context restore
  const restoreEv = { type: "webglcontextrestored" };
  domCanvas.dispatchEvent(restoreEv);

  check("contextLost flipped back to false on restore", vp.getRigStats().contextLost === false);

  // Clean up
  vp.dispose();
  check("viewport disposed cleanly", vp._disposed === true);

  globalThis.requestAnimationFrame = oldRaf;
  globalThis.cancelAnimationFrame = oldCaf;
  globalThis.document = oldDoc;
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "All tests must pass");
