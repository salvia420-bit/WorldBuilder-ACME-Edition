// tests/vehicle_session_lifecycle.test.mjs — Unit suite for Hellcat vehicle session lifecycle, audio oscillators,
// input funnel unpoison, controls dismount keys/pointer-lock, geometry disposal, and film queue recovery.
//
// Run from apps/holtburger-web/: node tests/vehicle_session_lifecycle.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

installFakeAudio();

const { createVehicleControls } = await import("../scene3d/vehicle/controls.js");
const { createWeaponsFx } = await import("../scene3d/vehicle/weapons.js");
const { createRecorder } = await import("../scene3d/film/runtime/recorder.js");
const { createTakePlayer } = await import("../scene3d/film/runtime/take_player.js");
const { initVehicles } = await import("../scene3d/vehicle/index.js");
const { createVehicleAudio } = await import("../scene3d/vehicle/audio.js");
const FM = await import("../scene3d/vehicle/flight_model.js");

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

test("controls.js passes keys through open [aria-modal=\"true\"], cancels jump charge & drag on lock(), and drains held keys on restore()", () => {
  const winListeners = new Map();
  const docListeners = new Map();
  let jumpCancelled = false;
  let dragEnded = false;

  const modalNode = {
    tagName: "DIV",
    isConnected: true,
    closest(sel) { return sel === '[aria-modal="true"]' ? this : null; },
  };
  const doc = {
    activeElement: null,
    pointerLockElement: null,
    visibilityState: "visible",
    querySelectorAll(sel) { return sel === '[aria-modal="true"]' && modalOpen ? [modalNode] : []; },
    addEventListener(t, fn) { docListeners.set(t, fn); },
    removeEventListener(t) { docListeners.delete(t); },
    exitPointerLock() {},
  };
  const win = {
    document: doc,
    __jumpChargeActive: true,
    __sessionHandle: {
      jumpChargeLevel() { return 0.7; },
      jumpChargeAbort() { jumpCancelled = true; },
    },
    addEventListener(t, fn, opts) {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push({ fn, cap: !!(typeof opts === "boolean" ? opts : opts?.capture) });
    },
    removeEventListener(t, fn) {
      const arr = winListeners.get(t);
      if (!arr) return;
      const i = arr.findIndex((x) => x.fn === fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, props = {}) {
      const arr = [...(winListeners.get(type) || [])];
      let defaultPrevented = false;
      let stopped = false;
      const ev = {
        type,
        repeat: false,
        cancelable: true,
        target: props.target ?? { tagName: "CANVAS" },
        preventDefault() { defaultPrevented = true; },
        stopImmediatePropagation() { stopped = true; },
        ...props,
      };
      for (const h of arr) {
        if (stopped) break;
        h.fn(ev);
      }
      return { defaultPrevented, stopped };
    },
  };
  const cameraSwitcher = {
    keys: { KeyW: true, KeyA: true },
    _endFollowDrag() { dragEnded = true; },
  };
  let modalOpen = false;

  const controls = createVehicleControls({ window: win, document: doc, cameraSwitcher });
  controls.lock();

  // lock() cancelled pending jump charge and follow drag/keys
  assert.equal(jumpCancelled, true, "lock() cancelled pending jump charge");
  assert.equal(win.__jumpChargeActive, false, "lock() cleared __jumpChargeActive");
  assert.equal(dragEnded, true, "lock() ended follow drag");
  assert.equal(cameraSwitcher.keys.KeyW, false, "lock() cleared cameraSwitcher.keys.KeyW");

  // Modal open: keys pass through unblocked
  modalOpen = true;
  const modalKey = win.dispatch("keydown", { code: "Space", target: modalNode });
  assert.equal(modalKey.defaultPrevented, false, "modal keydown not prevented");
  assert.equal(modalKey.stopped, false, "modal keydown not stopped");
  modalOpen = false;

  // Hold KeyW, then restore() -> drain swallows autorepeat and final keyup, then drops on fresh keydown
  const heldRes = win.dispatch("keydown", { code: "KeyW" });
  assert.equal(heldRes.defaultPrevented, true, "locked KeyW blocked");
  controls.restore();

  const repeatAfterExit = win.dispatch("keydown", { code: "KeyW", repeat: true });
  assert.equal(repeatAfterExit.defaultPrevented, true, "drain swallows KeyW autorepeat after exit");
  const keyupAfterExit = win.dispatch("keyup", { code: "KeyW" });
  assert.equal(keyupAfterExit.defaultPrevented, true, "drain swallows final KeyW keyup after exit");

  const freshPressAfterDrain = win.dispatch("keydown", { code: "KeyW", repeat: false });
  assert.equal(freshPressAfterDrain.defaultPrevented, false, "fresh KeyW press passes normally after drain completes");

  controls.dispose();
});

test("teardownSession clears prompt, hides osd, and hides/clears radarScope on webglcontextlost", () => {
  let contextLostListener = null;
  const byId = new Map();
  const makeEl = (tag) => {
    let id = "";
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      textContent: "",
      children: [],
      parentNode: null,
      get id() { return id; },
      set id(v) { id = String(v || ""); if (id) byId.set(id, el); },
      appendChild(c) { c.parentNode = el; el.children.push(c); if (c.id) byId.set(c.id, c); return c; },
      remove() { if (id) byId.delete(id); },
      getContext() { return { clearRect() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, arc() {}, stroke() {}, fill() {}, clip() {}, moveTo() {}, lineTo() {}, createRadialGradient() { return { addColorStop() {} }; } }; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
    return el;
  };
  const doc = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
  };
  const fakeCanvas = {
    addEventListener(evt, fn) { if (evt === "webglcontextlost") contextLostListener = fn; },
    removeEventListener(evt) { if (evt === "webglcontextlost") contextLostListener = null; },
  };
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    location: { search: "?vehicles=on" },
  };
  const inbox = [];
  const fakeSessionHandle = {
    vehicleCapabilities() {},
    drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
    clearVehicleSeat() {},
  };
  const live = {
    sessionHandle: fakeSessionHandle,
    renderer: { domElement: fakeCanvas },
    worldRoot: { add() {}, remove() {} },
    nullRender: false,
  };

  const api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
  // Push a transient event prompt and radar contacts, then mount radarScope via afterTick
  inbox.push({ type: "event", vehicle: 1, kind: 24, aux: 2, step: 1, subject: 0, cell: 0, x: 0, y: 0, z: 0, value: 0 });
  inbox.push({ type: "deployable_state", deployable: 0x80070001, kind: 1, cell: 0, x: 0, y: 0, z: 0, onlineFlags: 0x05 });
  inbox.push({ type: "radar_contacts", radar: 0x80070001, contacts: [{ dxM: 1000, dyM: 1000, altAglM: 100, standing: 3 }] });
  live.vehicles.afterTick(16, 16);

  const promptEl = byId.get("hb-vehicle-prompt");
  assert.ok(promptEl && promptEl.style.display === "block", "prompt shown before context loss");
  assert.equal(api.deployables.scope.visible, true, "radar scope visible before context loss");
  assert.equal(api.deployables.scope.airContacts.length, 1, "radar scope airContacts populated before context loss");

  contextLostListener();

  assert.equal(promptEl.style.display, "none", "prompt hidden after webglcontextlost");
  assert.equal(api.deployables.scope.visible, false, "radar scope hidden after webglcontextlost");
  assert.equal(api.deployables.scope.airContacts.length, 0, "radar scope airContacts cleared after webglcontextlost");
  assert.equal(api.deployables.scope.groundContacts.length, 0, "radar scope groundContacts cleared after webglcontextlost");

  api.dispose();
});

test("controls.js: data-open=\"0\" and computed hidden modals do NOT block vehicle keys, data-open=\"1\" DOES, and dispose() drops drain listeners", () => {
  const winListeners = new Map();
  const docListeners = new Map();

  const makeFakeNode = (tag = "DIV") => {
    const attrs = Object.create(null);
    return {
      tagName: tag,
      isConnected: true,
      hidden: false,
      style: {},
      dataset: {},
      parentNode: null,
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      closest(sel) {
        if (sel === '[aria-modal="true"]' && attrs["aria-modal"] === "true") return this;
        return this.parentNode?.closest?.(sel) ?? null;
      },
    };
  };

  const modalNode = makeFakeNode("DIV");
  modalNode.id = "hb-modal-dialog";
  modalNode.setAttribute("aria-modal", "true");
  modalNode.setAttribute("data-open", "0");
  const modalBtn = makeFakeNode("BUTTON");
  modalBtn.parentNode = modalNode;

  let computedDisplay = "flex";
  const doc = {
    activeElement: null,
    pointerLockElement: null,
    visibilityState: "visible",
    querySelectorAll(sel) { return sel === '[aria-modal="true"]' ? [modalNode] : []; },
    addEventListener(t, fn) { docListeners.set(t, fn); },
    removeEventListener(t) { docListeners.delete(t); },
    exitPointerLock() {},
  };
  const win = {
    document: doc,
    getComputedStyle(el) {
      if (el === modalNode) return { display: computedDisplay, visibility: "visible" };
      return { display: "block", visibility: "visible" };
    },
    addEventListener(t, fn, opts) {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push({ fn, cap: !!(typeof opts === "boolean" ? opts : opts?.capture) });
    },
    removeEventListener(t, fn, opts) {
      const cap = !!(typeof opts === "boolean" ? opts : opts?.capture);
      const arr = winListeners.get(t);
      if (!arr) return;
      const i = arr.findIndex((x) => x.fn === fn && x.cap === cap);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, props = {}) {
      const arr = [...(winListeners.get(type) || [])];
      let defaultPrevented = false;
      let stopped = false;
      const ev = {
        type,
        repeat: false,
        cancelable: true,
        target: props.target ?? { tagName: "CANVAS" },
        preventDefault() { defaultPrevented = true; },
        stopImmediatePropagation() { stopped = true; },
        ...props,
      };
      for (const h of arr) {
        if (stopped) break;
        h.fn(ev);
      }
      return { defaultPrevented, stopped };
    },
    listenerCount(type) {
      return (winListeners.get(type) || []).length;
    },
  };

  const controls = createVehicleControls({ window: win, document: doc });
  controls.lock();

  // Closed modal (data-open="0" in querySelectorAll AND target inside it) must NOT block vehicle keys
  let res = win.dispatch("keydown", { code: "KeyW", target: modalBtn });
  assert.equal(res.defaultPrevented, true, "closed modal (data-open=0) must NOT disable KeyW when target is inside");
  assert.equal(controls.poll(0.1).pitch < 0, true, "closed modal allows vehicle pitch input");
  win.dispatch("keyup", { code: "KeyW", target: modalBtn });

  // Open modal (data-open="1" with visible computed style) DOES pass keys through
  modalNode.setAttribute("data-open", "1");
  res = win.dispatch("keydown", { code: "Space", target: modalBtn });
  assert.equal(res.defaultPrevented, false, "open modal (data-open=1) passes Space through");
  assert.equal(res.stopped, false, "open modal (data-open=1) does not stop propagation");

  // Computed style display:none overrides even if data-open="1"
  computedDisplay = "none";
  res = win.dispatch("keydown", { code: "Space" });
  assert.equal(res.defaultPrevented, true, "computed display:none modal does NOT block vehicle keys");

  // Re-close modal, hold KeyW, restore(), then dispose() -> 0 drain listeners left on window
  modalNode.setAttribute("data-open", "0");
  computedDisplay = "flex";
  win.dispatch("keydown", { code: "KeyW" });
  controls.restore();
  assert.equal(win.listenerCount("keydown"), 1, "drain keydown listener active after restore() while KeyW held");
  assert.equal(win.listenerCount("keyup"), 1, "drain keyup listener active after restore() while KeyW held");
  assert.equal(win.listenerCount("blur"), 1, "drain blur listener active after restore() while KeyW held");

  controls.dispose();
  assert.equal(win.listenerCount("keydown"), 0, "dispose() leaves 0 keydown drain listeners on window");
  assert.equal(win.listenerCount("keyup"), 0, "dispose() leaves 0 keyup drain listeners on window");
  assert.equal(win.listenerCount("blur"), 0, "dispose() leaves 0 blur drain listeners on window");
});

test("teardownSession stops active PowerGenerator oscillators on webglcontextlost and disconnect", () => {
  for (const trigger of ["webglcontextlost", "hb-disconnected"]) {
    let contextLostListener = null;
    const winListeners = new Map();
    const oscCreated = [];
    const oscStopped = [];
    const param = (v = 0) => ({
      value: v,
      setValueAtTime(val) { this.value = val; },
      linearRampToValueAtTime(val) { this.value = val; },
      exponentialRampToValueAtTime(val) { this.value = val; },
      cancelScheduledValues() {},
    });
    const mockNode = (extra = {}) => ({
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
      ...extra,
    });
    const mockCtx = {
      state: "running",
      currentTime: 2.0,
      sampleRate: 44100,
      destination: mockNode(),
      createGain: () => mockNode({ gain: param(1) }),
      createOscillator: () => {
        const o = mockNode({
          frequency: param(440),
          type: "sine",
          start() { oscCreated.push(o); },
          stop() { oscStopped.push(o); },
        });
        return o;
      },
      createBiquadFilter: () => mockNode({ frequency: param(1000), Q: param(1), type: "lowpass" }),
      createPanner: () => mockNode({ positionX: param(0), positionY: param(0), positionZ: param(0) }),
    };

    const fakeCanvas = {
      addEventListener(evt, fn) { if (evt === "webglcontextlost") contextLostListener = fn; },
      removeEventListener(evt) { if (evt === "webglcontextlost") contextLostListener = null; },
    };
    const win = {
      addEventListener(evt, fn) { winListeners.set(evt, fn); },
      removeEventListener(evt) { winListeners.delete(evt); },
      location: { search: "?vehicles=on" },
    };
    const inbox = [];
    const fakeSessionHandle = {
      vehicleCapabilities() {},
      drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
      clearVehicleSeat() {},
    };
    const live = {
      sessionHandle: fakeSessionHandle,
      renderer: { domElement: fakeCanvas },
      worldRoot: { add() {}, remove() {} },
      nullRender: false,
      audioManager: {
        isActive: () => true,
        getEffectBus: () => ({ ctx: mockCtx, node: mockCtx.destination }),
      },
    };

    const api = initVehicles(live, { window: win, canvas: fakeCanvas, THREE });
    inbox.push({
      type: "deployable_state",
      deployable: 0x80080901,
      kind: 4, // PowerGenerator
      cell: 0,
      x: 4,
      y: 4,
      z: 0,
      onlineFlags: 0x01,
      fuelSec: 120,
    });
    live.vehicles.afterTick(16, 16);
    assert.equal(oscCreated.length, 3, `${trigger}: PowerGenerator started 3 oscillators`);
    assert.equal(oscStopped.length, 0, `${trigger}: 0 oscillators stopped before teardown`);

    if (trigger === "webglcontextlost") contextLostListener();
    else winListeners.get("hb-disconnected")();

    assert.equal(oscStopped.length, 3, `${trigger}: teardownSession stopped all 3 PowerGenerator oscillators`);
    api.dispose();
  }
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
// 6. Tier 5 Adversarial Hardening (Findings 3 & 4)
// ---------------------------------------------------------------------------

test("Adversarial (Finding 3): startPiloting releases camera owner when transitioning to vehicle without params", () => {
  const byId = new Map();
  const makeEl = (tag) => {
    let id = "";
    return {
      tagName: tag.toUpperCase(),
      style: {},
      textContent: "",
      children: [],
      get id() { return id; },
      set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
      appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
      remove() { if (id) byId.delete(id); },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
  };
  const doc = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
    exitPointerLock() {},
  };
  const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
  const localGuid = 0x50000010;
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    getLocalPlayerGuid: () => localGuid,
    location: { search: "?vehicles=on" },
  };
  const inbox = [];
  const fakeSessionHandle = {
    vehicleCapabilities() {},
    drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
    clearVehicleSeat() {},
    setVehicleSeat() {},
  };
  const origPosCam = () => {};
  const entityMap = new Map([[localGuid, { root: new THREE.Group(), _filmHidden: false }]]);
  const live = {
    sessionHandle: fakeSessionHandle,
    renderer: { domElement: fakeCanvas },
    worldRoot: new THREE.Group(),
    nullRender: false,
    localPlayerGuid: localGuid,
    entityManager: { entityMap, localPlayerGuid: localGuid, setFilmHidden() { return true; } },
    cameraSwitcher: {
      persp: new THREE.PerspectiveCamera(),
      mode: "follow",
      positionCamera: origPosCam,
      switchMode() {},
    },
  };

  const api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
  const vehA = 0x71000001;
  const vehB = 0x71000002; // no profile -> !v.params

  inbox.push({ type: "ack", granted: 3 });
  inbox.push({
    type: "profile",
    vehicle: vehA,
    displayName: "Jeep",
    profileKey: "jeep-mb",
    vehicleClass: 2,
    locomotion: 2,
    maxSeats: 4,
    vMax: 29,
    vMaxRoad: 29,
  });
  inbox.push({ type: "state", vehicle: vehA, cell: 0, x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01 });
  inbox.push({ type: "seat", vehicle: vehA, occupant: localGuid, seat: 0, state: 1 });
  live.vehicles.afterTick(16, 16);

  assert.equal(api.piloting, true, "piloting vehicle A");
  assert.notEqual(live.cameraSwitcher.positionCamera, origPosCam, "camera owner installed while piloting A");

  // Transition to vehicle B whose profile has not arrived (!v.params)
  inbox.push({ type: "seat", vehicle: vehB, occupant: localGuid, seat: 0, state: 1 });
  live.vehicles.afterTick(32, 16);

  assert.equal(api.piloting, false, "piloting stopped after !v.params transition");
  assert.equal(live.cameraSwitcher.positionCamera, origPosCam, "cameraSwitcher.positionCamera restored on !v.params early return");

  api.dispose();
});

test("Adversarial (Finding 4): out-of-view / teleported deployables, containers, trailers & jacks are pruned without touching localOnly or mounted containers", () => {
  const byId = new Map();
  const makeEl = (tag) => {
    let id = "";
    return {
      tagName: tag.toUpperCase(),
      style: {},
      textContent: "",
      children: [],
      get id() { return id; },
      set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
      appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
      remove() { if (id) byId.delete(id); },
      getContext() { return { clearRect() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, arc() {}, stroke() {}, fill() {}, clip() {}, moveTo() {}, lineTo() {}, createRadialGradient() { return { addColorStop() {} }; } }; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
  };
  const doc = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
  };
  const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
  const win = { document: doc, addEventListener() {}, removeEventListener() {}, location: { search: "?vehicles=on" } };

  const origPerfNow = performance.now.bind(performance);
  let fakeNowMs = 1000;
  Object.defineProperty(performance, "now", { value: () => fakeNowMs, configurable: true, writable: true });

  let api = null;
  try {
    const inbox = [];
    const removedColliders = [];
    const entityMap = new Map();
    const fakeSessionHandle = {
      vehicleCapabilities() {},
      drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
      clearVehicleSeat() {},
      upsertContainerCollider() {},
      removeContainerCollider(guid) { removedColliders.push(guid >>> 0); },
    };
    const live = {
      sessionHandle: fakeSessionHandle,
      renderer: { domElement: fakeCanvas },
      worldRoot: new THREE.Group(),
      nullRender: false,
      entityManager: {
        entityMap,
        setFilmHidden(guid, hidden) {
          const ent = entityMap.get(guid >>> 0);
          if (!ent) return false;
          ent._filmHidden = !!hidden;
          return true;
        },
      },
    };

    api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
    const radarGuid = 0x80070099;
    const containerGuid = 0x80090099;
    const localContainerGuid = 0x8009009a;
    const activeTrailerGuid = 0x800a0099;
    const mountedContainerGuid = 0x8009009b;

    entityMap.set(radarGuid, { root: new THREE.Group(), _filmHidden: false });
    entityMap.set(containerGuid, { root: new THREE.Group(), _filmHidden: false });
    entityMap.set(activeTrailerGuid, { root: new THREE.Group(), _filmHidden: false });
    entityMap.set(mountedContainerGuid, { root: new THREE.Group(), _filmHidden: false });

    inbox.push({ type: "deployable_state", deployable: radarGuid, kind: 1, cell: 0, x: 0, y: 0, z: 0, onlineFlags: 0x05 });
    inbox.push({ type: "container_state", containerGuid, containerKind: 10, cell: 0, position: [10, 0, 0], heading: 0, doorProgress: 0, doorState: 0, slots: [] });
    inbox.push({ type: "trailer_state", trailerGuid: activeTrailerGuid, kind: 14, cell: 0, position: [20, 0, 0], heading: 0, coupledTractorGuid: 0, mountedContainerGuid, trailerFlags: 0 });
    inbox.push({ type: "container_state", containerGuid: mountedContainerGuid, containerKind: 11, cell: 0, position: [20, 0, 1.32], heading: 0, doorProgress: 0, doorState: 0, slots: [] });
    api.containers.spawnLocal(localContainerGuid, 10, [30, 0, 0], 0, {});

    live.vehicles.afterTick(fakeNowMs, 16);
    assert.equal(api.deployables.list().length, 1, "radar spawned");
    assert.equal(api.deployables.scope.visible, true, "radar scope visible before teleport");
    assert.equal(api.containers.list().length, 3, "3 containers present before teleport");

    // Simulate ACE ObjectDelete on teleport for radar, grounded container, and mounted container (while activeTrailer remains in entityMap!)
    entityMap.delete(radarGuid);
    entityMap.delete(containerGuid);
    entityMap.delete(mountedContainerGuid);
    fakeNowMs += 200;
    live.vehicles.onTeleport();
    fakeNowMs += 6000;
    live.vehicles.afterTick(fakeNowMs, 16);

    assert.equal(api.deployables.list().length, 0, "teleported radar pruned");
    assert.equal(api.deployables.scope.visible, false, "radar scope hidden after radar pruned");
    assert.ok(removedColliders.includes(containerGuid), "grounded container collider removed on prune");
    assert.equal(api.containers.get(containerGuid), null, "grounded container pruned");
    assert.ok(api.containers.get(localContainerGuid) !== null, "localOnly spawnLocal container preserved");
    assert.ok(api.containers.get(mountedContainerGuid) !== null, "container mounted on active trailer preserved");
  } finally {
    api?.dispose?.();
    Object.defineProperty(performance, "now", { value: origPerfNow, configurable: true, writable: true });
  }
});

test("Adversarial (T2.QC.F8.04 race): VehicleSeat(state=1) arriving before VehicleProfile recovers piloting (seat 0) and riding (seat 1) on delayed profile", () => {
  const makeEnv = () => {
    const byId = new Map();
    const makeEl = (tag) => {
      let id = "";
      return {
        tagName: tag.toUpperCase(),
        style: {},
        textContent: "",
        children: [],
        get id() { return id; },
        set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
        appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
        remove() { if (id) byId.delete(id); },
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      };
    };
    const doc = {
      head: makeEl("head"),
      body: makeEl("body"),
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => byId.get(id) ?? null,
      querySelectorAll: () => [],
      exitPointerLock() {},
    };
    const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
    const localGuid = 0x50000022;
    const win = {
      document: doc,
      addEventListener() {},
      removeEventListener() {},
      getLocalPlayerGuid: () => localGuid,
      location: { search: "?vehicles=on" },
    };
    const inbox = [];
    const fakeSessionHandle = {
      vehicleCapabilities() {},
      drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
      clearVehicleSeat() {},
      setVehicleSeat() {},
    };
    const origPosCam = () => {};
    const entityMap = new Map([[localGuid, { root: new THREE.Group(), _filmHidden: false }]]);
    const live = {
      sessionHandle: fakeSessionHandle,
      renderer: { domElement: fakeCanvas },
      worldRoot: new THREE.Group(),
      nullRender: false,
      localPlayerGuid: localGuid,
      entityManager: { entityMap, localPlayerGuid: localGuid, setFilmHidden() { return true; } },
      cameraSwitcher: {
        persp: new THREE.PerspectiveCamera(),
        mode: "follow",
        positionCamera: origPosCam,
        switchMode() {},
      },
    };
    const api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
    return { api, live, inbox, localGuid, origPosCam };
  };

  // 1. Pilot seat 0 arrives before VehicleProfile
  {
    const { api, live, inbox, localGuid, origPosCam } = makeEnv();
    const veh = 0x72000001;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01 });
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 0, state: 1 });
    live.vehicles.afterTick(16, 16);

    assert.equal(api.piloting, false, "pilot seat 0 waits while params are missing");
    assert.equal(live.cameraSwitcher.positionCamera, origPosCam, "camera not owned before profile arrives");

    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Willys MB",
      profileKey: "jeep-mb",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 4,
      vMax: 29,
      vMaxRoad: 29,
      seats: [{ offset: [-0.38, 0.12, 0.62] }, { offset: [0.38, 0.12, 0.62] }],
    });
    live.vehicles.afterTick(32, 16);

    assert.equal(api.piloting, true, "api.piloting becomes true once delayed profile arrives");
    assert.equal(api.status().pilot?.seat, 0, "pilot seat is 0 after delayed profile");
    assert.notEqual(api.status().pilot?.state, null, "pilot predictor initialized from buffered state");
    assert.notEqual(live.cameraSwitcher.positionCamera, origPosCam, "camera owned after delayed profile");
    api.dispose();
  }

  // 2. Passenger seat 1 arrives before VehicleProfile
  {
    const { api, live, inbox, localGuid, origPosCam } = makeEnv();
    const veh = 0x72000002;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 1, state: 1 });
    live.vehicles.afterTick(16, 16);

    assert.equal(api.riding, false, "passenger seat 1 waits while params are missing");
    assert.equal(live.cameraSwitcher.positionCamera, origPosCam, "camera not owned before profile arrives (seat 1)");

    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Willys MB",
      profileKey: "jeep-mb",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 4,
      vMax: 29,
      vMaxRoad: 29,
      seats: [{ offset: [-0.38, 0.12, 0.62] }, { offset: [0.38, 0.12, 0.62] }],
    });
    live.vehicles.afterTick(32, 16);

    assert.equal(api.riding, true, "api.riding becomes true once delayed profile arrives");
    assert.equal(api.status().passenger?.seat, 1, "passenger seat is 1 after delayed profile");
    assert.notEqual(live.cameraSwitcher.positionCamera, origPosCam, "camera owned for passenger after delayed profile");
    api.dispose();
  }

  // 3. Seat vacated (state=0) before delayed VehicleProfile does NOT spuriously board
  {
    const { api, live, inbox, localGuid } = makeEnv();
    const veh = 0x72000003;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 0, state: 1 });
    inbox.push({ type: "seat", vehicle: veh, occupant: 0, seat: 0, state: 0 });
    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Willys MB",
      profileKey: "jeep-mb",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 4,
      vMax: 29,
      vMaxRoad: 29,
    });
    live.vehicles.afterTick(16, 16);

    assert.equal(api.piloting, false, "vacated seat before profile does not board on profile");
    assert.equal(api.riding, false, "vacated seat before profile does not ride on profile");
    api.dispose();
  }
});

test("Adversarial (Challenger 4 Finding 1): tickPilot preserves Dericost 0x8000 bit and does not skip Dericost (0,0) or Dereth (0,0) collision terrain", () => {
  const probeStreamingAt = (coordsList) => {
    const origPerfNow = performance.now.bind(performance);
    let fakeNowMs = 1000;
    Object.defineProperty(performance, "now", { value: () => fakeNowMs, configurable: true, writable: true });
    let api = null;
    try {
      const byId = new Map();
      const makeEl = (tag) => {
        let id = "";
        return {
          tagName: tag.toUpperCase(),
          style: {},
          textContent: "",
          children: [],
          get id() { return id; },
          set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
          appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
          remove() { if (id) byId.delete(id); },
          addEventListener() {},
          removeEventListener() {},
          setAttribute() {},
        };
      };
      const doc = {
        head: makeEl("head"),
        body: makeEl("body"),
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => byId.get(id) ?? null,
        querySelectorAll: () => [],
        exitPointerLock() {},
      };
      const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
      const localGuid = 0x50000033;
      const collisionCalls = [];
      const streamerCalls = [];
      const win = {
        document: doc,
        addEventListener() {},
        removeEventListener() {},
        getLocalPlayerGuid: () => localGuid,
        location: { search: "?vehicles=on" },
        __ensureCollisionTerrain: (lb) => {
          collisionCalls.push(lb >>> 0);
        },
        __worldStreamer: {
          onPositionUpdate: (upd) => {
            streamerCalls.push({
              landblockId: upd.landblockId >>> 0,
              continent: upd.continent,
              gy: upd.gy,
            });
          },
        },
      };
      const inbox = [];
      const fakeSessionHandle = {
        vehicleCapabilities() {},
        drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
        clearVehicleSeat() {},
        setVehicleSeat() {},
        sendVehicleInput() {},
        terrainHeightAt() { return 0; },
      };
      const origPosCam = () => {};
      const entityMap = new Map([[localGuid, { root: new THREE.Group(), _filmHidden: false }]]);
      const live = {
        sessionHandle: fakeSessionHandle,
        renderer: { domElement: fakeCanvas },
        worldRoot: new THREE.Group(),
        nullRender: false,
        localPlayerGuid: localGuid,
        entityManager: { entityMap, localPlayerGuid: localGuid, setFilmHidden() { return true; } },
        cameraSwitcher: {
          persp: new THREE.PerspectiveCamera(),
          mode: "follow",
          positionCamera: origPosCam,
          switchMode() {},
        },
      };
      api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
      const veh = 0x73000001;
      inbox.push({ type: "ack", granted: 3 });
      inbox.push({
        type: "profile",
        vehicle: veh,
        displayName: "Willys MB",
        profileKey: "jeep-mb",
        vehicleClass: 2,
        locomotion: 2,
        maxSeats: 4,
        vMax: 29,
        vMaxRoad: 29,
        seats: [{ offset: [-0.38, 0.12, 0.62] }, { offset: [0.38, 0.12, 0.62] }],
      });

      coordsList.forEach(([gx, gy, gz], idx) => {
        fakeNowMs += 50;
        const cl = FM.toCellLocal(gx, gy, gz);
        inbox.push({
          type: "state",
          vehicle: veh,
          ack: idx,
          cell: cl.cell,
          x: cl.x,
          y: cl.y,
          z: cl.z,
          heading: 0,
          pitch: 0,
          bank: 0,
          speed: 0,
          flags: 0x01,
        });
        if (idx === 0) {
          inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 0, state: 1 });
        }
        live.vehicles.afterTick(fakeNowMs, 0.05);
      });

      return { collisionCalls, streamerCalls };
    } finally {
      api?.dispose?.();
      Object.defineProperty(performance, "now", { value: origPerfNow, configurable: true, writable: true });
    }
  };

  // 1. Dericost (0, 0): 0x00008013 -> __ensureCollisionTerrain(0x00008000)
  {
    const { collisionCalls, streamerCalls } = probeStreamingAt([[50, FM.DERICOST_Y_OFFSET + 50, 200]]);
    assert.deepEqual(collisionCalls, [0x00008000], "Dericost (0,0) calls __ensureCollisionTerrain(0x00008000)");
    assert.equal(streamerCalls[0]?.landblockId, 0x00008013, "Dericost (0,0) publishes 0x00008013 to __worldStreamer");
  }

  // 2. Dericost (10, 20): 0x0a148013 -> __ensureCollisionTerrain(0x0a148000)
  {
    const { collisionCalls, streamerCalls } = probeStreamingAt([[10 * 192 + 50, FM.DERICOST_Y_OFFSET + 20 * 192 + 50, 200]]);
    assert.deepEqual(collisionCalls, [0x0a148000], "Dericost (10,20) preserves 0x8000 -> 0x0a148000");
    assert.equal(streamerCalls[0]?.landblockId, 0x0a148013, "Dericost (10,20) publishes 0x0a148013");
  }

  // 3. Dereth (10, 20): 0x0a140013 -> __ensureCollisionTerrain(0x0a140000)
  {
    const { collisionCalls, streamerCalls } = probeStreamingAt([[10 * 192 + 50, 20 * 192 + 50, 200]]);
    assert.deepEqual(collisionCalls, [0x0a140000], "Dereth (10,20) resolves to 0x0a140000");
    assert.equal(streamerCalls[0]?.landblockId, 0x0a140013, "Dereth (10,20) publishes 0x0a140013");
  }

  // 4. Dereth (0, 0) -> Dericost (0, 0) transition: both 0 and 0x00008000 trigger __ensureCollisionTerrain
  {
    const { collisionCalls } = probeStreamingAt([
      [50, 50, 200],
      [50, FM.DERICOST_Y_OFFSET + 50, 200],
    ]);
    assert.deepEqual(collisionCalls, [0x00000000, 0x00008000], "Dereth (0,0) -> Dericost (0,0) triggers both 0 and 0x00008000");
  }
});

test("Adversarial (T4.QC.S05 race): profile/seat refresh lastMsgAt and pruneVehicles preserves pendingBoard and occupied seats across >5 s without entityMap entry", () => {
  const withEnv = (fn) => {
    const origPerfNow = performance.now.bind(performance);
    let fakeNowMs = 1000;
    Object.defineProperty(performance, "now", { value: () => fakeNowMs, configurable: true, writable: true });
    let api = null;
    try {
      const byId = new Map();
      const makeEl = (tag) => {
        let id = "";
        return {
          tagName: tag.toUpperCase(),
          style: {},
          textContent: "",
          children: [],
          get id() { return id; },
          set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
          appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
          remove() { if (id) byId.delete(id); },
          addEventListener() {},
          removeEventListener() {},
          setAttribute() {},
        };
      };
      const doc = {
        head: makeEl("head"),
        body: makeEl("body"),
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => byId.get(id) ?? null,
        querySelectorAll: () => [],
        exitPointerLock() {},
      };
      const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
      const localGuid = 0x50000044;
      const win = {
        document: doc,
        addEventListener() {},
        removeEventListener() {},
        getLocalPlayerGuid: () => localGuid,
        location: { search: "?vehicles=on" },
      };
      const inbox = [];
      const boardCalls = [];
      const fakeSessionHandle = {
        vehicleCapabilities() {},
        vehicleBoard(g, s) { boardCalls.push({ guid: g >>> 0, seat: s }); },
        drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
        clearVehicleSeat() {},
        setVehicleSeat() {},
      };
      const entityMap = new Map([[localGuid, { root: new THREE.Group(), _filmHidden: false }]]);
      const live = {
        sessionHandle: fakeSessionHandle,
        renderer: { domElement: fakeCanvas },
        worldRoot: new THREE.Group(),
        nullRender: false,
        localPlayerGuid: localGuid,
        entityManager: { entityMap, localPlayerGuid: localGuid, setFilmHidden() { return true; } },
        cameraSwitcher: {
          persp: new THREE.PerspectiveCamera(),
          mode: "follow",
          positionCamera() {},
          switchMode() {},
        },
      };
      api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
      fn({
        api,
        live,
        inbox,
        localGuid,
        boardCalls,
        advanceMs(ms) { fakeNowMs += ms; },
        tick(dtMs = 16) { live.vehicles.afterTick(fakeNowMs, dtMs); },
      });
    } finally {
      api?.dispose?.();
      Object.defineProperty(performance, "now", { value: origPerfNow, configurable: true, writable: true });
    }
  };

  // 1. case "seat" (seat=1, !v.params) refreshes lastMsgAt and protects v from pruneVehicles() across >5 s
  withEnv(({ api, inbox, localGuid, advanceMs, tick }) => {
    const veh = 0x74000001;
    const unrelated = 0x74000099;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    inbox.push({ type: "state", vehicle: unrelated, cell: 0, x: 50, y: 60, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    tick();

    advanceMs(4000);
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 1, state: 1 });
    tick();
    assert.equal(api.riding, false, "seat=1 waits while params missing");
    assert.equal(api.passenger, false, "passenger waits while params missing");

    advanceMs(6000); // > 5 s with !entityMap.has(veh) and !entityMap.has(unrelated)
    tick();
    assert.equal(api.isVehicle(unrelated), false, "unrelated untracked vehicle still pruned after >5 s");
    assert.equal(api.isVehicle(veh), true, "vehicle with localGuid in v.seats[1] preserved across >5 s");

    advanceMs(100);
    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Ironhorse 379",
      profileKey: "semi-379",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 2,
      vMax: 29,
      vMaxRoad: 29,
      seats: [{ offset: [-0.45, 0.2, 1.4] }, { offset: [0.45, 0.2, 1.4] }],
    });
    tick();
    assert.equal(api.riding, true, "delayed profile restores api.riding after >5 s");
    assert.equal(api.passenger, true, "delayed profile restores api.passenger after >5 s");
    assert.equal(api.status().passenger?.seat, 1, "passenger seat 1 preserved");
  });

  // 2. case "profile" refreshes lastMsgAt independently of state messages
  withEnv(({ api, inbox, advanceMs, tick }) => {
    const veh = 0x74000002;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    tick();

    advanceMs(4000);
    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Willys MB",
      profileKey: "jeep-mb",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 4,
      vMax: 29,
      vMaxRoad: 29,
    });
    tick();

    advanceMs(2000); // 6 s since state, 2 s since profile
    tick();
    assert.equal(api.isVehicle(veh), true, "case 'profile' refreshed lastMsgAt so vehicle survives at 6 s after state");

    advanceMs(5500); // 7.5 s since profile, unoccupied
    tick();
    assert.equal(api.isVehicle(veh), false, "unoccupied vehicle still prunes >5 s after profile");
  });

  // 3. pendingBoard?.guid === guid protects vehicle from pruneVehicles() across >5 s
  withEnv(({ api, inbox, localGuid, boardCalls, advanceMs, tick }) => {
    const veh = 0x74000003;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Ironhorse 379",
      profileKey: "semi-379",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 2,
      vMax: 29,
      vMaxRoad: 29,
      seats: [{ offset: [-0.45, 0.2, 1.4] }, { offset: [0.45, 0.2, 1.4] }],
    });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    tick();

    const res = api.board(veh, 1);
    assert.equal(res.ok, true, "board(veh, 1) succeeds");
    assert.equal(boardCalls.length, 1, "vehicleBoard dispatched");

    advanceMs(6000); // > 5 s before seat arrives, !entityMap.has(veh)
    tick();
    assert.equal(api.isVehicle(veh), true, "pendingBoard vehicle preserved across >5 s");

    advanceMs(100);
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 1, state: 1 });
    tick();
    assert.equal(api.passenger, true, "passenger becomes true when seat arrives after >5 s");
    assert.equal(api.riding, true, "riding becomes true when seat arrives after >5 s");
  });
});

test("Adversarial (T4.QC.S05 teleport): onTeleport stops riding and re-boarding seat 1 on the same vehicle restores api.passenger === true", () => {
  const byId = new Map();
  const makeEl = (tag) => {
    let id = "";
    return {
      tagName: tag.toUpperCase(),
      style: {},
      textContent: "",
      children: [],
      get id() { return id; },
      set id(v) { id = String(v || ""); if (id) byId.set(id, this); },
      appendChild(c) { this.children.push(c); if (c?.id) byId.set(c.id, c); return c; },
      remove() { if (id) byId.delete(id); },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
    };
  };
  const doc = {
    head: makeEl("head"),
    body: makeEl("body"),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
    exitPointerLock() {},
  };
  const fakeCanvas = { addEventListener() {}, removeEventListener() {} };
  const localGuid = 0x50000055;
  const win = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    getLocalPlayerGuid: () => localGuid,
    location: { search: "?vehicles=on" },
  };
  const inbox = [];
  const boardCalls = [];
  const fakeSessionHandle = {
    vehicleCapabilities() {},
    vehicleBoard(g, s) { boardCalls.push({ guid: g >>> 0, seat: s }); },
    drainVehicleMessages() { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
    clearVehicleSeat() {},
    setVehicleSeat() {},
  };
  const entityMap = new Map([[localGuid, { root: new THREE.Group(), _filmHidden: false }]]);
  const live = {
    sessionHandle: fakeSessionHandle,
    renderer: { domElement: fakeCanvas },
    worldRoot: new THREE.Group(),
    nullRender: false,
    localPlayerGuid: localGuid,
    entityManager: { entityMap, localPlayerGuid: localGuid, setFilmHidden() { return true; } },
    cameraSwitcher: {
      persp: new THREE.PerspectiveCamera(),
      mode: "follow",
      positionCamera() {},
      switchMode() {},
    },
  };
  const api = initVehicles(live, { window: win, document: doc, canvas: fakeCanvas, THREE });
  try {
    const veh = 0x75000001;
    inbox.push({ type: "ack", granted: 3 });
    inbox.push({
      type: "profile",
      vehicle: veh,
      displayName: "Ironhorse 379",
      profileKey: "semi-379",
      vehicleClass: 2,
      locomotion: 2,
      maxSeats: 2,
      vMax: 29,
      vMaxRoad: 29,
      seats: [{ offset: [-0.45, 0.2, 1.4] }, { offset: [0.45, 0.2, 1.4] }],
    });
    inbox.push({ type: "state", vehicle: veh, cell: 0, x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x00 });
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 1, state: 1 });
    live.vehicles.afterTick(16, 16);

    assert.equal(api.passenger, true, "initial seat 1 sets api.passenger === true");
    assert.equal(api.riding, true, "initial seat 1 sets api.riding === true");

    live.vehicles.onTeleport();
    assert.equal(api.passenger, false, "onTeleport stops riding (api.passenger === false)");
    assert.equal(api.riding, false, "onTeleport stops riding (api.riding === false)");
    assert.equal(api.isVehicle(veh), true, "vehicle remains tracked after onTeleport");

    const reboard = api.board(veh, 1);
    assert.equal(reboard.ok, true, "re-board seat 1 after teleport returns ok: true");
    assert.equal(boardCalls.length, 1, "vehicleBoard called once for re-board");
    inbox.push({ type: "seat", vehicle: veh, occupant: localGuid, seat: 1, state: 1 });
    live.vehicles.afterTick(32, 16);

    assert.equal(api.passenger, true, "re-boarding seat 1 after teleport restores api.passenger === true");
    assert.equal(api.riding, true, "re-boarding seat 1 after teleport restores api.riding === true");
    assert.equal(api.status().passenger?.seat, 1, "passenger seat is 1 after re-board");
  } finally {
    api.dispose();
  }
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

for (const t of tests) {
  await t();
}

console.log(`\nVehicle Session Lifecycle Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
