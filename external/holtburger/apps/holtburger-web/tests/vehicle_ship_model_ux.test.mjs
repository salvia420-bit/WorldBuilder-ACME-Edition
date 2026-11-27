// tests/vehicle_ship_model_ux.test.mjs — Headless Unit & WebGL2 Suite for B3 (Ship Model, VFX, Controls, OSD, Audio)
// Covers:
//   - scene3d/vehicle/ship_model.js (78 m feeder geometry, 0 lights, <= 18 vessel DC + <= 6 container DC,
//     CSM shader patching, open hold z = +0.45 m, hatch covers, rudder, prop, radar, hawsers, ISO 9711 stowage, WebGL2 render)
//   - scene3d/vehicle/ship_fx.js (0 lights, <= 4 DC, Kelvin wake, prop wash, bow/stern thruster jets, disposal)
//   - scene3d/vehicle/ship_controls.js (all keybindings, __inputFunnel lock/restore/drain, chat/modal/Escape/F-key/other-vehicle guards,
//     4-mode nautical camera rig + createCameraOwner + _camDebugParked respect)
//   - scene3d/vehicle/ship_osd.js (#hb-ship-osd DOM rendering, dirty-checked mutations, EOT/rudder/thruster/berth alignment, disposal)
//   - scene3d/vehicle/port_audio.js (headless null-ctx safety, mock WebAudio diesel/thruster/foghorn/crane/twistlock/ambient, stop & dispose)
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_ship_model_ux.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  manifest as shipModelManifest,
  buildContainerShip,
} from "../scene3d/vehicle/ship_model.js";
import {
  manifest as shipFxManifest,
  createShipFx,
  SHIP_FX_LIMITS,
} from "../scene3d/vehicle/ship_fx.js";
import {
  createShipControls,
  createShipCameraRig,
  SHIP_VIEW_MODES,
  SHIP_MAX_RUDDER_RAD,
  shipLocalToWorld,
} from "../scene3d/vehicle/ship_controls.js";
import {
  createShipOsd,
  SHIP_OSD_ID,
  SHIP_PROMPT_ID,
  formatCompassHeading,
} from "../scene3d/vehicle/ship_osd.js";
import {
  createPortAudio,
  computeShipAudioParams,
  portAudioEnabled,
  acToAudioPos,
} from "../scene3d/vehicle/port_audio.js";
import {
  SHIP_SPECS,
  PORT_ORIGIN,
  PORT_WCID,
  buildPortLayout,
} from "../scene3d/vehicle/port_specs.js";
import {
  createShipState,
  createShipCargoStore,
  computeMooringLines,
} from "../scene3d/vehicle/ship_kinematics.js";
import { lintManifest, lintSource } from "../scene3d/vfx/lint_caps.js";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let fakeNowMs = 100000;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => fakeNowMs },
  configurable: true,
  writable: true,
});

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-3, msg = "near") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

function countDrawCalls(root, excludeGroup = null) {
  let calls = 0;
  root.traverse((o) => {
    if (excludeGroup && (o === excludeGroup || isDescendantOf(o, excludeGroup))) return;
    if (o.isMesh || o.isLine || o.isSprite || o.isPoints) calls++;
  });
  return calls;
}

function isDescendantOf(node, ancestor) {
  let p = node.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

function countLights(root) {
  let lights = 0;
  root.traverse((o) => {
    if (o.isLight) lights++;
  });
  return lights;
}

function spyDisposal(root) {
  const geoms = [];
  const mats = [];
  const seenG = new Set();
  const seenM = new Set();
  root.traverse((o) => {
    if (o.geometry && !seenG.has(o.geometry)) {
      seenG.add(o.geometry);
      const rec = { disposed: false, name: o.name || "geom" };
      const orig = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => {
        rec.disposed = true;
        orig();
      };
      geoms.push(rec);
    }
    if (o.material) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m && !seenM.has(m)) {
          seenM.add(m);
          const rec = { disposed: false, name: o.name || "mat" };
          const orig = m.dispose.bind(m);
          m.dispose = () => {
            rec.disposed = true;
            orig();
          };
          mats.push(rec);
        }
      }
    }
  });
  return { geoms, mats };
}

function makeControlEnv() {
  const winListeners = new Map();
  const docListeners = new Map();
  const funnelCalls = [];
  const funnel = {
    _fault: null,
    snapshot() { return { fault: this._fault }; },
    releaseHeld(reason) { funnelCalls.push(["releaseHeld", reason]); },
    poison(slot) { funnelCalls.push(["poison", slot]); this._fault = slot; },
    unpoison() { funnelCalls.push(["unpoison"]); this._fault = null; },
    cancelJumpCharge() { funnelCalls.push(["cancelJumpCharge"]); },
  };
  const doc = {
    activeElement: null,
    visibilityState: "visible",
    body: { tagName: "BODY" },
    querySelectorAll: () => [],
    addEventListener(t, fn) {
      if (!docListeners.has(t)) docListeners.set(t, new Set());
      docListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      docListeners.get(t)?.delete(fn);
    },
  };
  const win = {
    document: doc,
    __inputFunnel: funnel,
    addEventListener(t, fn) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      winListeners.get(t)?.delete(fn);
    },
    dispatch(type, props = {}) {
      let prevented = false;
      let stopped = false;
      const ev = {
        type,
        repeat: false,
        cancelable: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        target: doc.body,
        stopImmediatePropagation() { stopped = true; },
        preventDefault() { prevented = true; },
        ...props,
      };
      const set = winListeners.get(type);
      if (set) {
        for (const fn of [...set]) fn(ev);
      }
      return { prevented, stopped };
    },
    listenerCount(type) {
      return winListeners.get(type)?.size ?? 0;
    },
  };
  return { win, doc, funnel, funnelCalls };
}

function makeFakeDom() {
  let mutations = 0;
  const byId = new Map();
  const trackStyle = () => new Proxy({}, {
    set(target, prop, val) {
      mutations++;
      target[prop] = val;
      return true;
    },
  });
  const mkNode = (tag) => {
    let txt = "";
    let cls = "";
    let id = "";
    const n = {
      tag,
      children: [],
      style: trackStyle(),
      get id() { return id; },
      set id(v) { mutations++; id = v; if (v) byId.set(v, n); },
      get className() { return cls; },
      set className(v) { mutations++; cls = v; },
      get textContent() { return txt; },
      set textContent(v) { mutations++; txt = String(v); },
      appendChild(child) { mutations++; this.children.push(child); if (child.id) byId.set(child.id, child); return child; },
      remove() { mutations++; if (id) byId.delete(id); },
    };
    return n;
  };
  const head = mkNode("head");
  const body = mkNode("body");
  return {
    doc: {
      head,
      body,
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => mkNode(tag),
    },
    byId,
    get mutations() { return mutations; },
    resetMutations() { mutations = 0; },
  };
}

function makeFakeWebAudioBus() {
  const createdNodes = [];
  const makeParam = (init = 0) => ({
    value: init,
    setValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
  });
  const makeNode = (kind) => {
    const n = {
      kind,
      started: false,
      stopped: false,
      disconnected: false,
      connectedTo: [],
      connect(dst) { this.connectedTo.push(dst); return dst; },
      disconnect() { this.disconnected = true; },
      start() { this.started = true; },
      stop() { this.stopped = true; },
    };
    createdNodes.push(n);
    return n;
  };
  const ctx = {
    currentTime: 10.0,
    sampleRate: 48000,
    destination: makeNode("destination"),
    createGain() {
      const n = makeNode("gain");
      n.gain = makeParam(1);
      return n;
    },
    createOscillator() {
      const n = makeNode("oscillator");
      n.type = "sine";
      n.frequency = makeParam(440);
      return n;
    },
    createBiquadFilter() {
      const n = makeNode("filter");
      n.type = "lowpass";
      n.frequency = makeParam(1000);
      n.Q = makeParam(1);
      return n;
    },
    createPanner() {
      const n = makeNode("panner");
      n.positionX = makeParam(0);
      n.positionY = makeParam(0);
      n.positionZ = makeParam(0);
      return n;
    },
    createBuffer(ch, len, sr) {
      const arr = new Float32Array(len);
      return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => arr };
    },
    createBufferSource() {
      const n = makeNode("bufferSource");
      n.buffer = null;
      n.loop = false;
      return n;
    },
  };
  return {
    bus: { ctx, node: ctx.destination, sliderGain: () => 1.0, isActive: () => true },
    ctx,
    createdNodes,
  };
}

console.log("=== Container Ship Model, VFX, Helm Controls, Bridge OSD & Maritime Audio Suite (B3) ===");

// ---------------------------------------------------------------------------
// 1. Lint Caps (Manifest & Static Source Scan)
// ---------------------------------------------------------------------------
check("T_SM_01 lintManifest() & lintSource() zero hits across ship_model.js & ship_fx.js", () => {
  const targets = [
    [shipModelManifest, "scene3d/vehicle/ship_model.js", "vfx-container-ship-model"],
    [shipFxManifest, "scene3d/vehicle/ship_fx.js", "vfx-ship-maritime-fx"],
  ];
  for (const [m, rel, expectedId] of targets) {
    assert.equal(m.id, expectedId);
    assert.equal(m.lightCountDelta, 0);
    assert.equal(m.deterministic, true);
    const mHits = lintManifest(m);
    assert.equal(mHits.length, 0, `${rel} lintManifest hits: ${JSON.stringify(mHits)}`);
    const src = readFileSync(join(ROOT, rel), "utf8");
    const sHits = lintSource(src);
    assert.equal(sHits.length, 0, `${rel} lintSource hits: ${JSON.stringify(sHits)}`);
  }
  // Also ensure port_audio.js has 0 lintSource violations
  const audioHits = lintSource(readFileSync(join(ROOT, "scene3d/vehicle/port_audio.js"), "utf8"));
  assert.equal(audioHits.length, 0, `port_audio.js lintSource hits: ${JSON.stringify(audioHits)}`);
});

// ---------------------------------------------------------------------------
// 2. Ship Model Geometry, Draw-Call Caps, CSM Patching & 0 Lights
// ---------------------------------------------------------------------------
check("T_SM_02 Ship model dimensions (78m x 14.4m), 0 lights, <= 18 vessel DC, <= 6 container DC & CSM", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const ship = buildContainerShip(THREE, { csmState: fakeCsm });
  ship.root.updateMatrixWorld(true);

  assert.equal(ship.wcid, PORT_WCID.ContainerShipFeeder);
  assert.equal(countLights(ship.root), 0, "ship must have 0 dynamic THREE.Light instances");

  const vesselDc = countDrawCalls(ship.root, ship.cargoGroup);
  const cargoDc = countDrawCalls(ship.cargoGroup);
  assert.ok(vesselDc <= 18, `vessel DC (${vesselDc}) <= 18`);
  assert.ok(cargoDc <= 6, `stowed container pool DC (${cargoDc}) <= 6`);

  // Every MeshStandardMaterial must be CSM-patched
  ship.root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      assert.ok(m.isMeshStandardMaterial, `${o.name} uses MeshStandardMaterial`);
      assert.equal(m.userData?.csmEnabled, true, `${o.name} CSM patched`);
    }
  });
  assert.equal(ship.lampsMat.onBeforeCompile.name, "chainedOnBeforeCompile", "nav lamps chain CSM");

  // Verify hull bounding box matches 78 m LOA (+bulbous bow to ~40.25 m), 14.4 m beam, draft -3.80 m, mast <= 23 m
  const box = new THREE.Box3().setFromObject(ship.root);
  assert.ok(box.min.x <= -7.15 && box.max.x >= 7.15, `beam span [${box.min.x.toFixed(2)}, ${box.max.x.toFixed(2)}] ~ ±7.2 m`);
  assert.ok(box.min.y <= -38.9 && box.max.y >= 40.0, `LOA + bulbous bow [${box.min.y.toFixed(2)}, ${box.max.y.toFixed(2)}]`);
  near(box.min.z, -SHIP_SPECS.draftM, 0.1, "keel draft at -3.80 m");
  assert.ok(box.max.z >= 22.0 && box.max.z <= 23.0, `mast height ${box.max.z.toFixed(2)} m`);

  // Verify closed hatch cover top face rests cleanly at SHIP_SPECS.hatchDeckZ (3.95 m)
  const h04Box = new THREE.Box3().setFromObject(ship.hatchCovers[4].mesh);
  near(h04Box.max.z, SHIP_SPECS.hatchDeckZ, 0.02, "closed hatch cover top === 3.95 m");

  const spy = spyDisposal(ship.root);
  ship.dispose();
  assert.equal(ship.disposed, true);
  assert.ok(spy.geoms.length > 0 && spy.geoms.every((g) => g.disposed), "all ship geometries disposed");
  assert.ok(spy.mats.length > 0 && spy.mats.every((m) => m.disposed), "all ship materials disposed");
});

// ---------------------------------------------------------------------------
// 3. Ship Model Articulations, Hatch Covers, Mooring Hawsers & ISO 9711 Stowage
// ---------------------------------------------------------------------------
check("T_SM_03 Ship update() articulations (hatch/rudder/prop/radar), mooring hawsers & ISO 9711 container slots", () => {
  const ship = buildContainerShip(THREE);
  const state = createShipState({ spawnAtBerth: "B1", origin: PORT_ORIGIN });
  const layout = buildPortLayout(PORT_ORIGIN);

  // Articulated updates
  ship.update({
    dt: 0.5,
    eotNotch: 3,
    surgeU: 5.0,
    rudderRad: 0.45,
    hatchCovers: { 2: 0.0, 4: 1.0, 6: 0.5 },
    applyRootPose: true,
    x: state.x,
    y: state.y,
    z: state.z,
    heading: state.heading,
    pitch: 0.02,
    roll: -0.03,
  });

  near(ship.rudderRad, 0.45, 1e-4, "rudderRad applied");
  near(ship.rudderPivot.rotation.z, 0.45, 1e-4, "rudderPivot.rotation.z");
  assert.ok(ship.propSpinRad !== 0, "propeller rotated");
  assert.ok(ship.radarSpinRad > 0, "radar rotated");
  near(ship.hatchCovers[2].open, 0.0, 1e-4, "bay 02 hatch closed");
  near(ship.hatchCovers[4].open, 1.0, 1e-4, "bay 04 hatch open");
  assert.ok(ship.hatchCovers[4].pivot.rotation.x > 1.0, "bay 04 hatch pivoted open");
  near(ship.hatchCovers[6].open, 0.5, 1e-4, "bay 06 hatch half open");

  // Rudder clamping at ±35°
  ship.update({ rudderRad: 9.0 });
  near(ship.rudderRad, SHIP_SPECS.maxRudderRad, 1e-4, "rudder clamped to +35°");

  // Dynamic mooring hawser lines from ship_kinematics.computeMooringLines
  const lines = computeMooringLines(state, layout);
  assert.equal(lines.length, 6, "6 mooring lines computed for moored Berth 1 vessel");
  const drawnLines = ship.setMooringLines(lines, state);
  assert.equal(drawnLines, 6, "all 6 mooring hawsers instanced");
  assert.equal(ship.mooringLinesMesh.count, 6);
  // Clear lines on unmoor
  assert.equal(ship.setMooringLines([]), 0);
  assert.equal(ship.mooringLinesMesh.count, 0);

  // ISO 9711 shipboard stowed containers (mix of 20ft hold/deck, 40ft, 40HC)
  const cargo = createShipCargoStore();
  assert.equal(cargo.load(2, 1, 2, { wcid: 4000021, liveryId: 0 }).ok, true);  // Hold 02 40ft
  assert.equal(cargo.load(4, 2, 82, { wcid: 4000022, liveryId: 1 }).ok, true); // Deck 82 40HC
  assert.equal(cargo.load(4, 2, 84, { wcid: 4000021, liveryId: 2 }).ok, true); // Deck 84 40ft atop 40HC
  assert.equal(cargo.load(9, 3, 82, { wcid: 4000020, liveryId: 3 }).ok, true); // Deck 82 20ft odd bay
  assert.equal(cargo.load(11, 3, 82, { wcid: 4000020, liveryId: 4 }).ok, true); // Deck 82 20ft twin odd bay
  const stowed = ship.setContainers(cargo);
  assert.equal(stowed, 5, "5 stowed containers rendered across 20ft/40ft/40HC pools");
  assert.equal(ship.containerPools["20ft"].bodyInst.count, 2);
  assert.equal(ship.containerPools["40ft"].bodyInst.count, 2);
  assert.equal(ship.containerPools["40hc"].bodyInst.count, 1);

  // Verify hold tank-top elevation strictly above max wave crest (+0.25 m)
  assert.ok(SHIP_SPECS.holdTankTopZ >= 0.45 && SHIP_SPECS.holdTankTopZ > 0.25, "hold tank-top z=+0.45 m > +0.25 m max swell");
  const holdEntry = cargo.get(2, 1, 2);
  assert.ok(holdEntry && holdEntry.localZ >= 0.45, "hold container sits at z >= 0.45 m above water");

  // Direct setHatchCover() helper
  ship.setHatchCover(2, 0.75);
  near(ship.hatchCovers[2].open, 0.75, 1e-4, "setHatchCover(2, 0.75)");

  // Verify real WebGL2 render via fake_webgl2.mjs (camera framed on ship's actual Berth 1 position)
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  cam.position.set(state.x, state.y - 80, 40);
  cam.lookAt(state.x, state.y, 5);
  scene.add(ship.root);
  gl.__fake.reset();
  renderer.render(scene, cam);
  const totalGlDraws =
    (gl.__fake.counts.drawArrays || 0) +
    (gl.__fake.counts.drawElements || 0) +
    (gl.__fake.counts.drawArraysInstanced || 0) +
    (gl.__fake.counts.drawElementsInstanced || 0);
  assert.ok(totalGlDraws > 0 && totalGlDraws <= 19, `fake WebGL2 rendered ${totalGlDraws} ship+container draws (<= 19)`);
  renderer.dispose();
  ship.dispose();
});

// ---------------------------------------------------------------------------
// 4. Maritime VFX (ship_fx.js) — Draw Calls, 0 Lights, Zero-Alloc Pools & Disposal
// ---------------------------------------------------------------------------
check("T_SM_04 ship_fx.js <= 4 DC, 0 lights, wake/prop/thruster/spray emissions & clean disposal", () => {
  const fx = createShipFx(THREE);
  assert.equal(fx.lightCountDelta, 0);
  assert.equal(countLights(fx.root), 0, "0 dynamic lights in ship_fx");
  assert.ok(countDrawCalls(fx.root) <= SHIP_FX_LIMITS.maxDrawCalls, `ship_fx DC (${countDrawCalls(fx.root)}) <= 4`);
  assert.equal(fx.getTotalActiveCount(), 0, "0 active particles initially");

  // Step underway with bow & stern thrusters firing
  const underwayState = {
    x: 44880,
    y: 47940,
    z: 0,
    heading: Math.PI * 0.5,
    surgeU: 5.2,
    throttle: 0.85,
    rudderRad: 0.25,
    bowThruster: 0.9,
    sternThruster: -0.8,
  };
  for (let i = 0; i < 30; i++) {
    fx.update(underwayState, 0.05, i * 0.05);
  }
  const counts = fx.getActiveCounts();
  assert.ok(counts.wake > 0, `Kelvin wake emitted (${counts.wake})`);
  assert.ok(counts.propWash > 0, `prop wash emitted (${counts.propWash})`);
  assert.ok(counts.thrusters > 0, `bow/stern thruster whitewater jets emitted (${counts.thrusters})`);
  assert.ok(counts.spray > 0, `bow spray emitted (${counts.spray})`);

  // Fake WebGL2 render check on VFX instanced meshes
  const gl = createFakeWebGL2({ maxTextures: 16 });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  cam.position.set(44880, 47860, 45);
  cam.lookAt(44880, 47940, 0);
  scene.add(fx.root);
  renderer.render(scene, cam);
  renderer.dispose();

  // Reset zeroes all active counts cleanly
  fx.reset();
  assert.equal(fx.getTotalActiveCount(), 0, "reset clears all pools");

  // Disposal frees geometry, materials & DataTexture
  const spy = spyDisposal(fx.root);
  fx.dispose();
  assert.equal(fx.disposed, true);
  assert.ok(spy.geoms.every((g) => g.disposed), "fx geometries disposed");
  assert.ok(spy.mats.every((m) => m.disposed), "fx materials disposed");
  // Safe no-op after dispose
  fx.update(underwayState, 0.05, 99);
  assert.equal(fx.getTotalActiveCount(), 0);
});

// ---------------------------------------------------------------------------
// 5. Ship Controls & 4-Mode Camera Rig (ship_controls.js)
// ---------------------------------------------------------------------------
check("T_SM_05 ship_controls.js keybindings, __inputFunnel lock/drain, guards & occupied-vehicle safety", () => {
  const env = makeControlEnv();
  const actions = [];
  let camOwned = false;
  let camWrites = 0;
  let camReleased = false;
  let otherOccupied = true;

  const fakeLive = {
    cameraSwitcher: { _camDebugParked: false, keys: { KeyW: true }, _endFollowDrag() {} },
  };

  const ctrl = createShipControls({
    window: env.win,
    document: env.doc,
    liveScene3d: fakeLive,
    isOtherVehicleOccupied: () => otherOccupied,
    cameraOwnerFactory: () => ({
      get owned() { return camOwned; },
      own() { camOwned = true; },
      write() { camWrites++; return true; },
      release() { camOwned = false; camReleased = true; },
      dispose() { camOwned = false; },
    }),
  });
  ctrl.onAction((a) => actions.push(a));

  // Must refuse lock if another vehicle currently occupies the player!
  const refused = ctrl.lock();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "other-vehicle-occupied");
  assert.equal(ctrl.locked, false);
  assert.equal(env.funnel._fault, null);

  // Unlock other vehicle and acquire helm lock
  otherOccupied = false;
  const ok = ctrl.lock({ initialHeading: Math.PI * 0.5 });
  assert.equal(ok.ok, true);
  assert.equal(ctrl.locked, true);
  assert.equal(ctrl.cameraOwned, true);
  assert.equal(env.funnel._fault, "gate", "__inputFunnel poisoned to gate while at helm");
  assert.equal(fakeLive.cameraSwitcher.keys.KeyW, false, "cameraSwitcher held keys cleared");

  // W/S EOT notches (-3..+3) & Space All Stop
  env.win.dispatch("keydown", { code: "KeyW" });
  env.win.dispatch("keyup", { code: "KeyW" });
  env.win.dispatch("keydown", { code: "KeyW" });
  env.win.dispatch("keyup", { code: "KeyW" });
  assert.equal(ctrl.eot, 2, "W increments EOT to +2");
  let polled = ctrl.poll(0.1);
  assert.equal(polled.eotNotch, 2);
  assert.ok(polled.throttle > 0.5);

  env.win.dispatch("keydown", { code: "KeyS" });
  env.win.dispatch("keyup", { code: "KeyS" });
  assert.equal(ctrl.eot, 1, "S decrements EOT to +1");

  env.win.dispatch("keydown", { code: "Space" });
  env.win.dispatch("keyup", { code: "Space" });
  assert.equal(ctrl.eot, 0, "Space All Stop resets EOT to 0");

  // A/D Rudder & C Center (step 3x 0.20 s to accumulate realistic wheel turn past dt<=0.25 clamp)
  env.win.dispatch("keydown", { code: "KeyD" });
  for (let i = 0; i < 3; i++) polled = ctrl.poll(0.20);
  assert.ok(polled.rudder > 0.45 && polled.targetRudderRad > 0.25, `D steers rudder starboard (rudder=${polled.rudder.toFixed(3)})`);
  env.win.dispatch("keyup", { code: "KeyD" });
  // Rudder holds set angle after release
  const heldPolled = ctrl.poll(0.2);
  near(heldPolled.rudder, polled.rudder, 1e-4, "ship rudder holds wheel angle");
  env.win.dispatch("keydown", { code: "KeyC" });
  env.win.dispatch("keyup", { code: "KeyC" });
  assert.equal(ctrl.rudder, 0, "C centers rudder");

  // Q/E Parallel lateral thrusters (crab port/stbd)
  env.win.dispatch("keydown", { code: "KeyE" });
  for (let i = 0; i < 2; i++) polled = ctrl.poll(0.20);
  assert.ok(polled.bowThruster > 0.9 && polled.sternThruster > 0.9, "E drives parallel starboard thrusters");
  env.win.dispatch("keyup", { code: "KeyE" });
  for (let i = 0; i < 3; i++) ctrl.poll(0.20);

  env.win.dispatch("keydown", { code: "KeyQ" });
  for (let i = 0; i < 2; i++) polled = ctrl.poll(0.20);
  assert.ok(polled.bowThruster < -0.9 && polled.sternThruster < -0.9, "Q drives parallel port thrusters");
  env.win.dispatch("keyup", { code: "KeyQ" });
  for (let i = 0; i < 3; i++) ctrl.poll(0.20);

  // Shift+A/D Counter-pivot thrusters (must not steer rudder)
  env.win.dispatch("keydown", { code: "ShiftLeft" });
  env.win.dispatch("keydown", { code: "KeyD" });
  for (let i = 0; i < 2; i++) polled = ctrl.poll(0.20);
  assert.ok(polled.bowThruster > 0.9 && polled.sternThruster < -0.9, "Shift+D drives CW counter-pivot thrusters");
  assert.equal(ctrl.rudder, 0, "Shift+D does not move rudder");
  env.win.dispatch("keyup", { code: "KeyD" });
  env.win.dispatch("keydown", { code: "KeyA" });
  for (let i = 0; i < 3; i++) polled = ctrl.poll(0.20);
  assert.ok(polled.bowThruster < -0.9 && polled.sternThruster > 0.9, "Shift+A drives CCW counter-pivot thrusters");
  env.win.dispatch("keyup", { code: "KeyA" });
  env.win.dispatch("keyup", { code: "ShiftLeft" });

  // RMB freelook drag & spring-back
  env.win.dispatch("mousedown", { button: 2 });
  env.win.dispatch("mousemove", { movementX: 100, movementY: -40 });
  polled = ctrl.poll(0.05);
  assert.ok(polled.freelook.yaw > 0.2 && polled.freelook.pitch > 0.05, "RMB freelook tracks mouse delta");
  env.win.dispatch("mouseup", { button: 2 });
  for (let i = 0; i < 10; i++) polled = ctrl.poll(0.15);
  near(polled.freelook.yaw, 0, 0.02, "freelook springs back to 0");

  // Programmatic override
  ctrl.setOverride({ eotNotch: -2, rudder: -0.5, bowThruster: 0.4, sternThruster: 0.4 }, 1000);
  polled = ctrl.poll(0.05);
  assert.equal(polled.eotNotch, -2);
  near(polled.rudder, -0.5, 1e-4);
  ctrl.setOverride(null);

  // Restore-time key drain: hold KeyW across exit() -> keyup must be absorbed cleanly
  env.win.dispatch("keydown", { code: "KeyW" });
  const res = ctrl.exit();
  assert.equal(res.wasLocked, true);
  assert.equal(ctrl.locked, false);
  assert.equal(camReleased, true, "camera released cleanly");
  assert.equal(env.funnel._fault, null, "__inputFunnel unpoisoned cleanly");
  const drainUp = env.win.dispatch("keyup", { code: "KeyW" });
  assert.equal(drainUp.prevented, true, "restore-time key drain swallowed orphaned keyup");

  // Re-lock to test M, P, 1/2, H, Tab, X actions & non-stolen keys
  ctrl.lock();

  // M, P, 1/2, H, Tab, X actions
  for (const code of ["KeyM", "KeyP", "Digit2", "Digit1", "KeyH", "Tab", "Tab", "Tab", "Tab", "KeyX"]) {
    env.win.dispatch("keydown", { code });
    env.win.dispatch("keyup", { code });
  }
  const types = actions.map((a) => a.type);
  assert.ok(types.includes("toggleMoor"), "M emits toggleMoor");
  assert.ok(types.includes("toggleAutopilot"), "P emits toggleAutopilot");
  assert.ok(actions.some((a) => a.type === "selectBerth" && a.berthId === "B2"), "2 selects B2");
  assert.ok(actions.some((a) => a.type === "selectBerth" && a.berthId === "B1"), "1 selects B1");
  assert.ok(types.includes("foghorn"), "H emits foghorn");
  assert.ok(types.includes("exit"), "X emits exit");
  assert.equal(ctrl.getViewMode(), "chase", "4 Tab presses cycle chase->bridge->wing->overhead->chase");

  // Never steals chat input, Escape, Enter, F-keys, or Ctrl chords
  const chatInput = { tagName: "INPUT", isContentEditable: false };
  const rChat = env.win.dispatch("keydown", { code: "KeyW", target: chatInput });
  assert.equal(rChat.prevented, false, "does not steal keys while typing in chat input");
  const rEsc = env.win.dispatch("keydown", { code: "Escape" });
  assert.equal(rEsc.prevented, false, "never steals Escape");
  const rF1 = env.win.dispatch("keydown", { code: "F1" });
  assert.equal(rF1.prevented, false, "never steals F-keys");
  const rCtrl = env.win.dispatch("keydown", { code: "KeyP", ctrlKey: true });
  assert.equal(rCtrl.prevented, false, "never steals Ctrl chords");

  // Camera write & _camDebugParked respect
  const pose = { x: 44880, y: 47900, z: 0, heading: Math.PI * 0.5, pitch: 0, roll: 0 };
  ctrl.updateCamera(pose, 0.016);
  assert.equal(camWrites, 1, "cameraOwner.write called when active");
  fakeLive.cameraSwitcher._camDebugParked = true;
  ctrl.updateCamera(pose, 0.016);
  assert.equal(camWrites, 1, "_camDebugParked prevents overwriting debug orbit camera");

  // Clean exit / restore & dispose
  const res2 = ctrl.exit();
  assert.equal(res2.wasLocked, true);
  assert.equal(ctrl.locked, false);
  assert.equal(camReleased, true, "camera released cleanly");
  assert.equal(env.funnel._fault, null, "__inputFunnel unpoisoned cleanly");
  ctrl.dispose();
  assert.equal(env.win.listenerCount("keydown"), 0, "all keydown listeners removed on dispose");
});

check("T_SM_06 4-mode nautical camera rig geometry (chase / bridge / wing / overhead)", () => {
  const rig = createShipCameraRig({ initialView: "chase" });
  const pose = { x: 44880, y: 47888.55, z: 0, heading: Math.PI * 0.5, pitch: 0.01, roll: 0.0 };
  const berth = { x: 44880, y: 47888.55, quayY: 47880 };

  assert.deepEqual([...SHIP_VIEW_MODES], ["chase", "bridge", "wing", "overhead"]);

  // 1. Chase: astern (-X when heading East) and elevated
  const cChase = rig.step({ pose, dt: 0.016, berth });
  assert.ok(cChase.cam.pos[0] < pose.x - 50, "chase sits astern of ship");
  assert.ok(cChase.cam.pos[2] > 18, "chase elevated above deck");

  // 2. Bridge: inside wheelhouse looking East (+X)
  rig.setView("bridge");
  const cBridge = rig.step({ pose, dt: 0.016, berth });
  const expectedBridge = shipLocalToWorld(pose, SHIP_SPECS.cameraAnchors.bridge.x, SHIP_SPECS.cameraAnchors.bridge.y, SHIP_SPECS.cameraAnchors.bridge.z);
  near(cBridge.cam.pos[0], expectedBridge[0], 0.01, "bridge X");
  near(cBridge.cam.pos[1], expectedBridge[1], 0.01, "bridge Y");
  near(cBridge.cam.pos[2], expectedBridge[2], 0.01, "bridge Z");

  // 3. Wing: auto-selects starboard wing facing South quay when heading East
  rig.setView("wing");
  const cWing = rig.step({ pose, dt: 0.016, berth });
  assert.equal(cWing.wingSide, "starboard", "auto-selects quay-facing starboard bridge wing");
  assert.ok(cWing.cam.pos[1] < pose.y - 6.0, "starboard wing sits over South fender line");
  assert.ok(cWing.cam.p < -0.15, "wing camera looks down toward fenders");

  // 4. Overhead: high bird's-eye view pitched sharply down
  rig.setView("overhead");
  const cOver = rig.step({ pose, dt: 0.016, berth });
  assert.ok(cOver.cam.pos[2] > 85, "overhead altitude > 85 m");
  assert.ok(cOver.cam.p < -1.1, "overhead pitched steep down");
});

// ---------------------------------------------------------------------------
// 6. Bridge Nautical DOM HUD (ship_osd.js)
// ---------------------------------------------------------------------------
check("T_SM_07 ship_osd.js #hb-ship-osd DOM rendering, dirty-checked updates & zero post-dispose writes", () => {
  const dom = makeFakeDom();
  const osd = createShipOsd({ document: dom.doc });
  assert.equal(osd.id, SHIP_OSD_ID);
  assert.equal(formatCompassHeading(Math.PI * 0.5), "090° E");

  const snap = {
    name: "M/V Dereth Feeder",
    mode: "manual",
    viewMode: "wing",
    heading: Math.PI * 0.5,
    eotNotch: 2,
    surgeU: 4.5,
    swayV: 0.1,
    yawRateR: 0.02,
    ukcM: 10.2,
    cargoCount: 24,
    rudderRad: 0.35,
    bowThruster: 0.6,
    sternThruster: -0.4,
    targetBerthId: "B1",
    moored: false,
    berthAlignment: {
      berthId: "B1",
      fenderGapM: 1.2,
      longErrM: 0.8,
      headingErrDeg: 1.5,
      inEnvelope: true,
    },
  };

  osd.update(snap);
  assert.equal(osd.isVisible(), true);
  assert.ok(dom.byId.has(SHIP_OSD_ID), "#hb-ship-osd created in DOM");
  assert.ok(dom.byId.has(SHIP_PROMPT_ID), "#hb-ship-prompt created in DOM");
  assert.equal(dom.byId.get(SHIP_OSD_ID).style.display, "block");

  // Dirty-checking: identical update must cause 0 DOM mutations!
  dom.resetMutations();
  osd.update(snap);
  assert.equal(dom.mutations, 0, "identical state triggers 0 redundant DOM mutations");

  // Mode transitions: Autonomous Captain -> Moored Cargo Ops + Shoal UKC crit
  osd.update({ ...snap, mode: "autonomous", captainState: "FINAL_BERTHING", ukcM: 0.7, rudderRad: -0.4 });
  assert.equal(osd.isVisible(), true);
  osd.update({ ...snap, moored: true, captainState: "CARGO_OPS", eotNotch: 0, ukcM: 2.2 });
  assert.equal(osd.isVisible(), true);

  // toggleHidden() & null state hide HUD cleanly
  assert.equal(osd.toggleHidden(), true);
  assert.equal(osd.isHidden(), true);
  assert.equal(osd.isVisible(), false);
  assert.equal(osd.toggleHidden(), false);
  osd.update(null);
  assert.equal(osd.isVisible(), false);
  assert.equal(dom.byId.get(SHIP_OSD_ID).style.display, "none");

  osd.prompt("Press X to exit helm");
  assert.equal(dom.byId.get(SHIP_PROMPT_ID).style.display, "block");
  osd.prompt(null);
  assert.equal(dom.byId.get(SHIP_PROMPT_ID).style.display, "none");

  // Dispose removes DOM nodes & prevents any further DOM mutations
  osd.dispose();
  assert.equal(osd.disposed, true);
  assert.equal(dom.byId.has(SHIP_OSD_ID), false, "#hb-ship-osd removed on dispose");
  dom.resetMutations();
  osd.update(snap);
  osd.prompt("should not write");
  assert.equal(dom.mutations, 0, "0 DOM mutations after dispose()");
});

// ---------------------------------------------------------------------------
// 7. Procedural Spatial Maritime Audio (port_audio.js)
// ---------------------------------------------------------------------------
check("T_SM_08 port_audio.js headless safety, acoustic curves, mock WebAudio synthesis, stop & dispose", () => {
  assert.equal(portAudioEnabled("?vehicles=on"), true);
  assert.equal(portAudioEnabled("?portAudio=off"), false);
  assert.equal(portAudioEnabled("?vehicleAudio=off"), false);
  assert.deepEqual(acToAudioPos([10, 20, 5]), [10, 5, -20]);

  // Acoustic transfer curve monotonicity
  const pIdle = computeShipAudioParams({ eotNotch: 0, surgeU: 0, bowThruster: 0, sternThruster: 0 });
  const pFull = computeShipAudioParams({ eotNotch: 3, surgeU: 6.0, bowThruster: 0.9, sternThruster: 0.5 });
  assert.ok(pFull.dieselHz > pIdle.dieselHz, "diesel pitch increases with EOT");
  assert.ok(pFull.dieselGain > pIdle.dieselGain, "diesel gain increases with EOT");
  assert.equal(pIdle.thrusterGain, 0, "zero thruster hiss when idle");
  assert.ok(pFull.thrusterGain > 0.1, "thruster cavitation active under load");

  // Headless / null-AudioContext safety (must never throw)
  const headlessAudio = createPortAudio({ bus: null });
  assert.equal(headlessAudio.updateShip("SHIP-1", { eotNotch: 2, x: 44880, y: 47900, z: 0 }), false);
  assert.equal(headlessAudio.playFoghorn([44880, 47900, 15]), false);
  assert.equal(headlessAudio.updateCrane("STS-1", { trolleySpeed: 2.0, pos: [44880, 47865, 25] }), false);
  assert.equal(headlessAudio.playTwistlockClunk([44880, 47880, 10], true), false);
  assert.equal(headlessAudio.updateAmbient([44880, 47870, 2], PORT_ORIGIN, true), false);
  headlessAudio.stop();
  headlessAudio.dispose();
  assert.equal(headlessAudio.disposed, true);

  // Mock WebAudio graph synthesis + stop() + dispose()
  const mock = makeFakeWebAudioBus();
  const audio = createPortAudio({ bus: mock.bus });
  assert.equal(audio.updateShip("SHIP-1", { eotNotch: 2, surgeU: 4.0, bowThruster: 0.8, x: 44880, y: 47900, z: 0 }, [44880, 47870, 5]), true);
  assert.equal(audio.playFoghorn([44880, 47900, 15]), true);
  assert.equal(audio.updateCrane("STS-1", { trolleySpeed: 3.0, hoistSpeed: 1.5, pos: [44880, 47865, 22] }, [44880, 47870, 2]), true);
  assert.equal(audio.playTwistlockClunk([44880, 47880, 6], true), true);
  assert.equal(audio.playMooringWinch([44880, 47880, 3]), true);
  assert.equal(audio.updateAmbient([44880, 47870, 2], PORT_ORIGIN, true), true);

  const st = audio.stats();
  assert.equal(st.activeShips, 1);
  assert.equal(st.activeCranes, 1);
  assert.equal(st.ambientActive, true);
  assert.equal(st.foghorns, 1);
  assert.equal(st.twistlocks, 1);
  assert.ok(mock.createdNodes.length >= 15, "WebAudio synthesis graph nodes created");

  // stop() cleans up active voices without permanently disabling
  audio.stop();
  assert.equal(audio.stats().activeShips, 0);
  assert.equal(audio.stats().activeCranes, 0);
  assert.equal(audio.stats().ambientActive, false);

  // dispose() permanently tears down
  audio.dispose();
  assert.equal(audio.disposed, true);
  assert.equal(audio.playFoghorn([0, 0, 0]), false, "no synthesis after dispose()");
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
