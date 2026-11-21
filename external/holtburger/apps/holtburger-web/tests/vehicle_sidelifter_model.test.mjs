// tests/vehicle_sidelifter_model.test.mjs — Sidelifter 3D Model (`WCID 4000032`),
// Trailer Kind Resolution, Container Bay Highlight (`setHighlightedSlot`), and Sidelifter Audio.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  SIDELIFTER_WCID,
  SIDELIFT_PHASE,
  SIDELIFTER_SPECS,
  manifest as sidelifterManifest,
  buildSidelifterTrailer,
} from "../scene3d/vehicle/sidelifter_model.js";
import {
  TRAILER_WCID,
  TRAILER_DEPLOYABLE_KIND,
  CHASSIS_DECK_Z,
  CHASSIS_KINGPIN_Z,
  TWISTLOCK_STATE,
  isSidelifterKind,
  resolveTrailerKind,
} from "../scene3d/vehicle/trailer_models.js";
import {
  buildIsoContainer,
  CONTAINER_WCID,
  PINWHEEL_SLOTS_20,
  PINWHEEL_SLOTS_40,
} from "../scene3d/vehicle/container_models.js";
import { buildSemiTruck } from "../scene3d/vehicle/semi_truck_model.js";
import { buildDeployable, DEPLOYABLE_WCID } from "../scene3d/vehicle/deployable_models.js";
import { buildDeployedRadar } from "../scene3d/vehicle/radar_model.js";
import {
  LOGISTICS_AUDIO_TUNING,
  createLogisticsAudio,
  acToThreePos,
} from "../scene3d/vehicle/audio.js";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-4, msg = "near") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

function countDrawCalls(root) {
  let calls = 0;
  root.traverse((o) => {
    if (o.isMesh || o.isLine || o.isSprite || o.isPoints) calls++;
  });
  return calls;
}

function countLights(root) {
  let lights = 0;
  root.traverse((o) => {
    if (o.isLight) lights++;
  });
  return lights;
}

// --- Minimal Audio Context Mocks ---
function rparam(init = 0) {
  return {
    value: init,
    calls: [],
    setValueAtTime(v, t) { this.calls.push(["set", v, t]); this.value = v; },
    setTargetAtTime(v, t, tau) { this.calls.push(["target", v, t, tau]); this.value = v; },
    linearRampToValueAtTime(v, t) { this.calls.push(["lin", v, t]); this.value = v; },
    exponentialRampToValueAtTime(v, t) { this.calls.push(["exp", v, t]); this.value = v; },
    cancelScheduledValues(t) { this.calls.push(["cancel", t]); },
  };
}

class LogisticsFakeCtx {
  constructor() {
    this.sampleRate = 8000;
    this.currentTime = 0;
    this.state = "running";
    this.made = [];
    this.resumes = 0;
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
      started: null,
      stopAt: null,
      stopped: false,
      onended: null,
      start(t = 0) { this.started = t; },
      stop(t) { this.stopped = true; this.stopAt = t === undefined ? "now" : t; },
      ...extra,
    });
  }
  createOscillator() {
    return this._src("osc", { type: "sine", frequency: rparam(440) });
  }
  createBiquadFilter() {
    return this._n("biquad", { type: "lowpass", frequency: rparam(350), Q: rparam(1), gain: rparam(0) });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() {
    return this._src("bufsrc", { buffer: null, loop: false });
  }
  createGain() {
    return this._n("gain", { gain: rparam(1) });
  }
  createPanner() {
    return this._n("panner", {
      panningModel: "equalpower",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10000,
      positionX: rparam(0),
      positionY: rparam(0),
      positionZ: rparam(0),
    });
  }
  async resume() {
    this.resumes++;
    this.state = "running";
  }
}

function makeFakeBus({ state = "running", Ctx = LogisticsFakeCtx } = {}) {
  const ctx = new Ctx();
  ctx.state = state;
  const node = ctx._n("bus", { gain: rparam(1) });
  ctx.made.length = 0;
  return { ctx, node, sliderGain: () => 1, isActive: () => true };
}

function flushEnded(ctx) {
  for (const n of [...ctx.made]) {
    if (typeof n.onended === "function" && n.stopped) n.onended();
  }
}

console.log("=== Sidelifter Model, Trailer Kind, Bay Highlight & Audio Suite ===");

check("T_SL_01 lintSource, manifest & trailer kind/WCID resolution", () => {
  assert.equal(SIDELIFTER_WCID, 4000032);
  assert.equal(TRAILER_WCID.Sidelifter40, 4000032);
  assert.equal(TRAILER_DEPLOYABLE_KIND.Sidelifter40, 15);
  assert.equal(lintManifest(sidelifterManifest).length, 0);

  for (const rel of [
    "scene3d/vehicle/sidelifter_model.js",
    "scene3d/vehicle/trailer_models.js",
    "scene3d/vehicle/container_models.js",
  ]) {
    const hits = lintSource(readFileSync(join(ROOT, rel), "utf8"));
    assert.equal(hits.length, 0, `${rel} lintSource hits: ${JSON.stringify(hits)}`);
  }

  for (const k of [15, 4000032, "sidelifter40", "Sidelifter40", "TrailerSidelifter40"]) {
    assert.equal(resolveTrailerKind(k), "40ft", `resolveTrailerKind(${k}) === "40ft"`);
    assert.equal(isSidelifterKind(k), true, `isSidelifterKind(${k}) === true`);
  }
  assert.equal(resolveTrailerKind("20ft"), "20ft");
  assert.equal(resolveTrailerKind(13), "20ft");
  assert.equal(resolveTrailerKind(4000030), "20ft");
  assert.equal(resolveTrailerKind("40ft"), "40ft");
  assert.equal(resolveTrailerKind(14), "40ft");
  assert.equal(resolveTrailerKind(4000031), "40ft");
  assert.equal(isSidelifterKind(14), false);
});

check("T_SL_02 GPU budget (<= 14 draw calls), 0 lights, AGX PBR & CSM shader patch", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const sl = buildSidelifterTrailer(THREE, { csmState: fakeCsm });
  const draws = countDrawCalls(sl.root);
  const lights = countLights(sl.root);
  assert.ok(draws >= 8 && draws <= 14, `sidelifter draw calls (${draws}) <= 14`);
  assert.equal(lights, 0, "0 THREE.Light instances");
  assert.equal(sl.maxDrawCalls, 14);
  assert.equal(sl.isSidelifter, true);
  assert.equal(sl.wcid, 4000032);

  let meshCount = 0;
  sl.root.traverse((o) => {
    if (o.isMesh) {
      meshCount++;
      assert.equal(o.castShadow, true, `${o.name} castShadow`);
      assert.equal(o.receiveShadow, true, `${o.name} receiveShadow`);
      assert.ok(o.material.isMeshStandardMaterial, `${o.name} MeshStandardMaterial`);
      assert.equal(o.material.vertexColors, true, `${o.name} vertexColors`);
      assert.equal(o.material.color.getHex(), 0xffffff, `${o.name} white albedo`);
      assert.equal(o.material.userData?.csmEnabled, true, `${o.name} CSM patched`);
    }
  });
  assert.ok(meshCount >= 10);
  sl.dispose();
});

check("T_SL_03 Dimensions, pallet jack rack, sliding cranes, outriggers & phases 0..10", () => {
  const sl = buildSidelifterTrailer(THREE);
  near(sl.kingpinY, 5.35, 1e-4, "kingpinY");
  near(sl.kingpinZ, CHASSIS_KINGPIN_Z, 1e-4, "kingpinZ");
  near(sl.containerMount.position.z, CHASSIS_DECK_Z, 1e-4, "deckZ");

  // Pallet jack rack at (-0.95, -1.6, 0.55)
  near(sl.palletJackRackGroup.position.x, -0.95, 1e-4, "rack X");
  near(sl.palletJackRackGroup.position.y, -1.6, 1e-4, "rack Y");
  near(sl.palletJackRackGroup.position.z, 0.55, 1e-4, "rack Z");
  assert.equal(sl.hasStowedPalletJack, true);
  assert.equal(sl.stowedPalletJackMesh.visible, true);

  sl.update({ hasStowedPalletJack: false });
  assert.equal(sl.hasStowedPalletJack, false);
  assert.equal(sl.stowedPalletJackMesh.visible, false);

  sl.update({ sideliftFlags: 0x08 });
  assert.equal(sl.hasStowedPalletJack, true);
  assert.equal(sl.stowedPalletJackMesh.visible, true);

  // Crane span slides between 20ft (2.9265) and 40ft (5.9925)
  sl.update({ craneSpanY: SIDELIFTER_SPECS.craneSpan20 });
  near(sl.frontCraneGroup.position.y, +2.9265, 1e-4, "20ft front crane Y");
  near(sl.rearCraneGroup.position.y, -2.9265, 1e-4, "20ft rear crane Y");

  sl.update({ craneSpanY: SIDELIFTER_SPECS.craneSpan40 });
  near(sl.frontCraneGroup.position.y, +5.9925, 1e-4, "40ft front crane Y");
  near(sl.rearCraneGroup.position.y, -5.9925, 1e-4, "40ft rear crane Y");

  // Outriggers extend laterally to +-3.60m and drop footpad to z = 0
  sl.update({ sideliftPhase: SIDELIFT_PHASE.OutriggersPlanted, outriggerProgress: 1.0, sideliftSide: 1 });
  near(sl.frontOutriggerGroup.position.x, +3.60, 1e-4, "right outrigger X");
  near(sl.frontOutriggerGroup.position.z, 0.0, 1e-4, "right outrigger Z");

  sl.update({ sideliftPhase: SIDELIFT_PHASE.OutriggersPlanted, outriggerProgress: 1.0, sideliftSide: -1 });
  near(sl.frontOutriggerGroup.position.x, -3.60, 1e-4, "left outrigger X");
  near(sl.rearOutriggerGroup.position.x, -3.60, 1e-4, "left rear outrigger X");

  // Exercise all SideliftPhase 0..10 and verify instanced matrices stay finite and Box3 expands
  const im = sl.root.getObjectByName("sidelifter-crane-spreaders-instanced");
  const m0 = new THREE.Matrix4();
  const m1 = new THREE.Matrix4();
  sl.update({ sideliftPhase: SIDELIFT_PHASE.Idle, sideliftProgress: 0, outriggerProgress: 0 });
  im.getMatrixAt(0, m0);

  for (let ph = 0; ph <= 10; ph++) {
    sl.update({ sideliftPhase: ph, sideliftProgress: 0.5, outriggerProgress: ph >= 2 && ph <= 9 ? 1 : 0.5 });
  }
  sl.update({ sideliftPhase: SIDELIFT_PHASE.Swinging, sideliftProgress: 0.9, outriggerProgress: 1.0, sideliftSide: 1 });
  im.getMatrixAt(0, m1);
  assert.ok(!m0.equals(m1), "swing phase updates crane spreader instanced matrix");

  const box = new THREE.Box3().setFromObject(sl.root);
  assert.ok(box.max.x >= 3.5, `extended outrigger widens Box3 max.x (${box.max.x})`);
  sl.dispose();
});

check("T_SL_04 Twistlocks, landing gear, wheel roll, Semi coupling & non-disposal of mounted container", () => {
  const sl = buildSidelifterTrailer(THREE, { twistlockState: TWISTLOCK_STATE.Unlocked });
  assert.equal(sl.twistlockPivots.length, 8);
  assert.equal(sl.twistlockPivots[0].rotation.z, 0);
  sl.update(0.033, { twistlockState: TWISTLOCK_STATE.Locked });
  near(sl.twistlockPivots[0].rotation.z, Math.PI / 2, 1e-6, "twistlock locked 90 deg");

  sl.setLandingGearRetracted(true);
  near(sl.landingGearGroup.position.z, 0.45, 1e-4, "landing gear retracted +0.45m");
  sl.update({ landingGearRetracted: false });
  near(sl.landingGearGroup.position.z, 0.0, 1e-4, "landing gear extended z=0");

  sl.update(0.1, { speed: 10.1 });
  const expectedRoll = (10.1 * 0.1) / 0.505;
  near(sl.wheelRollAngle, expectedRoll, 1e-4, "wheel roll (dt, state)");
  sl.update({ dt: 0.1, speed: 10.1 });
  near(sl.wheelRollAngle, 2 * expectedRoll, 1e-4, "wheel roll (state)");

  // Semi-379 coupling & 40HC container seat
  const semi = buildSemiTruck(THREE);
  const c = buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer40HC);
  sl.attachContainer(c);
  semi.attachTrailer(sl);
  assert.equal(sl.landingGearRetracted, true, "semi.attachTrailer retracts sidelifter landing gear");
  semi.root.updateMatrixWorld(true);
  const cb = new THREE.Box3().setFromObject(c.root);
  near(cb.min.z, CHASSIS_DECK_Z, 0.05, "mounted container floor at CHASSIS_DECK_Z");

  // Sidelifter dispose() must NOT dispose mounted container
  let containerDisposed = false;
  c.root.traverse((o) => {
    if (o.geometry) {
      const orig = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => { containerDisposed = true; orig(); };
    }
  });
  sl.dispose();
  assert.equal(containerDisposed, false, "sidelifter.dispose() must not dispose mounted container");
  c.dispose();
  semi.dispose();
});

check("T_SL_05 container_models.js setHighlightedSlot (20ft/40ft, 2-wide unified 1.100x1.100, lazy attach, z > 0.176, dispose)", () => {
  for (const [wcid, slots] of [
    [CONTAINER_WCID.IsoContainer20, PINWHEEL_SLOTS_20],
    [CONTAINER_WCID.IsoContainer40HC, PINWHEEL_SLOTS_40],
  ]) {
    const c = buildIsoContainer(THREE, wcid);
    assert.equal(c.cargoBayGroup.children.length, 0, "no highlight child attached initially");
    assert.ok(countDrawCalls(c.root) <= 8, "base draw calls <= 8");

    // Highlight slot 0 reachable (2-wide grid, orient Y, rotation.z === 0)
    assert.equal(c.setHighlightedSlot(0, null, "reachable"), true);
    assert.equal(c.cargoBayGroup.children.length, 1, "highlight lazily attached");
    assert.ok(countDrawCalls(c.root) <= 8, "draw calls with highlight <= 8");
    assert.ok(c.bayHighlightPivot.position.z > c.spec.floorZ + 0.014, "highlight sits above wood floor top (0.176m)");
    near(c.bayHighlightPivot.position.z, 0.178, 1e-4, "highlight Z = 0.178m");
    near(c.bayHighlightPivot.rotation.z, 0, 1e-6, "2-wide slot 0 orient Y rotation 0");
    near(c.bayHighlightMesh.position.x, 0, 1e-6, "unified full slot has x offset 0");
    near(c.bayHighlightMesh.position.y, 0, 1e-6, "unified full slot has y offset 0");
    c.bayHighlightMesh.geometry.computeBoundingBox();
    const hlBox = c.bayHighlightMesh.geometry.boundingBox;
    near(hlBox.max.x - hlBox.min.x, 1.100, 1e-3, "highlight border width = 1.100m");
    near(hlBox.max.y - hlBox.min.y, 1.100, 1e-3, "highlight border depth = 1.100m");

    // Highlight Y-oriented slot ("target") with subSlot 0 and subSlot null (no +/-0.3048 split)
    const ySlot = slots.find((s) => s.orient === "Y" && s.slotIndex > 0) || slots[0];
    assert.equal(c.setHighlightedSlot(ySlot.slotIndex, 0, "target"), true);
    near(c.bayHighlightPivot.rotation.z, 0, 1e-6, "2-wide orient Y rotation 0");
    near(c.bayHighlightPivot.position.x, ySlot.x, 1e-4, "highlight X matches slot.x");
    near(c.bayHighlightPivot.position.y, ySlot.y, 1e-4, "highlight Y matches slot.y");
    near(c.bayHighlightMesh.position.x, 0, 1e-6, "unified subSlot 0 has no half-pallet X offset");

    // Blocked state
    assert.equal(c.setHighlightedSlot(ySlot.slotIndex, null, "blocked"), true);
    near(c.bayHighlightPivot.rotation.z, 0, 1e-6, "blocked orient Y rotation 0");
    near(c.bayHighlightMesh.position.x, 0, 1e-6, "unified subSlot null offset 0");

    // Clear restores cargoBayGroup.children.length === 0
    assert.equal(c.setHighlightedSlot(null, null, null), false);
    assert.equal(c.cargoBayGroup.children.length, 0, "clearing detaches highlight");

    // Dispose cleans up highlight geom & mat
    let hlMatDisposed = false;
    const origMatDispose = c.bayHighlightMesh.material.dispose.bind(c.bayHighlightMesh.material);
    c.bayHighlightMesh.material.dispose = () => { hlMatDisposed = true; origMatDispose(); };
    c.dispose();
    assert.equal(hlMatDisposed, true, "container.dispose() disposes highlight material");
  }
});

check("T_SL_06 Headless WebGL2 render & teardown with zero console errors", () => {
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const gl = createFakeWebGL2({ maxTextures: 16 });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1.33, 0.1, 1000);
    camera.position.set(12, -16, 8);
    camera.lookAt(0, 0, 1.5);

    const sl = buildSidelifterTrailer(THREE);
    const c = buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer40HC, { doorProgress: 1.0 });
    c.setHighlightedSlot(18, null, "reachable");
    sl.attachContainer(c);
    sl.update({ sideliftPhase: SIDELIFT_PHASE.Swinging, sideliftProgress: 0.5, outriggerProgress: 1.0 });
    scene.add(sl.root);

    gl.__fake.reset();
    renderer.render(scene, camera);
    const draws = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
    assert.ok(draws > 0, `WebGL2 executed ${draws} draw commands`);
    assert.equal(errors.length, 0, `console.error: ${errors.join(" | ")}`);

    scene.remove(sl.root);
    sl.dispose();
    c.dispose();
    renderer.dispose();
  } finally {
    console.error = origError;
  }
});

check("T_SL_07 Logistics Audio: gating, PTO hum, swing warning LFO, outrigger thud, twistlock clank & 0-leak dispose", () => {
  assert.ok(Object.isFrozen(LOGISTICS_AUDIO_TUNING));

  // Gating checks
  const gatedBus = makeFakeBus();
  for (const bad of [
    createLogisticsAudio({ bus: gatedBus, search: "?vehicleAudio=off" }),
    createLogisticsAudio({ bus: gatedBus, liveScene3d: { nullRender: true } }),
    createLogisticsAudio({ bus: null }),
  ]) {
    assert.equal(bad.updateSidelifter(1, { phase: 6, pos: [0, 0, 0] }), false);
    assert.equal(bad.outriggerThud({ pos: [0, 0, 0] }), false);
    assert.equal(bad.twistlockClank({ pos: [0, 0, 0], locked: true }), false);
    assert.equal(bad.stats.totalNodes, 0);
    bad.dispose();
  }
  assert.equal(gatedBus.ctx.made.length, 0, "0 WebAudio nodes allocated when gated/disabled");

  // Active Sidelifter audio lifecycle
  let tSec = 10;
  const bus = makeFakeBus({ state: "suspended" });
  const au = createLogisticsAudio({ bus, clock: () => tSec });

  assert.equal(au.updateSidelifter(1, { phase: 5, load: 1, pos: [10, 20, 0] }), true);
  assert.equal(bus.ctx.resumes, 1, "resumes suspended AudioContext");
  assert.equal(au.stats.ptoVoices, 1);
  assert.equal(au.stats.swingVoices, 0);

  const panners = bus.ctx.made.filter((n) => n.kind === "panner");
  assert.ok(panners.length >= 1);
  const expectedPos = acToThreePos([10, 20, 0]);
  near(panners[0].positionX.value, expectedPos[0], 1e-4, "HRTF panner X");
  near(panners[0].positionY.value, expectedPos[1], 1e-4, "HRTF panner Y");
  near(panners[0].positionZ.value, expectedPos[2], 1e-4, "HRTF panner Z");

  // Phase 6 activates swing warning beep via square LFO (zero setTimeout)
  assert.equal(au.updateSidelifter(1, { phase: 6, pos: [10, 20, 0] }), true);
  assert.equal(au.stats.swingVoices, 1);
  const squareLfos = bus.ctx.made.filter((n) => n.kind === "osc" && n.type === "square");
  assert.ok(squareLfos.length >= 1, "swing warning uses square oscillator LFO");

  // Phase 0 stops swing warning
  assert.equal(au.updateSidelifter(1, { phase: 0, pos: [10, 20, 0] }), true);
  assert.equal(au.stats.swingVoices, 0);

  // One-shots & cooldowns
  assert.equal(au.outriggerThud({ pos: [10, 20, 0] }), true);
  assert.equal(au.outriggerThud({ pos: [10, 20, 0] }), false, "outriggerThud cooldown enforced");
  tSec += 0.2;
  assert.equal(au.twistlockClank({ pos: [10, 20, 0], locked: true }), true);
  assert.equal(au.twistlockClank({ pos: [10, 20, 0], locked: false }), false, "twistlockClank cooldown enforced");
  tSec += 0.2;
  assert.equal(au.twistlockClank({ pos: [10, 20, 0], locked: false }), true);
  assert.equal(au.stats.activeOneShots, 3);

  flushEnded(bus.ctx);
  assert.equal(au.stats.activeOneShots, 0, "onended frees finished one-shots");

  // Synchronous 0-leak dispose
  au.outriggerThud({ pos: [10, 20, 0] });
  au.updateSidelifter(1, { phase: 6, pos: [10, 20, 0] });
  au.dispose();
  assert.equal(au.stats.disposed, true);
  assert.equal(au.stats.ptoVoices, 0);
  assert.equal(au.stats.swingVoices, 0);
  assert.equal(au.stats.activeOneShots, 0);
  assert.equal(au.stats.totalNodes, 0);
  for (const n of bus.ctx.made) {
    assert.equal(n.connections.length, 0, `node ${n.kind} disconnected on dispose`);
    if (n.kind === "osc" || n.kind === "bufsrc") {
      assert.equal(n.stopped, true, `source ${n.kind} stopped on dispose`);
    }
  }
  const beforePost = bus.ctx.made.length;
  assert.equal(au.outriggerThud({ pos: [0, 0, 0] }), false);
  assert.equal(bus.ctx.made.length, beforePost, "post-dispose allocates 0 nodes");
});

check("T_SL_08 Idle outrigger Z-clearance, housing alignment, 20ft carriage clearance & CSM lamp hook chaining", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const sl = buildSidelifterTrailer(THREE, { csmState: fakeCsm });
  assert.ok(countDrawCalls(sl.root) <= 14, `draw calls (${countDrawCalls(sl.root)}) <= 14`);

  // Verify brakeLampMat & markerLampMat preserve BOTH vertex-color emissive shader AND CSM hook
  for (const lampMat of [sl.materials.brakeLampMat, sl.materials.markerLampMat]) {
    assert.equal(lampMat.userData?.csmEnabled, true);
    assert.equal(lampMat.onBeforeCompile?.name, "chainedOnBeforeCompile", "CSM chained onto lamp onBeforeCompile");
    const mockShader = {
      uniforms: {},
      vertexShader: "void main() { #include <begin_vertex>\n#include <project_vertex>\n }",
      fragmentShader: "void main() { vec3 totalEmissiveRadiance = emissive;\n#include <dithering_fragment>\n }",
    };
    lampMat.onBeforeCompile(mockShader, null);
    assert.ok(mockShader.fragmentShader.includes("emissive * vColor.rgb"), "lamp emissive vertexColor patch ran");
    assert.ok(mockShader.fragmentShader.includes("_csmShadowFactor"), "CSM shadow patch ran");
  }

  // Idle outriggers on both sides with 20ft rear crane carriage + mounted 40HC container
  const c40 = buildIsoContainer(THREE, CONTAINER_WCID.IsoContainer40HC);
  sl.attachContainer(c40);
  sl.root.updateMatrixWorld(true);
  const containerBox = new THREE.Box3().setFromObject(c40.root);

  const beamMesh = sl.root.getObjectByName("sidelifter-outrigger-beams-instanced");
  const legMesh = sl.root.getObjectByName("sidelifter-outriggers-instanced");
  const carriageMesh = sl.root.getObjectByName("sidelifter-crane-carriages-instanced");
  assert.ok(beamMesh && legMesh && carriageMesh);

  for (const side of [1, -1]) {
    sl.update({
      sideliftPhase: SIDELIFT_PHASE.Idle,
      outriggerProgress: 0,
      sideliftSide: side,
      craneSpanY: SIDELIFTER_SPECS.craneSpan20,
    });
    sl.root.updateMatrixWorld(true);

    near(sl.frontOutriggerBeamGroup.position.z, 0.84, 1e-4, "front beam aligned at z = 0.84");
    near(sl.rearOutriggerBeamGroup.position.z, 0.84, 1e-4, "rear beam aligned at z = 0.84");

    const beamBox = new THREE.Box3().setFromObject(beamMesh);
    const legBox = new THREE.Box3().setFromObject(legMesh);
    const carriageBox = new THREE.Box3().setFromObject(carriageMesh);

    assert.ok(beamBox.max.z < CHASSIS_DECK_Z, `Idle beam max.z (${beamBox.max.z}) < CHASSIS_DECK_Z`);
    assert.ok(legBox.max.z < CHASSIS_DECK_Z, `Idle leg max.z (${legBox.max.z}) < CHASSIS_DECK_Z`);
    assert.ok(beamBox.max.z <= 1.05, `Idle beam max.z (${beamBox.max.z}) <= 1.05`);
    assert.ok(legBox.max.z <= 1.05, `Idle leg max.z (${legBox.max.z}) <= 1.05`);
    assert.equal(beamBox.intersectsBox(containerBox), false, "Idle beam does not intersect mounted container");
    assert.equal(legBox.intersectsBox(containerBox), false, "Idle leg does not intersect mounted container");
    assert.equal(beamBox.intersectsBox(carriageBox), false, "Idle beam does not intersect 20ft crane carriage");
    assert.equal(legBox.intersectsBox(carriageBox), false, "Idle leg does not intersect 20ft crane carriage");
  }

  sl.dispose();
  c40.dispose();
});

check("T_SL_09 SideliftLoad & Offload crane spreader lug continuity across all phase boundaries (< 1e-4 m)", () => {
  const sl = buildSidelifterTrailer(THREE);
  const spreaderIM = sl.root.getObjectByName("sidelifter-crane-spreaders-instanced");
  const m = new THREE.Matrix4();
  const lugLocal = new THREE.Vector3(0, 0, -0.74);

  function getLugPos(phase, progress, isLoadDirection, side) {
    sl.update({
      sideliftPhase: phase,
      sideliftProgress: progress,
      outriggerProgress: phase >= 2 && phase <= 9 ? 1 : 0,
      isLoadDirection,
      sideliftSide: side,
    });
    spreaderIM.getMatrixAt(0, m);
    return lugLocal.clone().applyMatrix4(m);
  }

  const pairs = [
    [SIDELIFT_PHASE.OutriggersPlanted, SIDELIFT_PHASE.CranesPositioning],
    [SIDELIFT_PHASE.CranesPositioning, SIDELIFT_PHASE.CranesLatched],
    [SIDELIFT_PHASE.CranesLatched, SIDELIFT_PHASE.Hoisting],
    [SIDELIFT_PHASE.Hoisting, SIDELIFT_PHASE.Swinging],
    [SIDELIFT_PHASE.Swinging, SIDELIFT_PHASE.Lowering],
    [SIDELIFT_PHASE.Lowering, SIDELIFT_PHASE.Releasing],
    [SIDELIFT_PHASE.Releasing, SIDELIFT_PHASE.CranesStowing],
    [SIDELIFT_PHASE.CranesStowing, SIDELIFT_PHASE.OutriggersRetracting],
  ];

  for (const side of [1, -1]) {
    for (const isLoad of [false, true]) {
      for (const [phA, phB] of pairs) {
        const pEnd = getLugPos(phA, 1.0, isLoad, side);
        const pStart = getLugPos(phB, 0.0, isLoad, side);
        const dist = pEnd.distanceTo(pStart);
        assert.ok(dist < 1e-4, `side=${side} isLoad=${isLoad} phase ${phA}->${phB} lug delta (${dist}) < 1e-4`);
      }
    }
  }
  sl.dispose();
});

check("T_SL_10 Hardening: deployables update(null), Set-deduped dispose, audio surface prototype & failed start()", () => {
  // 1. All 9 deployables handle update(null) without throwing and dispose each material at most once
  const wcids = [4000002, ...Object.values(DEPLOYABLE_WCID)];
  for (const wcid of wcids) {
    const unit = wcid === 4000002 ? buildDeployedRadar(THREE) : buildDeployable(THREE, wcid);
    const seenDispose = new Map();
    unit.root.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!seenDispose.has(m)) {
          seenDispose.set(m, 0);
          const orig = m.dispose.bind(m);
          m.dispose = () => {
            seenDispose.set(m, seenDispose.get(m) + 1);
            orig();
          };
        }
      }
    });
    assert.doesNotThrow(() => unit.update(null), `WCID ${wcid} update(null) does not throw`);
    unit.dispose();
    for (const [matObj, calls] of seenDispose.entries()) {
      assert.equal(calls, 1, `WCID ${wcid} material ${matObj.type} disposed once (got ${calls})`);
    }
  }

  // 2. audio.js Object.hasOwn surface lookup (prototype key like "toString" must not yield NaN)
  const bus = makeFakeBus();
  const au = createLogisticsAudio({ bus, clock: () => 10 });
  assert.equal(au.updateWheelRoll(1, { speed: 1.5, surface: "toString" }), true);
  const filters = bus.ctx.made.filter((n) => n.kind === "biquad");
  assert.ok(filters.length >= 1);
  assert.ok(Number.isFinite(filters[0].frequency.value), "prototype key surface falls back cleanly to finite frequency");

  // 3. audio.js playOneShot cleans up activeOneShots if src.start() throws
  class ThrowStartCtx extends LogisticsFakeCtx {
    constructor() {
      super();
      this._srcCount = 0;
    }
    _src(kind, extra) {
      const idx = ++this._srcCount;
      const s = super._src(kind, extra);
      if (idx === 2) {
        s.start = () => { throw new Error("DOMException: start failed"); };
      }
      return s;
    }
  }
  const errBus = makeFakeBus({ Ctx: ThrowStartCtx });
  const errAu = createLogisticsAudio({ bus: errBus, clock: () => 10 });
  assert.equal(errAu.outriggerThud({ pos: [0, 0, 0] }), false);
  assert.equal(errAu.stats.activeOneShots, 0, "failed start() leaves 0 ghost activeOneShots");

  au.dispose();
  errAu.dispose();
});

check("T5_07 Sidelifter 20ft rear-mounted container aligns frontCraneGroup & rearCraneGroup around slotY (-2.9295)", () => {
  const sl = buildSidelifterTrailer(THREE);
  const c20 = buildIsoContainer(THREE, { kind: "20ft" });
  sl.attachContainer(c20, { position: "rear" });
  near(c20.root.position.y, -2.9295, 1e-4, "20ft rear container Y");

  sl.update({
    sideliftPhase: SIDELIFT_PHASE.Swinging,
    sideliftProgress: 0.5,
    craneSpanY: SIDELIFTER_SPECS.craneSpan20,
    craneCenterY: -2.9295,
  });
  near(sl.craneCenterY, -2.9295, 1e-4, "craneCenterY stored");
  near(sl.frontCraneGroup.position.y, -2.9295 + SIDELIFTER_SPECS.craneSpan20, 1e-4, "frontCraneGroup aligned to 20ft front casting");
  near(sl.rearCraneGroup.position.y, -2.9295 - SIDELIFTER_SPECS.craneSpan20, 1e-4, "rearCraneGroup aligned to 20ft rear casting");

  // Clamping: excessive craneCenterY stays within 40ft slide rails [-5.9925, +5.9925]
  sl.update({ craneSpanY: SIDELIFTER_SPECS.craneSpan20, craneCenterY: 10.0 });
  assert.ok(sl.frontCraneGroup.position.y <= SIDELIFTER_SPECS.craneSpan40 + 1e-4, "frontCraneGroup clamped to rail");
  assert.ok(sl.rearCraneGroup.position.y >= -SIDELIFTER_SPECS.craneSpan40 - 1e-4, "rearCraneGroup clamped to rail");
  sl.dispose();
});

console.log(`\nvehicle_sidelifter_model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
