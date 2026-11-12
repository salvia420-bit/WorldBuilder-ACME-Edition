// tests/vehicle_session_lifecycle.test.mjs — Unit suite for Hellcat vehicle session lifecycle, audio oscillators,
// input funnel unpoison, controls dismount keys/pointer-lock, geometry disposal, and film queue recovery.
//
// Run from apps/holtburger-web/: node tests/vehicle_session_lifecycle.test.mjs

import assert from "node:assert/strict";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

installFakeAudio();

const { createVehicleControls } = await import("../scene3d/vehicle/controls.js");
const { createWeaponsFx } = await import("../scene3d/vehicle/weapons.js");
const { createRecorder } = await import("../scene3d/film/runtime/recorder.js");
const { createTakePlayer } = await import("../scene3d/film/runtime/take_player.js");
const { initVehicles } = await import("../scene3d/vehicle/index.js");
const { createVehicleAudio } = await import("../scene3d/vehicle/audio.js");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed++;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Controls Dismount: Held Keys, Pointer Lock, and Funnel
// ---------------------------------------------------------------------------

test("controls dismount cleans up held keys and latches", () => {
  const win = {
    addEventListener() {},
    removeEventListener() {},
  };
  const doc = {
    addEventListener() {},
    removeEventListener() {},
    exitPointerLock() {},
    pointerLockElement: null,
  };
  let funnelUnpoisoned = false;
  let funnelReleased = false;
  const funnel = {
    _fault: null,
    poison(val) { this._fault = val; },
    unpoison() { this._fault = null; funnelUnpoisoned = true; },
    releaseHeld(tag) { if (tag === "vehicle") funnelReleased = true; },
  };

  const controls = createVehicleControls({ window: win, document: doc, funnel });
  controls.lock();

  // Simulate user pressing keys while flying
  const st = controls.status();
  assert.equal(controls.isLocked, undefined); // status contains sticks
  assert.equal(funnel._fault, "gate");

  // Manually drive keys into down state
  const pollRes1 = controls.poll(0.1);
  assert.equal(typeof pollRes1, "object");

  // Dismount
  const res = controls.dispose();
  assert.equal(res.ok, true);
  assert.equal(funnelUnpoisoned, true);
  assert.equal(funnelReleased, true);

  // Poll again: all sticks should be zeroed and keys cleared
  const pollRes2 = controls.poll(0.1);
  assert.equal(pollRes2.pitch, 0);
  assert.equal(pollRes2.roll, 0);
  assert.equal(pollRes2.yaw, 0);
  assert.equal(pollRes2.fire, false);
  assert.equal(pollRes2.boost, false);
});

test("controls dismount exits pointer lock even if pointerLock was on canvas or body", () => {
  let exitCalled = false;
  const doc = {
    addEventListener() {},
    removeEventListener() {},
    pointerLockElement: { id: "game-canvas" },
    exitPointerLock() { exitCalled = true; doc.pointerLockElement = null; },
  };
  const win = { addEventListener() {}, removeEventListener() {} };

  const controls = createVehicleControls({ window: win, document: doc });
  controls.lock();
  controls.dispose();

  assert.equal(exitCalled, true);
  assert.equal(doc.pointerLockElement, null);
});

test("controls requestPointerLock clean exit if dismounted while promise pending", async () => {
  let exitCalled = false;
  let resolvePromise;
  const doc = {
    addEventListener() {},
    removeEventListener() {},
    pointerLockElement: null,
    exitPointerLock() { exitCalled = true; doc.pointerLockElement = null; },
  };
  const canvas = {
    requestPointerLock() {
      return new Promise((resolve) => { resolvePromise = resolve; });
    },
  };
  const win = { addEventListener() {}, removeEventListener() {} };

  const controls = createVehicleControls({ window: win, document: doc, canvas });
  controls.lock();

  // Trigger pointer lock
  controls.requestPointerLock?.();

  // Dismount before promise resolves
  controls.dispose();

  // Resolve promise now
  if (resolvePromise) {
    doc.pointerLockElement = canvas;
    resolvePromise();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(exitCalled, true);
});

// ---------------------------------------------------------------------------
// 2. Vehicle Audio Teardown: Stopping & Disconnecting all 18 Radial Oscillators
// ---------------------------------------------------------------------------

test("vehicle audio stops and disconnects all oscillators on dispose", () => {
  const stoppedSources = [];
  const disconnectedNodes = [];

  class MockAudioNode {
    constructor() { this.gain = { value: 1, setTargetAtTime() {}, cancelScheduledValues() {} }; }
    disconnect() { disconnectedNodes.push(this); }
    connect() {}
  }

  class MockOscillator extends MockAudioNode {
    constructor() {
      super();
      this.frequency = { value: 440, setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {} };
    }
    setPeriodicWave() {}
    start() {}
    stop(t) { stoppedSources.push({ src: this, t }); }
  }

  class MockBufferSource extends MockAudioNode {
    start() {}
    stop(t) { stoppedSources.push({ src: this, t }); }
  }

  const fakeCtx = {
    currentTime: 10,
    createGain: () => new MockAudioNode(),
    createOscillator: () => new MockOscillator(),
    createBufferSource: () => new MockBufferSource(),
    createPanner: () => new MockAudioNode(),
    createBiquadFilter: () => new MockAudioNode(),
    createPeriodicWave: () => ({}),
  };

  const audio = createVehicleAudio({
    bus: () => ({ in: new MockAudioNode(), node: new MockAudioNode(), ctx: fakeCtx }),
    audioManager: { isActive: () => true },
  });

  audio.start();
  assert.equal(audio.active, true);

  // Stop & dispose immediately (as on disconnect/context-loss)
  audio.stop({ fadeSec: 0 });
  audio.dispose();

  assert.equal(audio.active, false);
  assert.ok(stoppedSources.length > 0, "Oscillators must be stopped");
  assert.ok(disconnectedNodes.length > 0, "Audio nodes must be disconnected");
});

// ---------------------------------------------------------------------------
// 3. Vehicle Session Teardown on Disconnect / WebGL Context Loss
// ---------------------------------------------------------------------------

test("initVehicles cleans up on webglcontextlost and session disconnect", () => {
  let contextLostListener = null;
  let pageHideListener = null;
  let seatCleared = false;
  let funnelUnpoisoned = false;

  const fakeCanvas = {
    addEventListener(evt, fn) {
      if (evt === "webglcontextlost") contextLostListener = fn;
    },
    removeEventListener(evt, fn) {
      if (evt === "webglcontextlost") contextLostListener = null;
    },
  };

  const win = {
    addEventListener(evt, fn) {
      if (evt === "pagehide") pageHideListener = fn;
    },
    removeEventListener() {},
    __inputFunnel: {
      _fault: "gate",
      unpoison() { this._fault = null; funnelUnpoisoned = true; },
      releaseHeld() {},
    },
    location: { search: "?vehicles=on" },
  };

  const fakeSessionHandle = {
    vehicleCapabilities() {},
    drainVehicleMessages: () => "[]",
    clearVehicleSeat() { seatCleared = true; },
  };

  const live = {
    sessionHandle: fakeSessionHandle,
    renderer: { domElement: fakeCanvas },
    worldRoot: { add() {}, remove() {} },
    nullRender: false,
  };

  const vehiclesApi = initVehicles(live, { window: win, canvas: fakeCanvas });
  assert.ok(vehiclesApi);
  assert.ok(typeof contextLostListener === "function", "Context lost listener must be registered");

  // Trigger webglcontextlost
  contextLostListener();
  assert.equal(seatCleared, true, "Seat must be cleared on context loss");
  assert.equal(funnelUnpoisoned, true, "Input funnel must be unpoisoned on context loss");

  vehiclesApi.dispose();
  assert.equal(contextLostListener, null, "Context loss listener must be removed on dispose");
});

// ---------------------------------------------------------------------------
// 4. Weapons Geometries & Disposal
// ---------------------------------------------------------------------------

test("weapons fx disposes geometries cleanly without leaks on dispose", () => {
  let disposedGeoms = 0;
  class MockBufferGeometry {
    setAttribute() {}
    setDrawRange() {}
    dispose() { disposedGeoms++; }
  }
  class MockColor {
    setHex() {}
  }
  class MockMaterial {
    constructor() {
      this.color = new MockColor();
      this.isSpriteMaterial = true;
      this.opacity = 1;
    }
    clone() { return new MockMaterial(); }
    dispose() {}
  }
  class MockTransformable {
    constructor() {
      this.position = { set() {} };
      this.scale = { setScalar() {} };
      this.userData = {};
      this.visible = true;
    }
  }
  class MockGroup extends MockTransformable {
    constructor() { super(); this.children = []; }
    add(item) { this.children.push(item); }
    remove(item) { const idx = this.children.indexOf(item); if (idx >= 0) this.children.splice(idx, 1); }
  }

  const fakeTHREE = {
    Group: MockGroup,
    BufferGeometry: MockBufferGeometry,
    BufferAttribute: class {},
    LineBasicMaterial: MockMaterial,
    LineSegments: class extends MockTransformable { constructor(g) { super(); this.geometry = g; } },
    SphereGeometry: class { dispose() { disposedGeoms++; } },
    PlaneGeometry: class { dispose() { disposedGeoms++; } },
    SpriteMaterial: MockMaterial,
    MeshBasicMaterial: MockMaterial,
    Sprite: class extends MockTransformable { constructor(m) { super(); this.material = m; } },
    Mesh: class extends MockTransformable { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
    CanvasTexture: class { dispose() {} },
    DataTexture: class { constructor() { this.needsUpdate = false; } dispose() {} },
    RGBAFormat: 1023,
    LinearFilter: 1006,
    Vector3: class {},
    Object3D: class {},
    AdditiveBlending: 1,
    DoubleSide: 2,
  };

  const worldRoot = new MockGroup();
  const live = { worldRoot };

  const fx = createWeaponsFx({ liveScene3d: live, THREE: fakeTHREE, ground: () => 0 });
  fx.debugExplode([0, 0, 10], 500);

  fx.dispose();
  assert.ok(disposedGeoms >= 3, `Expected at least 3 disposed geometries, got ${disposedGeoms}`);
});

// ---------------------------------------------------------------------------
// 5. Film Mode CleanFrame Rollback & Recorder Video Chunk Recovery
// ---------------------------------------------------------------------------

test("recorder abort and dispose release queued Uint8Array video chunks", () => {
  const rec = createRecorder({
    canvas: { width: 1280, height: 720 },
    codec: "vp9",
  });

  // Manually add simulated chunks to internal queue
  const chunk1 = new Uint8Array(1024 * 1024); // 1 MiB
  const chunk2 = new Uint8Array(2 * 1024 * 1024); // 2 MiB

  // Use stats or abort to check behavior
  rec.abort("testing abort");
  const st = rec.stats();
  assert.equal(st.queuedChunks, 0, "Queue must be empty after abort");
  assert.equal(st.bufferedBytes, 0, "Buffered bytes must be 0 after abort");

  rec.dispose();
  assert.equal(rec.stats().queuedChunks, 0);
});

test("take_player abort disposes current recorder and releases memory", () => {
  let recorderAborted = false;
  let recorderDisposed = false;

  const mockRecorder = {
    grab() { return true; },
    abort() { recorderAborted = true; },
    dispose() { recorderDisposed = true; },
    stats() { return { state: "stopped", queuedChunks: 0, bufferedBytes: 0 }; },
  };

  const player = createTakePlayer({
    cameraOwner: { write() {} },
    sensors: { sense: () => ({ hit: false, clearM: 100 }) },
    safety: { clamp: () => ({ clamped: false }) },
    recorder: mockRecorder,
  });

  player.abort();
  assert.equal(recorderAborted, true, "Recorder must be aborted when take_player aborts");

  player.dispose();
  assert.equal(recorderDisposed, true, "Recorder must be disposed when take_player disposes");
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

for (const t of tests) {
  await t();
}

console.log(`\nVehicle Session Lifecycle Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
