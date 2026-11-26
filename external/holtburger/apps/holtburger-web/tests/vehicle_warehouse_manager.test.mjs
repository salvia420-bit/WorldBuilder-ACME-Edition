// tests/vehicle_warehouse_manager.test.mjs — Scriptable Warehouse Runtime & Vehicle Integration Suite (M3)
// Covers:
//   1. Full intermodal choreography loop (container LIFO -> AGF -> rack -> AGF -> stand -> AMR -> Lift Table -> Pallet Jack)
//   2. Scale-stress 600-frame tick test (256+ racked pallets, 8+ AGFs, 16+ AMRs, 0 NaNs, 0 overlaps, LOD reduction, clean dispose)
//   3. pallet_jack_controller OBB pushout + lowered Lift Table + Staging Bay integration + backward compatibility
//   4. audio.js new cues (updateAgvHum, mastHydraulicWhine, safetyChime), BareMockCtx safety, gating, zero-leak dispose
//   5. index.js window.__vehicles.warehouse lifecycle & FakeWebGL2 render validation

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { createWarehouseManager } from "../scene3d/vehicle/warehouse_manager.js";
import { initVehicles } from "../scene3d/vehicle/index.js";
import { createPalletJackController } from "../scene3d/vehicle/pallet_jack_controller.js";
import { createLogisticsAudio, LOGISTICS_AUDIO_TUNING } from "../scene3d/vehicle/audio.js";
import { AGF_SPECS, CHARGER_SPECS, LIFT_TABLE_SPECS, NE_FLATLAND_SITE, PALLET_ENVELOPE_SPECS, RACK_SPECS, STAND_SPECS, buildDefaultHubLayout, localToWorld2D } from "../scene3d/vehicle/warehouse_specs.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

function makeAudioParam(init = 0) {
  return {
    value: init,
    setValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  };
}

class FullMockCtx {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.state = "running";
    this.made = [];
  }
  _n(kind, extra) {
    const n = {
      kind,
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
      ...extra,
    };
    this.made.push(n);
    return n;
  }
  _src(kind, extra) {
    return this._n(kind, {
      stopped: false,
      onended: null,
      start() {},
      stop() { this.stopped = true; },
      ...extra,
    });
  }
  createOscillator() { return this._src("osc", { type: "sine", frequency: makeAudioParam(440) }); }
  createBiquadFilter() { return this._n("biquad", { type: "lowpass", frequency: makeAudioParam(350), Q: makeAudioParam(1), gain: makeAudioParam(0) }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() { return this._src("bufsrc", { buffer: null, loop: false }); }
  createGain() { return this._n("gain", { gain: makeAudioParam(1) }); }
  createPanner() {
    return this._n("panner", {
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10000,
      positionX: makeAudioParam(0),
      positionY: makeAudioParam(0),
      positionZ: makeAudioParam(0),
    });
  }
  async resume() { this.state = "running"; }
}

class BareMockCtx {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.state = "running";
    this.made = [];
  }
  _n(kind, extra) {
    const n = {
      kind,
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
      ...extra,
    };
    this.made.push(n);
    return n;
  }
  _src(kind, extra) {
    return this._n(kind, {
      stopped: false,
      onended: null,
      start() {},
      stop() { this.stopped = true; },
      ...extra,
    });
  }
  createOscillator() { return this._src("osc", { type: "sine", frequency: { value: 440 } }); }
  createBufferSource() { return this._src("bufsrc", { buffer: null, loop: false }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createGain() { return this._n("gain", { gain: { value: 1 } }); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;
const queue = [];

function check(name, fn) {
  queue.push({ name, fn });
}

function makeTestWindow(search = "?vehicles=on&vehicleAudio=on") {
  const listeners = new Map();
  const win = {
    location: { search },
    innerWidth: 1280,
    innerHeight: 720,
    document: {
      body: { appendChild() {}, removeChild() {} },
      activeElement: null,
      querySelector() { return null; },
      createElement() {
        return {
          style: {},
          classList: { add() {}, remove() {} },
          appendChild() {},
          remove() {},
          addEventListener() {},
          removeEventListener() {},
        };
      },
      addEventListener(type, fn, cap) {
        const key = `doc:${type}:${Boolean(cap)}`;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
      },
      removeEventListener(type, fn, cap) {
        const key = `doc:${type}:${Boolean(cap)}`;
        listeners.get(key)?.delete(fn);
      },
    },
    addEventListener(type, fn, cap) {
      const key = `${type}:${Boolean(cap)}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn, cap) {
      const key = `${type}:${Boolean(cap)}`;
      listeners.get(key)?.delete(fn);
    },
    dispatch(type, evt = {}) {
      const fullEvt = {
        type,
        preventDefault() {},
        stopPropagation() {},
        ...evt,
      };
      for (const cap of [true, false]) {
        const set = listeners.get(`${type}:${cap}`);
        if (set) {
          for (const fn of [...set]) fn(fullEvt);
        }
        const docSet = listeners.get(`doc:${type}:${cap}`);
        if (docSet) {
          for (const fn of [...docSet]) fn(fullEvt);
        }
      }
    },
    listenerCount(type) {
      let c = 0;
      for (const cap of [true, false]) {
        c += listeners.get(`${type}:${cap}`)?.size ?? 0;
        c += listeners.get(`doc:${type}:${cap}`)?.size ?? 0;
      }
      return c;
    },
  };
  return win;
}

function makeRig({ withVehicles = false, audioManager = null, sessionHandle = undefined } = {}) {
  const win = makeTestWindow();
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 4000);
  const entityMap = new Map();
  const localPlayerGuid = 0x50000001;
  win.getLocalPlayerGuid = () => localPlayerGuid;

  const calls = {
    containerActions: [],
    palletJackActions: [],
  };

  const sh = sessionHandle === null ? null : {
    vehicleCapabilities() {},
    drainVehicleMessages() { return "[]"; },
    terrainHeightAt() { return 0; },
    probeContainerSurface() { return null; },
    resolveContainerPushout() { return null; },
    setVehicleSeat() { return true; },
    clearVehicleSeat() {},
    vehicleContainerAction(containerGuid, action, slotIndex, subSlot, cargoWcid) {
      calls.containerActions.push({ containerGuid, action, slotIndex, subSlot, cargoWcid });
      return true;
    },
    vehiclePalletJackAction(jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle) {
      calls.palletJackActions.push({ jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle });
    },
    upsertContainerCollider() {},
    removeContainerCollider() { return true; },
    jumpChargeAbort() {},
  };

  const live = {
    sessionHandle: sh,
    renderer: { domElement: win.document.createElement("canvas") },
    scene,
    worldRoot,
    camera,
    localPlayerGuid,
    csmState: { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 },
    ...(audioManager ? { audioManager } : {}),
    entityManager: {
      entityMap,
      localPlayerGuid,
      isDeathHeld() { return false; },
      setMotion() {},
      setFilmHidden() { return true; },
    },
  };

  const api = withVehicles ? initVehicles(live, { window: win, document: win.document, canvas: live.renderer.domElement, THREE }) : null;
  return {
    win,
    scene,
    worldRoot,
    camera,
    live,
    sh,
    api,
    calls,
    localPlayerGuid,
    cleanup() {
      try { api?.dispose?.(); } catch (_) {}
    },
  };
}

async function stepUntilSettled(stepFn, promise, maxSteps = 2400) {
  let done = false;
  let err = null;
  let val;
  Promise.resolve(promise).then(
    (v) => { done = true; val = v; },
    (e) => { done = true; err = e; },
  );
  for (let i = 0; i < maxSteps; i++) {
    stepFn(i);
    await Promise.resolve();
    if (done) {
      if (err) throw err;
      return { steps: i + 1, value: val };
    }
  }
  throw new Error(`Promise did not settle within ${maxSteps} steps`);
}

function countVisibleDrawCalls(root) {
  let calls = 0;
  const walk = (n) => {
    if (!n || !n.visible) return;
    if (n.isMesh || n.isLine || n.isSprite || n.isPoints) calls++;
    if (Array.isArray(n.children)) {
      for (const ch of n.children) walk(ch);
    }
  };
  walk(root);
  return calls;
}

function assertAllFinite(val, label = "value", seen = new Set()) {
  if (typeof val === "number") {
    assert.ok(Number.isFinite(val), `${label} non-finite: ${val}`);
    return;
  }
  if (!val || typeof val !== "object") return;
  if (seen.has(val)) return;
  seen.add(val);
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) assertAllFinite(val[i], `${label}[${i}]`, seen);
    return;
  }
  for (const [k, v] of Object.entries(val)) {
    if (typeof v !== "function") assertAllFinite(v, `${label}.${k}`, seen);
  }
}

// ---------------------------------------------------------------------------
// 1. Full Intermodal Choreography Loop
// ---------------------------------------------------------------------------
check("1. Full intermodal loop: container LIFO -> AGF -> 4-tier rack -> AGF -> stand -> AMR -> Lift Table -> lowered for Pallet Jack", async () => {
  const rig = makeRig({ withVehicles: true });
  try {
    const [ox, oy] = NE_FLATLAND_SITE.origin;
    const mgr = rig.win.__vehicles.warehouse;
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

    assert.equal(rig.scene.children.length, 0, "must never attach directly to scene");
    assert.equal(rig.worldRoot.children.filter((c) => c.name === "WarehouseHubRoot").length, 1, "single hubRoot attached to worldRoot");

    const cGuid = 0x71001001;
    const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox - 18, oy + 32, 0], Math.PI, {
      doorProgress: 1.0,
      slots: [
        { slotIndex: 16, palletSize: "standard", cargoWcid: 4000010 },
        { slotIndex: 18, palletSize: "standard", cargoWcid: 4000012 },
      ],
    });
    assert.ok(cEntry, "local container spawned");

    const rackId = [...mgr.racks.keys()][0];
    const standId = [...mgr.stands.keys()][0];
    const liftId = [...mgr.liftTables.keys()][0];
    const lt = mgr.liftTables.get(liftId);
    lt.setAutoMode(false);

    const agf = mgr.spawnAgf("agf-loop", { pos: [ox - 18, oy + 20, 0], heading: 0 });
    const amr = mgr.spawnAmr("amr-loop", { pos: [ox - 5, oy - 24, 0], heading: 0 });

    const tickFrame = (i) => rig.live.vehicles.afterTick((i + 1) * 16.667, 16.667);

    // LIFO blocked deep slot rejects cleanly and preserves queue health
    await assert.rejects(
      () => stepUntilSettled(tickFrame, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 16 }), 300),
      (err) => !/did not settle within/.test(err.message),
    );

    // Strip reachable slot 18
    await stepUntilSettled(tickFrame, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 }));
    assert.equal(cEntry.slots.some((s) => s.slotIndex === 18), false);
    assert.equal(agf.carriedWcid, 4000012);

    // Place in Tier 3 rack & pick back
    await stepUntilSettled(tickFrame, agf.enqueue({ type: "placeInRack", rackId, bay: 0, tier: 3, side: 0, slotInBay: 0 }));
    assert.equal(agf.carriedWcid, 0);
    await stepUntilSettled(tickFrame, agf.enqueue({ type: "pickFromRack", rackId, bay: 0, tier: 3, side: 0, slotInBay: 0 }));
    assert.equal(agf.carriedWcid, 4000012);

    // Place on P&D stand
    await stepUntilSettled(tickFrame, agf.enqueue({ type: "placeOnStand", standId }));
    assert.equal(mgr.stands.get(standId).carriedWcid, 4000012);

    // Raise Lift Table, AMR shuttles stand -> Lift Table, moves clear, Lift Table lowers
    await stepUntilSettled(tickFrame, lt.raise());
    assert.ok(lt.heightM >= 0.375);

    await stepUntilSettled(tickFrame, amr.enqueue({ type: "pickFromStand", standId }));
    assert.equal(amr.carriedWcid, 4000012);
    await stepUntilSettled(tickFrame, amr.enqueue({ type: "placeOnStand", standId: liftId }), 4200);
    assert.equal(lt.carriedWcid, 4000012);
    await stepUntilSettled(tickFrame, amr.enqueue({ type: "driveTo", waypoints: [[ox - 5, oy - 24]] }), 3600);

    await stepUntilSettled(tickFrame, lt.lower());
    assert.ok(lt.heightM <= 0.005);

    const lPos = lt.pos;
    const jackTarget = mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.25, heading: 0 });
    assert.ok(jackTarget && jackTarget.carriedWcid === 4000012, "lowered lift table ready for player pallet jack");
    assertAllFinite(mgr.getState(), "intermodalLoopState");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Scale Stress (256+ racked pallets, 8 AGFs, 16 AMRs, 600 frames, LOD, FakeWebGL2, clean dispose)
// ---------------------------------------------------------------------------
check("2. scale-stress 600-frame tick test: 256+ pallets, 8 AGFs, 16 AMRs, 0 NaNs, 0 overlaps, LOD, 0-leak dispose", async () => {
  const rig = makeRig({ withVehicles: true });
  try {
    const [ox, oy] = NE_FLATLAND_SITE.origin;
    const mgr = rig.win.__vehicles.warehouse;
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

    const scenP = mgr.runScenario("scale-stress");
    let nearDc = 0;
    let farDc = 0;

    for (let f = 0; f < 600; f++) {
      const camDist = f < 300 ? 15 : 180;
      mgr.tick(1 / 60, [ox, oy - camDist, 25]);
      if (f === 10) nearDc = countVisibleDrawCalls(rig.worldRoot);
      if (f === 310) farDc = countVisibleDrawCalls(rig.worldRoot);

      // Check zero footprint overlaps between any AGF/AMR pair
      const agents = [
        ...[...mgr.agfs.values()].map((a) => ({ id: `agf:${a.id}`, x: a.x, y: a.y })),
        ...[...mgr.amrs.values()].map((m) => ({ id: `amr:${m.id}`, x: m.x, y: m.y })),
      ];
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const d = Math.hypot(agents[i].x - agents[j].x, agents[i].y - agents[j].y);
          assert.ok(d >= 0.70, `overlap at frame ${f} between ${agents[i].id} and ${agents[j].id}: d=${d}`);
        }
      }
    }

    assert.ok(mgr.stats.rackedSlots >= 256, `expected >= 256 racked pallets, got ${mgr.stats.rackedSlots}`);
    assert.ok(mgr.agfs.size >= 8, `expected >= 8 AGFs, got ${mgr.agfs.size}`);
    assert.ok(mgr.amrs.size >= 16, `expected >= 16 AMRs, got ${mgr.amrs.size}`);
    assert.ok(farDc < nearDc, `expected far LOD draw calls (${farDc}) < near (${nearDc})`);
    assertAllFinite(mgr.getState(), "scaleStressState");

    // FakeWebGL2 render pass
    const gl = createFakeWebGL2({ maxTextures: 16 });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const renderScene = new THREE.Scene();
    renderScene.add(rig.worldRoot);
    const cam = new THREE.PerspectiveCamera(60, 1.33, 0.1, 2000);
    cam.position.set(ox, oy - 50, 30);
    cam.up.set(0, 0, 1);
    cam.lookAt(ox, oy, 2);
    gl.__fake.reset();
    renderer.render(renderScene, cam);
    const c = gl.__fake.counts;
    const draws = (c.drawArrays || 0) + (c.drawElements || 0) + (c.drawArraysInstanced || 0) + (c.drawElementsInstanced || 0);
    assert.ok(draws > 0, "FakeWebGL2 emitted draws");
    renderScene.remove(rig.worldRoot);
    renderer.dispose();

    mgr.stopScenarios();
    await scenP;

    mgr.clearHub();
    assert.equal(rig.worldRoot.children.filter((c) => c.name === "WarehouseHubRoot").length, 0, "hubRoot removed after clearHub");
    rig.api.dispose();
    assert.equal(rig.worldRoot.children.length, 0, "worldRoot empty after dispose");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Pallet Jack Controller OBB Pushout, Lift Table, Staging Bay & Backward Compat
// ---------------------------------------------------------------------------
check("3. pallet_jack_controller OBB pushout + Lift Table + Staging Bay + omitted warehouseManager compat", () => {
  const rig = makeRig({ withVehicles: false });
  const mgr = createWarehouseManager({
    THREE,
    liveScene3d: rig.live,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map(),
    trailers: new Map(),
    logisticsAudio: null,
    sh: () => rig.sh,
  });
  mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

  // 3a. OBB pushout
  const boxes = mgr.getObstacleBoxes();
  assert.ok(boxes.length > 0);
  const westBox = boxes.reduce((a, b) => (b.x0 < a.x0 ? b : a), boxes[0]);
  const startX = westBox.x0 - 0.65;
  const cy = (westBox.y0 + westBox.y1) * 0.5;
  const jackObb = {
    guid: 0x61000010,
    worldPos: [startX, cy, 0],
    heading: Math.PI / 2,
    tillerAngle: 0,
    forkHeightM: 0.085,
    carriedWcid: 0,
    model: { root: new THREE.Group(), update() {}, dispose() {} },
  };
  const ctrl = createPalletJackController({
    liveScene3d: rig.live,
    THREE,
    window: rig.win,
    sh: () => rig.sh,
    em: rig.live.entityManager,
    localGuid: () => rig.localPlayerGuid,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map([[jackObb.guid, jackObb]]),
    warehouseManager: mgr,
  });
  try {
    ctrl.start(jackObb);
    rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
    for (let i = 0; i < 45; i++) ctrl.tick(1 / 60);
    rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
    assert.ok(ctrl.state.x > startX + 0.15 && ctrl.state.x <= westBox.x0 + 1e-4, `OBB blocked jack at ${ctrl.state.x}`);
    ctrl.stop("test");

    // 3b. Lowered Lift Table drop & auto-mode raise
    const liftId = [...mgr.liftTables.keys()][0];
    const lt = mgr.liftTables.get(liftId);
    lt.setAutoMode(true);
    const lPos = lt.pos;
    lt.setHeightImmediate(0.021);
    assert.equal(mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.25, heading: 0 }), null, "0.021m excluded");
    lt.setHeightImmediate(0.0);
    assert.ok(mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.25, heading: 0 }), "0.0m selectable");

    const jackLt = {
      guid: 0x61000011,
      worldPos: [lPos[0], lPos[1] - 0.25, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.200,
      carriedWcid: 4000013,
      model: { root: new THREE.Group(), update() {}, dispose() {} },
    };
    ctrl.start(jackLt);
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(lt.carriedWcid, 4000013);
    assert.equal(ctrl.state.carriedWcid, 0);
    ctrl.stop("test");

    // 3c. Staging Bay drop
    const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
    const bay0 = layout.stagingBays[0];
    const jackSb = {
      guid: 0x61000012,
      worldPos: [bay0.pos[0], bay0.pos[1] - 0.25, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.200,
      carriedWcid: 4000011,
      model: { root: new THREE.Group(), update() {}, dispose() {} },
    };
    ctrl.start(jackSb);
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(ctrl.state.carriedWcid, 0);
    assert.equal(mgr.getState().stagingBays[bay0.id].carriedWcid, 4000011);
    ctrl.stop("test");
  } finally {
    ctrl.dispose();
    mgr.dispose();
  }

  // 3d. Backward compatibility with omitted warehouseManager
  const ctrlCompat = createPalletJackController({
    liveScene3d: rig.live,
    THREE,
    window: rig.win,
    sh: () => rig.sh,
    em: rig.live.entityManager,
    localGuid: () => rig.localPlayerGuid,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map(),
  });
  assert.equal(ctrlCompat.start({
    guid: 0x61000013,
    worldPos: [0, 0, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.085,
    carriedWcid: 0,
    model: { root: new THREE.Group(), update() {}, dispose() {} },
  }), true);
  ctrlCompat.tick(1 / 60);
  ctrlCompat.dispose();
});

// ---------------------------------------------------------------------------
// 4. Audio cues (updateAgvHum, mastHydraulicWhine, safetyChime), BareMockCtx, gating, zero-leak dispose
// ---------------------------------------------------------------------------
check("4. audio.js new warehouse cues, BareMockCtx safety, gating & zero-leak dispose", () => {
  assert.ok(Object.isFrozen(LOGISTICS_AUDIO_TUNING), "LOGISTICS_AUDIO_TUNING frozen");
  assert.ok(Number.isFinite(LOGISTICS_AUDIO_TUNING.agvHumBaseHz));

  // Verify zero Math.random / setTimeout in audio.js
  const audioSrc = readFileSync(join(ROOT, "scene3d/vehicle/audio.js"), "utf8");
  const codeOnly = audioSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\bMath\.random\s*\(/.test(codeOnly), false, "zero Math.random in audio.js");
  assert.equal(/\bsetTimeout\s*\(/.test(codeOnly), false, "zero setTimeout in audio.js");

  const fakeAudio = installFakeAudio();
  try {
    let tSec = 1;
    // FullMockCtx path
    const fullCtx = new FullMockCtx();
    const fullBus = { ctx: fullCtx, node: fullCtx.createGain() };
    const au = createLogisticsAudio({ bus: fullBus, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
    assert.equal(au.updateAgvHum("amr-1", { speed: 1.5, pos: [0, 0, 0] }), true);
    assert.equal(au.mastHydraulicWhine("agf-1", { active: true, speed: 0.55, pos: [1, 0, 1] }), true);
    assert.equal(au.safetyChime({ pos: [0, 0, 0] }), true);
    assert.ok(au.stats.totalNodes > 0 && fullCtx.made.length > 0);
    au.dispose();
    assert.equal(au.stats.totalNodes, 0);
    for (const n of fullCtx.made) {
      assert.equal(n.connections.length, 0);
      if (n.kind === "osc" || n.kind === "bufsrc") assert.equal(n.stopped, true);
    }

    // BareMockCtx path
    const bareCtx = new BareMockCtx();
    const bareBus = { ctx: bareCtx, node: bareCtx.createGain() };
    const auBare = createLogisticsAudio({ bus: bareBus, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
    assert.equal(auBare.updateAgvHum("amr-b", { speed: 1.0, pos: [0, 0, 0] }), true);
    assert.equal(auBare.mastHydraulicWhine("agf-b", { active: true, speed: 0.4, pos: [0, 0, 0] }), true);
    assert.equal(auBare.safetyChime({ pos: [0, 0, 0] }), true);
    auBare.dispose();
    assert.equal(auBare.stats.totalNodes, 0);

    // Gating checks
    for (const gated of [
      createLogisticsAudio({ bus: fullBus, search: "?vehicleAudio=off" }),
      createLogisticsAudio({ bus: fullBus, liveScene3d: { nullRender: true }, search: "?vehicleAudio=on" }),
      createLogisticsAudio({ bus: null, search: "?vehicleAudio=on" }),
    ]) {
      assert.equal(gated.updateAgvHum("a", { speed: 1, pos: [0, 0, 0] }), false);
      assert.equal(gated.mastHydraulicWhine("b", { active: true, speed: 0.5, pos: [0, 0, 0] }), false);
      assert.equal(gated.safetyChime({ pos: [0, 0, 0] }), false);
      assert.equal(gated.stats.totalNodes, 0);
      gated.dispose();
    }
  } finally {
    fakeAudio.uninstall();
  }
});

// ---------------------------------------------------------------------------
// 5. index.js window.__vehicles.warehouse 18-property contract & clean dispose
// ---------------------------------------------------------------------------
check("5. index.js window.__vehicles.warehouse API surface, afterTick & dispose lifecycle", () => {
  const rig = makeRig({ withVehicles: true });
  try {
    const wh = rig.win.__vehicles?.warehouse;
    assert.ok(wh && typeof wh === "object", "window.__vehicles.warehouse exposed");
    const required = [
      "buildHub", "clearHub", "spawnAgf", "spawnAmr", "agfs", "amrs",
      "racks", "stands", "liftTables", "chargers", "runScenario", "stopScenarios",
      "getState", "stats", "getObstacleBoxes", "findLoweredLiftTableTarget",
      "findStagingBayTarget", "dispose",
    ];
    for (const k of required) {
      assert.ok(k in wh, `missing warehouse property: ${k}`);
    }
    wh.buildHub({ origin: NE_FLATLAND_SITE.origin });
    wh.spawnAgf("agf-idx", { pos: [44832, 46960, 0], heading: 0 });
    wh.spawnAmr("amr-idx", { pos: [44832, 46920, 0], heading: 0 });
    for (let i = 1; i <= 10; i++) {
      rig.live.vehicles.afterTick(i * 16.667, 16.667);
    }
    assertAllFinite(wh.getState(), "indexWarehouseState");
    rig.win.__vehicles.dispose();
    assert.equal(rig.worldRoot.children.length, 0);
    assert.equal(rig.win.__vehicles, undefined);
    assert.equal(rig.win.listenerCount("keydown"), 0);
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Regression: 90 deg Crossings & Oblique Convergence Hull Separation
// ---------------------------------------------------------------------------
check("6. regression: 90 deg AGF-AGF/AGF-AMR crossings & oblique convergence maintain minSep >= 1.24 m / 1.18 m", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;

  const runPair = async (label, dt, maxSteps, setupFn) => {
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    try {
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const { promise, pair } = setupFn(mgr);
      let minSep = Infinity;
      await stepUntilSettled(() => {
        mgr.tick(dt);
        const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (d < minSep) minSep = d;
      }, promise, maxSteps);
      assertAllFinite(mgr.getState(), label);
      return minSep;
    } finally {
      mgr.dispose();
    }
  };

  // 6a. Simultaneous 90 deg AGF-AGF crossing at dt = 1/60 and dt = 0.1
  const sepAgf60 = await runPair("agfAgf90_60", 1 / 60, 2400, (mgr) => {
    const a1 = mgr.spawnAgf("a1", { pos: [ox - 8, oy + 20, 0], heading: Math.PI / 2 });
    const a2 = mgr.spawnAgf("a2", { pos: [ox, oy + 12, 0], heading: 0 });
    return {
      pair: [a1, a2],
      promise: Promise.all([
        a1.enqueue({ type: "driveTo", waypoints: [[ox + 8, oy + 20]] }),
        a2.enqueue({ type: "driveTo", waypoints: [[ox, oy + 28]] }),
      ]),
    };
  });
  assert.ok(sepAgf60 >= 1.24, `AGF-AGF 90 deg (1/60) minSep=${sepAgf60.toFixed(4)} < 1.24`);

  const sepAgf10 = await runPair("agfAgf90_01", 0.1, 1000, (mgr) => {
    const a1 = mgr.spawnAgf("a1", { pos: [ox - 8, oy + 20, 0], heading: Math.PI / 2 });
    const a2 = mgr.spawnAgf("a2", { pos: [ox, oy + 12, 0], heading: 0 });
    return {
      pair: [a1, a2],
      promise: Promise.all([
        a1.enqueue({ type: "driveTo", waypoints: [[ox + 8, oy + 20]] }),
        a2.enqueue({ type: "driveTo", waypoints: [[ox, oy + 28]] }),
      ]),
    };
  });
  assert.ok(sepAgf10 >= 1.24, `AGF-AGF 90 deg (0.1) minSep=${sepAgf10.toFixed(4)} < 1.24`);

  // 6b. Simultaneous 90 deg AGF-AMR crossing
  const sepAgfAmr = await runPair("agfAmr90", 1 / 60, 2400, (mgr) => {
    const agf = mgr.spawnAgf("agf1", { pos: [ox - 8, oy - 30, 0], heading: Math.PI / 2 });
    const amr = mgr.spawnAmr("amr1", { pos: [ox, oy - 35, 0], heading: 0 });
    return {
      pair: [agf, amr],
      promise: Promise.all([
        agf.enqueue({ type: "driveTo", waypoints: [[ox + 8, oy - 30]] }),
        amr.enqueue({ type: "driveTo", waypoints: [[ox, oy - 22]] }),
      ]),
    };
  });
  assert.ok(sepAgfAmr >= 1.18, `AGF-AMR 90 deg minSep=${sepAgfAmr.toFixed(4)} < 1.18`);

  // 6c. Oblique rear-quarter AGF overtaking AMR convergence
  const sepOblique = await runPair("agfAmrOblique", 1 / 60, 2400, (mgr) => {
    const agf = mgr.spawnAgf("agf1", { pos: [ox - 6, oy - 32, 0], heading: Math.PI * 0.35 });
    const amr = mgr.spawnAmr("amr1", { pos: [ox - 4, oy - 30, 0], heading: Math.PI * 0.5 });
    return {
      pair: [agf, amr],
      promise: Promise.all([
        agf.enqueue({ type: "driveTo", waypoints: [[ox + 8, oy - 26.5]] }),
        amr.enqueue({ type: "driveTo", waypoints: [[ox + 8, oy - 30]] }),
      ]),
    };
  });
  assert.ok(sepOblique >= 1.18, `AGF-AMR oblique minSep=${sepOblique.toFixed(4)} < 1.18`);
});

// ---------------------------------------------------------------------------
// 7. Regression: Server onServerState Cargo Duplication & Staging Highlight Stability
// ---------------------------------------------------------------------------
check("7. regression: server-backed pallet jack KeyF drop onto Lift Table prevents onServerState duplication", () => {
  const rig = makeRig({ withVehicles: false });
  const mgr = createWarehouseManager({
    THREE,
    liveScene3d: rig.live,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map(),
    trailers: new Map(),
    logisticsAudio: null,
    sh: () => rig.sh,
  });
  mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

  const liftId = [...mgr.liftTables.keys()][0];
  const lt = mgr.liftTables.get(liftId);
  lt.setAutoMode(false);
  lt.setHeightImmediate(0.0);
  const lPos = lt.pos;

  const jackEntry = {
    guid: 0x62000001,
    localOnly: false,
    worldPos: [lPos[0], lPos[1] - 0.25, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.200,
    carriedWcid: 4000015,
    carriedPalletSize: 2,
    model: { root: new THREE.Group(), update() {}, dispose() {} },
  };
  const ctrl = createPalletJackController({
    liveScene3d: rig.live,
    THREE,
    window: rig.win,
    sh: () => rig.sh,
    em: rig.live.entityManager,
    localGuid: () => rig.localPlayerGuid,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map([[jackEntry.guid, jackEntry]]),
    warehouseManager: mgr,
  });

  try {
    ctrl.start(jackEntry);
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(lt.carriedWcid, 4000015, "Lift Table received dropped cargo");
    assert.equal(ctrl.state.carriedWcid, 0, "jack cleared carriedWcid on drop");

    // Simulate 10 Hz ACE server echo still reporting 4000015
    for (let i = 0; i < 5; i++) {
      ctrl.onServerState({
        palletJackGuid: jackEntry.guid,
        operatorGuid: rig.localPlayerGuid,
        carriedWcid: 4000015,
        carriedPalletSize: 2,
      }, jackEntry);
      assert.equal(ctrl.state.carriedWcid, 0, "onServerState echo must not duplicate cargo onto jack");
    }

    // Server catches up (0), then jack picks from Staging Bay and performs DropToGround
    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
    }, jackEntry);
    const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
    const bay0 = layout.stagingBays[0];
    mgr.setStagingBayCargo(bay0.id, 4000011);
    ctrl.stop("test");

    const jackSb = {
      guid: 0x62000002,
      localOnly: false,
      worldPos: [bay0.pos[0], bay0.pos[1] - 0.25, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      carriedWcid: 0,
      model: { root: new THREE.Group(), update() {}, dispose() {} },
    };
    ctrl.start(jackSb);
    // Verify Staging Bay highlight mesh is not reallocated every frame while stationary
    ctrl.tick(1 / 60);
    const hubRoot = rig.worldRoot.children.find((c) => c.name === "WarehouseHubRoot");
    const firstHighlightMesh = hubRoot.children.find((c) => c.geometry?.type === "BoxGeometry" && c.material?.transparent);
    assert.ok(firstHighlightMesh, "staging bay highlight mesh created");
    ctrl.tick(1 / 60);
    const secondHighlightMesh = hubRoot.children.find((c) => c.geometry?.type === "BoxGeometry" && c.material?.transparent);
    assert.equal(secondHighlightMesh, firstHighlightMesh, "staging bay highlight mesh reused across frames");

    // Pick from staging bay, then DropToGround far away -> _localWarehouseCarryWcid cleared
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(ctrl.state.carriedWcid, 4000011);

    // Move away from staging bay and drop to ground
    jackSb.worldPos = [NE_FLATLAND_SITE.origin[0] - 30, NE_FLATLAND_SITE.origin[1] - 30, 0];
    ctrl.onServerState({
      palletJackGuid: jackSb.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
      position: [NE_FLATLAND_SITE.origin[0] - 30, NE_FLATLAND_SITE.origin[1] - 30, 0],
    }, jackSb);
    assert.equal(ctrl.state.carriedWcid, 4000011, "_localWarehouseCarryWcid preserved across srvWcid=0 before DropToGround");
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    ctrl.onServerState({
      palletJackGuid: jackSb.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
    }, jackSb);
    assert.equal(ctrl.state.carriedWcid, 0, "DropToGround cleared _localWarehouseCarryWcid");
    ctrl.stop("test");
  } finally {
    ctrl.dispose();
    mgr.dispose();
  }
});

// ---------------------------------------------------------------------------
// 8. Regression: Closed currentDoorProgress & Mid-Enter Door Closure Guards
// ---------------------------------------------------------------------------
check("8. regression: stale last.doorProgress and mid-enter door closure reject without mutating container slots", async () => {
  const rig = makeRig({ withVehicles: true });
  try {
    const [ox, oy] = NE_FLATLAND_SITE.origin;
    const mgr = rig.win.__vehicles.warehouse;
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

    const cGuid = 0x71009901;
    const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox - 18, oy + 32, 0], Math.PI, {
      doorProgress: 1.0,
      slots: [
        { slotIndex: 18, palletSize: "standard", cargoWcid: 4000012 },
      ],
    });

    // 8a. Stale last.doorProgress=1.0 & last.doorState=2 must NOT override currentDoorProgress=0.0
    cEntry.targetDoorProgress = 0.0;
    cEntry.currentDoorProgress = 0.0;
    cEntry.last.doorProgress = 1.0;
    cEntry.last.doorState = 2;

    const agf = mgr.spawnAgf("agf-door-guard", { pos: [ox - 18, oy + 20, 0], heading: 0 });
    const tickFrame = (i) => rig.live.vehicles.afterTick((i + 1) * 16.667, 16.667);

    await assert.rejects(
      () => stepUntilSettled(tickFrame, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 }), 300),
      /doors are closed/i,
    );
    assert.equal(cEntry.slots.length, 1, "container slots untouched on closed-door reject");

    // 8b. Doors open at enqueue & route arrival, then closed mid-enter (after reaching door approach & entering interior)
    cEntry.targetDoorProgress = 1.0;
    cEntry.currentDoorProgress = 1.0;
    const pickP = agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 });
    let reachedDoorZone = false;
    let closedMidEnter = false;
    await assert.rejects(
      () => stepUntilSettled((i) => {
        tickFrame(i);
        // 40ft container (kind 11, halfL=6.016) at oy+32 with heading=PI has doorApproach at oy+38.87 and slot 18 at oy+38.01
        if (agf.y >= oy + 38.6) reachedDoorZone = true;
        if (reachedDoorZone && !closedMidEnter && agf.y <= oy + 38.35) {
          cEntry.targetDoorProgress = 0.0;
          cEntry.currentDoorProgress = 0.0;
          cEntry.last.doorProgress = 0.0;
          cEntry.last.doorState = 0;
          closedMidEnter = true;
        }
      }, pickP, 2400),
      /unavailable/i,
    );
    assert.equal(closedMidEnter, true, "doors were closed while AGF was in enter phase");
    assert.equal(cEntry.slots.length, 1, "container slots untouched when doors closed mid-enter");
    assert.equal(agf.carriedWcid, 0, "AGF did not pick cargo from closed container");

    // Queue remains healthy for subsequent tasks
    await stepUntilSettled(tickFrame, agf.enqueue({ type: "driveTo", waypoints: [[ox - 18, oy + 20]] }), 2400);
    assert.ok(Math.hypot(agf.x - (ox - 18), agf.y - (oy + 20)) <= 0.1, "AGF recovered cleanly after mid-enter rejection");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Regression: Narrow Rack Aisle Deadlock Breaker & 3600/2400-tick Scale-Stress Rack Clearance
// ---------------------------------------------------------------------------
check("9. regression: rack aisle deadlock breaker & 3600/2400-tick scale-stress maintain 0 rack intrusions & >= 0.62 m clearance", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const minRackEdgeDist = (x, y, rackBoxes) => {
    let minD = Infinity;
    for (const b of rackBoxes) {
      const cx = Math.max(b.x0, Math.min(b.x1, x));
      const cy = Math.max(b.y0, Math.min(b.y1, y));
      const d = Math.hypot(x - cx, y - cy);
      if (d < minD) minD = d;
    }
    return minD;
  };

  // 9a. Head-on AGFs in narrow rack aisle (oy - 9.0 between R6 and R4_5)
  {
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    try {
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const rackBoxes = mgr.getObstacleBoxes().filter((b) => b.kind === "rack");
      const a1 = mgr.spawnAgf("aisle-agf-1", { pos: [ox - 10, oy - 9.0, 0], heading: Math.PI / 2 });
      const a2 = mgr.spawnAgf("aisle-agf-2", { pos: [ox + 2, oy - 9.0, 0], heading: -Math.PI / 2 });
      let minEdge = Infinity;
      let minSep = Infinity;
      let insideCount = 0;
      await stepUntilSettled(() => {
        mgr.tick(1 / 60);
        for (const a of [a1, a2]) {
          const d = minRackEdgeDist(a.x, a.y, rackBoxes);
          if (d === 0) insideCount++;
          if (d < minEdge) minEdge = d;
        }
        const sep = Math.hypot(a1.x - a2.x, a1.y - a2.y);
        if (sep < minSep) minSep = sep;
      }, Promise.all([
        a1.enqueue({ type: "driveTo", waypoints: [[ox + 4, oy - 9.0]] }),
        a2.enqueue({ type: "driveTo", waypoints: [[ox - 12, oy - 9.0]] }),
      ]), 2400);
      assert.equal(insideCount, 0, "no inside-rack positions during aisle passing");
      assert.ok(minEdge >= AGF_SPECS.hullRadiusM, `rack aisle minEdge=${minEdge.toFixed(4)} < ${AGF_SPECS.hullRadiusM}`);
      assert.ok(minSep >= 1.24, `rack aisle minSep=${minSep.toFixed(4)} < 1.24`);
    } finally {
      mgr.dispose();
    }
  }

  // 9b. scale-stress 4800-tick (1/60) & 3600-tick (1/30) rack/stand/charger 6-corner AGF hull, 4-corner AMR stand hull & late-window liveness invariant
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  for (const [stepDt, tickLimit] of [[1 / 60, 4800], [1 / 30, 3600]]) {
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    try {
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const staticBoxes = mgr.getObstacleBoxes().filter((b) => b.kind === "rack" || b.kind === "stand" || b.kind === "charger" || b.kind === "liftTable");
      const rackBoxes = staticBoxes.filter((b) => b.kind === "rack");
      const stHalfW = STAND_SPECS.outerWidthM * 0.5;
      const stHalfD = STAND_SPECS.outerDepthM * 0.5;
      const standBoxes = [...mgr.stands.values()].map((st) => {
        const rot = Math.abs(Math.sin(st.heading)) > 0.7;
        return {
          x0: st.pos[0] - (rot ? stHalfD : stHalfW),
          x1: st.pos[0] + (rot ? stHalfD : stHalfW),
          y0: st.pos[1] - (rot ? stHalfW : stHalfD),
          y1: st.pos[1] + (rot ? stHalfW : stHalfD),
          kind: "stand",
          id: st.id,
        };
      });
      const agfStaticBoxes = [...staticBoxes, ...standBoxes];
      const amrStaticBoxes = [...staticBoxes.filter((b) => b.kind !== "stand"), ...standBoxes];
      const scenP = mgr.runScenario("scale-stress");
      let insideCount = 0;
      let hullOverlapCount = 0;
      let cornerHits = 0;
      let amrStandHits = 0;
      let amrNonTargetHits = 0;
      let minEdge = Infinity;
      let minSep = Infinity;
      let amrMinSepMM = Infinity;
      const agfDist = new Map();
      const final10sDist = new Map();
      const curStallSec = new Map();
      const maxStallSec = new Map();
      const prevPos = new Map();
      const amrDist = new Map();
      const amrFinal10sDist = new Map();
      const amrCurStallSec = new Map();
      const amrMaxStallSec = new Map();
      const amrPrevPos = new Map();
      const lateWinStart = tickLimit - Math.round(10.0 / stepDt);
      for (let t = 0; t < tickLimit; t++) {
        mgr.tick(stepDt);
        const agfList = [...mgr.agfs.values()];
        for (let ai = 0; ai < agfList.length; ai++) {
          const a = agfList[ai];
          const prev = prevPos.get(a.id);
          const stepDist = prev ? Math.hypot(a.x - prev[0], a.y - prev[1]) : 0;
          if (prev) {
            agfDist.set(a.id, (agfDist.get(a.id) ?? 0) + stepDist);
            if (t >= lateWinStart) {
              final10sDist.set(a.id, (final10sDist.get(a.id) ?? 0) + stepDist);
            }
            const stalled = stepDist < 1e-4 ? (curStallSec.get(a.id) ?? 0) + stepDt : 0;
            curStallSec.set(a.id, stalled);
            if (stalled > (maxStallSec.get(a.id) ?? 0)) maxStallSec.set(a.id, stalled);
          }
          prevPos.set(a.id, [a.x, a.y]);
          const d = minRackEdgeDist(a.x, a.y, rackBoxes);
          if (d < minEdge) minEdge = d;
          if (d === 0) insideCount++;
          if (d < AGF_SPECS.hullRadiusM) hullOverlapCount++;
          for (let ci = 0; ci < agfHullCorners.length; ci++) {
            const [lx, ly] = agfHullCorners[ci];
            const [wx, wy] = localToWorld2D(lx, ly, a.x, a.y, a.heading);
            for (let bi = 0; bi < agfStaticBoxes.length; bi++) {
              const b = agfStaticBoxes[bi];
              if (wx > b.x0 + 1e-4 && wx < b.x1 - 1e-4 && wy > b.y0 + 1e-4 && wy < b.y1 - 1e-4) {
                cornerHits++;
              }
            }
          }
          for (let aj = ai + 1; aj < agfList.length; aj++) {
            const b = agfList[aj];
            const sep = Math.hypot(a.x - b.x, a.y - b.y);
            if (sep < minSep) minSep = sep;
          }
        }
        const amrList = [...mgr.amrs.values()];
        for (let mi = 0; mi < amrList.length; mi++) {
          const m = amrList[mi];
          const prev = amrPrevPos.get(m.id);
          const stepDist = prev ? Math.hypot(m.x - prev[0], m.y - prev[1]) : 0;
          if (prev) {
            amrDist.set(m.id, (amrDist.get(m.id) ?? 0) + stepDist);
            if (t >= lateWinStart) {
              amrFinal10sDist.set(m.id, (amrFinal10sDist.get(m.id) ?? 0) + stepDist);
            }
            const stalled = stepDist < 1e-4 ? (amrCurStallSec.get(m.id) ?? 0) + stepDt : 0;
            amrCurStallSec.set(m.id, stalled);
            if (stalled > (amrMaxStallSec.get(m.id) ?? 0)) amrMaxStallSec.set(m.id, stalled);
          }
          amrPrevPos.set(m.id, [m.x, m.y]);
          for (let ci = 0; ci < amrHullCorners.length; ci++) {
            const [lx, ly] = amrHullCorners[ci];
            const [wx, wy] = localToWorld2D(lx, ly, m.x, m.y, m.heading);
            for (let bi = 0; bi < standBoxes.length; bi++) {
              const b = standBoxes[bi];
              if (wx > b.x0 + 1e-4 && wx < b.x1 - 1e-4 && wy > b.y0 + 1e-4 && wy < b.y1 - 1e-4) {
                amrStandHits++;
              }
            }
            for (let bi = 0; bi < amrStaticBoxes.length; bi++) {
              const b = amrStaticBoxes[bi];
              if (wx > b.x0 + 1e-4 && wx < b.x1 - 1e-4 && wy > b.y0 + 1e-4 && wy < b.y1 - 1e-4) {
                amrNonTargetHits++;
              }
            }
          }
          for (let mj = mi + 1; mj < amrList.length; mj++) {
            const b = amrList[mj];
            const sep = Math.hypot(m.x - b.x, m.y - b.y);
            if (sep < amrMinSepMM) amrMinSepMM = sep;
          }
        }
      }
      const minDistMoved = Math.min(...agfDist.values());
      const minFinal10sDist = Math.min(...final10sDist.values());
      const worstStallSec = Math.max(...maxStallSec.values());
      const amrMinDistMoved = Math.min(...amrDist.values());
      const amrMinFinal10sDist = Math.min(...amrFinal10sDist.values());
      const amrWorstStallSec = Math.max(...amrMaxStallSec.values());
      assert.equal(insideCount, 0, `scale-stress (dt=${stepDt.toFixed(4)}) insideRackCount=${insideCount} !== 0`);
      assert.equal(hullOverlapCount, 0, `scale-stress (dt=${stepDt.toFixed(4)}) hullOverlapRackCount=${hullOverlapCount} !== 0`);
      assert.equal(cornerHits, 0, `scale-stress (dt=${stepDt.toFixed(4)}) 6-corner hull hits=${cornerHits} !== 0`);
      assert.equal(amrStandHits, 0, `scale-stress (dt=${stepDt.toFixed(4)}) AMR 4-corner stand hits=${amrStandHits} !== 0`);
      assert.equal(amrNonTargetHits, 0, `scale-stress (dt=${stepDt.toFixed(4)}) AMR 4-corner non-target hits=${amrNonTargetHits} !== 0`);
      assert.ok(minEdge >= AGF_SPECS.hullRadiusM, `scale-stress (dt=${stepDt.toFixed(4)}) minEdge=${minEdge.toFixed(4)} < ${AGF_SPECS.hullRadiusM}`);
      assert.ok(minSep >= 0.70, `scale-stress (dt=${stepDt.toFixed(4)}) minSep=${minSep.toFixed(4)} < 0.70`);
      assert.ok(amrMinSepMM >= 0.70, `scale-stress (dt=${stepDt.toFixed(4)}) amrMinSepMM=${amrMinSepMM.toFixed(4)} < 0.70`);
      assert.ok(minDistMoved >= 15.0, `scale-stress (dt=${stepDt.toFixed(4)}) minDistMoved=${minDistMoved.toFixed(2)} < 15.0`);
      assert.ok(minFinal10sDist >= 0.5, `scale-stress (dt=${stepDt.toFixed(4)}) minFinal10sDist=${minFinal10sDist.toFixed(2)} < 0.50`);
      assert.ok(worstStallSec < 10.0, `scale-stress (dt=${stepDt.toFixed(4)}) worstStallSec=${worstStallSec.toFixed(2)} >= 10.0`);
      assert.ok(amrMinDistMoved >= 10.0, `scale-stress (dt=${stepDt.toFixed(4)}) amrMinDistMoved=${amrMinDistMoved.toFixed(2)} < 10.0`);
      assert.ok(amrMinFinal10sDist >= 0.5, `scale-stress (dt=${stepDt.toFixed(4)}) amrMinFinal10sDist=${amrMinFinal10sDist.toFixed(2)} < 0.50`);
      assert.ok(amrWorstStallSec < 10.0, `scale-stress (dt=${stepDt.toFixed(4)}) amrWorstStallSec=${amrWorstStallSec.toFixed(2)} >= 10.0`);
      assertAllFinite(mgr.getState(), `scaleStress${tickLimit}State`);
      mgr.stopScenarios();
      await scenP;
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 9c. Regression: Rack-End & Aisle-Entry 6-Corner Clearance (1/60 & 1/30)
// ---------------------------------------------------------------------------
check("9c. regression: rack-end & aisle-entry turns maintain 0 6-corner hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const cases = [
    ["west_-18_+3_h0->+8_+3", [ox - 18, oy + 3, 0], 0, [ox + 8, oy + 3]],
    ["west_-18_-9_hPI->+8_-9", [ox - 18, oy - 9, 0], Math.PI, [ox + 8, oy - 9]],
    ["east_+8_+3_h0->-18_+3", [ox + 8, oy + 3, 0], 0, [ox - 18, oy + 3]],
    ["east_+8_-9_hPI->-18_-9", [ox + 8, oy - 9, 0], Math.PI, [ox - 18, oy - 9]],
    ["west_-22_+3_h0->+8_+3", [ox - 22, oy + 3, 0], 0, [ox + 8, oy + 3]],
    ["east_+10_+3_hPI->-18_+3", [ox + 10, oy + 3, 0], Math.PI, [ox - 18, oy + 3]],
    ["east_+10_-3_hPI2->-18_-3", [ox + 10, oy - 3, 0], Math.PI * 0.5, [ox - 18, oy - 3]],
  ];
  for (const stepDt of [1 / 60, 1 / 30]) {
    const maxSteps = stepDt < 0.025 ? 4000 : 2000;
    for (const [label, sPos, sH, tPos] of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const staticBoxes = mgr.getObstacleBoxes().filter((b) => b.kind === "rack" || b.kind === "stand" || b.kind === "charger");
        const agf = mgr.spawnAgf(`agf-9c-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(stepDt);
            for (let ci = 0; ci < hullCorners.length; ci++) {
              const [lx, ly] = hullCorners[ci];
              const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
              for (let bi = 0; bi < staticBoxes.length; bi++) {
                const b = staticBoxes[bi];
                if (wx > b.x0 + 1e-4 && wx < b.x1 - 1e-4 && wy > b.y0 + 1e-4 && wy < b.y1 - 1e-4) {
                  cornerHits++;
                }
              }
            }
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(cornerHits, 0, `9c ${label} dt=${stepDt.toFixed(4)} had ${cornerHits} hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `9c ${label} dt=${stepDt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 10. Regression: Cross-Bay Drop L1 -> Pick SB1 -> onServerState Echo Preserves Local Cargo
// ---------------------------------------------------------------------------
check("10. regression: server-backed KeyF drop 4000015 onto L1 then pick 4000012 from SB1 survives 10 Hz onServerState echo", () => {
  const rig = makeRig({ withVehicles: false });
  const mgr = createWarehouseManager({
    THREE,
    liveScene3d: rig.live,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map(),
    trailers: new Map(),
    logisticsAudio: null,
    sh: () => rig.sh,
  });
  mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

  const liftId = [...mgr.liftTables.keys()][0];
  const lt = mgr.liftTables.get(liftId);
  lt.setAutoMode(false);
  lt.setHeightImmediate(0.0);

  const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
  const bay0 = layout.stagingBays[0];
  mgr.setStagingBayCargo(bay0.id, 4000012);

  const jackEntry = {
    guid: 0x62000010,
    localOnly: false,
    worldPos: [lt.pos[0], lt.pos[1] - 0.25, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.200,
    carriedWcid: 4000015,
    carriedPalletSize: 2,
    model: { root: new THREE.Group(), update() {}, dispose() {} },
  };
  const ctrl = createPalletJackController({
    liveScene3d: rig.live,
    THREE,
    window: rig.win,
    sh: () => rig.sh,
    em: rig.live.entityManager,
    localGuid: () => rig.localPlayerGuid,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map([[jackEntry.guid, jackEntry]]),
    warehouseManager: mgr,
  });

  try {
    ctrl.start(jackEntry);
    // Step 1: drop server cargo 4000015 onto L1 via KeyF
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(lt.carriedWcid, 4000015, "L1 holds dropped 4000015");
    assert.equal(ctrl.state.carriedWcid, 0, "jack empty after drop onto L1");

    // Step 2: walk to SB1 (reconciled position while ACE still echoes carriedWcid=4000015) and pick 4000012 via KeyF
    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 4000015,
      carriedPalletSize: 2,
      position: [bay0.pos[0], bay0.pos[1] - 0.25, 0],
    }, jackEntry);
    assert.equal(ctrl.state.carriedWcid, 0, "echo suppressed before SB1 pick");

    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(ctrl.state.carriedWcid, 4000012, "jack picked local 4000012 from SB1");
    assert.equal(mgr.getState().stagingBays[bay0.id].carriedWcid, 0, "SB1 emptied after pick");

    // Step 3: subsequent 10 Hz ACE echo of 4000015 must NOT duplicate 4000015 or overwrite 4000012
    for (let i = 0; i < 5; i++) {
      ctrl.onServerState({
        palletJackGuid: jackEntry.guid,
        operatorGuid: rig.localPlayerGuid,
        carriedWcid: 4000015,
        carriedPalletSize: 2,
      }, jackEntry);
      assert.equal(ctrl.state.carriedWcid, 4000012, `echo ${i}: local 4000012 preserved`);
      assert.equal(lt.carriedWcid, 4000015, `echo ${i}: L1 still holds 4000015`);
      assert.equal(mgr.getState().stagingBays[bay0.id].carriedWcid, 0, `echo ${i}: SB1 remains empty`);
    }

    // Step 4: server catches up to 0 -> still preserves 4000012 until locally dropped/loaded
    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
    }, jackEntry);
    assert.equal(ctrl.state.carriedWcid, 4000012, "local 4000012 preserved after srvWcid=0");
    ctrl.stop("test");
  } finally {
    ctrl.dispose();
    mgr.dispose();
  }
});

// ---------------------------------------------------------------------------
// 11. Regression: entry.carriedWcid & carriedPalletSize Survive ACE Echo=0
// ---------------------------------------------------------------------------
check("11. regression: entry.carriedWcid === 4000012 & carriedPalletSize === 2 survive ACE pallet_jack_state echo=0", () => {
  const rig = makeRig({ withVehicles: false });
  const mgr = createWarehouseManager({
    THREE,
    liveScene3d: rig.live,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map(),
    trailers: new Map(),
    logisticsAudio: null,
    sh: () => rig.sh,
  });
  mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

  const lt = mgr.liftTables.get("L1");
  lt.setAutoMode(false);
  lt.setHeightImmediate(0.0);
  lt.setCargoWcid(4000012);

  const jackEntry = {
    guid: 0x62000011,
    localOnly: false,
    worldPos: [lt.pos[0], lt.pos[1] + 0.25, 0],
    heading: Math.PI,
    tillerAngle: 0,
    forkHeightM: 0.085,
    carriedWcid: 0,
    carriedPalletSize: 0,
    model: { root: new THREE.Group(), update() {}, dispose() {} },
  };
  const ctrl = createPalletJackController({
    liveScene3d: rig.live,
    THREE,
    window: rig.win,
    sh: () => rig.sh,
    em: rig.live.entityManager,
    localGuid: () => rig.localPlayerGuid,
    containers: new Map(),
    deployables: new Map(),
    palletJacks: new Map([[jackEntry.guid, jackEntry]]),
    warehouseManager: mgr,
  });

  try {
    ctrl.start(jackEntry);
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    ctrl.tick(1 / 60);
    assert.equal(lt.carriedWcid, 0, "L1 cleared after KeyF pick");
    assert.equal(jackEntry.carriedWcid, 4000012, "jackEntry.carriedWcid set to 4000012");
    assert.equal(jackEntry.carriedPalletSize, 2, "jackEntry.carriedPalletSize set to 2");

    // Simulate index.js:2332-2334 + 2365 receiving ACE pallet_jack_state echo with carriedWcid=0 (e.g. after raise())
    jackEntry.carriedPalletSize = 0;
    jackEntry.carriedWcid = 0;
    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
      carriedPalletSize: 0,
      forkHeightM: 0.20,
    }, jackEntry);
    assert.equal(jackEntry.carriedWcid, 4000012, "jackEntry.carriedWcid restored to 4000012 after onServerState echo=0");
    assert.equal(jackEntry.carriedPalletSize, 2, "jackEntry.carriedPalletSize restored to 2 after onServerState echo=0");

    ctrl.tick(1 / 60);
    assert.equal(jackEntry.carriedWcid, 4000012, "jackEntry.carriedWcid stays 4000012 after tick()");
    assert.equal(jackEntry.carriedPalletSize, 2, "jackEntry.carriedPalletSize stays 2 after tick()");

    // Release (KeyX) + server echo(operatorGuid=0, carriedWcid=0) + re-grab echo(operatorGuid=me, carriedWcid=0)
    rig.win.dispatch("keydown", { code: "KeyX", key: "x" });
    rig.win.dispatch("keyup", { code: "KeyX", key: "x" });
    assert.equal(ctrl.isActive(), false, "KeyX releases active pallet jack");
    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: 0,
      carriedWcid: 0,
      carriedPalletSize: 0,
      forkHeightM: 0.20,
    }, jackEntry);
    assert.equal(jackEntry.carriedWcid, 4000012, "released jackEntry preserves local carriedWcid=4000012");
    assert.equal(jackEntry.carriedPalletSize, 2, "released jackEntry preserves carriedPalletSize=2");

    ctrl.onServerState({
      palletJackGuid: jackEntry.guid,
      operatorGuid: rig.localPlayerGuid,
      carriedWcid: 0,
      carriedPalletSize: 0,
      forkHeightM: 0.20,
    }, jackEntry);
    assert.equal(ctrl.isActive(), true, "re-grab reactivates pallet jack controller");
    assert.equal(ctrl.state.carriedWcid, 4000012, "re-grabbed controller state preserves 4000012");
    assert.equal(jackEntry.carriedWcid, 4000012, "re-grabbed jackEntry preserves 4000012");
    assert.equal(jackEntry.carriedPalletSize, 2, "re-grabbed jackEntry preserves carriedPalletSize=2");

    ctrl.stop("test");
  } finally {
    ctrl.dispose();
    mgr.dispose();
  }
});

// ---------------------------------------------------------------------------
// 12. Regression: Narrow Two-Sided Container Alley (4.2m pitch, facing North)
// ---------------------------------------------------------------------------
check("12. regression: AGF exits narrow 4.2m two-sided container alley facing North without neighbor/wall clip", async () => {
  const rig = makeRig({ withVehicles: false });
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const containers = new Map();
  const makeContainer = (guid, cx, cy, slots = [], doorOpen = false) => ({
    guid,
    wcid: 4000022,
    kind: 12,
    heading: 0,
    rawPos: [cx, cy, 0],
    currentDoorProgress: doorOpen ? 1.0 : 0.0,
    slots,
    model: { root: { position: { x: cx, y: cy, z: 0 } }, syncSlots() {} },
  });
  const targetCx = ox - 18;
  const targetCy = oy + 32;
  containers.set(0x9301, makeContainer(0x9301, targetCx, targetCy, [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }], true));
  containers.set(0x9302, makeContainer(0x9302, targetCx - 4.2, targetCy, [], false));
  containers.set(0x9303, makeContainer(0x9303, targetCx + 4.2, targetCy, [], false));

  const mgr = createWarehouseManager({
    THREE,
    liveScene3d: rig.live,
    containers,
    deployables: new Map(),
    palletJacks: new Map(),
    trailers: new Map(),
    logisticsAudio: null,
    sh: () => rig.sh,
  });
  mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

  try {
    const agf = mgr.spawnAgf("narrow-alley-agf", {
      pos: [targetCx - 2.1, targetCy, 0],
      heading: 0,
    });
    let minOtherWallDist = Infinity;
    let minTargetSideDist = Infinity;
    const task = agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9301, slotIndex: 0 });
    await stepUntilSettled(() => {
      mgr.tick(1 / 60, [ox, oy, 12]);
      for (const ncx of [targetCx - 4.2, targetCx + 4.2]) {
        const dx = Math.max(0, Math.abs(agf.x - ncx) - 1.219);
        const dy = Math.max(0, Math.abs(agf.y - targetCy) - 6.096);
        const d = Math.hypot(dx, dy);
        if (d < minOtherWallDist) minOtherWallDist = d;
      }
      const lx = agf.x - targetCx;
      const ly = agf.y - targetCy;
      if (Math.abs(lx) >= 1.219 || ly > 6.096) {
        const dx = Math.max(0, Math.abs(lx) - 1.219);
        const dy = Math.max(0, Math.abs(ly) - 6.096);
        const d = Math.hypot(dx, dy);
        if (d < minTargetSideDist) minTargetSideDist = d;
      }
    }, task, 4000);
    assert.equal(agf.carriedWcid, 4000012, "AGF must pick cargo 4000012 from target container");
    assert.ok(minTargetSideDist >= AGF_SPECS.hullRadiusM, `minTargetSideDist ${minTargetSideDist} < ${AGF_SPECS.hullRadiusM}`);
    assert.ok(minOtherWallDist >= AGF_SPECS.hullRadiusM, `minOtherWallDist ${minOtherWallDist} < ${AGF_SPECS.hullRadiusM}`);
  } finally {
    mgr.dispose();
  }
});

// ---------------------------------------------------------------------------
// 13. Regression: Released Pallet Jack (KeyX) 3D Cargo Mesh Echo Sync via index.js
// ---------------------------------------------------------------------------
check("13. regression: released pallet jack (KeyX) preserves entry.model.carriedWcid=4000012 across ACE pallet_jack_state echoes", () => {
  const rig = makeRig({ withVehicles: true });
  try {
    const mgr = rig.win.__vehicles.warehouse;
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

    const liftId = [...mgr.liftTables.keys()][0];
    const lt = mgr.liftTables.get(liftId);
    lt.setAutoMode(false);
    lt.setHeightImmediate(0.0);
    lt.setCargoWcid(4000012);

    const pjGuid = 0x62000099;
    const msgQueue = [];
    rig.sh.drainVehicleMessages = () => {
      if (msgQueue.length === 0) return "[]";
      return JSON.stringify(msgQueue.splice(0, msgQueue.length));
    };

    // Spawn and grab jack near lowered Lift Table L1
    msgQueue.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: rig.localPlayerGuid,
      cell: 0,
      position: [lt.pos[0], lt.pos[1] + 0.25, 0],
      heading: Math.PI,
      tillerAngle: 0,
      forkHeightM: 0.085,
      carriedWcid: 0,
      carriedPalletSize: 0,
      flags: 0,
    });
    rig.live.vehicles.afterTick(16.667, 16.667);

    // Pick local cargo 4000012 from L1 with KeyF
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    rig.live.vehicles.afterTick(33.333, 16.667);
    assert.equal(lt.carriedWcid, 0, "L1 cleared after KeyF pick");

    let pj = rig.win.__vehicles.palletJacks.get(pjGuid);
    assert.equal(pj.carriedWcid, 4000012, "jack entry carriedWcid is 4000012 after pick");
    assert.equal(pj.model.carriedWcid, 4000012, "jack 3D model carriedWcid is 4000012 after pick");

    // Release jack with KeyX
    rig.win.dispatch("keydown", { code: "KeyX", key: "x" });
    rig.win.dispatch("keyup", { code: "KeyX", key: "x" });
    assert.equal(rig.win.__vehicles.palletJacks.active, null, "KeyX releases active pallet jack");

    // ACE sends pallet_jack_state echo with operatorGuid=0, carriedWcid=0
    msgQueue.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: 0,
      cell: 0,
      position: [lt.pos[0], lt.pos[1] + 0.25, 0],
      heading: Math.PI,
      tillerAngle: 0,
      forkHeightM: 0.20,
      carriedWcid: 0,
      carriedPalletSize: 0,
      flags: 0,
    });
    rig.live.vehicles.afterTick(50.0, 16.667);

    pj = rig.win.__vehicles.palletJacks.get(pjGuid);
    assert.equal(pj.carriedWcid, 4000012, "released jack entry preserves carriedWcid=4000012 on ACE echo=0");
    assert.equal(pj.model.carriedWcid, 4000012, "released jack 3D model preserves carriedWcid=4000012 on ACE echo=0");
    assert.equal(pj.model.mountedCargo?.wcid, 4000012, "released jack 3D mountedCargo stays mounted");

    // Also test stale server echo suppression after local drop + KeyX release:
    // Re-grab jack carrying server cargo 4000015 -> drop onto L1 -> KeyX -> stale echo carriedWcid=4000015
    const pjGuid2 = 0x6200009a;
    msgQueue.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid2,
      operatorGuid: rig.localPlayerGuid,
      cell: 0,
      position: [lt.pos[0], lt.pos[1] + 0.25, 0],
      heading: Math.PI,
      tillerAngle: 0,
      forkHeightM: 0.20,
      carriedWcid: 4000015,
      carriedPalletSize: 2,
      flags: 0,
    });
    rig.live.vehicles.afterTick(66.667, 16.667);
    let pj2 = rig.win.__vehicles.palletJacks.get(pjGuid2);
    assert.equal(pj2.model.carriedWcid, 4000015, "jack2 mounts server cargo 4000015");

    // Drop 4000015 onto L1 with KeyF, then release with KeyX
    rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
    rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
    rig.live.vehicles.afterTick(83.333, 16.667);
    assert.equal(lt.carriedWcid, 4000015, "L1 received server cargo 4000015");
    rig.win.dispatch("keydown", { code: "KeyX", key: "x" });
    rig.win.dispatch("keyup", { code: "KeyX", key: "x" });

    // Stale echo still carrying 4000015 arrives for released jack2
    msgQueue.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid2,
      operatorGuid: 0,
      cell: 0,
      position: [lt.pos[0], lt.pos[1] + 0.25, 0],
      heading: Math.PI,
      tillerAngle: 0,
      forkHeightM: 0.20,
      carriedWcid: 4000015,
      carriedPalletSize: 2,
      flags: 0,
    });
    rig.live.vehicles.afterTick(100.0, 16.667);
    pj2 = rig.win.__vehicles.palletJacks.get(pjGuid2);
    assert.equal(pj2.carriedWcid, 0, "released jack2 suppresses stale carriedWcid=4000015 after local drop");
    assert.equal(pj2.model.carriedWcid, 0, "released jack2 3D model suppresses ghost remount on stale carriedWcid=4000015");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 14. Regression: Doorway Sidewall Fork-Tip Clearance (behind_3p6 & regionA_front_center_slot0)
// ---------------------------------------------------------------------------
check("14. regression: behind_with_both_sides_blocked_3p6 & regionA_40ft_front_center_slot0 enter doorway with 0 sidewall fork-tip hits", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const mkContainer = (guid, cx, cy, slots = [], doorOpen = false) => ({
    guid,
    wcid: 4000022,
    kind: 12,
    heading: 0,
    rawPos: [cx, cy, 0],
    currentDoorProgress: doorOpen ? 1.0 : 0.0,
    slots,
    model: { root: { position: { x: cx, y: cy, z: 0 } }, syncSlots() {} },
  });

  const targetCx = ox - 18;
  const targetCy = oy + 32;
  const cases = [
    { name: "behind_3p6_slot0", slotIndex: 0, startPos: [targetCx, targetCy + 8.5, 0], neighbors: true, expectedWcid: 4000012 },
    { name: "behind_3p6_slot1", slotIndex: 1, startPos: [targetCx, targetCy + 8.5, 0], neighbors: true, expectedWcid: 4000013 },
    { name: "regionA_40ft_front_center_slot0", slotIndex: 0, startPos: [targetCx, targetCy - 8.196, 0], neighbors: false, expectedWcid: 4000012 },
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    for (const tc of cases) {
      const rig = makeRig({ withVehicles: false });
      const containers = new Map();
      containers.set(0x9301, mkContainer(0x9301, targetCx, targetCy, [
        { slotIndex: 0, palletSize: "full", cargoWcid: 4000012 },
        { slotIndex: 1, palletSize: "full", cargoWcid: 4000013 },
      ], true));
      if (tc.neighbors) {
        containers.set(0x9302, mkContainer(0x9302, targetCx - 3.6, targetCy, [], false));
        containers.set(0x9303, mkContainer(0x9303, targetCx + 3.6, targetCy, [], false));
      }
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${tc.name}`, { pos: tc.startPos, heading: 0 });
        const task = agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9301, slotIndex: tc.slotIndex });
        let sidewallHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt, [ox, oy, 12]);
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
            const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
            const clx = wx - targetCx;
            const cly = wy - targetCy;
            if (Math.abs(clx) < 1.219 && Math.abs(cly) < 6.096) {
              if (!(Math.abs(clx) < 1.176 && cly < 6.016)) {
                sidewallHits++;
              }
            }
          }
        }, task, dt < 0.025 ? 4500 : 2250);
        assert.equal(sidewallHits, 0, `${tc.name} dt=${dt.toFixed(4)} had ${sidewallHits} sidewall hits`);
        assert.equal(agf.carriedWcid, tc.expectedWcid, `${tc.name} dt=${dt.toFixed(4)} picked expected cargo`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 15. Regression: Container Departure Counterweight Clearance (ch=PI -> placeInRack R1)
// ---------------------------------------------------------------------------
check("15. regression: chained pickFromContainer (ch=PI, slot 0 & 1) -> placeInRack R1 maintains 0 counterweight/sidewall hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const targetCx = ox - 18;
  const targetCy = oy + 32;
  const ch = Math.PI;
  const cosH = Math.cos(ch);
  const sinH = Math.sin(ch);

  for (const dt of [1 / 60, 1 / 30]) {
    for (const [slotIndex, expectedWcid] of [[0, 4000012], [1, 4000013]]) {
      const rig = makeRig({ withVehicles: false });
      const containers = new Map();
      containers.set(0x9301, {
        guid: 0x9301,
        wcid: 4000022,
        kind: 12,
        heading: ch,
        rawPos: [targetCx, targetCy, 0],
        currentDoorProgress: 1.0,
        slots: [
          { slotIndex: 0, palletSize: "full", cargoWcid: 4000012 },
          { slotIndex: 1, palletSize: "full", cargoWcid: 4000013 },
        ],
        model: { root: { position: { x: targetCx, y: targetCy, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-depart-slot${slotIndex}`, { pos: [ox - 18, oy + 20, 0], heading: 0 });
        const chained = (async () => {
          await agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9301, slotIndex });
          await agf.enqueue({ type: "placeInRack", rackId: "R1", bay: 0, tier: 1, side: 0, slotInBay: 0 });
        })();
        let sidewallHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt, [ox, oy, 12]);
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
            const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
            const dx = wx - targetCx;
            const dy = wy - targetCy;
            const clx = dx * cosH - dy * sinH;
            const cly = dx * sinH + dy * cosH;
            if (Math.abs(clx) < 1.219 && Math.abs(cly) < 6.096) {
              if (!(Math.abs(clx) < 1.176 && cly < 6.016)) {
                sidewallHits++;
              }
            }
          }
        }, chained, dt < 0.025 ? 8000 : 4000);
        assert.equal(sidewallHits, 0, `slot=${slotIndex} dt=${dt.toFixed(4)} had ${sidewallHits} sidewall hits`);
        assert.equal(agf.carriedWcid, 0, `slot=${slotIndex} dt=${dt.toFixed(4)} unloaded cargo into rack`);
        const slotObj = mgr.racks.get("R1")?.loadedSlots?.get("0:0:1:0");
        assert.equal(slotObj?.wcid, expectedWcid, `slot=${slotIndex} dt=${dt.toFixed(4)} placed expected WCID ${expectedWcid} in R1`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 16. Regression: Open-Apron Transit Rack/Charger/Sidewall 6-Corner Clearance (z28_11 & z28_25)
// ---------------------------------------------------------------------------
check("16. regression: Zone D transit (z28_11 east_far & z28_25 between_chargers -> C1) maintains 0 rack/charger/sidewall 6-corner hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const targetCx = ox - 18;
  const targetCy = oy + 32;
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const cases = [
    { name: "z28_11_east_far", pos: [ox + 26, oy - 35, 0] },
    { name: "z28_25_between_chargers", pos: [ox - 4, oy - 38, 0] },
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    for (const tc of cases) {
      const rig = makeRig({ withVehicles: false });
      const containers = new Map();
      containers.set(0x9401, {
        guid: 0x9401,
        wcid: 4000022,
        kind: 12,
        heading: 0,
        rawPos: [targetCx, targetCy, 0],
        currentDoorProgress: 1.0,
        slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: targetCx, y: targetCy, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${tc.name}`, { pos: tc.pos, heading: 0 });
        const task = agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9401, slotIndex: 0 });
        const racks = [...mgr.racks.values()];
        const chargers = [...mgr.chargers.values()];
        let hits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt, [ox, oy, 12]);
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
            const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
            for (let ri = 0; ri < racks.length; ri++) {
              const b = racks[ri].worldBounds;
              if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
            }
            for (let chi = 0; chi < chargers.length; chi++) {
              const ch = chargers[chi];
              if (Math.abs(wx - ch.pos[0]) < chHalfW && Math.abs(wy - ch.pos[1]) < chHalfD) hits++;
            }
            const clx = wx - targetCx;
            const cly = wy - targetCy;
            if (Math.abs(clx) < 1.219 && Math.abs(cly) < 6.096) {
              if (!(Math.abs(clx) < 1.176 && cly < 6.016)) hits++;
            }
          }
        }, task, dt < 0.025 ? 8000 : 4000);
        assert.equal(hits, 0, `${tc.name} dt=${dt.toFixed(4)} had ${hits} rack/charger/sidewall hits`);
        assert.equal(agf.carriedWcid, 4000012, `${tc.name} dt=${dt.toFixed(4)} picked expected WCID 4000012`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 17. Regression: Spine-to-Aisle 90 deg Entry Turn 6-Corner Clearance (R1, R2_3, R4_5, R6)
// ---------------------------------------------------------------------------
check("17. regression: Zone D -> placeInRack spine-to-aisle 90 deg entry (R6 bay 4 & 0, R1 bay 0, R2_3 s0/s1 bay 4) maintains 0 transit rack/stand/charger hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const cases = [
    { name: "south_of_chargers->R6_b4", pos: [ox, oy - 42, 0], rackId: "R6", bay: 4, side: 0 },
    { name: "south_of_chargers->R6_b0", pos: [ox, oy - 42, 0], rackId: "R6", bay: 0, side: 0 },
    { name: "between_chargers->R6_b0", pos: [ox - 4, oy - 38, 0], rackId: "R6", bay: 0, side: 0 },
    { name: "east_far->R1_b0", pos: [ox + 26, oy - 35, 0], rackId: "R1", bay: 0, side: 0 },
    { name: "south_of_chargers->R2_3_s0_b4", pos: [ox, oy - 42, 0], rackId: "R2_3", bay: 4, side: 0 },
    { name: "south_of_chargers->R2_3_s1_b4", pos: [ox, oy - 42, 0], rackId: "R2_3", bay: 4, side: 1 },
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    for (const tc of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${tc.name}`, { pos: tc.pos, heading: 0, carriedWcid: 4000012 });
        const targetRow = mgr.racks.get(tc.rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + tc.bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        const task = agf.enqueue({ type: "placeInRack", rackId: tc.rackId, bay: tc.bay, tier: 1, side: tc.side, slotInBay: 0 });
        const racks = [...mgr.racks.values()];
        const stands = [...mgr.stands.values()];
        const chargers = [...mgr.chargers.values()];
        let transitRackHits = 0;
        let transitStandHits = 0;
        let chargerHits = 0;
        await stepUntilSettled(() => {
          mgr.tick(dt, [ox, oy, 12]);
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
            const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
            if (agf.statusMode === "transit") {
              for (let ri = 0; ri < racks.length; ri++) {
                const r = racks[ri];
                const b = r.worldBounds;
                if (!b || !(wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY)) continue;
                const isTargetBayRetract = r.id === tc.rackId && Math.abs(wx - bayCenterX) <= 1.50;
                if (!isTargetBayRetract) transitRackHits++;
              }
              for (let si = 0; si < stands.length; si++) {
                const st = stands[si];
                const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
                const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
                if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) transitStandHits++;
              }
            }
            for (let chi = 0; chi < chargers.length; chi++) {
              const ch = chargers[chi];
              if (Math.abs(wx - ch.pos[0]) < chHalfW && Math.abs(wy - ch.pos[1]) < chHalfD) chargerHits++;
            }
          }
        }, task, dt < 0.025 ? 8000 : 4000);
        assert.equal(transitRackHits, 0, `${tc.name} dt=${dt.toFixed(4)} had ${transitRackHits} transit rack 6-corner hits`);
        assert.equal(transitStandHits, 0, `${tc.name} dt=${dt.toFixed(4)} had ${transitStandHits} transit stand 6-corner hits`);
        assert.equal(chargerHits, 0, `${tc.name} dt=${dt.toFixed(4)} had ${chargerHits} charger 6-corner hits`);
        assert.equal(agf.carriedWcid, 0, `${tc.name} dt=${dt.toFixed(4)} unloaded cargo into ${tc.rackId}`);
        const slotObj = targetRow?.loadedSlots?.get(`${tc.side}:${tc.bay}:1:0`);
        assert.equal(slotObj?.wcid, 4000012, `${tc.name} dt=${dt.toFixed(4)} placed expected WCID 4000012`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 18. Regression: Rack Departure, East Spine vs Stands, & Long Container Route
// ---------------------------------------------------------------------------
check("18. regression: via_rack_0..3 (bay 0 & 4) rack departure, C2_pad/north_of_racks -> A1 east spine, and east_far -> C3_20ft_hPI2 maintain 0 transit hull hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const checkRackHits = (agf, racks, targetRackId = null, bayCenterX = NaN) => {
    let hits = 0;
    if (agf.statusMode !== "transit") return 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const r = racks[ri];
        const b = r.worldBounds;
        if (!b || !(wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY)) continue;
        const isTargetBay = targetRackId && r.id === targetRackId && Number.isFinite(bayCenterX) && Math.abs(wx - bayCenterX) <= 1.50;
        if (!isTargetBay) hits++;
      }
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;

    // 18a. via_rack_0..3 (bay 0 & bay 4): placeInRack -> pickFromContainer(C1)
    for (const [rackId, bay] of [
      ["R1", 0], ["R1", 4],
      ["R2_3", 0], ["R2_3", 4],
      ["R4_5", 0], ["R4_5", 4],
      ["R6", 0], ["R6", 4],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const containers = new Map();
      containers.set(0x9501, {
        guid: 0x9501,
        wcid: 4000022,
        kind: 12,
        heading: 0,
        rawPos: [ox - 18, oy + 32, 0],
        currentDoorProgress: 1.0,
        slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: ox - 18, y: oy + 32, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-via-${rackId}-b${bay}`, { pos: [ox - 4, oy - 38, 0], heading: 0, carriedWcid: 4000014 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        const racks = [...mgr.racks.values()];
        const stands = [...mgr.stands.values()];
        let transitHits = 0;
        let transitStandHits = 0;
        const countStandHits = () => {
          if (agf.statusMode !== "transit") return 0;
          let sh = 0;
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
            const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
            for (let si = 0; si < stands.length; si++) {
              const st = stands[si];
              const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
              const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
              if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) sh++;
            }
          }
          return sh;
        };
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            transitHits += checkRackHits(agf, racks, rackId, bayCenterX);
            transitStandHits += countStandHits();
          },
          agf.enqueue({ type: "placeInRack", rackId, bay, tier: 1, side: 0, slotInBay: 0 }),
          maxSteps,
        );
        assert.equal(transitHits, 0, `via_rack ${rackId} b${bay} place dt=${dt.toFixed(4)} had ${transitHits} transit rack hits`);
        let departHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            departHits += checkRackHits(agf, racks);
            transitStandHits += countStandHits();
          },
          agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9501, slotIndex: 0 }),
          maxSteps,
        );
        assert.equal(departHits, 0, `via_rack ${rackId} b${bay} depart dt=${dt.toFixed(4)} had ${departHits} transit rack hits`);
        assert.equal(transitStandHits, 0, `via_rack ${rackId} b${bay} dt=${dt.toFixed(4)} had ${transitStandHits} transit stand hits`);
        assert.equal(agf.carriedWcid, 4000012, `via_rack ${rackId} b${bay} dt=${dt.toFixed(4)} picked 4000012`);
      } finally {
        mgr.dispose();
      }
    }

    // 18b. C2_pad & north_of_racks -> R1_s0_b4 & R2_3_s1_b4 (East spine vs R2_3 NE corner & Zone C stands S1..S6)
    for (const [label, startPos, rackId, side] of [
      ["C2_pad->R1_b4", [ox - 6, oy + 24, 0], "R1", 0],
      ["C2_pad->R2_3_s1_b4", [ox - 6, oy + 24, 0], "R2_3", 1],
      ["north->R1_b4", [ox, oy + 16, 0], "R1", 0],
      ["north->R2_3_s1_b4", [ox, oy + 16, 0], "R2_3", 1],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${label}`, { pos: startPos, heading: Math.PI, carriedWcid: 4000012 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + 4 * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        const racks = [...mgr.racks.values()];
        const stands = [...mgr.stands.values()];
        let transitRackHits = 0;
        let transitStandHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            transitRackHits += checkRackHits(agf, racks, rackId, bayCenterX);
            if (agf.statusMode === "transit") {
              for (let ci = 0; ci < hullCorners.length; ci++) {
                const [lx, ly] = hullCorners[ci];
                const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
                const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
                for (let si = 0; si < stands.length; si++) {
                  const st = stands[si];
                  const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
                  const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
                  if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) transitStandHits++;
                }
              }
            }
          },
          agf.enqueue({ type: "placeInRack", rackId, bay: 4, tier: 1, side, slotInBay: 0 }),
          maxSteps,
        );
        assert.equal(transitRackHits, 0, `${label} dt=${dt.toFixed(4)} had ${transitRackHits} transit rack hits`);
        assert.equal(transitStandHits, 0, `${label} dt=${dt.toFixed(4)} had ${transitStandHits} transit stand hits`);
        assert.equal(agf.carriedWcid, 0, `${label} dt=${dt.toFixed(4)} unloaded cargo`);
      } finally {
        mgr.dispose();
      }
    }

    // 18c. east_far -> C3_20ft_hPI2 at [ox+6, oy+32, 0], h=PI/2 (long Zone D route validation budget)
    {
      const rig = makeRig({ withVehicles: false });
      const targetCx = ox + 6;
      const targetCy = oy + 32;
      const ch = Math.PI / 2;
      const cosH = Math.cos(ch);
      const sinH = Math.sin(ch);
      const containers = new Map();
      containers.set(0x9502, {
        guid: 0x9502,
        wcid: 4000020,
        kind: 10,
        heading: ch,
        rawPos: [targetCx, targetCy, 0],
        currentDoorProgress: 1.0,
        slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: targetCx, y: targetCy, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("agf-east-c3", { pos: [ox + 26, oy - 35, 0], heading: 0 });
        const racks = [...mgr.racks.values()];
        const chargers = [...mgr.chargers.values()];
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            if (agf.statusMode !== "transit") return;
            hits += checkRackHits(agf, racks);
            for (let ci = 0; ci < hullCorners.length; ci++) {
              const [lx, ly] = hullCorners[ci];
              const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
              const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
              for (let chi = 0; chi < chargers.length; chi++) {
                const c = chargers[chi];
                if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
              }
              const dx = wx - targetCx;
              const dy = wy - targetCy;
              const clx = dx * cosH - dy * sinH;
              const cly = dx * sinH + dy * cosH;
              if (Math.abs(clx) < 1.219 && Math.abs(cly) < 3.029) {
                if (!(Math.abs(clx) < 1.176 && cly < 2.949)) hits++;
              }
            }
          },
          agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9502, slotIndex: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `east_far->C3_hPI2 dt=${dt.toFixed(4)} had ${hits} transit rack/charger/container hits`);
        assert.equal(agf.carriedWcid, 4000012, `east_far->C3_hPI2 dt=${dt.toFixed(4)} picked 4000012`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 19. Regression: Transfer Stand Clearances, East-of-Stand Entry, S1->S6 driveTo, & C1->C2 Slot 0 Load
// ---------------------------------------------------------------------------
check("19. regression: between_chargers -> R1..R6 & C3, S1/S6 departures & east_of_S1 -> R1..R6, S1->S6 driveTo, and C1->C2 slot 0 load maintain 0 hull hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const checkAllHits = (agf, mgr, containersMap, targetRackId = null, bayCenterX = NaN) => {
    if (agf.statusMode !== "transit") return 0;
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const r = racks[ri];
        const b = r.worldBounds;
        if (!b || !(wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY)) continue;
        const isTargetBay = targetRackId && r.id === targetRackId && Number.isFinite(bayCenterX) && Math.abs(wx - bayCenterX) <= 1.50;
        if (!isTargetBay) hits++;
      }
      for (let si = 0; si < stands.length; si++) {
        const st = stands[si];
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (let chi = 0; chi < chargers.length; chi++) {
        const c = chargers[chi];
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
      if (containersMap) {
        for (const ce of containersMap.values()) {
          const p = ce.rawPos;
          const ch = ce.heading || 0;
          const cosH = Math.cos(ch);
          const sinH = Math.sin(ch);
          const dx = wx - p[0];
          const dy = wy - p[1];
          const clx = dx * cosH - dy * sinH;
          const cly = dx * sinH + dy * cosH;
          const intHalfL = ce.kind === 10 ? 2.949 : 6.016;
          const extHalfL = ce.kind === 10 ? 3.029 : 6.096;
          if (Math.abs(clx) < 1.219 && Math.abs(cly) < extHalfL) {
            if (!(Math.abs(clx) < 1.176 && cly < intHalfL)) hits++;
          }
        }
      }
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;

    // 19a. between_chargers -> R1..R6 & C3_20ft_hPI2
    for (const [rackId, bay, side] of [
      ["R1", 0, 0],
      ["R2_3", 4, 0],
      ["R2_3", 4, 1],
      ["R4_5", 4, 0],
      ["R4_5", 4, 1],
      ["R6", 7, 0],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-bc-${rackId}-${side}`, { pos: [ox - 4, oy - 38, 0], heading: 0, carriedWcid: 4000012 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkAllHits(agf, mgr, null, rackId, bayCenterX);
          },
          agf.enqueue({ type: "placeInRack", rackId, bay, tier: 1, side, slotInBay: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `between_chargers->${rackId}_s${side}_b${bay} dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.equal(agf.carriedWcid, 0);
      } finally {
        mgr.dispose();
      }
    }

    {
      const rig = makeRig({ withVehicles: false });
      const cMap = new Map();
      cMap.set(0x9601, {
        guid: 0x9601, wcid: 4000020, kind: 10, heading: Math.PI / 2, rawPos: [ox + 6, oy + 32, 0],
        currentDoorProgress: 1.0, slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: ox + 6, y: oy + 32, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("agf-bc-c3", { pos: [ox - 4, oy - 38, 0], heading: 0 });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkAllHits(agf, mgr, cMap);
          },
          agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9601, slotIndex: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `between_chargers->C3 dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.equal(agf.carriedWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }

    // 19b. at_S1_approach, at_S6_approach, east_of_S1 -> R1..R6
    for (const [label, startPos, startH, rackId, bay, side] of [
      ["at_S1->R1_b0", [ox + 12.05, oy + 4.2, 0], Math.PI / 2, "R1", 0, 0],
      ["at_S1->R4_5_s1_b4", [ox + 12.05, oy + 4.2, 0], Math.PI / 2, "R4_5", 4, 1],
      ["at_S6->R4_5_s0_b0", [ox + 12.05, oy - 10.2, 0], Math.PI / 2, "R4_5", 0, 0],
      ["at_S6->R6_b4", [ox + 12.05, oy - 10.2, 0], Math.PI / 2, "R6", 4, 0],
      ["at_S6->R6_b7", [ox + 12.05, oy - 10.2, 0], Math.PI / 2, "R6", 7, 0],
      ["east_of_S1->R2_3_s0_b0", [ox + 20, oy + 4, 0], -Math.PI / 2, "R2_3", 0, 0],
      ["east_of_S1->R4_5_s1_b4", [ox + 20, oy + 4, 0], -Math.PI / 2, "R4_5", 4, 1],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${label}`, { pos: startPos, heading: startH, carriedWcid: 4000012 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkAllHits(agf, mgr, null, rackId, bayCenterX);
          },
          agf.enqueue({ type: "placeInRack", rackId, bay, tier: 1, side, slotInBay: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `${label} dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.equal(agf.carriedWcid, 0);
      } finally {
        mgr.dispose();
      }
    }

    // 19c. S1 -> S6 driveTo
    {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("agf-s1-s6", { pos: [ox + 12.05, oy + 4.2, 0], heading: Math.PI / 2 });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkAllHits(agf, mgr);
          },
          agf.enqueue({ type: "driveTo", waypoints: [[ox + 12.05, oy - 10.2]] }),
          maxSteps,
        );
        assert.equal(hits, 0, `S1->S6 driveTo dt=${dt.toFixed(4)} had ${hits} hull hits`);
      } finally {
        mgr.dispose();
      }
    }

    // 19d. pickFromContainer(C1, h=PI) -> loadIntoContainer(C2, slot 0)
    {
      const rig = makeRig({ withVehicles: false });
      const cMap = new Map();
      cMap.set(0x9602, {
        guid: 0x9602, wcid: 4000022, kind: 12, heading: Math.PI, rawPos: [ox - 18, oy + 32, 0],
        currentDoorProgress: 1.0, slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: ox - 18, y: oy + 32, z: 0 } }, syncSlots() {} },
      });
      cMap.set(0x9603, {
        guid: 0x9603, wcid: 4000022, kind: 12, heading: 0, rawPos: [ox - 24, oy + 32.5, 0],
        currentDoorProgress: 1.0, slots: [],
        model: { root: { position: { x: ox - 24, y: oy + 32.5, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf("agf-c1-c2-s0", { pos: [ox - 18, oy + 20, 0], heading: 0 });
        const chained = (async () => {
          await agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9602, slotIndex: 0 });
          await agf.enqueue({ type: "loadIntoContainer", containerGuid: 0x9603, slotIndex: 0 });
        })();
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkAllHits(agf, mgr, cMap);
          },
          chained,
          maxSteps * 2,
        );
        assert.equal(hits, 0, `C1->C2 slot 0 dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.equal(agf.carriedWcid, 0);
        assert.equal(cMap.get(0x9603).slots.find((s) => s.slotIndex === 0)?.cargoWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 20. Regression: Zone D Transfer Stand (S7..S18) Buffer Routing via zoneDBufY
// ---------------------------------------------------------------------------
check("20. regression: charger gaps (chgap_-12/4/8/12) -> S7/S11/S12/S16, S1/S6 -> S11/S18, and S7<->S18 route via zoneDBufY with 0 non-target stand/rack/charger 6-corner hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const checkStandRouteHits = (agf, mgr, targetStandId) => {
    if (agf.statusMode !== "transit") return 0;
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const b = racks[ri].worldBounds;
        if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
      }
      for (let si = 0; si < stands.length; si++) {
        const st = stands[si];
        if (st.id === targetStandId) continue;
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (let chi = 0; chi < chargers.length; chi++) {
        const c = chargers[chi];
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
    }
    return hits;
  };

  const cases = [];
  for (const dx of [-12, 4, 8, 12]) {
    for (const stId of ["S7", "S11", "S12", "S16"]) {
      cases.push([`chgap_${dx}->${stId}`, [ox + dx, oy - 38, 0], 0, stId]);
    }
  }
  cases.push(
    ["S1->S18", [ox + 12.05, oy + 4.2, 0], Math.PI / 2, "S18"],
    ["S6->S11", [ox + 12.05, oy - 10.2, 0], Math.PI / 2, "S11"],
    ["S6->S18", [ox + 12.05, oy - 10.2, 0], Math.PI / 2, "S18"],
    ["S7->S18", [ox - 16.5, oy - 22.05, 0], Math.PI, "S18"],
    ["S18->S7", [ox + 16.5, oy - 22.05, 0], Math.PI, "S7"],
  );

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, startPos, startH, standId] of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-${label}`, { pos: startPos, heading: startH, carriedWcid: 4000012 });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += checkStandRouteHits(agf, mgr, standId);
          },
          agf.enqueue({ type: "placeOnStand", standId }),
          maxSteps,
        );
        assert.equal(hits, 0, `${label} dt=${dt.toFixed(4)} had ${hits} non-target stand/rack/charger hull hits`);
        assert.equal(agf.carriedWcid, 0, `${label} dt=${dt.toFixed(4)} did not drop cargo`);
        assert.equal(mgr.stands.get(standId).carriedWcid, 4000012, `${label} dt=${dt.toFixed(4)} stand cargo mismatch`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 21. Regression: driveTo findPath, rackDepartInfo, S11/S12(buf0)->R6, & C1 doorApproachWp alignment
// ---------------------------------------------------------------------------
check("21. regression: Bug 1 driveTo, Bug 2 rackDepartInfo, Bug 3 S11/S12(buf0)->R6, & Bug 4 via_rack->C1 maintain 0 6-corner hits & <5 deg docking yaw at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  const countHullHits = (agf, mgr, { containersMap = null, targetRackId = null, bayCenterX = NaN, targetStandId = null, transitOnly = false } = {}) => {
    if (transitOnly && agf.statusMode !== "transit") return 0;
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const r = racks[ri];
        const b = r.worldBounds;
        if (!b || !(wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY)) continue;
        const isTargetBay = targetRackId && r.id === targetRackId && Number.isFinite(bayCenterX) && Math.abs(wx - bayCenterX) <= 1.50;
        if (!isTargetBay) hits++;
      }
      for (let si = 0; si < stands.length; si++) {
        const st = stands[si];
        if (targetStandId && st.id === targetStandId) continue;
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (let chi = 0; chi < chargers.length; chi++) {
        const c = chargers[chi];
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
      if (containersMap) {
        for (const ce of containersMap.values()) {
          const p = ce.rawPos;
          const ch = ce.heading || 0;
          const cosH = Math.cos(ch);
          const sinH = Math.sin(ch);
          const dx = wx - p[0];
          const dy = wy - p[1];
          const clx = dx * cosH - dy * sinH;
          const cly = dx * sinH + dy * cosH;
          const intHalfL = ce.kind === 10 ? 2.949 : 6.016;
          const extHalfL = ce.kind === 10 ? 3.029 : 6.096;
          if (Math.abs(clx) < 1.219 && Math.abs(cly) < extHalfL) {
            if (!(Math.abs(clx) < 1.176 && cly < intHalfL)) hits++;
          }
        }
      }
    }
    return hits;
  };

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;

    // 21a. Bug 1: driveTo via findPath (between_chargers/east_far/south_of_chargers -> L1/L2/C1/C2)
    for (const [label, startPos, targetPos] of [
      ["between_chargers->L1", [ox - 4, oy - 38, 0], [ox - 46, oy - 12.05]],
      ["between_chargers->L2", [ox - 4, oy - 38, 0], [ox - 38, oy - 12.05]],
      ["east_far->L1", [ox + 26, oy - 35, 0], [ox - 46, oy - 12.05]],
      ["east_far->L2", [ox + 26, oy - 35, 0], [ox - 38, oy - 12.05]],
      ["east_far->C2", [ox + 26, oy - 35, 0], [ox - 24, oy + 24.5]],
      ["south_of_chargers->C1", [ox, oy - 42, 0], [ox - 40, oy + 24.5]],
      ["south_of_chargers->C2", [ox, oy - 42, 0], [ox - 24, oy + 24.5]],
      ["south_of_chargers->L1", [ox, oy - 42, 0], [ox - 46, oy - 12.05]],
      ["south_of_chargers->L2", [ox, oy - 42, 0], [ox - 38, oy - 12.05]],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-21a-${label}`, { pos: startPos, heading: 0 });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += countHullHits(agf, mgr);
          },
          agf.enqueue({ type: "driveTo", waypoints: [targetPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `21a ${label} dt=${dt.toFixed(4)} had ${hits} hull hits`);
      } finally {
        mgr.dispose();
      }
    }

    // 21b. Bug 2: rackDepartInfo -> Zone D stands (S7/S11/S16/S18) and via_R6 -> R1..R6
    for (const [label, startPos, startH] of [
      ["at_R1_b0", [ox - 14.55, oy + 3.35, 0], 0],
      ["at_R1_b7", [ox + 5.05, oy + 3.35, 0], 0],
      ["at_R2_3_s1_b0", [ox - 14.55, oy - 2.65, 0], 0],
      ["at_R4_5_s0_b4", [ox - 3.35, oy - 3.35, 0], Math.PI],
      ["at_R6_b0", [ox + 5.05, oy - 9.35, 0], Math.PI],
    ]) {
      for (const standId of ["S7", "S11", "S16", "S18"]) {
        const rig = makeRig({ withVehicles: false });
        const mgr = createWarehouseManager({
          THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
          palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
        });
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        try {
          const agf = mgr.spawnAgf(`agf-21b-${label}-${standId}`, { pos: startPos, heading: startH, carriedWcid: 4000012 });
          let hits = 0;
          await stepUntilSettled(
            () => {
              mgr.tick(dt, [ox, oy, 12]);
              hits += countHullHits(agf, mgr, { targetStandId: standId, transitOnly: true });
            },
            agf.enqueue({ type: "placeOnStand", standId }),
            maxSteps,
          );
          assert.equal(hits, 0, `21b ${label}->${standId} dt=${dt.toFixed(4)} had ${hits} hull hits`);
          assert.equal(agf.carriedWcid, 0);
        } finally {
          mgr.dispose();
        }
      }
    }
    for (const [rackId, bay, side] of [
      ["R1", 0, 0], ["R2_3", 4, 0], ["R2_3", 4, 1], ["R4_5", 4, 0], ["R4_5", 4, 1], ["R6", 7, 0],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-21b-viaR6-${rackId}-s${side}`, { pos: [ox + 5.05, oy - 9.35, 0], heading: Math.PI, carriedWcid: 4000012 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += countHullHits(agf, mgr, { targetRackId: rackId, bayCenterX, transitOnly: true });
          },
          agf.enqueue({ type: "placeInRack", rackId, bay, tier: 1, side, slotInBay: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `21b via_R6->${rackId}_s${side}_b${bay} dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.equal(agf.carriedWcid, 0);
      } finally {
        mgr.dispose();
      }
    }

    // 21c. Bug 3: S11(buf0) & S12(buf0) -> R1/R2_3/R4_5/R6
    for (const [sLabel, startX] of [["S11_buf0", ox - 4.5], ["S12_buf0", ox - 1.5]]) {
      for (const [rackId, bay, side] of [
        ["R1", 0, 0], ["R2_3", 4, 0], ["R4_5", 4, 0], ["R6", 0, 0], ["R6", 7, 0],
      ]) {
        const rig = makeRig({ withVehicles: false });
        const mgr = createWarehouseManager({
          THREE, liveScene3d: rig.live, containers: new Map(), deployables: new Map(),
          palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
        });
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        try {
          const agf = mgr.spawnAgf(`agf-21c-${sLabel}-${rackId}-b${bay}`, { pos: [startX, oy - 18.5, 0], heading: 0, carriedWcid: 4000012 });
          const targetRow = mgr.racks.get(rackId);
          const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
          const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
          let hits = 0;
          await stepUntilSettled(
            () => {
              mgr.tick(dt, [ox, oy, 12]);
              hits += countHullHits(agf, mgr, { targetRackId: rackId, bayCenterX, transitOnly: true });
            },
            agf.enqueue({ type: "placeInRack", rackId, bay, tier: 1, side, slotInBay: 0 }),
            maxSteps,
          );
          assert.equal(hits, 0, `21c ${sLabel}->${rackId}_b${bay} dt=${dt.toFixed(4)} had ${hits} hull hits`);
          assert.equal(agf.carriedWcid, 0);
        } finally {
          mgr.dispose();
        }
      }
    }

    // 21d. Bug 4: via_rack_R1/R2_3/R4_5 (tier 1 & 3) -> pickFromContainer(C1 at [ox-40, oy+32.5], slot 0)
    for (const [rackId, bay, side, tier] of [
      ["R1", 0, 0, 1], ["R1", 0, 0, 3],
      ["R2_3", 0, 1, 1], ["R2_3", 0, 1, 3],
      ["R4_5", 0, 1, 1], ["R4_5", 0, 1, 3],
    ]) {
      const rig = makeRig({ withVehicles: false });
      const cMap = new Map();
      cMap.set(0x9101, {
        guid: 0x9101,
        wcid: 4000022,
        kind: 12,
        heading: 0,
        rawPos: [ox - 40, oy + 32.5, 0],
        currentDoorProgress: 1.0,
        slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
        model: { root: { position: { x: ox - 40, y: oy + 32.5, z: 0 } }, syncSlots() {} },
      });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap, deployables: new Map(),
        palletJacks: new Map(), trailers: new Map(), logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-21d-${rackId}-t${tier}`, { pos: [ox - 4, oy - 38, 0], heading: 0, carriedWcid: 4000014 });
        const targetRow = mgr.racks.get(rackId);
        const bayCenterLocalX = RACK_SPECS.uprightWidthM + bay * RACK_SPECS.bayPitchM + RACK_SPECS.baySpanM * 0.5;
        const [bayCenterX] = localToWorld2D(bayCenterLocalX, 0, targetRow.pos[0], targetRow.pos[1], targetRow.heading);
        let hits = 0;
        let maxDockYaw = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += countHullHits(agf, mgr, { targetRackId: rackId, bayCenterX, transitOnly: true });
          },
          agf.enqueue({ type: "placeInRack", rackId, bay, tier, side, slotInBay: 0 }),
          maxSteps,
        );
        await stepUntilSettled(
          () => {
            mgr.tick(dt, [ox, oy, 12]);
            hits += countHullHits(agf, mgr, { containersMap: cMap });
            if (agf.statusMode === "docking") {
              maxDockYaw = Math.max(maxDockYaw, Math.abs(wrapPi(agf.heading - 0)));
            }
          },
          agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9101, slotIndex: 0 }),
          maxSteps,
        );
        assert.equal(hits, 0, `21d via_${rackId}_s${side}_b${bay}_t${tier}->C1 dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.ok(maxDockYaw <= 0.087, `21d via_${rackId}_t${tier}->C1 dt=${dt.toFixed(4)} docking yaw ${maxDockYaw.toFixed(4)} > 0.087`);
        assert.equal(agf.carriedWcid, 4000012);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 22. Regression: DriveTo_WithContainers (Zone A pad_approach with default C1/C2/C3 spawned)
// ---------------------------------------------------------------------------
check("22. regression: DriveTo_WithContainers routes Zone A pad_C1/C2/C3_approach via crossAisleY with 0 6-corner hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const makeDefaultContainers = () => {
    const cMap = new Map();
    cMap.set(0x9201, {
      guid: 0x9201,
      wcid: 4000021,
      kind: 11,
      heading: 0,
      rawPos: [ox - 40, oy + 32.5, 0],
      currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
      model: { root: { position: { x: ox - 40, y: oy + 32.5, z: 0 } }, syncSlots() {} },
    });
    cMap.set(0x9202, {
      guid: 0x9202,
      wcid: 4000022,
      kind: 12,
      heading: 0,
      rawPos: [ox - 24, oy + 32.5, 0],
      currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000013 }],
      model: { root: { position: { x: ox - 24, y: oy + 32.5, z: 0 } }, syncSlots() {} },
    });
    cMap.set(0x9203, {
      guid: 0x9203,
      wcid: 4000020,
      kind: 10,
      heading: 0,
      rawPos: [ox - 8, oy + 29.43, 0],
      currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000014 }],
      model: { root: { position: { x: ox - 8, y: oy + 29.43, z: 0 } }, syncSlots() {} },
    });
    return cMap;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const b = racks[ri].worldBounds;
        if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
      }
      for (let si = 0; si < stands.length; si++) {
        const st = stands[si];
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (let chi = 0; chi < chargers.length; chi++) {
        const c = chargers[chi];
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const ch = ce.heading || 0;
        const cosH = Math.cos(ch);
        const sinH = Math.sin(ch);
        const dx = wx - p[0];
        const dy = wy - p[1];
        const clx = dx * cosH - dy * sinH;
        const cly = dx * sinH + dy * cosH;
        const intHalfL = ce.kind === 10 ? 2.949 : 6.016;
        const extHalfL = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(clx) < 1.219 && Math.abs(cly) < extHalfL) {
          if (!(ce.currentDoorProgress >= 0.5 && Math.abs(clx) < 1.176 && cly < intHalfL)) hits++;
        }
      }
    }
    return hits;
  };

  const starts = [
    ["between_chargers", [ox - 4, oy - 38, 0], 0],
    ["chgap_-12", [ox - 12, oy - 38, 0], 0],
    ["chgap_+12", [ox + 12, oy - 38, 0], 0],
    ["east_far", [ox + 26, oy - 35, 0], 0],
    ["at_S1", [ox + 12.05, oy + 4.2, 0], Math.PI * 0.5],
    ["at_S6", [ox + 12.05, oy - 10.2, 0], Math.PI * 0.5],
    ["at_R1_b0", [ox - 14.55, oy + 3.35, 0], 0],
    ["near_C2_east_y25", [ox - 21, oy + 25, 0], 0],
    ["near_C2_east_y28", [ox - 21, oy + 28, 0], 0],
  ];
  const pads = [
    ["pad_C1_approach", [ox - 40, oy + 24.5]],
    ["pad_C2_approach", [ox - 24, oy + 24.5]],
    ["pad_C3_approach", [ox - 8, oy + 24.5]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    for (const [sLabel, sPos, sHeading] of starts) {
      for (const [pLabel, pPos] of pads) {
        const rig = makeRig({ withVehicles: false });
        const cMap = makeDefaultContainers();
        const mgr = createWarehouseManager({
          THREE,
          liveScene3d: rig.live,
          containers: cMap,
          deployables: new Map(),
          palletJacks: new Map(),
          trailers: new Map(),
          logisticsAudio: null,
          sh: () => rig.sh,
        });
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        try {
          const agf = mgr.spawnAgf(`agf-22-${sLabel}-${pLabel}`, { pos: sPos, heading: sHeading });
          let hits = 0;
          await stepUntilSettled(
            () => {
              mgr.tick(dt, [ox, oy, 12]);
              hits += countHullHits(agf, mgr, cMap);
            },
            agf.enqueue({ type: "driveTo", waypoints: [pPos] }),
            maxSteps,
          );
          assert.equal(hits, 0, `22 ${sLabel}->${pLabel} dt=${dt.toFixed(4)} had ${hits} hull hits`);
          assert.ok(
            Math.hypot(agf.x - pPos[0], agf.y - pPos[1]) <= 0.12,
            `22 ${sLabel}->${pLabel} final pose mismatch`,
          );
        } finally {
          mgr.dispose();
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 23. Regression: North/Zone A/B/C -> Zone D driveTo & ch0_slot0 -> driveTo_behind
// ---------------------------------------------------------------------------
check("23. regression: North/Zone A/B/C -> Zone D driveTo (with C1..C3 spawned) & ch0_slot0 -> driveTo_behind maintain 0 6-corner hits at dt=1/60 and 1/30", async () => {
  const ox = NE_FLATLAND_SITE.origin[0];
  const oy = NE_FLATLAND_SITE.origin[1];
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = (CHARGER_SPECS.widthM ?? 1.24) * 0.5;
  const chHalfD = (CHARGER_SPECS.depthM ?? 0.90) * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const makeDefaultContainers = () => {
    const cMap = new Map();
    cMap.set(0x9201, {
      guid: 0x9201, wcid: 4000021, kind: 11, heading: 0,
      rawPos: [ox - 40, oy + 32.5, 0], currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
      model: { root: { position: { x: ox - 40, y: oy + 32.5, z: 0 } }, syncSlots() {} },
    });
    cMap.set(0x9202, {
      guid: 0x9202, wcid: 4000022, kind: 12, heading: 0,
      rawPos: [ox - 24, oy + 32.5, 0], currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000013 }],
      model: { root: { position: { x: ox - 24, y: oy + 32.5, z: 0 } }, syncSlots() {} },
    });
    cMap.set(0x9203, {
      guid: 0x9203, wcid: 4000020, kind: 10, heading: 0,
      rawPos: [ox - 8, oy + 29.43, 0], currentDoorProgress: 0.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000014 }],
      model: { root: { position: { x: ox - 8, y: oy + 29.43, z: 0 } }, syncSlots() {} },
    });
    return cMap;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (let ri = 0; ri < racks.length; ri++) {
        const b = racks[ri].worldBounds;
        if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
      }
      for (let si = 0; si < stands.length; si++) {
        const st = stands[si];
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (let chi = 0; chi < chargers.length; chi++) {
        const c = chargers[chi];
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const ch = ce.heading || 0;
        const cosH = Math.cos(ch);
        const sinH = Math.sin(ch);
        const dx = wx - p[0];
        const dy = wy - p[1];
        const clx = dx * cosH - dy * sinH;
        const cly = dx * sinH + dy * cosH;
        const intHalfL = ce.kind === 10 ? 2.949 : 6.016;
        const extHalfL = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(clx) < 1.219 && Math.abs(cly) < extHalfL) {
          if (!(ce.currentDoorProgress >= 0.5 && Math.abs(clx) < 1.176 && cly < intHalfL)) hits++;
        }
      }
    }
    return hits;
  };

  const starts = [
    ["pad_C1_h0", [ox - 40, oy + 24.5, 0], 0],
    ["pad_C2_h0", [ox - 24, oy + 24.5, 0], 0],
    ["pad_C3_h0", [ox - 8, oy + 24.5, 0], 0],
    ["C2_pad", [ox - 24, oy + 20, 0], 0],
    ["north_of_racks", [ox, oy + 16, 0], Math.PI],
    ["at_S1", [ox + 12.05, oy + 4.2, 0], Math.PI * 0.5],
    ["at_S6", [ox + 12.05, oy - 10.2, 0], Math.PI * 0.5],
    ["at_R1_b0", [ox - 14.55, oy + 3.35, 0], 0],
    ["L1_north", [ox - 46, oy - 10.5, 0], 0],
  ];
  const targets = [
    ["between_chargers", [ox - 4, oy - 38]],
    ["chgap_-12", [ox - 12, oy - 38]],
    ["chgap_+12", [ox + 12, oy - 38]],
    ["south_of_chargers", [ox, oy - 42]],
    ["CH1_dock", [ox - 14, oy - 34.5]],
    ["CH8_dock", [ox + 14, oy - 34.5]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    for (const [sLabel, sPos, sHeading] of starts) {
      for (const [tLabel, tPos] of targets) {
        const rig = makeRig({ withVehicles: false });
        const cMap = makeDefaultContainers();
        const mgr = createWarehouseManager({
          THREE,
          liveScene3d: rig.live,
          containers: cMap,
          deployables: new Map(),
          palletJacks: new Map(),
          trailers: new Map(),
          logisticsAudio: null,
          sh: () => rig.sh,
        });
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        try {
          const agf = mgr.spawnAgf(`agf-23-${sLabel}-${tLabel}`, { pos: sPos, heading: sHeading });
          let hits = 0;
          await stepUntilSettled(
            () => {
              mgr.tick(dt, [ox, oy, 12]);
              hits += countHullHits(agf, mgr, cMap);
            },
            agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
            maxSteps,
          );
          assert.equal(hits, 0, `23 ${sLabel}->${tLabel} dt=${dt.toFixed(4)} had ${hits} hull hits`);
          assert.ok(
            Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.12,
            `23 ${sLabel}->${tLabel} final pose mismatch`,
          );
        } finally {
          mgr.dispose();
        }
      }
    }

    // ch0_slot0 -> driveTo_behind
    const rig = makeRig({ withVehicles: false });
    const cMap = new Map();
    cMap.set(0x9701, {
      guid: 0x9701,
      wcid: 4000022,
      kind: 12,
      heading: 0,
      rawPos: [ox - 18, oy + 32, 0],
      currentDoorProgress: 1.0,
      slots: [{ slotIndex: 0, palletSize: "full", cargoWcid: 4000012 }],
      model: { root: { position: { x: ox - 18, y: oy + 32, z: 0 } }, syncSlots() {} },
    });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: cMap,
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    try {
      const agf = mgr.spawnAgf("agf-23-ch0-behind", { pos: [ox - 18, oy + 18, 0], heading: 0 });
      let hits = 0;
      await stepUntilSettled(
        () => {
          mgr.tick(dt, [ox, oy, 12]);
          hits += countHullHits(agf, mgr, cMap);
        },
        agf.enqueue({ type: "pickFromContainer", containerGuid: 0x9701, slotIndex: 0 }),
        maxSteps,
      );
      assert.equal(hits, 0, `23 ch0_slot0 pick dt=${dt.toFixed(4)} had ${hits} hull hits`);
      assert.equal(agf.carriedWcid, 4000012, `23 ch0_slot0 picked 4000012`);
      await stepUntilSettled(
        () => {
          mgr.tick(dt, [ox, oy, 12]);
          hits += countHullHits(agf, mgr, cMap);
        },
        agf.enqueue({ type: "driveTo", waypoints: [[ox - 18, oy + 41.0]] }),
        maxSteps,
      );
      assert.equal(hits, 0, `23 ch0_slot0->driveTo_behind dt=${dt.toFixed(4)} had ${hits} hull hits`);
      assert.ok(
        Math.hypot(agf.x - (ox - 18), agf.y - (oy + 41.0)) <= 0.12,
        `23 ch0_slot0->driveTo_behind final pose mismatch`,
      );
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 24. Regression: Charger South-Edge (oy - 39.4) Corridor & Alignment
// ---------------------------------------------------------------------------
check("24. regression: Zone D & North starts -> CH1/CH4/CH7 oy-39.4 edge route & chained departures via south corridor with 0 6-corner hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;

  const countStaticHits = (agf, mgr) => {
    let hits = 0;
    const racks = [...mgr.racks.values()];
    const stands = [...mgr.stands.values()];
    const chargers = [...mgr.chargers.values()];
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const wx = agf.x + lx * Math.cos(agf.heading) + ly * Math.sin(agf.heading);
      const wy = agf.y - lx * Math.sin(agf.heading) + ly * Math.cos(agf.heading);
      for (const r of racks) {
        const b = r.worldBounds;
        if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
      }
      for (const st of stands) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
      }
      for (const c of chargers) {
        if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
      }
    }
    return hits;
  };

  const cases = [
    ["zoneD_east->CH1", [ox + 20, oy - 29, 0], Math.PI, [ox - 14, oy - 39.4]],
    ["pad_C1_h0->CH4", [ox - 40, oy + 24.5, 0], 0, [ox - 2, oy - 39.4]],
    ["north_of_racks->CH4", [ox, oy + 16, 0], Math.PI, [ox - 2, oy - 39.4]],
    ["at_S1->CH4", [ox + 12.05, oy + 4.2, 0], Math.PI * 0.5, [ox - 2, oy - 39.4]],
    ["L1_north->CH4", [ox - 46, oy - 10.5, 0], 0, [ox - 2, oy - 39.4]],
    ["north_of_racks->CH7", [ox, oy + 16, 0], Math.PI, [ox + 10, oy - 39.4]],
    ["at_S1->CH7", [ox + 12.05, oy + 4.2, 0], Math.PI * 0.5, [ox + 10, oy - 39.4]],
    ["C2_pad->CH4", [ox - 24, oy + 20, 0], 0, [ox - 2, oy - 39.4]],
    ["north_of_racks_y12->CH4", [ox, oy + 12, 0], 0, [ox - 2, oy - 39.4]],
    ["zoneD_west_y16->CH4", [ox - 12, oy - 16, 0], 0, [ox - 2, oy - 39.4]],
    ["north_east->CH4", [ox + 18, oy + 10, 0], 0, [ox - 2, oy - 39.4]],
    ["north_of_racks_y12->CH7", [ox, oy + 12, 0], 0, [ox + 10, oy - 39.4]],
    ["zoneD_west_y16->CH7", [ox - 12, oy - 16, 0], 0, [ox + 10, oy - 39.4]],
    ["CH2_y40.5_h+PI2->pad_C1", [ox - 10, oy - 40.5, 0], Math.PI * 0.5, [ox - 40, oy + 24.5]],
    ["CH4_y40.5_hPI->pad_C1", [ox - 2, oy - 40.5, 0], Math.PI, [ox - 40, oy + 24.5]],
    ["CH3_y40.5_h-PI2->zoneD_east", [ox - 6, oy - 40.5, 0], -Math.PI * 0.5, [ox + 20, oy - 29]],
    ["CH6_y40.5_h0->CH8_edge", [ox + 6, oy - 40.5, 0], 0, [ox + 14, oy - 39.4]],
    ["CH5_y40.7_h+PI2->CH1_edge", [ox + 2, oy - 40.7, 0], Math.PI * 0.5, [ox - 14, oy - 39.4]],
    ["CH7_y40.7_hPI->L1_north", [ox + 10, oy - 40.7, 0], Math.PI, [ox - 46, oy - 10.5]],
    ["CH8_y40.7_h0->north", [ox + 14, oy - 40.7, 0], 0, [ox, oy + 16]],
  ];

  const chainedCases = [
    ["pad_C1_h0->CH1->pad_C1_approach", [ox - 40, oy + 24.5, 0], 0, [[ox - 14, oy - 39.4], [ox - 40, oy + 24.5]]],
    ["zoneD_east->CH1->L1_north", [ox + 20, oy - 29, 0], Math.PI, [[ox - 14, oy - 39.4], [ox - 46, oy - 10.5]]],
    ["from_CH1_h1.57->pad_C1_approach", [ox - 14, oy - 39.4, 0], Math.PI * 0.5, [[ox - 40, oy + 24.5]]],
    ["from_CH1_h1.57->L1_north", [ox - 14, oy - 39.4, 0], Math.PI * 0.5, [[ox - 46, oy - 10.5]]],
    ["from_CH7_h1.57->CH2", [ox + 10, oy - 39.4, 0], Math.PI * 0.5, [[ox - 10, oy - 39.4]]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-24-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countStaticHits(agf, mgr);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `24 ${label} dt=${dt.toFixed(4)} had ${hits} static hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `24 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }
    for (const [label, sPos, sH, legs] of chainedCases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-24c-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        for (const tPos of legs) {
          await stepUntilSettled(
            () => {
              mgr.tick(dt);
              hits += countStaticHits(agf, mgr);
            },
            agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
            maxSteps,
          );
          assert.ok(
            Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
            `24 ${label} dt=${dt.toFixed(4)} leg pose mismatch`,
          );
        }
        assert.equal(hits, 0, `24 ${label} dt=${dt.toFixed(4)} had ${hits} static hull hits`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 25. Regression: Open-Apron RANDOM_FUZZ i=20 S6 Stand-Corner Clearance
// ---------------------------------------------------------------------------
check("25. regression: open-apron driveTo [-44.432,-16.877,-2.762] -> [22.37,1.705] clears S6 counterweight at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    try {
      const agf = mgr.spawnAgf("agf-25-fuzz20", { pos: [ox - 44.432, oy - 16.877, 0], heading: -2.762 });
      let hits = 0;
      await stepUntilSettled(
        () => {
          mgr.tick(dt);
          for (let ci = 0; ci < hullCorners.length; ci++) {
            const [lx, ly] = hullCorners[ci];
            const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
            for (const r of mgr.racks.values()) {
              const b = r.worldBounds;
              if (b && wx > b.minX && wx < b.maxX && wy > b.minY && wy < b.maxY) hits++;
            }
            for (const st of mgr.stands.values()) {
              const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
              const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
              if (Math.abs(wx - st.pos[0]) < rx && Math.abs(wy - st.pos[1]) < ry) hits++;
            }
            for (const c of mgr.chargers.values()) {
              if (Math.abs(wx - c.pos[0]) < chHalfW && Math.abs(wy - c.pos[1]) < chHalfD) hits++;
            }
          }
        },
        agf.enqueue({ type: "driveTo", waypoints: [[ox + 22.37, oy + 1.705]] }),
        maxSteps,
      );
      assert.equal(hits, 0, `25 fuzz20 dt=${dt.toFixed(4)} had ${hits} static hull hits`);
      assert.ok(
        Math.hypot(agf.x - (ox + 22.37), agf.y - (oy + 1.705)) <= 0.15,
        `25 fuzz20 dt=${dt.toFixed(4)} final pose mismatch`,
      );
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 26. Regression: AMR L1/L2 Lift Table Avoidance & Docking Preservation
// ---------------------------------------------------------------------------
check("26. regression: AMR driveTo avoids L1/L2 (idx 15/22/79 + direct crossings) and preserves L1/L2 placeOnStand/pickFromStand docking", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const countAmrStaticHits = (amr, mgr) => {
    let hits = 0;
    for (let ci = 0; ci < amrHullCorners.length; ci++) {
      const [lx, ly] = amrHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
    }
    return hits;
  };

  const cases = [
    ["idx_15", [ox + 19.060, oy + 9.407, 0], -0.4208, [ox + 22.849, oy - 30.884]],
    ["idx_22", [ox - 8.253, oy - 21.392, 0], 1.7871, [ox - 9.860, oy + 12.186]],
    ["idx_79", [ox - 4.001, oy + 13.743, 0], -2.8886, [ox - 5.019, oy - 40.084]],
    ["cross_L1", [ox - 49.5, oy - 17.5, 0], 0.4, [ox - 42.5, oy - 10.5]],
    ["cross_L2", [ox - 41.5, oy - 17.5, 0], -0.6, [ox - 34.5, oy - 10.5]],
    ["cross_L1_L2", [ox - 49.0, oy - 14.0, 0], Math.PI * 0.5, [ox - 34.0, oy - 14.0]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const amr = mgr.spawnAmr(`amr-26-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countAmrStaticHits(amr, mgr);
          },
          amr.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `26 ${label} dt=${dt.toFixed(4)} had ${hits} AMR 4-corner static hits`);
        assert.ok(
          Math.hypot(amr.x - tPos[0], amr.y - tPos[1]) <= 0.15,
          `26 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }

    // Docking preservation: AMR placeOnStand -> pickFromStand at L1 and L2
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    try {
      const amr = mgr.spawnAmr("amr-26-dock", { pos: [ox - 42.0, oy - 17.5, 0], heading: 0, carriedWcid: 4000012 });
      const l1 = mgr.liftTables.get("L1");
      const l2 = mgr.liftTables.get("L2");
      await stepUntilSettled(() => mgr.tick(dt), l1.raise(), maxSteps);
      await stepUntilSettled(() => mgr.tick(dt), l2.raise(), maxSteps);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "placeOnStand", standId: "L1" }), maxSteps);
      assert.equal(l1.carriedWcid, 4000012, `26 L1 holds cargo dt=${dt.toFixed(4)}`);
      assert.equal(amr.carriedWcid, 0, `26 AMR empty after placeOnStand L1 dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "pickFromStand", standId: "L1" }), maxSteps);
      assert.equal(amr.carriedWcid, 4000012, `26 AMR picked cargo from L1 dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "placeOnStand", standId: "L2" }), maxSteps);
      assert.equal(l2.carriedWcid, 4000012, `26 L2 holds cargo dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "pickFromStand", standId: "L2" }), maxSteps);
      assert.equal(amr.carriedWcid, 4000012, `26 AMR picked cargo from L2 dt=${dt.toFixed(4)}`);
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 27. Regression: Zone C Stand S1, Fuzz (5/27/31/132), Idx (84/109/124), Charger-Gap & Near-Container Pull-Outs
// ---------------------------------------------------------------------------
check("27. regression: Zone C S1, fuzz 5/27/31/132, idx 84/109/124, charger-gap h=PI & near-container pad approaches clear 6-corner hull at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 0x9501, wcid: 4000022, kind: 12, pos: [ox - 40, oy + 32, 0] },
      { guid: 0x9502, wcid: 4000022, kind: 12, pos: [ox - 24, oy + 32, 0] },
      { guid: 0x9503, wcid: 4000020, kind: 10, pos: [ox - 8, oy + 32, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.wcid,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      if (containersMap) {
        for (const ce of containersMap.values()) {
          const p = ce.rawPos;
          const hl = ce.kind === 10 ? 3.029 : 6.096;
          if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
        }
      }
    }
    return hits;
  };

  const cases = [
    ["C2_west_y28->S1_withC", [ox - 28.0, oy + 28.0, 0], -Math.PI * 0.5, [ox + 12.05, oy + 4.2], true],
    ["C2_west_y28->S1_noC", [ox - 28.0, oy + 28.0, 0], -Math.PI * 0.5, [ox + 12.05, oy + 4.2], false],
    ["fuzz_5", [ox - 1.19, oy + 8.46, 0], -2.33, [ox + 14.22, oy - 26.75], true],
    ["fuzz_27", [ox - 8.33, oy - 13.29, 0], -0.80, [ox + 2.76, oy + 22.69], true],
    ["idx_84", [ox - 20.152, oy + 8.325, 0], 2.048, [ox - 16.674, oy - 36.334], true],
    ["idx_109", [ox - 20.762, oy - 38.134, 0], -1.554, [ox + 31.502, oy - 31.387], true],
    ["idx_124", [ox + 42.999, oy + 27.025, 0], -0.119, [ox - 12.787, oy - 17.994], true],
    ["fuzz_31", [ox + 20.56, oy - 14.78, 0], 1.37, [ox + 17.94, oy - 22.32], true],
    ["fuzz_132", [ox + 17.05, oy - 37.00, 0], -1.07, [ox + 6.15, oy - 13.62], true],
    ["chgap_-4_hPI->pad_C1", [ox - 4, oy - 38, 0], Math.PI, [ox - 40, oy + 24.5], true],
    ["chgap_-4_hPI->pad_C2", [ox - 4, oy - 38, 0], Math.PI, [ox - 24, oy + 24.5], true],
    ["chgap_-4_hPI->pad_C3", [ox - 4, oy - 38, 0], Math.PI, [ox - 8, oy + 24.5], true],
    ["chgap_+12_hPI->pad_C1", [ox + 12, oy - 38, 0], Math.PI, [ox - 40, oy + 24.5], true],
    ["chgap_+12_hPI->pad_C2", [ox + 12, oy - 38, 0], Math.PI, [ox - 24, oy + 24.5], true],
    ["chgap_+12_hPI->pad_C3", [ox + 12, oy - 38, 0], Math.PI, [ox - 8, oy + 24.5], true],
    ["near_C1_west_y26_h0->pad_C1", [ox - 43, oy + 26, 0], 0, [ox - 40, oy + 24.5], true],
    ["near_C3_west_y26_h0->pad_C3", [ox - 11, oy + 26, 0], 0, [ox - 8, oy + 24.5], true],
    ["near_C2_east_y28_h-PI2->pad_C1", [ox - 21, oy + 28, 0], -Math.PI * 0.5, [ox - 40, oy + 24.5], true],
    ["near_C2_east_y28_h-PI2->pad_C2", [ox - 21, oy + 28, 0], -Math.PI * 0.5, [ox - 24, oy + 24.5], true],
    ["near_C2_east_y28_h-PI2->pad_C3", [ox - 21, oy + 28, 0], -Math.PI * 0.5, [ox - 8, oy + 24.5], true],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, withC] of cases) {
      const cMap = withC ? makeDefaultContainers() : new Map();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-27-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countHullHits(agf, mgr, cMap);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `27 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `27 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 28. Regression: AGF Fuzz (5/13/15/33/69/129/344 + rand_27/41/127/133/143/150/238) & Narrow Rack Aisle Behind-Target
// ---------------------------------------------------------------------------
check("28. regression: AGF fuzz (Class 1) & narrow rack aisle behind-target (Class 2) clear 6-corner hull at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 0x9601, wcid: 4000022, kind: 12, pos: [ox - 40, oy + 32, 0] },
      { guid: 0x9602, wcid: 4000022, kind: 12, pos: [ox - 24, oy + 32, 0] },
      { guid: 0x9603, wcid: 4000020, kind: 10, pos: [ox - 8, oy + 32, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.wcid,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      if (containersMap) {
        for (const ce of containersMap.values()) {
          const p = ce.rawPos;
          const hl = ce.kind === 10 ? 3.029 : 6.096;
          if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
        }
      }
    }
    return hits;
  };

  const cases = [
    // Exact m4_challenger_18 RANDOM_FUZZ_AGF cases
    ["ch18_fuzz_agf_5", [ox - 21.447, oy + 12.964, 0], -1.703, [ox - 2.938, oy - 24.249], true, 0],
    ["ch18_fuzz_agf_13", [ox + 35.291, oy - 2.992, 0], 2.920, [ox + 9.820, oy - 36.579], true, 0],
    ["ch18_fuzz_agf_15", [ox - 14.805, oy + 11.413, 0], 2.830, [ox - 4.781, oy - 25.350], true, 0],
    ["ch18_fuzz_agf_33", [ox - 3.677, oy - 33.055, 0], 0.168, [ox + 12.151, oy - 1.704], true, 0],
    ["ch18_fuzz_agf_69_withC", [ox + 23.118, oy - 23.745, 0], -2.423, [ox + 3.529, oy - 39.172], true, 0],
    ["ch18_fuzz_agf_69_noC", [ox + 23.118, oy - 23.745, 0], -2.423, [ox + 3.529, oy - 39.172], false, 0],
    ["ch18_fuzz_agf_129", [ox + 10.303, oy - 21.875, 0], -2.456, [ox + 39.657, oy + 27.560], true, 0],
    ["ch18_fuzz_agf_344_loaded", [ox + 15.487, oy + 1.414, 0], -0.195, [ox - 7.931, oy - 29.225], true, 4000012],
    ["ch18_fuzz_agf_344_empty", [ox + 15.487, oy + 1.414, 0], -0.195, [ox - 7.931, oy - 29.225], true, 0],
    // Valid 6-corner-clear m4_explorer_19_1b table & 500-run fuzz edge cases
    ["exp1b_fuzz_agf_5", [ox - 2.94, oy - 29.0, 0], 0, [ox + 12.05, oy + 4.2], true, 0],
    ["exp1b_fuzz_agf_15", [ox - 33.541, oy - 13.681, 0], 0, [ox + 10.526, oy + 4.651], true, 0],
    ["exp1b_fuzz_agf_33", [ox + 17.448, oy - 22.253, 0], -1.484, [ox + 12.151, oy - 1.874], true, 0],
    ["rand_41", [ox - 17.48, oy - 9.85, 0], 0.48, [ox + 6.93, oy + 2.02], true, 0],
    ["rand_127", [ox - 6.0, oy + 2.75, 0], -1.18, [ox - 24.0, oy + 24.5], true, 0],
    ["rand_133", [ox - 18.0, oy + 20.0, 0], 0.0, [ox - 13.10, oy - 40.30], true, 0],
    // Class 2 AISLE_SWEEP narrow rack aisle behind-target cases
    ["A(4,-9)_h-PI/2->R6_b7", [ox + 4.0, oy - 9.0, 0], -Math.PI * 0.5, [ox + 5.05, oy - 9.35], false, 0],
    ["A(4,-9)_h-PI/2->R4_5_s0_b7", [ox + 4.0, oy - 9.0, 0], -Math.PI * 0.5, [ox + 5.05, oy - 8.65], false, 0],
    ["A(4,-3)_h-PI/2->R4_5_s1_b7", [ox + 4.0, oy - 3.0, 0], -Math.PI * 0.5, [ox + 5.05, oy - 3.35], false, 0],
    ["A(4,3)_h-PI/2->R1_s0_b7", [ox + 4.0, oy + 3.0, 0], -Math.PI * 0.5, [ox + 5.05, oy + 3.35], false, 0],
    ["A(-10,3)_h-PI/2->R2_3_s1_b2", [ox - 10.0, oy + 3.0, 0], -Math.PI * 0.5, [ox - 8.95, oy + 2.65], false, 0],
    ["A(-2.55,-9)_h+PI/2->R6_b4", [ox - 2.55, oy - 9.0, 0], Math.PI * 0.5, [ox - 3.35, oy - 9.35], false, 0],
  ];

  // Center-clear-only (t=0 corner overlap or dst < 0.57 m) table coordinates from m4_explorer_19_1b
  const arrivalOnlyCases = [
    ["exp1b_fuzz_agf_13", [ox - 2.94, oy - 39.32, 0], 0, [ox + 10.517, oy - 40.761], true, 0],
    ["exp1b_fuzz_agf_69_withC", [ox + 21.255, oy + 7.213, 0], 2.65, [ox - 12.905, oy - 38.490], true, 0],
    ["exp1b_fuzz_agf_69_noC", [ox + 21.255, oy + 7.213, 0], 2.65, [ox - 12.905, oy - 38.490], false, 0],
    ["exp1b_fuzz_agf_129", [ox + 9.035, oy - 22.842, 0], 0.818, [ox - 3.952, oy + 23.025], true, 0],
    ["exp1b_fuzz_agf_344_loaded", [ox + 12.944, oy + 1.720, 0], 1.132, [ox - 7.50, oy - 24.51], true, 4000012],
    ["exp1b_fuzz_agf_344_empty", [ox + 12.944, oy + 1.720, 0], 1.132, [ox - 7.50, oy - 24.51], true, 0],
    ["rand_27", [ox - 13.5, oy - 21.9, 0], 0.40, [ox + 18.0, oy + 10.0], true, 0],
    ["rand_143", [ox + 13.0, oy - 4.5, 0], 0.30, [ox - 40.0, oy + 24.5], true, 0],
    ["rand_150", [ox + 9.2, oy - 23.0, 0], -0.80, [ox - 14.6, oy + 3.35], true, 0],
    ["rand_238", [ox + 4.06, oy - 9.71, 0], 0.02, [ox - 10.42, oy - 23.09], true, 0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, withC, carriedWcid] of cases) {
      const cMap = withC ? makeDefaultContainers() : new Map();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-28-${label}`, { pos: sPos, heading: sH, carriedWcid });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countHullHits(agf, mgr, cMap);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `28 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `28 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }
    for (const [label, sPos, sH, tPos, withC, carriedWcid] of arrivalOnlyCases) {
      const cMap = withC ? makeDefaultContainers() : new Map();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-28-arr-${label}`, { pos: sPos, heading: sH, carriedWcid });
        const standUnreachable = label.startsWith("exp1b_fuzz_agf_344") || label === "rand_238";
        let settled = false;
        let rejErr = null;
        let hits = 0;
        const t0Hits = countHullHits(agf, mgr, cMap);
        agf.enqueue({ type: "driveTo", waypoints: [tPos] }).then(
          () => { settled = true; },
          (e) => { rejErr = e; },
        );
        for (let step = 0; step < maxSteps && !settled && !rejErr; step++) {
          mgr.tick(dt);
          if (standUnreachable && t0Hits === 0) hits += countHullHits(agf, mgr, cMap);
          await Promise.resolve();
        }
        if (standUnreachable) {
          assert.ok(rejErr && /AGF route unreachable/.test(rejErr.message), `28 ${label} dt=${dt.toFixed(4)} expected unreachable rejection, got ${rejErr?.message}`);
          assert.ok(Math.hypot(agf.x - sPos[0], agf.y - sPos[1]) <= 1e-4, `28 ${label} dt=${dt.toFixed(4)} moved before rejecting`);
          assert.equal(hits, 0, `28 ${label} dt=${dt.toFixed(4)} had ${hits} hull hits on rejected target`);
        } else {
          if (!label.startsWith("exp1b_fuzz_agf_69")) {
            assert.ok(settled, `28 ${label} dt=${dt.toFixed(4)} did not settle within ${maxSteps} steps`);
          }
          assert.ok(
            Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
            `28 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
          );
        }
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 29. Regression: AMR Outside-Perimeter driveTo Near L1/L2/S10 (0.62 m) & L1/L2 Docking
// ---------------------------------------------------------------------------
check("29. regression: AMR outside-perimeter driveTo near L1/L2/S10 (0.62 m) routes around obstacles with 0 4-corner hits and preserves L1/L2 docking at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const countAmrStaticHits = (amr, mgr) => {
    let hits = 0;
    for (let ci = 0; ci < amrHullCorners.length; ci++) {
      const [lx, ly] = amrHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
    }
    return hits;
  };

  const cases = [
    ["AMR_north_L1->south_edge_L1", [ox - 46.0, oy - 10.5, 0], Math.PI, [ox - 46.0, oy - 15.27]],
    ["AMR_east_L2->west_edge_L2", [ox - 34.0, oy - 14.0, 0], -Math.PI * 0.5, [ox - 39.29, oy - 14.0]],
    ["AMR_south_L1->north_edge_L1", [ox - 46.0, oy - 17.5, 0], 0, [ox - 46.0, oy - 12.73]],
    ["AMR_west_L2->east_edge_L2", [ox - 42.0, oy - 14.0, 0], Math.PI * 0.5, [ox - 36.71, oy - 14.0]],
    ["AMR_south_L1_edge->north_L1", [ox - 46.0, oy - 15.27, 0], 0, [ox - 46.0, oy - 10.5]],
    ["AMR_north_S10->south_edge_S10", [ox - 7.5, oy - 21.5, 0], Math.PI, [ox - 7.5, oy - 25.19]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of cases) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const amr = mgr.spawnAmr(`amr-29-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countAmrStaticHits(amr, mgr);
          },
          amr.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `29 ${label} dt=${dt.toFixed(4)} had ${hits} AMR 4-corner static hits`);
        assert.ok(
          Math.hypot(amr.x - tPos[0], amr.y - tPos[1]) <= 0.15,
          `29 ${label} dt=${dt.toFixed(4)} final pose mismatch`,
        );
      } finally {
        mgr.dispose();
      }
    }

    // Chained edge-arrival -> L1/L2 placeOnStand / pickFromStand docking preservation
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    try {
      const amr = mgr.spawnAmr("amr-29-dock", { pos: [ox - 46.0, oy - 10.5, 0], heading: Math.PI, carriedWcid: 4000012 });
      const l1 = mgr.liftTables.get("L1");
      const l2 = mgr.liftTables.get("L2");
      await stepUntilSettled(() => mgr.tick(dt), l1.raise(), maxSteps);
      await stepUntilSettled(() => mgr.tick(dt), l2.raise(), maxSteps);
      let hits = 0;
      await stepUntilSettled(
        () => {
          mgr.tick(dt);
          hits += countAmrStaticHits(amr, mgr);
        },
        amr.enqueue({ type: "driveTo", waypoints: [[ox - 46.0, oy - 15.27]] }),
        maxSteps,
      );
      assert.equal(hits, 0, `29 chain-edge dt=${dt.toFixed(4)} had ${hits} AMR 4-corner static hits`);
      assert.ok(
        Math.hypot(amr.x - (ox - 46.0), amr.y - (oy - 15.27)) <= 0.15,
        `29 chain-edge dt=${dt.toFixed(4)} final pose mismatch`,
      );
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "placeOnStand", standId: "L1" }), maxSteps);
      assert.equal(l1.carriedWcid, 4000012, `29 L1 holds cargo dt=${dt.toFixed(4)}`);
      assert.equal(amr.carriedWcid, 0, `29 AMR empty after placeOnStand L1 dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "pickFromStand", standId: "L1" }), maxSteps);
      assert.equal(amr.carriedWcid, 4000012, `29 AMR picked cargo from L1 dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "placeOnStand", standId: "L2" }), maxSteps);
      assert.equal(l2.carriedWcid, 4000012, `29 L2 holds cargo dt=${dt.toFixed(4)}`);
      await stepUntilSettled(() => mgr.tick(dt), amr.enqueue({ type: "pickFromStand", standId: "L2" }), maxSteps);
      assert.equal(amr.carriedWcid, 4000012, `29 AMR picked cargo from L2 dt=${dt.toFixed(4)}`);
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 30. Regression: Oblique Rack Aisle Departures (fuzz520_38 & rfuzz_*), Close-to-Container driveTo (fuzz520_398), & Zone D Stand Pivot (rfuzz_412)
// ---------------------------------------------------------------------------
check("30. regression: oblique rack aisle departures (fuzz520_38 & rfuzz_147/199/204/207/325/367), close-to-container driveTo (fuzz520_398), & Zone D stand pivot (rfuzz_412) clear 6-corner hull at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const hl = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
      }
    }
    return hits;
  };

  const cases = [
    ["fuzz520_38",  [ox - 8.963, oy - 2.749, 0],  0.357,  [ox - 46.049, oy + 36.376]],
    ["fuzz520_398", [ox + 16.341, oy + 23.942, 0], -1.652, [ox - 5.601, oy + 27.554]],
    ["rfuzz_147",   [ox - 3.124, oy - 8.732, 0],  0.061,  [ox - 0.489, oy - 33.429]],
    ["rfuzz_199",   [ox + 3.786, oy + 2.769, 0], -2.961,  [ox - 19.095, oy - 4.872]],
    ["rfuzz_204",   [ox - 0.976, oy + 3.449, 0],  0.967,  [ox - 43.834, oy + 38.349]],
    ["rfuzz_207",   [ox - 9.226, oy + 2.404, 0],  2.33,   [ox + 38.306, oy + 9.72]],
    ["rfuzz_325",   [ox + 2.52,  oy + 3.557, 0], -0.886,  [ox - 47.951, oy + 28.483]],
    ["rfuzz_367",   [ox + 3.253, oy - 2.445, 0], -1.008,  [ox + 7.097, oy + 7.806]],
    ["rfuzz_412",   [ox - 0.907, oy - 22.664, 0], -0.206, [ox + 25.005, oy - 26.275]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-30-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countHullHits(agf, mgr, cMap);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `30 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `30 ${label} dt=${dt.toFixed(4)} final pose err > 0.15 m`,
        );
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 31. Regression: scale-stress A3 Head-On Deadlock (dt=1/30 7200t withC) & east_of_S1 Stand Transit (S1..S6)
// ---------------------------------------------------------------------------
check("31. regression: scale-stress 7200 ticks @ dt=1/30 withC & A3 staggered pass clear deadlock; east_of_S1 -> placeOnStand/pickFromStand clears S1", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const minRackEdgeDist = (x, y, rackBoxes) => {
    let minD = Infinity;
    for (const b of rackBoxes) {
      const cx = Math.max(b.x0, Math.min(b.x1, x));
      const cy = Math.max(b.y0, Math.min(b.y1, y));
      const d = Math.hypot(x - cx, y - cy);
      if (d < minD) minD = d;
    }
    return minD;
  };

  // Part A1: scale-stress 7200 ticks @ dt = 1/30 with C1..C3 spawned
  {
    const stepDt = 1 / 30;
    const tickLimit = 7200;
    const cMap = makeDefaultContainers();
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: cMap,
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    try {
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const rackBoxes = mgr.getObstacleBoxes().filter((b) => b.kind === "rack");
      const scenP = mgr.runScenario("scale-stress");
      let agfHits = 0;
      let amrHits = 0;
      let minEdge = Infinity;
      let minSepAA = Infinity;
      let minSepMM = Infinity;
      const final10sDist = new Map();
      const curStallSec = new Map();
      const maxStallSec = new Map();
      const prevPos = new Map();
      const amrFinal10sDist = new Map();
      const amrCurStallSec = new Map();
      const amrMaxStallSec = new Map();
      const amrPrevPos = new Map();
      const lateWinStart = tickLimit - Math.round(10.0 / stepDt);

      const checkCorners = (corners, agent) => {
        let h = 0;
        for (let ci = 0; ci < corners.length; ci++) {
          const [wx, wy] = localToWorld2D(corners[ci][0], corners[ci][1], agent.x, agent.y, agent.heading);
          for (const r of mgr.racks.values()) {
            const b = r.worldBounds;
            if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) h++;
          }
          for (const st of mgr.stands.values()) {
            const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
            const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
            if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) h++;
          }
          for (const lt of mgr.liftTables.values()) {
            if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) h++;
          }
          for (const c of mgr.chargers.values()) {
            if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) h++;
          }
          for (const ce of cMap.values()) {
            const p = ce.rawPos;
            const hl = ce.kind === 10 ? 3.029 : 6.096;
            if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) h++;
          }
        }
        return h;
      };

      for (let t = 0; t < tickLimit; t++) {
        mgr.tick(stepDt);
        const agfList = [...mgr.agfs.values()];
        for (let ai = 0; ai < agfList.length; ai++) {
          const a = agfList[ai];
          const prev = prevPos.get(a.id);
          const stepDist = prev ? Math.hypot(a.x - prev[0], a.y - prev[1]) : 0;
          if (prev) {
            if (t >= lateWinStart) final10sDist.set(a.id, (final10sDist.get(a.id) ?? 0) + stepDist);
            const stalled = stepDist < 1e-4 ? (curStallSec.get(a.id) ?? 0) + stepDt : 0;
            curStallSec.set(a.id, stalled);
            if (stalled > (maxStallSec.get(a.id) ?? 0)) maxStallSec.set(a.id, stalled);
          }
          prevPos.set(a.id, [a.x, a.y]);
          const d = minRackEdgeDist(a.x, a.y, rackBoxes);
          if (d < minEdge) minEdge = d;
          agfHits += checkCorners(agfHullCorners, a);
          for (let aj = ai + 1; aj < agfList.length; aj++) {
            const sep = Math.hypot(a.x - agfList[aj].x, a.y - agfList[aj].y);
            if (sep < minSepAA) minSepAA = sep;
          }
        }
        const amrList = [...mgr.amrs.values()];
        for (let mi = 0; mi < amrList.length; mi++) {
          const m = amrList[mi];
          const prev = amrPrevPos.get(m.id);
          const stepDist = prev ? Math.hypot(m.x - prev[0], m.y - prev[1]) : 0;
          if (prev) {
            if (t >= lateWinStart) amrFinal10sDist.set(m.id, (amrFinal10sDist.get(m.id) ?? 0) + stepDist);
            const stalled = stepDist < 1e-4 ? (amrCurStallSec.get(m.id) ?? 0) + stepDt : 0;
            amrCurStallSec.set(m.id, stalled);
            if (stalled > (amrMaxStallSec.get(m.id) ?? 0)) amrMaxStallSec.set(m.id, stalled);
          }
          amrPrevPos.set(m.id, [m.x, m.y]);
          amrHits += checkCorners(amrHullCorners, m);
          for (let mj = mi + 1; mj < amrList.length; mj++) {
            const sep = Math.hypot(m.x - amrList[mj].x, m.y - amrList[mj].y);
            if (sep < minSepMM) minSepMM = sep;
          }
        }
      }

      const agfMinFinal10 = Math.min(...final10sDist.values());
      const agfWorstStall = Math.max(...maxStallSec.values());
      const amrMinFinal10 = Math.min(...amrFinal10sDist.values());
      const amrWorstStall = Math.max(...amrMaxStallSec.values());
      assert.equal(agfHits, 0, `31 scale-stress 7200t@1/30 agfHits=${agfHits}`);
      assert.equal(amrHits, 0, `31 scale-stress 7200t@1/30 amrHits=${amrHits}`);
      assert.ok(minEdge >= AGF_SPECS.hullRadiusM, `31 minEdge=${minEdge.toFixed(4)} < ${AGF_SPECS.hullRadiusM}`);
      assert.ok(minSepAA >= 0.70, `31 minSepAA=${minSepAA.toFixed(4)} < 0.70`);
      assert.ok(minSepMM >= 0.70, `31 minSepMM=${minSepMM.toFixed(4)} < 0.70`);
      assert.ok(agfMinFinal10 >= 1.0, `31 agfMinFinal10=${agfMinFinal10.toFixed(2)} < 1.0`);
      assert.ok(agfWorstStall < 10.0, `31 agfWorstStall=${agfWorstStall.toFixed(2)} >= 10.0`);
      assert.ok(amrMinFinal10 >= 0.5, `31 amrMinFinal10=${amrMinFinal10.toFixed(2)} < 0.5`);
      assert.ok(amrWorstStall < 10.0, `31 amrWorstStall=${amrWorstStall.toFixed(2)} >= 10.0`);
      mgr.stopScenarios();
      await scenP;
    } finally {
      mgr.dispose();
    }
  }

  // Part A2: Staggered A3 head-on pass (stress-agf-1 vs stress-agf-4) at dt=1/60 and 1/30
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 6000 : 3000;
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    try {
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const a1 = mgr.spawnAgf("stress-agf-1", { pos: [ox - 0.550, oy - 9.377, 0], heading: 1.487 });
      const a4 = mgr.spawnAgf("stress-agf-4", { pos: [ox - 0.341, oy - 8.094, 0], heading: 4.695 });
      let rackHits = 0;
      let minSep = Infinity;
      const p1 = a1.enqueue({ type: "driveTo", waypoints: [[ox + 18, oy - 9.0]] });
      const p4 = a4.enqueue({ type: "driveTo", waypoints: [[ox - 24, oy - 9.0]] });
      await stepUntilSettled(
        () => {
          mgr.tick(dt);
          for (const a of [a1, a4]) {
            for (let ci = 0; ci < agfHullCorners.length; ci++) {
              const [wx, wy] = localToWorld2D(agfHullCorners[ci][0], agfHullCorners[ci][1], a.x, a.y, a.heading);
              for (const r of mgr.racks.values()) {
                const b = r.worldBounds;
                if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) rackHits++;
              }
            }
          }
          const sep = Math.hypot(a1.x - a4.x, a1.y - a4.y);
          if (sep < minSep) minSep = sep;
        },
        Promise.all([p1, p4]),
        maxSteps,
      );
      assert.equal(rackHits, 0, `31 A3 head-on dt=${dt.toFixed(4)} had ${rackHits} rack hits`);
      assert.ok(minSep >= 1.24, `31 A3 head-on dt=${dt.toFixed(4)} minSep=${minSep.toFixed(4)} < 1.24`);
    } finally {
      mgr.dispose();
    }
  }

  // Part B: Failure 2 (east_of_S1 -> placeOnStand("S1","S2","S6") & pickFromStand("S2") at dt=1/60 & 1/30)
  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const targetId of ["S1", "S2", "S6"]) {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      try {
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const agf = mgr.spawnAgf(`agf-31-place-${targetId}`, { pos: [ox + 18, oy + 4.2, 0], heading: -Math.PI * 0.5, carriedWcid: 4000012 });
        const targetStand = mgr.stands.get(targetId);
        const targetAppH = Math.atan2(targetStand.pos[0] - targetStand.agfApproachPos[0], targetStand.pos[1] - targetStand.agfApproachPos[1]);
        const yawDiff = (a, b) => Math.abs((((a - b + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
        let nonTargetHits = 0;
        let transitS1Hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            const inDock = Math.hypot(agf.x - targetStand.agfApproachPos[0], agf.y - targetStand.agfApproachPos[1]) <= 1.35 && yawDiff(agf.heading, targetAppH) < 0.25;
            for (let ci = 0; ci < agfHullCorners.length; ci++) {
              const [wx, wy] = localToWorld2D(agfHullCorners[ci][0], agfHullCorners[ci][1], agf.x, agf.y, agf.heading);
              for (const r of mgr.racks.values()) {
                const b = r.worldBounds;
                if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) nonTargetHits++;
              }
              for (const st of mgr.stands.values()) {
                const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
                const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
                if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) {
                  if (st.id !== targetId) nonTargetHits++;
                  if (st.id === "S1" && !inDock) transitS1Hits++;
                }
              }
              for (const lt of mgr.liftTables.values()) {
                if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) nonTargetHits++;
              }
              for (const c of mgr.chargers.values()) {
                if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) nonTargetHits++;
              }
            }
          },
          agf.enqueue({ type: "placeOnStand", standId: targetId }),
          maxSteps,
        );
        assert.equal(nonTargetHits, 0, `31 east_of_S1->placeOnStand(${targetId}) dt=${dt.toFixed(4)} nonTargetHits=${nonTargetHits}`);
        assert.equal(transitS1Hits, 0, `31 east_of_S1->placeOnStand(${targetId}) dt=${dt.toFixed(4)} transitS1Hits=${transitS1Hits}`);
        assert.equal(targetStand.carriedWcid, 4000012, `31 S${targetId} holds placed cargo`);
        assert.equal(agf.carriedWcid, 0, `31 AGF unloaded cargo on ${targetId}`);
      } finally {
        mgr.dispose();
      }
    }

    // pickFromStand("S2") from east_of_S1
    {
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      try {
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const s2 = mgr.stands.get("S2");
        const loader = mgr.spawnAgf("agf-31-loader", { pos: [s2.agfApproachPos[0], s2.agfApproachPos[1], 0], heading: Math.PI * 0.5, carriedWcid: 4000012 });
        await stepUntilSettled(() => mgr.tick(dt), loader.enqueue({ type: "placeOnStand", standId: "S2" }), maxSteps);
        await stepUntilSettled(() => mgr.tick(dt), loader.enqueue({ type: "driveTo", waypoints: [[ox + 18, oy + 12.0]] }), maxSteps);

        const agf = mgr.spawnAgf("agf-31-pick-S2", { pos: [ox + 18, oy + 4.2, 0], heading: -Math.PI * 0.5 });
        const s2AppH = Math.atan2(s2.pos[0] - s2.agfApproachPos[0], s2.pos[1] - s2.agfApproachPos[1]);
        const yawDiff = (a, b) => Math.abs((((a - b + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
        let nonTargetHits = 0;
        let transitS1Hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            const inDock = Math.hypot(agf.x - s2.agfApproachPos[0], agf.y - s2.agfApproachPos[1]) <= 1.35 && yawDiff(agf.heading, s2AppH) < 0.25;
            for (let ci = 0; ci < agfHullCorners.length; ci++) {
              const [wx, wy] = localToWorld2D(agfHullCorners[ci][0], agfHullCorners[ci][1], agf.x, agf.y, agf.heading);
              for (const r of mgr.racks.values()) {
                const b = r.worldBounds;
                if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) nonTargetHits++;
              }
              for (const st of mgr.stands.values()) {
                const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
                const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
                if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) {
                  if (st.id !== "S2") nonTargetHits++;
                  if (st.id === "S1" && !inDock) transitS1Hits++;
                }
              }
              for (const lt of mgr.liftTables.values()) {
                if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) nonTargetHits++;
              }
              for (const c of mgr.chargers.values()) {
                if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) nonTargetHits++;
              }
            }
          },
          agf.enqueue({ type: "pickFromStand", standId: "S2" }),
          maxSteps,
        );
        assert.equal(nonTargetHits, 0, `31 east_of_S1->pickFromStand(S2) dt=${dt.toFixed(4)} nonTargetHits=${nonTargetHits}`);
        assert.equal(transitS1Hits, 0, `31 east_of_S1->pickFromStand(S2) dt=${dt.toFixed(4)} transitS1Hits=${transitS1Hits}`);
        assert.equal(agf.carriedWcid, 4000012, `31 AGF picked 4000012 from S2`);
        assert.equal(s2.carriedWcid, 0, `31 S2 empty after pickFromStand`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 32. Regression: Close-to-Obstacle / Container-South Arrivals & Multi-AGF Aisle Pileups
// ---------------------------------------------------------------------------
check("32. regression: closeC_C1/C2/C3_S, challenger20_fuzz_293/404(full+L2)/490(loaded)/172, 2agf_A2_headon_loaded & 3agf_A3_pileup settle with 0 hull hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const hl = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
      }
    }
    return hits;
  };

  const singleCases = [
    ["closeC_C1_S_0.70",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 40, oy + 25.704],     0],
    ["closeC_C1_S_1.15",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 40, oy + 25.254],     0],
    ["closeC_C2_S_0.70",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 24, oy + 25.704],     0],
    ["closeC_C2_S_1.15",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 24, oy + 25.254],     0],
    ["closeC_C3_S_0.70",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 8, oy + 25.701],      0],
    ["closeC_C3_S_1.15",       [ox - 24, oy + 41, 0],         Math.PI, [ox - 8, oy + 25.251],      0],
    ["challenger20_fuzz_293",  [ox + 39.559, oy - 13.315, 0], 0.788,   [ox - 23.331, oy + 25.318], 0],
    ["challenger20_fuzz_404",  [ox - 0.725, oy - 37.314, 0],  0.501,   [ox - 37.53, oy - 12.151],  0],
    ["fuzz404_L2_north",       [ox - 30, oy - 8, 0],          0,       [ox - 37.53, oy - 12.151],  0],
    ["fuzz404_L2_south",       [ox - 30, oy - 20, 0],         0,       [ox - 37.53, oy - 12.151],  0],
    ["challenger20_fuzz_490",  [ox - 11.316, oy + 22.927, 0], 2.678,   [ox - 5.333, oy - 36.656],  4000012],
    ["challenger20_fuzz_172",  [ox + 23.413, oy - 3.038, 0],  0.076,   [ox + 12.736, oy - 3.987],   0],
  ];

  const multiCases = [
    [
      "2agf_A2_headon_loaded",
      [
        { id: "a1", pos: [ox - 10, oy - 3.3, 0], heading: Math.PI * 0.5, carriedWcid: 4000012, target: [ox + 8, oy - 3.0] },
        { id: "a2", pos: [ox + 1, oy - 2.7, 0],  heading: -Math.PI * 0.5, carriedWcid: 4000012, target: [ox - 18, oy - 3.0] },
      ],
    ],
    [
      "3agf_A3_pileup_empty",
      [
        { id: "a1", pos: [ox - 13, oy - 9.2, 0], heading: Math.PI * 0.5, carriedWcid: 0, target: [ox + 9, oy - 9.0] },
        { id: "a2", pos: [ox - 2, oy - 8.8, 0],  heading: -Math.PI * 0.5, carriedWcid: 0, target: [ox - 20, oy - 9.0] },
        { id: "a3", pos: [ox + 5, oy - 9.2, 0],  heading: -Math.PI * 0.5, carriedWcid: 0, target: [ox - 18, oy - 9.0] },
      ],
    ],
    [
      "3agf_A3_pileup_loaded",
      [
        { id: "a1", pos: [ox - 13, oy - 9.2, 0], heading: Math.PI * 0.5, carriedWcid: 4000012, target: [ox + 9, oy - 9.0] },
        { id: "a2", pos: [ox - 2, oy - 8.8, 0],  heading: -Math.PI * 0.5, carriedWcid: 4000012, target: [ox - 20, oy - 9.0] },
        { id: "a3", pos: [ox + 5, oy - 9.2, 0],  heading: -Math.PI * 0.5, carriedWcid: 4000012, target: [ox - 18, oy - 9.0] },
      ],
    ],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSingleSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, carriedWcid] of singleCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-32-${label}`, { pos: sPos, heading: sH, carriedWcid });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countHullHits(agf, mgr, cMap);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSingleSteps,
        );
        assert.equal(hits, 0, `32 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `32 ${label} dt=${dt.toFixed(4)} final pose err > 0.15 m`,
        );
      } finally {
        mgr.dispose();
      }
    }

    const maxMultiSteps = dt < 0.025 ? 8000 : 6000;
    for (const [label, specs] of multiCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agents = specs.map((sp) => ({
          sp,
          handle: mgr.spawnAgf(`agf-32-${label}-${sp.id}`, { pos: sp.pos, heading: sp.heading, carriedWcid: sp.carriedWcid }),
        }));
        const promises = agents.map(({ sp, handle }) => handle.enqueue({ type: "driveTo", waypoints: [sp.target] }));
        let hits = 0;
        let minSep = Infinity;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            for (let i = 0; i < agents.length; i++) {
              hits += countHullHits(agents[i].handle, mgr, cMap);
              for (let j = i + 1; j < agents.length; j++) {
                const sep = Math.hypot(agents[i].handle.x - agents[j].handle.x, agents[i].handle.y - agents[j].handle.y);
                if (sep < minSep) minSep = sep;
              }
            }
          },
          Promise.all(promises),
          maxMultiSteps,
        );
        assert.equal(hits, 0, `32 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(minSep >= 1.30, `32 ${label} dt=${dt.toFixed(4)} minSep=${minSep.toFixed(4)} < 1.30`);
        for (const { sp, handle } of agents) {
          assert.ok(
            Math.hypot(handle.x - sp.target[0], handle.y - sp.target[1]) <= 0.15,
            `32 ${label} ${sp.id} dt=${dt.toFixed(4)} final pose err > 0.15 m`,
          );
        }
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 33. Regression: Charger Oblique, Stand-Band Oblique, Oblique Rack Aisles & AMR Charger Trap
// ---------------------------------------------------------------------------
check("33. regression: challenger20 charger/stand-band/oblique-aisle AGF fuzz & amr_fuzz_214 settle with 0 hull hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    const defs = [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ];
    for (const d of defs) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countCorners = (agent, corners, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < corners.length; ci++) {
      const [lx, ly] = corners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agent.x, agent.y, agent.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const hl = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
      }
    }
    return hits;
  };

  const agfCases = [
    ["challenger20_fuzz_36",  [ox + 5.374, oy - 39.582, 0],  2.161,  [ox - 35.159, oy - 19.94]],
    ["challenger20_fuzz_73",  [ox + 0.725, oy - 37.153, 0], -2.466,  [ox - 29.3, oy + 19.15]],
    ["challenger20_fuzz_202", [ox + 9.936, oy - 39.538, 0],  2.943,  [ox + 15.573, oy + 0.792]],
    ["challenger20_fuzz_376", [ox - 11.27, oy - 38.059, 0],  0.799,  [ox - 39.134, oy - 18.712]],
    ["challenger20_fuzz_454", [ox - 5.165, oy - 36.826, 0],  2.978,  [ox - 36.948, oy - 16.926]],
    ["challenger20_fuzz_9",   [ox + 12.689, oy - 4.571, 0], -2.607,  [ox + 20.697, oy + 37.629]],
    ["challenger20_fuzz_393", [ox - 17.328, oy - 22.766, 0], -0.081, [ox - 29.949, oy + 27.185]],
    ["challenger20_fuzz_429", [ox - 14.766, oy - 23.216, 0], -0.357, [ox - 39.354, oy - 24.08]],
    ["zoneD_band_8",          [ox + 15.525, oy - 22.507, 0], -1.23,  [ox + 25, oy - 26.3]],
    ["zoneD_band_13",         [ox + 16.595, oy - 22.734, 0],  2.401, [ox - 40, oy + 24.5]],
    ["zoneD_band_19",         [ox + 6.513, oy - 22.714, 0], -2.156,  [ox + 12.05, oy + 4.2]],
    ["zoneD_band_21",         [ox + 7.407, oy - 22.774, 0], -0.876,  [ox - 40, oy + 24.5]],
    ["zoneD_band_52",         [ox - 7.513, oy - 22.589, 0],  0.774,  [ox + 25, oy - 26.3]],
    ["oblique_aisle_6",       [ox + 2.13, oy - 2.158, 0],   -1.151,  [ox + 12.05, oy + 4.2]],
    ["oblique_aisle_51",      [ox - 14.474, oy - 9.533, 0],  2.461,  [ox + 12.05, oy + 4.2]],
    ["oblique_aisle_72",      [ox - 10.669, oy + 2.788, 0], -2.964,  [ox - 2.0, oy - 39.4]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of agfCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-33-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countCorners(agf, agfHullCorners, mgr, cMap);
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `33 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(
          Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15,
          `33 ${label} dt=${dt.toFixed(4)} final pose err > 0.15 m`,
        );
      } finally {
        mgr.dispose();
      }
    }

    // AMR charger trap regression (amr_fuzz_214)
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const amr = mgr.spawnAmr("amr-33-fuzz214", { pos: [ox - 0.854, oy - 37.093, 0], heading: 0.555 });
        let hits = 0;
        const target = [ox - 38.608, oy + 6.177];
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += countCorners(amr, amrHullCorners, mgr, cMap);
          },
          amr.enqueue({ type: "driveTo", waypoints: [target] }),
          maxSteps,
        );
        assert.equal(hits, 0, `33 amr_fuzz_214 dt=${dt.toFixed(4)} had ${hits} 4-corner hull hits`);
        assert.ok(
          Math.hypot(amr.x - target[0], amr.y - target[1]) <= 0.15,
          `33 amr_fuzz_214 dt=${dt.toFixed(4)} final pose err > 0.15 m`,
        );
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 34. Regression: M4 Challenger 21 Failure 1 & 2 AGF Rescue Budget & Tight-Clearance Routing
// ---------------------------------------------------------------------------
check("34. regression: fuzz_agf_100/136/156/324/334, adv_close_tgt_S9_186/S11_188, adv_zoneD_band_100 & rand_41 settle < 5000 ms with 0 hull hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const hullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const countHullHits = (agf, mgr, containersMap) => {
    let hits = 0;
    for (let ci = 0; ci < hullCorners.length; ci++) {
      const [lx, ly] = hullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const r of mgr.racks.values()) {
        const b = r.worldBounds;
        if (b && wx > b.minX + 1e-4 && wx < b.maxX - 1e-4 && wy > b.minY + 1e-4 && wy < b.maxY - 1e-4) hits++;
      }
      for (const st of mgr.stands.values()) {
        const rx = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfD : stHalfW;
        const ry = Math.abs(Math.sin(st.heading)) > 0.7 ? stHalfW : stHalfD;
        if (Math.abs(wx - st.pos[0]) < rx - 1e-4 && Math.abs(wy - st.pos[1]) < ry - 1e-4) hits++;
      }
      for (const lt of mgr.liftTables.values()) {
        if (Math.abs(wx - lt.x) < ltHalfW - 1e-4 && Math.abs(wy - lt.y) < ltHalfD - 1e-4) hits++;
      }
      for (const c of mgr.chargers.values()) {
        if (Math.abs(wx - c.pos[0]) < chHalfW - 1e-4 && Math.abs(wy - c.pos[1]) < chHalfD - 1e-4) hits++;
      }
      for (const ce of containersMap.values()) {
        const p = ce.rawPos;
        const hl = ce.kind === 10 ? 3.029 : 6.096;
        if (Math.abs(wx - p[0]) < 1.219 - 1e-4 && Math.abs(wy - p[1]) < hl - 1e-4) hits++;
      }
    }
    return hits;
  };

  const cases = [
    ["fuzz_agf_100",        [ox - 33.268, oy + 33.582, 0], -2.966,  [ox + 9.623, oy - 36.911],   0],
    ["fuzz_agf_136",        [ox + 12.513, oy - 38.253, 0], -0.372,  [ox + 12.305, oy - 22.898],  0],
    ["fuzz_agf_156",        [ox + 7.091, oy - 31.053, 0],  -1.484,  [ox - 25.258, oy + 39.233],  0],
    ["fuzz_agf_324",        [ox - 28.284, oy + 20.595, 0],  1.697,  [ox - 8.926, oy - 38.763],   0],
    ["fuzz_agf_334",        [ox - 3.837, oy + 14.624, 0],  -2.463,  [ox - 6.628, oy - 25.018],   0],
    ["adv_close_tgt_S9_186",  [ox + 22.0, oy + 12.0, 0],    Math.PI, [ox - 10.370, oy - 22.460], 4000012],
    ["adv_close_tgt_S11_188", [ox + 22.0, oy + 12.0, 0],    Math.PI, [ox - 4.574, oy - 25.258],  0],
    ["adv_zoneD_band_100",  [ox - 5.643, oy - 23.093, 0],  -2.491,  [ox - 40.0, oy + 24.5],      0],
    ["rand_41",             [ox - 17.48, oy - 9.85, 0],     0.48,   [ox + 6.93, oy + 2.02],      0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, carriedWcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      try {
        const agf = mgr.spawnAgf(`agf-34-${label}`, { pos: sPos, heading: sH, carriedWcid });
        let hits = 0;
        let initMs = 0;
        let settled = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            hits += countHullHits(agf, mgr, cMap);
          },
          p,
          maxSteps,
        );
        settled = true;
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        assert.equal(hits, 0, `34 ${label} dt=${dt.toFixed(4)} had ${hits} 6-corner hull hits`);
        assert.ok(settled, `34 ${label} dt=${dt.toFixed(4)} did not settle`);
        assert.ok(err <= 0.15, `34 ${label} dt=${dt.toFixed(4)} final pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 5000, `34 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 5000 ms`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 35. Regression: M4 Challenger 21 Failure 3 & 4 AMR OBB/A* Routing & A1 Multi-AGF Mouth Rescue
// ---------------------------------------------------------------------------
check("35. regression: AMR C1/S1..S2 gap (amr_rand_181), S14 standoff (amr_rand_17), diagonal 0.58-0.65m edge rotation (edge_S10_14), & 3agf_A1_revIds_loaded settle with 0 SAT OBB/hull hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const amrObbOverlapCount = (agent, obbs) => {
    const aU = [Math.cos(agent.heading), -Math.sin(agent.heading)];
    const aV = [Math.sin(agent.heading), Math.cos(agent.heading)];
    let hits = 0;
    for (const b of obbs) {
      const bU = [Math.cos(b.h), -Math.sin(b.h)];
      const bV = [Math.sin(b.h), Math.cos(b.h)];
      const dx = b.cx - agent.x;
      const dy = b.cy - agent.y;
      let sep = false;
      for (const [nx, ny] of [aU, aV, bU, bV]) {
        const dist = Math.abs(dx * nx + dy * ny);
        const rA = 0.39 * Math.abs(aU[0] * nx + aU[1] * ny) + 0.52 * Math.abs(aV[0] * nx + aV[1] * ny);
        const rB = b.hw * Math.abs(bU[0] * nx + bU[1] * ny) + b.hl * Math.abs(bV[0] * nx + bV[1] * ny);
        if (dist >= rA + rB - 1e-4) { sep = true; break; }
      }
      if (!sep) hits++;
    }
    return hits;
  };

  const amrCases = [
    ["amr_rand_181", [ox - 43.046, oy + 35.761, 0], 1.084, [ox + 40.542, oy - 6.513]],
    ["amr_rand_17",  [ox - 18.725, oy + 0.433, 0],  3.086, [ox + 4.252, oy - 24.975]],
    ["edge_S10_14",  [ox - 6.856, oy - 25.163, 0],  5.783, [ox - 6.685, oy - 22.870]],
    ["edge_L2_1",    [ox - 39.290, oy - 14.000, 0], Math.PI * 0.5, [ox - 36.710, oy - 14.000]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4500;
    for (const [label, sPos, sH, tPos] of amrCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap,
        deployables: new Map(), palletJacks: new Map(), trailers: new Map(),
        logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const amr = mgr.spawnAmr(`amr-35-${label}`, { pos: sPos, heading: sH });
        let hits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            hits += amrObbOverlapCount(amr, obbs);
          },
          amr.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(hits, 0, `35 ${label} dt=${dt.toFixed(4)} had ${hits} SAT OBB hits`);
        assert.ok(Math.hypot(amr.x - tPos[0], amr.y - tPos[1]) <= 0.15, `35 ${label} dt=${dt.toFixed(4)} pose err > 0.15 m`);
      } finally {
        mgr.dispose();
      }
    }

    // Failure 4: 3agf_A1_revIds_loaded
    {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap,
        deployables: new Map(), palletJacks: new Map(), trailers: new Map(),
        logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const specs = [
          { id: "z1", pos: [ox - 12, oy + 3.2, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy + 3.0] },
          { id: "m2", pos: [ox - 1,  oy + 2.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy + 3.0] },
          { id: "a3", pos: [ox + 5,  oy + 3.2, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy + 3.0] },
        ];
        const agents = specs.map((sp) => ({ sp, h: mgr.spawnAgf(`35-a1-${sp.id}`, { pos: sp.pos, heading: sp.h, carriedWcid: 4000012 }) }));
        let hits = 0;
        let minSep = Infinity;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            for (let i = 0; i < agents.length; i++) {
              const a = agents[i].h;
              for (const [lx, ly] of agfHullCorners) {
                const [wx, wy] = localToWorld2D(lx, ly, a.x, a.y, a.heading);
                for (const b of obbs) {
                  const dx = wx - b.cx, dy = wy - b.cy;
                  const c = Math.cos(b.h), s = Math.sin(b.h);
                  const bx = dx * c - dy * s, by = dx * s + dy * c;
                  if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) hits++;
                }
              }
              for (let j = i + 1; j < agents.length; j++) {
                minSep = Math.min(minSep, Math.hypot(a.x - agents[j].h.x, a.y - agents[j].h.y));
              }
            }
          },
          Promise.all(agents.map(({ sp, h }) => h.enqueue({ type: "driveTo", waypoints: [sp.tgt] }))),
          maxSteps,
        );
        assert.equal(hits, 0, `35 3agf_A1_revIds_loaded dt=${dt.toFixed(4)} had ${hits} hull hits`);
        assert.ok(minSep >= 1.30, `35 3agf_A1_revIds_loaded dt=${dt.toFixed(4)} minSep=${minSep.toFixed(3)} < 1.30`);
        for (const { sp, h } of agents) {
          assert.ok(Math.hypot(h.x - sp.tgt[0], h.y - sp.tgt[1]) <= 0.15, `35 3agf_A1_revIds_loaded ${sp.id} pose err > 0.15 m`);
        }
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 36. Regression: M4 Iter 23 Failure 1 & Close-Target (0.58-0.64 m / L1 / Charger-South)
// ---------------------------------------------------------------------------
check("36. regression: Failure 1 deterministic finalizeAgfRoute & 0.58-0.64 m close-target / L1_south / CH->S10 settle < 2500 ms with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["agf_fresh_125",          [ox + 5.808, oy + 23.329, 0],  2.516,          [ox - 7.252, oy + 1.912],   0],
    ["fresh_S10_south_0.640m", [ox - 7.5, oy - 29.0, 0],      0,              [ox - 7.5, oy - 25.21],     0],
    ["fresh_C2_south_0.640m",  [ox - 24.0, oy + 20.0, 0],     0,              [ox - 24.0, oy + 25.764],   0],
    ["adv_close_tgt_S9_186",   [ox + 22.0, oy + 12.0, 0],     Math.PI,        [ox - 10.370, oy - 22.460], 4000012],
    ["fresh_S10_south_0.600m", [ox - 7.5, oy - 29.0, 0],      0,              [ox - 7.5, oy - 25.17],     0],
    ["fresh_S10_south_0.580m", [ox - 7.5, oy - 29.0, 0],      0,              [ox - 7.5, oy - 25.15],     0],
    ["fresh_CH4_north_0.580m", [ox - 2.0, oy - 32.0, 0],      Math.PI,        [ox - 2.0, oy - 36.97],     0],
    ["fresh_C2_south_0.620m",  [ox - 24.0, oy + 20.0, 0],     0,              [ox - 24.0, oy + 25.784],   0],
    ["fresh_C2_south_0.580m",  [ox - 24.0, oy + 20.0, 0],     0,              [ox - 24.0, oy + 25.824],   0],
    ["L1_south_0.620m_from_S", [ox - 46.0, oy - 18.5, 0],     0,              [ox - 46.0, oy - 15.27],    0],
    ["L1_south_0.620m_from_N", [ox - 46.0, oy - 10.5, 0],     Math.PI,        [ox - 46.0, oy - 15.27],    0],
    ["L1_south_0.620m_from_E", [ox - 42.0, oy - 16.0, 0],     -Math.PI * 0.5, [ox - 46.0, oy - 15.27],    0],
    ["L1_south_0.640m_d15.29", [ox - 46.0, oy - 10.5, 0],     Math.PI,        [ox - 46.0, oy - 15.29],    0],
    ["fresh_L2_south_0.640m",  [ox - 38.0, oy - 10.5, 0],     Math.PI,        [ox - 38.0, oy - 15.29],    0],
    ["fresh_L2_south_0.620m",  [ox - 38.0, oy - 10.5, 0],     Math.PI,        [ox - 38.0, oy - 15.27],    0],
    ["CH_-7.5_-34.5_0.00->S10",[ox - 7.5, oy - 34.5, 0],      0,              [ox - 7.5, oy - 25.21],     0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, carriedWcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-36-${label}`, { pos: sPos, heading: sH, carriedWcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `36 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `36 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `36 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `36 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `36 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 37. Regression: M4 Iter 23 Failure 2 Opposite-Mouth A2/A3 & Failure 3 SAT OBB Flank-Clip
// ---------------------------------------------------------------------------
check("37. regression: Failure 2 (3agf_A2/A3_revIds_loaded) & Failure 3 SAT OBB flank-clip (L1/L2 0.640m, agf_fresh_71, charger gaps, scale-stress 9600t@1/60) pass with 0 6-corner & SAT OBB hits", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const multiCases = [
    [
      "3agf_A2_revIds_loaded",
      [
        { id: "z1", pos: [ox - 12, oy - 2.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 3.0] },
        { id: "m2", pos: [ox - 1,  oy - 3.2, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 3.0] },
        { id: "a3", pos: [ox + 5,  oy - 2.8, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy - 3.0] },
      ],
    ],
    [
      "3agf_A3_revIds_loaded",
      [
        { id: "z1", pos: [ox - 12, oy - 8.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 9.0] },
        { id: "m2", pos: [ox - 1,  oy - 9.2, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 9.0] },
        { id: "a3", pos: [ox + 5,  oy - 8.8, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy - 9.0] },
      ],
    ],
  ];

  const singleCases = [
    ["L1_south_0.640m_d15.29", [ox - 46.0, oy - 10.5, 0],     Math.PI, [ox - 46.0, oy - 15.29]],
    ["fresh_L2_south_0.640m",  [ox - 38.0, oy - 10.5, 0],     Math.PI, [ox - 38.0, oy - 15.29]],
    ["agf_fresh_71",           [ox - 12.175, oy - 21.149, 0], 0.635,   [ox - 45.566, oy + 38.368]],
    ["chgap_-10.5_-40.8_-0.75",[ox - 10.5, oy - 40.8, 0],     -0.75,   [ox - 22.0, oy - 29.0]],
    ["chgap_-6.0_-40.8_-0.75", [ox - 6.0, oy - 40.8, 0],      -0.75,   [ox - 22.0, oy - 29.0]],
    ["chgap_-16.5_-36.0_0.75", [ox - 16.5, oy - 36.0, 0],     0.75,    [ox + 22.0, oy - 29.0]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxMultiSteps = dt < 0.025 ? 8000 : 6000;
    for (const [label, specs] of multiCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap,
        deployables: new Map(), palletJacks: new Map(), trailers: new Map(),
        logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agents = specs.map((sp) => ({
          sp,
          h: mgr.spawnAgf(`37-${label}-${sp.id}`, { pos: sp.pos, heading: sp.h, carriedWcid: 4000012 }),
        }));
        let cornerHits = 0;
        let satObbHits = 0;
        let minSep = Infinity;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            for (let i = 0; i < agents.length; i++) {
              const a = agents[i].h;
              const h = checkAgfHits(a, obbs);
              cornerHits += h.cornerHits;
              satObbHits += h.satHits;
              for (let j = i + 1; j < agents.length; j++) {
                minSep = Math.min(minSep, Math.hypot(a.x - agents[j].h.x, a.y - agents[j].h.y));
              }
            }
          },
          Promise.all(agents.map(({ sp, h }) => h.enqueue({ type: "driveTo", waypoints: [sp.tgt] }))),
          maxMultiSteps,
        );
        assert.equal(cornerHits, 0, `37 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `37 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(minSep >= 1.30, `37 ${label} dt=${dt.toFixed(4)} minSep=${minSep.toFixed(3)} < 1.30`);
        for (const { sp, h } of agents) {
          assert.ok(Math.hypot(h.x - sp.tgt[0], h.y - sp.tgt[1]) <= 0.15, `37 ${label} ${sp.id} pose err > 0.15 m`);
        }
      } finally {
        mgr.dispose();
      }
    }

    const maxSingleSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of singleCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE, liveScene3d: rig.live, containers: cMap,
        deployables: new Map(), palletJacks: new Map(), trailers: new Map(),
        logisticsAudio: null, sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`37-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        let satObbHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          agf.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSingleSteps,
        );
        assert.equal(cornerHits, 0, `37 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `37 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(Math.hypot(agf.x - tPos[0], agf.y - tPos[1]) <= 0.15, `37 ${label} dt=${dt.toFixed(4)} pose err > 0.15 m`);
      } finally {
        mgr.dispose();
      }
    }
  }

  // scale-stress 9600 ticks @ dt=1/60 with C1..C3 spawned, strict 6-corner AND chassis+fork SAT OBB 0 hits
  {
    const cMap = makeDefaultContainers();
    const rig = makeRig({ withVehicles: false });
    const mgr = createWarehouseManager({
      THREE, liveScene3d: rig.live, containers: cMap,
      deployables: new Map(), palletJacks: new Map(), trailers: new Map(),
      logisticsAudio: null, sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    const obbs = getObbs(mgr, cMap);
    try {
      mgr.runScenario("scale-stress").catch(() => {});
      let cornerHits = 0;
      let satObbHits = 0;
      for (let t = 0; t < 9600; t++) {
        mgr.tick(1 / 60);
        for (const agf of mgr.agfs.values()) {
          const h = checkAgfHits(agf, obbs);
          cornerHits += h.cornerHits;
          satObbHits += h.satHits;
        }
      }
      assert.equal(mgr.agfs.size, 8);
      assert.ok(mgr.stats.rackedSlots >= 256);
      assert.equal(cornerHits, 0, `37 scale-stress 9600t@1/60 had ${cornerHits} 6-corner hits`);
      assert.equal(satObbHits, 0, `37 scale-stress 9600t@1/60 had ${satObbHits} SAT OBB hits`);
      mgr.stopScenarios();
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 38. Regression: M4 Iter 24 Failure 1 & Failure 2 initMs < 2500 ms
// ---------------------------------------------------------------------------
check("38. regression: Iter 24 Failure 1 (rf_agf_169, rf_agf_442) & Failure 2 initMs < 2500 ms (rf_agf_433, rand_41, fuzz_agf_100, ch_north_1, fresh_S10_south_0.640m, S10_S_0.6_from_CH, CH_-7.5_-34.5_0.00->S10) settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["rf_agf_169",               [ox + 15.421, oy - 41.444, 0], -2.462,       [ox - 8.679, oy - 12.569]],
    ["rf_agf_442",               [ox + 13.126, oy + 8.892, 0],   2.794,       [ox - 2.282, oy - 36.289]],
    ["rf_agf_433",               [ox - 39.734, oy - 33.647, 0], -1.033,       [ox + 10.662, oy - 22.822]],
    ["rand_41",                  [ox - 17.480, oy - 9.850, 0],   0.480,       [ox + 6.930, oy + 2.020]],
    ["fuzz_agf_100",             [ox - 33.268, oy + 33.582, 0], -2.966,       [ox + 9.623, oy - 36.911]],
    ["ch_north_1",               [ox - 10.000, oy - 36.900, 0],  Math.PI * 0.5, [ox + 10.000, oy - 36.900]],
    ["fresh_S10_south_0.640m",   [ox - 7.500, oy - 29.000, 0],   0,           [ox - 7.500, oy - 25.210]],
    ["S10_S_0.6_from_CH",        [ox - 7.500, oy - 34.500, 0],   0,           [ox - 7.500, oy - 25.170]],
    ["CH_-7.5_-34.5_0.00->S10",  [ox - 7.500, oy - 34.500, 0],   0,           [ox - 7.500, oy - 25.210]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-38-${label}`, { pos: sPos, heading: sH, carriedWcid: 0 });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `38 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `38 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `38 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `38 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `38 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 39. Regression: M4 Iter 24 Multi-AGF Pileup, 2east_1west & 4agf A2 Cross-Traffic
// ---------------------------------------------------------------------------
check("39. regression: M4 multi-AGF pileup, 2east_1west, and 4agf A2 cross-traffic stay collision-free and bounded-tick at dt=1/60 and dt=1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const scenarios = [
    [
      "3agf_A3_pileup_empty",
      [
        { id: "a1", pos: [ox - 13, oy - 9.2, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 9.0], wcid: 0 },
        { id: "a2", pos: [ox - 2,  oy - 8.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 9.0], wcid: 0 },
        { id: "a3", pos: [ox + 5,  oy - 9.2, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy - 9.0], wcid: 0 },
      ],
    ],
    [
      "3agf_A3_pileup_loaded",
      [
        { id: "a1", pos: [ox - 13, oy - 9.2, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 9.0], wcid: 4000012 },
        { id: "a2", pos: [ox - 2,  oy - 8.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 9.0], wcid: 4000012 },
        { id: "a3", pos: [ox + 5,  oy - 9.2, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy - 9.0], wcid: 4000012 },
      ],
    ],
    [
      "3agf_A3_pileup_a2_18_a3_20_loaded",
      [
        { id: "a1", pos: [ox - 15, oy - 8.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 9.0], wcid: 4000012 },
        { id: "a2", pos: [ox - 12, oy - 9.2, 0], h:  Math.PI * 0.5, tgt: [ox - 18, oy - 9.0], wcid: 4000012 },
        { id: "a3", pos: [ox + 7,  oy - 8.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 9.0], wcid: 4000012 },
      ],
    ],
    [
      "3agf_A1_2east_1west_loaded",
      [
        { id: "a1", pos: [ox - 15, oy + 3.2, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy + 3.0], wcid: 4000012 },
        { id: "a2", pos: [ox - 5,  oy + 2.8, 0], h:  Math.PI * 0.5, tgt: [ox + 7,  oy + 3.0], wcid: 4000012 },
        { id: "a3", pos: [ox + 6,  oy + 3.2, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy + 3.0], wcid: 4000012 },
      ],
    ],
    [
      "3agf_A2_2east_1west_loaded",
      [
        { id: "a1", pos: [ox - 15, oy - 2.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 3.0], wcid: 4000012 },
        { id: "a2", pos: [ox - 5,  oy - 3.2, 0], h:  Math.PI * 0.5, tgt: [ox + 7,  oy - 3.0], wcid: 4000012 },
        { id: "a3", pos: [ox + 6,  oy - 2.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 3.0], wcid: 4000012 },
      ],
    ],
    [
      "3agf_A3_2east_1west_loaded",
      [
        { id: "a1", pos: [ox - 15, oy - 8.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 9.0], wcid: 4000012 },
        { id: "a2", pos: [ox - 5,  oy - 9.2, 0], h:  Math.PI * 0.5, tgt: [ox + 7,  oy - 9.0], wcid: 4000012 },
        { id: "a3", pos: [ox + 6,  oy - 8.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 9.0], wcid: 4000012 },
      ],
    ],
    [
      "4agf_A2_cross_loaded",
      [
        { id: "z1", pos: [ox - 13, oy - 2.8, 0], h:  Math.PI * 0.5, tgt: [ox + 9,  oy - 3.0], wcid: 4000012 },
        { id: "y2", pos: [ox - 5,  oy - 3.2, 0], h:  Math.PI * 0.5, tgt: [ox + 7,  oy - 3.0], wcid: 4000012 },
        { id: "b3", pos: [ox + 1,  oy - 2.8, 0], h: -Math.PI * 0.5, tgt: [ox - 20, oy - 3.0], wcid: 4000012 },
        { id: "a4", pos: [ox + 6,  oy - 3.2, 0], h: -Math.PI * 0.5, tgt: [ox - 18, oy - 3.0], wcid: 4000012 },
      ],
    ],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 12000 : 6000;
    for (const [label, specs] of scenarios) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agents = specs.map((sp) => ({
          sp,
          h: mgr.spawnAgf(`39-${label}-${sp.id}`, { pos: sp.pos, heading: sp.h, carriedWcid: sp.wcid }),
        }));
        let cHits = 0;
        let sHits = 0;
        let minSep = Infinity;
        let maxTickMs = 0;
        await stepUntilSettled(
          () => {
            const t0 = performance.now();
            mgr.tick(dt);
            const tMs = performance.now() - t0;
            if (tMs > maxTickMs) maxTickMs = tMs;
            for (let i = 0; i < agents.length; i++) {
              const a = agents[i].h;
              const h = checkAgfHits(a, obbs);
              cHits += h.cornerHits;
              sHits += h.satHits;
              for (let j = i + 1; j < agents.length; j++) {
                minSep = Math.min(minSep, Math.hypot(a.x - agents[j].h.x, a.y - agents[j].h.y));
              }
            }
          },
          Promise.all(agents.map(({ sp, h }) => h.enqueue({ type: "driveTo", waypoints: [sp.tgt] }))),
          maxSteps,
        );
        let maxErr = 0;
        for (const { sp, h } of agents) {
          maxErr = Math.max(maxErr, Math.hypot(h.x - sp.tgt[0], h.y - sp.tgt[1]));
        }
        assert.equal(cHits, 0, `39 ${label} dt=${dt.toFixed(4)} had ${cHits} 6-corner hits`);
        assert.equal(sHits, 0, `39 ${label} dt=${dt.toFixed(4)} had ${sHits} SAT OBB hits`);
        assert.ok(minSep >= 1.30, `39 ${label} dt=${dt.toFixed(4)} minSep=${minSep.toFixed(3)} < 1.30`);
        assert.ok(maxErr <= 0.15, `39 ${label} dt=${dt.toFixed(4)} maxErr=${maxErr.toFixed(4)} > 0.15 m`);
        assert.ok(maxTickMs < 1500, `39 ${label} dt=${dt.toFixed(4)} maxTickMs=${maxTickMs.toFixed(1)} >= 1500 ms`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 40. Regression: M4 Iter 25 (rf_agf_359, rf_agf_580, headless ground deployable)
// ---------------------------------------------------------------------------
check("40. regression: Iter 25 rf_agf_359, rf_agf_580 (empty/loaded & outside starts), and headless (THREE:null) dropToGround->pickGroundDeployable", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const routeCases = [
    ["rf_agf_359_empty",     [ox - 33.159, oy - 9.589, 0],   2.822,  [ox + 15.160, oy - 5.690], 0],
    ["rf_agf_359_loaded",    [ox - 33.159, oy - 9.589, 0],   2.822,  [ox + 15.160, oy - 5.690], 4000012],
    ["rf_agf_580_empty",     [ox + 42.530, oy - 34.177, 0], -0.506,  [ox + 5.201, oy + 1.907],  0],
    ["rf_agf_580_loaded",    [ox + 42.530, oy - 34.177, 0], -0.506,  [ox + 5.201, oy + 1.907],  4000012],
    ["rf_agf_580_out_20_-15",[ox + 20.000, oy - 15.000, 0],  0,      [ox + 5.201, oy + 1.907],  0],
    ["rf_agf_580_west_sym",  [ox - 30.000, oy + 12.000, 0],  Math.PI,[ox - 14.700, oy + 1.907], 4000012],
    ["fuzz271_aisle_1p18m",  [ox - 25.550, oy - 27.530, 0],  0.200,  [ox - 15.150, oy - 2.380], 4000012],
    ["fuzz175_R6_south_0p69m",[ox + 18.780, oy + 32.220, 0], -1.820, [ox - 3.460, oy - 12.590], 4000012],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, wcid] of routeCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-40-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `40 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `40 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `40 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `40 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `40 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }

  // Headless (THREE: null) dropToGround -> pickGroundDeployable
  {
    const rig = makeRig({ withVehicles: false });
    const deployables = new Map();
    const mgr = createWarehouseManager({
      THREE: null,
      liveScene3d: rig.live,
      containers: new Map(),
      deployables,
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rig.sh,
    });
    mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
    try {
      const agf = mgr.spawnAgf("agf-40-headless-ground", {
        pos: [ox + 18, oy + 4.2, 0],
        heading: 0,
        carriedWcid: 4000012,
      });
      const dropTarget = [ox + 22, oy + 12, 0];
      const pDrop = agf.enqueue({ type: "dropToGround", pos: dropTarget, heading: 0 });
      await stepUntilSettled(() => mgr.tick(1 / 60), pDrop, 4000);
      assert.equal(agf.carriedWcid, 0);
      assert.equal(deployables.size, 1);
      const [dGuid, dEntry] = [...deployables.entries()][0];
      assert.equal(dEntry.model, null);
      assert.ok(Array.isArray(dEntry.rawPos), "headless ground deployable must record rawPos");
      assert.ok(Math.hypot(dEntry.rawPos[0] - dropTarget[0], dEntry.rawPos[1] - dropTarget[1]) <= 0.01);

      const pPick = agf.enqueue({ type: "pickGroundDeployable", deployableGuid: dGuid });
      await stepUntilSettled(() => mgr.tick(1 / 60), pPick, 4000);
      assert.equal(agf.carriedWcid, 4000012);
      assert.equal(deployables.size, 0);
      assert.ok(Math.hypot(agf.x - dropTarget[0], agf.y - dropTarget[1]) < 4.0, "AGF must pick near dropTarget, not drive to (0,0)");
    } finally {
      mgr.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 41. Regression: M4 Iter 26 Failure 1 (rf_agf_20261124_306 C2 +0.04m padding exemption)
// ---------------------------------------------------------------------------
check("41. regression: Iter 26 rf_agf_20261124_306 & container +0.04m padding starts settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["rf_agf_20261124_306_empty",  [ox - 23.954, oy + 39.307, 0], 1.859, [ox + 13.719, oy + 11.802], 0],
    ["rf_agf_20261124_306_loaded", [ox - 23.954, oy + 39.307, 0], 1.859, [ox + 13.719, oy + 11.802], 4000012],
    ["c1_pad_0p03m_loaded",        [ox - 40.000, oy + 39.307, 0], 1.859, [ox + 13.719, oy + 11.802], 4000012],
    ["c2_pad_0p03m_loaded",        [ox - 24.000, oy + 39.307, 0], 1.859, [ox + 13.719, oy + 11.802], 4000012],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-41-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `41 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `41 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `41 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `41 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `41 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 42. Regression: M4 Iter 26 Failure 2 (rf_agf_20261123_11) & Failure 3 (EDGE_MINE CH4 0.50-0.64 m)
// ---------------------------------------------------------------------------
check("42. regression: Iter 26 rf_agf_20261123_11 (empty/loaded) & EDGE_MINE CH4 0.50-0.64 m / C2 0.50 m settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["rf_agf_20261123_11_empty",  [ox + 33.084, oy - 22.891, 0], -2.084,         [ox - 42.796, oy + 35.318], 0],
    ["rf_agf_20261123_11_loaded", [ox + 33.084, oy - 22.891, 0], -2.084,         [ox - 42.796, oy + 35.318], 4000012],
    ["edge_CH4_0.64_0_-1",        [ox - 45.000, oy - 18.500, 0],  0,             [ox - 2.000,  oy - 39.090], 0],
    ["edge_CH4_0.58_0_-1",        [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5, [ox - 2.000,  oy - 39.030], 0],
    ["edge_CH4_0.58_1_0",         [ox - 45.000, oy - 18.500, 0],  0,             [ox - 0.800,  oy - 38.000], 0],
    ["edge_CH4_0.5_0_-1",         [ox - 45.000, oy - 18.500, 0],  0,             [ox - 2.000,  oy - 38.950], 0],
    ["edge_CH4_0.5_1_0",          [ox - 45.000, oy - 18.500, 0],  0,             [ox - 0.880,  oy - 38.000], 0],
    ["edge_C2_0.5_-1_0_E",        [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5, [ox - 25.720, oy + 32.500], 0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-42-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `42 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `42 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `42 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `42 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `42 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 43. Regression: M4 Iter 27 Failures 1 & 2 (tt_11 / L1 & L2 0.620 m + CONTAINER_PAD_ADVERSARIAL 0.020-0.041 m)
// ---------------------------------------------------------------------------
check("43. regression: Iter 27 tt_11 / L1 & L2 0.620 m south-edge departure & CONTAINER_PAD_ADVERSARIAL 0.020-0.041 m loaded settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["tt_11_loaded",                  [ox - 46.0, oy - 15.270, 0],  Math.PI * 0.5, [ox - 24.0, oy + 25.784], 4000012],
    ["tt_11_empty",                   [ox - 46.0, oy - 15.270, 0],  Math.PI * 0.5, [ox - 24.0, oy + 25.784], 0],
    ["L2_0.620_east_loaded",          [ox - 38.0, oy - 15.270, 0],  Math.PI * 0.5, [ox - 24.0, oy + 25.784], 4000012],
    ["pad_C1_gap0.02_east_loaded",    [ox - 40.0, oy + 39.186, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C1_gap0.03_east_loaded",    [ox - 40.0, oy + 39.196, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C1_gap0.04_east_loaded",    [ox - 40.0, oy + 39.206, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C2_gap0.02_east_loaded",    [ox - 24.0, oy + 39.186, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C2_gap0.03_east_loaded",    [ox - 24.0, oy + 39.196, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C3_gap0.03_east_loaded",    [ox -  8.0, oy + 33.059, 0],  Math.PI * 0.5, [ox - 21.0, oy + 20.000], 4000012],
    ["pad_C1_gap0.02_straight8m",     [ox - 40.0, oy + 39.186, 0],  Math.PI * 0.5, [ox - 32.0, oy + 39.200], 4000012],
    ["pad_C1_west_0.03_north_loaded", [ox - 41.819, oy + 32.500, 0], 0,            [ox - 41.819, oy + 40.500], 4000012],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-43-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `43 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `43 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `43 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `43 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `43 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 44. Regression: M4 Iter 27 Failure 3 (idx=296, si=99->S10 0.64 m, zoneA_45, edge_C2_0.5_-1_0 & C1/C2/C3 flanks)
// ---------------------------------------------------------------------------
check("44. regression: Iter 27 idx=296, si=99->S10 0.64 m, zoneA_45, edge_C2_0.5_-1_0, C1/C3 flanks & west mouth settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["idx=296_empty",        [ox - 24.850, oy - 26.300, 0], -2.120,            [ox + 7.780,  oy + 2.410],  0],
    ["idx=296_loaded",       [ox - 24.850, oy - 26.300, 0], -2.120,            [ox + 7.780,  oy + 2.410],  4000012],
    ["si=99->S10_0.64_emp",  [ox - 12.000, oy - 38.000, 0],  3 * Math.PI / 4,  [ox - 7.500,  oy - 25.210], 0],
    ["si=99->S10_0.64_load", [ox - 12.000, oy - 38.000, 0],  3 * Math.PI / 4,  [ox - 7.500,  oy - 25.210], 4000012],
    ["zoneA_45_empty",       [ox - 40.000, oy + 41.000, 0], -Math.PI * 0.5,    [ox - 25.720, oy + 32.500], 0],
    ["zoneA_45_loaded",      [ox - 40.000, oy + 41.000, 0], -Math.PI * 0.5,    [ox - 25.720, oy + 32.500], 4000012],
    ["edge_C2_0.5_-1_0",     [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5,    [ox - 25.719, oy + 32.500], 0],
    ["edge_C2_0.5_-1_0_ld",  [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5,    [ox - 25.719, oy + 32.500], 4000012],
    ["edge_C3_0.58_-1_0",    [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5,    [ox - 9.799,  oy + 29.430], 0],
    ["edge_C1_0.58_1_0",     [ox + 20.000, oy - 29.000, 0], -Math.PI * 0.5,    [ox - 38.201, oy + 32.500], 0],
    ["west_mouth_sym",       [ox + 24.850, oy - 26.300, 0],  2.120,            [ox - 17.280, oy + 2.410],  0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-44-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `44 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `44 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `44 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `44 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `44 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 45. Regression: M4 Iter 28 AGF Failures 1, 2, 3 (CH4_N_0.58, C2_south_0.620m, 20261121_i370)
// ---------------------------------------------------------------------------
check("45. regression: Iter 28 CH4_N_0.58, C2_south_0.620m (tt_22 / L1 & L2 / S2..S6) & 20261121_i370 settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["CH4_N_0.58_-12_-38",       [ox - 12.0,   oy - 38.0,   0],  0,              [ox - 2.0,  oy - 36.970], 0],
    ["CH4_N_0.58_-21_+20",       [ox - 21.0,   oy + 20.0,   0],  Math.PI,        [ox - 2.0,  oy - 36.970], 0],
    ["CH4_N_0.58_zA_-24_41",     [ox - 24.0,   oy + 41.0,   0],  Math.PI * 0.5,  [ox - 2.0,  oy - 36.970], 0],
    ["tt_22_R1_N_0.64_W_emp",    [ox - 10.0,   oy + 6.540,  0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["tt_22_R1_N_0.64_W_ld",     [ox - 10.0,   oy + 6.540,  0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 4000012],
    ["L2_S_0.63_W_ld",           [ox - 38.0,   oy - 15.280, 0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 4000012],
    ["L2_S_0.64_W_ld",           [ox - 38.0,   oy - 15.290, 0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 4000012],
    ["L2_S_0.65_W_ld",           [ox - 38.0,   oy - 15.300, 0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 4000012],
    ["L2_S_0.64_E",              [ox - 38.0,   oy - 15.290, 0],  Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["L1_S_0.64_W",              [ox - 46.0,   oy - 15.290, 0], -Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["L1_N_0.64",                [ox - 46.0,   oy - 12.710, 0],  Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["L2_N_0.64",                [ox - 38.0,   oy - 12.710, 0],  Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["L1_E_0.64",                [ox - 44.690, oy - 14.0,   0],  0,              [ox - 24.0, oy + 25.784], 0],
    ["L1_W_0.64",                [ox - 47.310, oy - 14.0,   0],  0,              [ox - 24.0, oy + 25.784], 0],
    ["S2_to_C2_S_0.620",         [ox + 12.05,  oy + 1.8,    0],  Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["S6_to_C2_S_0.620",         [ox + 12.05,  oy - 10.2,   0],  Math.PI * 0.5,  [ox - 24.0, oy + 25.784], 0],
    ["20261121_i370_emp",        [ox - 30.731, oy + 41.647, 0],  1.499,          [ox - 8.522, oy - 25.527], 0],
    ["20261121_i370_ld",         [ox - 30.731, oy + 41.647, 0],  1.499,          [ox - 8.522, oy - 25.527], 4000012],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-45-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(cornerHits, 0, `45 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `45 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `45 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `45 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `45 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 46. Regression: M4 Iter 27 Failure 4 (AMR S1/S6 0.58 m stand/gap & rack close-target timeouts)
// ---------------------------------------------------------------------------
check("46. regression: Iter 27 AMR amr_edge_S1/S6 0.58 m stand/gap & amr_fuzz_145/169/20261123_0 rack close targets settle with 0 4-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAmrHits = (amr, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < amrHullCorners.length; ci++) {
      const [lx, ly] = amrHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    for (const b of obbs) {
      if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) satHits++;
    }
    return { cornerHits, satHits };
  };

  const amrCases = [
    ["amr_edge_S1_0.58_-1_0",   [ox + 19.000, oy - 29.000, 0], 0,              [ox + 12.850, oy + 4.200]],
    ["amr_edge_S1_0.58_0_-1",   [ox + 19.000, oy - 29.000, 0], 0,              [ox + 14.000, oy + 2.980]],
    ["amr_edge_S1_0.58_0_-1_W", [ox - 46.000, oy - 18.000, 0], 0,              [ox + 14.000, oy + 2.980]],
    ["amr_edge_S6_0.58_0_1",    [ox + 19.000, oy - 29.000, 0], 0,              [ox + 14.000, oy - 8.980]],
    ["amr_edge_S6_0.58_0_1_W",  [ox - 46.000, oy - 18.000, 0], 0,              [ox + 14.000, oy - 8.980]],
    ["amr_fuzz_145_R2_3_0.515", [ox + 16.896, oy + 25.719, 0], 0,              [ox + 1.431,  oy - 1.715]],
    ["amr_fuzz_169_R1_0.441",   [ox - 20.000, oy + 10.000, 0], 0,              [ox - 13.228, oy + 4.359]],
    ["amr_fuzz_20261123_0_R1",  [ox -  3.172, oy + 14.471, 0], -0.091,         [ox - 10.213, oy + 6.365]],
    ["amr_fuzz_145_depart",     [ox +  1.431, oy -  1.715, 0], Math.PI * 0.5,  [ox + 16.896, oy + 25.719]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, tPos] of amrCases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const amr = mgr.spawnAmr(`amr-46-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        let satObbHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            const h = checkAmrHits(amr, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          amr.enqueue({ type: "driveTo", waypoints: [tPos] }),
          maxSteps,
        );
        assert.equal(cornerHits, 0, `46 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 4-corner hits`);
        assert.equal(satObbHits, 0, `46 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(Math.hypot(amr.x - tPos[0], amr.y - tPos[1]) <= 0.15, `46 ${label} dt=${dt.toFixed(4)} pose err > 0.15 m`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 47. Regression: M4 Iter 29 AGF +0.04m container pad, CH4/CH7/CH3/CH8 matrix & tt_14, uAgf_185 Minkowski, & Zone A flank -> C2_W_0.50
// ---------------------------------------------------------------------------
check("47. regression: Iter 29 AGF +0.04m container pad (C1_E_0.02/0.03_S), CH4/CH7/CH3/CH8 matrix & tt_14, uAgf_185 Minkowski, & Zone A flank -> C2_W_0.50 settle with 0 6-corner & SAT OBB hits and initMs < 2500 ms at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["caveat_pad_C1_E_0.02_S_emp", [ox - 38.191, oy + 32.500, 0],  Math.PI,       [ox - 21.000, oy + 20.000], 0],
    ["caveat_pad_C1_E_0.03_S_ld",  [ox - 38.181, oy + 32.500, 0],  Math.PI,       [ox - 21.000, oy + 20.000], 4000012],
    ["pad_C2_W_0.025_N_ld",        [ox - 25.795, oy + 32.500, 0],  0,             [ox - 21.000, oy + 20.000], 4000012],
    ["pad_C3_S_0.025_E_ld",        [ox -  8.000, oy + 25.195, 0],  Math.PI * 0.5, [ox + 10.000, oy - 21.970], 4000012],
    ["CH4_N_0.58_from_S",          [ox -  4.000, oy - 40.500, 0], -Math.PI * 0.5, [ox -  2.000, oy - 36.970], 0],
    ["CH7_N_0.58_from_-4_-40.5",   [ox -  4.000, oy - 40.500, 0], -Math.PI * 0.5, [ox + 10.000, oy - 36.970], 0],
    ["CH7_N_0.58_from_14_-40.8",   [ox + 14.000, oy - 40.800, 0],  0.5,           [ox + 10.000, oy - 36.970], 0],
    ["CH1_W_0.65_hPI->CH7_S",      [ox - 15.200, oy - 38.000, 0],  Math.PI,       [ox + 10.000, oy - 39.030], 0],
    ["CH7_W_0.65_hPI->CH3_N",      [ox +  8.800, oy - 38.000, 0],  Math.PI,       [ox -  6.000, oy - 36.970], 0],
    ["CH1_N_0.58_hPI2->CH8_N",     [ox - 14.000, oy - 36.970, 0],  Math.PI * 0.5, [ox + 14.000, oy - 36.970], 0],
    ["CH6_S_0.58_h-PI2->CH5_N",    [ox +  6.000, oy - 39.030, 0], -Math.PI * 0.5, [ox +  2.000, oy - 36.970], 0],
    ["tt_14",                      [ox -  2.000, oy - 36.970, 0],  Math.PI * 0.5, [ox -  8.000, oy + 24.500], 0],
    ["uAgf_185",                   [ox + 36.562, oy +  2.174, 0], -Math.PI * 0.5, [ox +  6.816, oy +  1.865], 0],
    ["zA_n24_41_E->C2_W_0.50",     [ox - 24.000, oy + 41.000, 0],  Math.PI * 0.5, [ox - 25.719, oy + 32.500], 0],
    ["zA_n24_41_W->C2_W_0.50",     [ox - 24.000, oy + 41.000, 0], -Math.PI * 0.5, [ox - 25.719, oy + 32.500], 0],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, wcid] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-47-${label}`, { pos: sPos, heading: sH, carriedWcid: wcid });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        let settled = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        p.then(() => { settled = true; });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        // Verify post-arrival idle ticks preserve parked close-wall pose
        for (let k = 0; k < 30; k++) {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          cornerHits += h.cornerHits;
          satObbHits += h.satHits;
        }
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(settled, true, `47 ${label} dt=${dt.toFixed(4)} did not settle`);
        assert.equal(cornerHits, 0, `47 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `47 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(err <= 0.15, `47 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `47 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `47 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 48. Regression: M4 Iter 28 Failure 2 (AMR explicit-heading parallel close targets & unheaded multi-wp §3)
// ---------------------------------------------------------------------------
check("48. regression: Iter 28 AMR explicit-heading parallel close targets (R1..R4, C1..C3, S1..S6, L1..L2, 0.40-0.65 m, reverseSlide & unheaded multi-wp) settle with 0 4-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const amrHullCorners = [[-0.39, -0.52], [0.39, -0.52], [-0.39, 0.52], [0.39, 0.52]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = (extra = []) => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
      ...extra,
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAmrHits = (amr, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < amrHullCorners.length; ci++) {
      const [lx, ly] = amrHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, amr.x, amr.y, amr.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    for (const b of obbs) {
      if (satObbHit(amr.x, amr.y, amr.heading, 0.39, 0.52, b)) satHits++;
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["amr_explicitH_R1_S_0.44",        [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 10.0,   y: oy + 4.360,  heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_R1_S_0.44_from_W", [ox - 25.0, oy + 10.0, 0], Math.PI,       [{ x: ox - 10.0,   y: oy + 4.360,  heading: -Math.PI * 0.5 }], []],
    ["amr_explicitH_C1_W_0.44",        [ox - 46.0, oy + 10.0, 0], 0,             [{ x: ox - 41.659, y: oy + 32.500, heading: 0 }], []],
    ["amr_explicitH_C1_W_0.40",        [ox - 46.0, oy + 10.0, 0], 0,             [{ x: ox - 41.619, y: oy + 32.500, heading: 0 }], []],
    ["amr_explicitH_R1_N_0.40_far",    [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 5.0,    y: oy + 6.300,  heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_R2_N_0.40_far",    [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 6.0,    y: oy + 1.600,  heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_R3_N_0.40_far",    [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 4.0,    y: oy - 4.400,  heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_R4_S_0.44_rev",    [ox - 8.0,  oy - 12.34,0], -Math.PI * 0.5,[{ x: ox - 8.0,    y: oy - 12.340, heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_C2_E_0.44_perp",   [ox - 20.5, oy + 27.5, 0], Math.PI * 0.5, [{ x: ox - 22.341, y: oy + 32.500, heading: Math.PI }], []],
    ["amr_explicitH_C3_W_0.40_near",   [ox - 11.6, oy + 29.43,0], Math.PI * 0.5, [{ x: ox - 9.619,  y: oy + 29.430, heading: 0 }], []],
    ["amr_explicitH_S3_E_0.40_far",    [ox - 20.0, oy - 20.0, 0], 0,             [{ x: ox + 14.970, y: oy - 1.800,  heading: 0 }], []],
    ["amr_explicitH_S1_S2_gap_0.56",   [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox + 14.0,   y: oy + 3.000,  heading: -Math.PI * 0.5 }], []],
    ["amr_explicitH_L1_N_0.40_far",    [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 46.0,   y: oy - 12.950, heading: Math.PI * 0.5 }], []],
    ["amr_explicitH_L2_W_0.44_rev",    [ox - 39.11,oy - 14.0, 0], Math.PI,       [{ x: ox - 39.110, y: oy - 14.000, heading: 0 }], []],
    ["amr_explicitH_reverseSlide_blk", [ox + 19.0, oy - 29.0, 0], 0,             [{ x: ox - 10.0,   y: oy + 4.360,  heading: Math.PI * 0.5 }], [{ guid: 99901, kind: 10, pos: [ox - 19.0, oy + 4.36, 0] }]],
    ["amr_unheaded_multi_wp_R1_S",     [ox - 10.0, oy + 2.0,  0], 0,             [[ox - 10.0, oy + 2.5], [ox - 10.0, oy + 4.36]], []],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 8000 : 4000;
    for (const [label, sPos, sH, wps, extraC] of cases) {
      const cMap = makeDefaultContainers(extraC);
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const amr = mgr.spawnAmr(`amr-48-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        let satObbHits = 0;
        await stepUntilSettled(
          () => {
            mgr.tick(dt);
            const h = checkAmrHits(amr, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          amr.enqueue({ type: "driveTo", waypoints: wps }),
          maxSteps,
        );
        // Verify post-arrival idle ticks preserve parked close-wall pose
        for (let k = 0; k < 30; k++) {
          mgr.tick(dt);
          const h = checkAmrHits(amr, obbs);
          cornerHits += h.cornerHits;
          satObbHits += h.satHits;
        }
        const last = wps[wps.length - 1];
        const tx = Array.isArray(last) ? last[0] : last.x;
        const ty = Array.isArray(last) ? last[1] : last.y;
        const th = Array.isArray(last) ? null : last.heading;
        assert.equal(cornerHits, 0, `48 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 4-corner hits`);
        assert.equal(satObbHits, 0, `48 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(Math.hypot(amr.x - tx, amr.y - ty) <= 0.15, `48 ${label} dt=${dt.toFixed(4)} pose err > 0.15 m`);
        if (th !== null) {
          const yawErr = Math.abs(((th - amr.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          assert.ok(yawErr <= 0.05, `48 ${label} dt=${dt.toFixed(4)} yawErr ${yawErr.toFixed(4)} > 0.05 rad`);
        }
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 49. Regression: M4 Iter 29 Failures 1-4 (CH_MATRIX live collisions/unreachables, R1..R6 & S10 0.58 m departures, fuzz_20261123_155, pre/post-task 30-tick AGF idle stability)
// ---------------------------------------------------------------------------
check("49. regression: Iter 29 Failures 1-4 (CH_MATRIX, R1_N/S10_N 0.58 m departures, fuzz_20261123_155 & AGF pre/post-task 30-tick idle stability) settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = (extra = []) => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
      ...extra,
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  // Multi-obstacle idle stability (two close containers 1.162 m apart -> 0.581 m physical flank clearance on both sides)
  {
    const cMapMulti = makeDefaultContainers([
      { guid: 91001, kind: 11, pos: [ox - 31.8, oy + 32.5, 0] },
      { guid: 91002, kind: 11, pos: [ox - 28.2, oy + 32.5, 0] },
    ]);
    const rigM = makeRig({ withVehicles: false });
    const mgrM = createWarehouseManager({
      THREE,
      liveScene3d: rigM.live,
      containers: cMapMulti,
      deployables: new Map(),
      palletJacks: new Map(),
      trailers: new Map(),
      logisticsAudio: null,
      sh: () => rigM.sh,
    });
    mgrM.buildHub({ origin: NE_FLATLAND_SITE.origin });
    const obbsM = getObbs(mgrM, cMapMulti);
    try {
      const agfM = mgrM.spawnAgf("agf-49-multi-idle", { pos: [ox - 30.0, oy + 32.5, 0], heading: 0 });
      for (let k = 0; k < 30; k++) {
        mgrM.tick(1 / 60);
        const h = checkAgfHits(agfM, obbsM);
        assert.equal(h.cornerHits, 0, "49 multi-idle 6-corner hit");
        assert.equal(h.satHits, 0, "49 multi-idle SAT OBB hit");
      }
      const multiDrift = Math.hypot(agfM.x - (ox - 30.0), agfM.y - (oy + 32.5));
      assert.ok(multiDrift <= 1e-4, `49 multi-idle drifted ${multiDrift.toFixed(6)} m`);
    } finally {
      mgrM.dispose();
    }
  }

  const cases = [
    ["S_CH1_W_0.58->CH6_N_0.60",  [ox - 15.200, oy - 38.000, 0],  Math.PI,       [ox +  6.000, oy - 36.950], false],
    ["S_CH4_N_0.58->CH2_W_0.65",  [ox -  2.000, oy - 36.970, 0],  Math.PI * 0.5, [ox - 11.270, oy - 38.000], true],
    ["S_CH4_N_0.58->CH4_E_0.58",  [ox -  2.000, oy - 36.970, 0],  Math.PI * 0.5, [ox -  0.800, oy - 38.000], false],
    ["S_CH6_S_0.58->CH5_W_0.58",  [ox +  6.000, oy - 39.030, 0], -Math.PI * 0.5, [ox +  0.800, oy - 38.000], false],
    ["depart_R1_N_0.58",          [ox -  5.000, oy +  6.480, 0],  Math.PI * 0.5, [ox + 10.000, oy + 20.000], true],
    ["S10_N_0.58_depart_E",       [ox -  7.500, oy - 22.850, 0],  Math.PI * 0.5, [ox + 10.000, oy + 20.000], false],
    ["fuzz_20261123_155",         [ox + 44.991, oy -  8.134, 0], -0.257,         [ox + 11.104, oy - 39.010], false],
    ["zA_n24_41_E->C2_W_0.50",    [ox - 24.000, oy + 41.000, 0],  Math.PI * 0.5, [ox - 25.719, oy + 32.500], false],
    ["preidle_C1_E_0.02",         [ox - 38.191, oy + 32.500, 0],  Math.PI,       [ox - 21.000, oy + 20.000], true],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos, preIdle] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-49-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        let satObbHits = 0;
        if (preIdle) {
          for (let k = 0; k < 30; k++) {
            mgr.tick(dt);
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          }
          const preShift = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
          assert.ok(preShift <= 1e-4, `49 ${label} dt=${dt.toFixed(4)} pre-task idle shift ${preShift.toFixed(6)} > 1e-4 m`);
        }
        let initMs = 0;
        let sawTransit = false;
        let settled = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        p.then(() => { settled = true; });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const xSettle = agf.x;
        const ySettle = agf.y;
        for (let k = 0; k < 30; k++) {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          cornerHits += h.cornerHits;
          satObbHits += h.satHits;
        }
        const postDrift = Math.hypot(agf.x - xSettle, agf.y - ySettle);
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(settled, true, `49 ${label} dt=${dt.toFixed(4)} did not settle`);
        assert.equal(cornerHits, 0, `49 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `49 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(postDrift <= 1e-4, `49 ${label} dt=${dt.toFixed(4)} post-arrival idle drift ${postDrift.toFixed(6)} > 1e-4 m`);
        assert.ok(err <= 0.15, `49 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `49 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `49 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 50. Regression: M4 Iter 30 Challenger Failures (R1_N_0.58->R6_S_0.58/0.60, fuzz_20261127_226, S_CH1_S_0.58->CH1_E_0.60 idle stability, & fuzz_20261128_28 apron transit speed)
// ---------------------------------------------------------------------------
check("50. regression: Iter 30 AGF failures (R1_N_0.58->R6_S_0.58/0.60, fuzz_20261127_226, S_CH1_S_0.58->CH1_E_0.60 idle drift & fuzz_20261128_28 speed) settle with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["R1_N_0.58->R6_S_0.58",     [ox -  5.000, oy +  6.480, 0],  Math.PI * 0.5, [ox -  5.000, oy - 12.480]],
    ["R1_N_0.58->R6_S_0.60",     [ox -  5.000, oy +  6.480, 0],  Math.PI * 0.5, [ox -  5.000, oy - 12.500]],
    ["fuzz_20261127_226",        [ox + 10.925, oy +  8.707, 0],  2.871,         [ox + 16.375, oy - 25.544]],
    ["S_CH1_S_0.58->CH1_E_0.60", [ox - 14.000, oy - 39.030, 0], -Math.PI * 0.5, [ox - 12.780, oy - 38.000]],
    ["fuzz_20261128_28",         [ox + 26.594, oy - 43.738, 0], -0.738,         [ox - 37.490, oy + 30.260]],
  ];

  for (const dt of [1 / 60, 1 / 30]) {
    const maxSteps = dt < 0.025 ? 10000 : 5000;
    for (const [label, sPos, sH, tPos] of cases) {
      const cMap = makeDefaultContainers();
      const rig = makeRig({ withVehicles: false });
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: cMap,
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sh,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const obbs = getObbs(mgr, cMap);
      try {
        const agf = mgr.spawnAgf(`agf-50-${label}`, { pos: sPos, heading: sH });
        let cornerHits = 0;
        let satObbHits = 0;
        let initMs = 0;
        let sawTransit = false;
        let settled = false;
        const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
        p.then(() => { settled = true; });
        const { steps } = await stepUntilSettled(
          (stepIdx) => {
            const t0 = stepIdx === 0 ? performance.now() : 0;
            mgr.tick(dt);
            if (stepIdx === 0) initMs = performance.now() - t0;
            if (agf.statusMode === "transit") sawTransit = true;
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          },
          p,
          maxSteps,
        );
        const xSettle = agf.x;
        const ySettle = agf.y;
        for (let k = 0; k < 30; k++) {
          mgr.tick(dt);
          const h = checkAgfHits(agf, obbs);
          cornerHits += h.cornerHits;
          satObbHits += h.satHits;
        }
        const postDrift = Math.hypot(agf.x - xSettle, agf.y - ySettle);
        const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
        const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
        assert.equal(settled, true, `50 ${label} dt=${dt.toFixed(4)} did not settle`);
        assert.equal(cornerHits, 0, `50 ${label} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
        assert.equal(satObbHits, 0, `50 ${label} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
        assert.ok(postDrift <= 1e-4, `50 ${label} dt=${dt.toFixed(4)} post-arrival idle drift ${postDrift.toFixed(6)} > 1e-4 m`);
        assert.ok(err <= 0.15, `50 ${label} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
        assert.ok(initMs < 2500, `50 ${label} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
        assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `50 ${label} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
      } finally {
        mgr.dispose();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 51. Regression: M4 Iter 31 Challenger Tight-Clearance AGF Failures (tight_88, tight_107, tight_136, C1_E_0.02_short, & Zone C tight stand-flank siblings)
// ---------------------------------------------------------------------------
check("51. regression: Iter 31 tight-clearance AGF failures (tight_88, tight_107, tight_136, C1_E_0.02_short & Zone C tight siblings) settle empty & 4000012 loaded with 0 6-corner & SAT OBB hits at dt=1/60 and 1/30", async () => {
  const [ox, oy] = NE_FLATLAND_SITE.origin;
  const agfHullCorners = [[-0.57, -1.93], [0.57, -1.93], [-0.57, 0.15], [0.57, 0.15], [-0.34, 1.30], [0.34, 1.30]];
  const stHalfW = STAND_SPECS.outerWidthM * 0.5;
  const stHalfD = STAND_SPECS.outerDepthM * 0.5;
  const ltHalfW = LIFT_TABLE_SPECS.outerWidthM * 0.5;
  const ltHalfD = LIFT_TABLE_SPECS.outerDepthM * 0.5;
  const chHalfW = CHARGER_SPECS.widthM * 0.5;
  const chHalfD = CHARGER_SPECS.depthM * 0.5;

  const makeDefaultContainers = () => {
    const map = new Map();
    for (const d of [
      { guid: 38145, kind: 11, pos: [ox - 40, oy + 32.5, 0] },
      { guid: 38146, kind: 12, pos: [ox - 24, oy + 32.5, 0] },
      { guid: 38147, kind: 10, pos: [ox - 8, oy + 29.43, 0] },
    ]) {
      map.set(d.guid, {
        guid: d.guid,
        wcid: d.kind === 10 ? 4000020 : d.kind === 11 ? 4000021 : 4000022,
        kind: d.kind,
        heading: 0,
        rawPos: [...d.pos],
        currentDoorProgress: 1.0,
        slots: [],
        model: { root: { position: { x: d.pos[0], y: d.pos[1], z: 0 } }, syncSlots() {} },
      });
    }
    return map;
  };

  const getObbs = (mgr, containersMap) => {
    const list = [];
    for (const r of mgr.racks.values()) {
      const b = r.worldBounds;
      if (b) list.push({ cx: (b.minX + b.maxX) * 0.5, cy: (b.minY + b.maxY) * 0.5, h: 0, hw: (b.maxX - b.minX) * 0.5, hl: (b.maxY - b.minY) * 0.5 });
    }
    for (const st of mgr.stands.values()) list.push({ cx: st.pos[0], cy: st.pos[1], h: st.heading, hw: stHalfW, hl: stHalfD });
    for (const lt of mgr.liftTables.values()) list.push({ cx: lt.x, cy: lt.y, h: 0, hw: ltHalfW, hl: ltHalfD });
    for (const c of mgr.chargers.values()) list.push({ cx: c.pos[0], cy: c.pos[1], h: c.heading || 0, hw: chHalfW, hl: chHalfD });
    for (const ce of containersMap.values()) {
      const p = ce.rawPos;
      list.push({ cx: p[0], cy: p[1], h: ce.heading || 0, hw: 1.219, hl: ce.kind === 10 ? 3.029 : 6.096 });
    }
    return list;
  };

  const satObbHit = (cx, cy, h, hw, hl, ob) => {
    const aU = [Math.cos(h), -Math.sin(h)];
    const aV = [Math.sin(h), Math.cos(h)];
    const bU = [Math.cos(ob.h), -Math.sin(ob.h)];
    const bV = [Math.sin(ob.h), Math.cos(ob.h)];
    const dx = ob.cx - cx;
    const dy = ob.cy - cy;
    for (const [nx, ny] of [aU, aV, bU, bV]) {
      const dist = Math.abs(dx * nx + dy * ny);
      const rA = hw * Math.abs(aU[0] * nx + aU[1] * ny) + hl * Math.abs(aV[0] * nx + aV[1] * ny);
      const rB = ob.hw * Math.abs(bU[0] * nx + bU[1] * ny) + ob.hl * Math.abs(bV[0] * nx + bV[1] * ny);
      if (dist >= rA + rB - 1e-4) return false;
    }
    return true;
  };

  const checkAgfHits = (agf, obbs) => {
    let cornerHits = 0;
    let satHits = 0;
    for (let ci = 0; ci < agfHullCorners.length; ci++) {
      const [lx, ly] = agfHullCorners[ci];
      const [wx, wy] = localToWorld2D(lx, ly, agf.x, agf.y, agf.heading);
      for (const b of obbs) {
        const dx = wx - b.cx;
        const dy = wy - b.cy;
        const c = Math.cos(b.h);
        const s = Math.sin(b.h);
        const bx = dx * c - dy * s;
        const by = dx * s + dy * c;
        if (Math.abs(bx) < b.hw - 1e-4 && Math.abs(by) < b.hl - 1e-4) cornerHits++;
      }
    }
    const [chX, chY] = localToWorld2D(0, -0.89, agf.x, agf.y, agf.heading);
    const [fkX, fkY] = localToWorld2D(0, 0.725, agf.x, agf.y, agf.heading);
    for (const b of obbs) {
      if (satObbHit(chX, chY, agf.heading, 0.57, 1.04, b) || satObbHit(fkX, fkY, agf.heading, 0.34, 0.575, b)) {
        satHits++;
      }
    }
    return { cornerHits, satHits };
  };

  const cases = [
    ["tight_88",        [ox +  1.030, oy +  3.996, 0], -1.208, [ox +  0.080, oy - 23.932]],
    ["tight_107",       [ox +  2.630, oy +  4.181, 0],  1.453, [ox -  0.340, oy -  9.776]],
    ["tight_136",       [ox +  3.362, oy - 22.650, 0], -2.171, [ox - 23.340, oy + 39.520]],
    ["C1_E_0.02_short", [ox - 37.000, oy + 32.500, 0],  0,     [ox - 38.191, oy + 32.500]],
    ["zoneC_S3_flank",  [ox -  0.076, oy +  1.927, 0], -1.571, [ox + 12.745, oy -  2.267]],
    ["zoneC_S2S3_gap",  [ox -  0.544, oy - 38.538, 0], -2.749, [ox + 13.649, oy -  0.267]],
  ];

  for (const wcid of [0, 4000012]) {
    for (const dt of [1 / 60, 1 / 30]) {
      const maxSteps = dt < 0.025 ? 10000 : 5000;
      for (const [label, sPos, sH, tPos] of cases) {
        const cMap = makeDefaultContainers();
        const rig = makeRig({ withVehicles: false });
        const mgr = createWarehouseManager({
          THREE,
          liveScene3d: rig.live,
          containers: cMap,
          deployables: new Map(),
          palletJacks: new Map(),
          trailers: new Map(),
          logisticsAudio: null,
          sh: () => rig.sh,
        });
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const obbs = getObbs(mgr, cMap);
        try {
          const agf = mgr.spawnAgf(`agf-51-${label}-${wcid}`, { pos: sPos, heading: sH, carriedWcid: wcid });
          let cornerHits = 0;
          let satObbHits = 0;
          let initMs = 0;
          let sawTransit = false;
          let settled = false;
          const p = agf.enqueue({ type: "driveTo", waypoints: [tPos] });
          p.then(() => { settled = true; });
          const { steps } = await stepUntilSettled(
            (stepIdx) => {
              const t0 = stepIdx === 0 ? performance.now() : 0;
              mgr.tick(dt);
              if (stepIdx === 0) initMs = performance.now() - t0;
              if (agf.statusMode === "transit") sawTransit = true;
              const h = checkAgfHits(agf, obbs);
              cornerHits += h.cornerHits;
              satObbHits += h.satHits;
            },
            p,
            maxSteps,
          );
          const xSettle = agf.x;
          const ySettle = agf.y;
          for (let k = 0; k < 30; k++) {
            mgr.tick(dt);
            const h = checkAgfHits(agf, obbs);
            cornerHits += h.cornerHits;
            satObbHits += h.satHits;
          }
          const postDrift = Math.hypot(agf.x - xSettle, agf.y - ySettle);
          const err = Math.hypot(agf.x - tPos[0], agf.y - tPos[1]);
          const movedDist = Math.hypot(agf.x - sPos[0], agf.y - sPos[1]);
          assert.equal(settled, true, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} did not settle`);
          assert.equal(cornerHits, 0, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} had ${cornerHits} 6-corner hits`);
          assert.equal(satObbHits, 0, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} had ${satObbHits} SAT OBB hits`);
          assert.ok(postDrift <= 1e-4, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} post-arrival idle drift ${postDrift.toFixed(6)} > 1e-4 m`);
          assert.ok(err <= 0.15, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} pose err ${err.toFixed(4)} > 0.15 m`);
          assert.ok(initMs < 2500, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} initMs=${initMs.toFixed(1)} >= 2500 ms`);
          assert.ok(steps >= 2 && movedDist >= 1.0 && sawTransit, `51 ${label} wcid=${wcid} dt=${dt.toFixed(4)} aborted at start (steps=${steps}, moved=${movedDist.toFixed(2)})`);
        } finally {
          mgr.dispose();
        }
      }
    }
  }
});

for (const { name, fn } of queue) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

console.log(`\nvehicle_warehouse_manager: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
