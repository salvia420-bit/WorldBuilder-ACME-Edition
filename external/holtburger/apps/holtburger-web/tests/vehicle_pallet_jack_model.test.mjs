// tests/vehicle_pallet_jack_model.test.mjs — ISO 3691-5 Pallet Jack (`WCID 4000035`),
// Runtime `setStowed(bool)` across all 9 Deployables (`4000002`, `4000010..4000017`),
// and Pallet Jack Procedural Audio (`pumpRatchet`, `releaseHiss`, `updateWheelRoll`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  PALLET_JACK_WCID,
  PALLET_JACK_SPECS,
  manifest as pjManifest,
  buildPalletJack,
} from "../scene3d/vehicle/pallet_jack_model.js";
import {
  DEPLOYABLE_WCID,
  buildDeployable,
} from "../scene3d/vehicle/deployable_models.js";
import { buildDeployedRadar } from "../scene3d/vehicle/radar_model.js";
import {
  PALLET_JACK_SURFACE_PROFILES,
  createLogisticsAudio,
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

function spyDisposal(root) {
  const geoms = [];
  const mats = [];
  const seenG = new Set();
  const seenM = new Set();
  root.traverse((o) => {
    if (o.geometry && !seenG.has(o.geometry)) {
      seenG.add(o.geometry);
      const rec = { disposed: false };
      const orig = o.geometry.dispose.bind(o.geometry);
      o.geometry.dispose = () => { rec.disposed = true; orig(); };
      geoms.push(rec);
    }
    if (o.material) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m && !seenM.has(m)) {
          seenM.add(m);
          const rec = { disposed: false };
          const orig = m.dispose.bind(m);
          m.dispose = () => { rec.disposed = true; orig(); };
          mats.push(rec);
        }
      }
    }
  });
  return { geoms, mats };
}

// --- WebAudio Mocks (full & bare) ---
function rparam(init = 0) {
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
  createOscillator() { return this._src("osc", { type: "sine", frequency: rparam(440) }); }
  createBiquadFilter() { return this._n("biquad", { type: "lowpass", frequency: rparam(350), Q: rparam(1), gain: rparam(0) }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  createBufferSource() { return this._src("bufsrc", { buffer: null, loop: false }); }
  createGain() { return this._n("gain", { gain: rparam(1) }); }
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
  async resume() { this.state = "running"; }
}

/** Bare context lacking createBiquadFilter, createPanner, and ramp methods. */
class BareMockCtx extends FullMockCtx {
  constructor() {
    super();
    this.createBiquadFilter = undefined;
    this.createPanner = undefined;
  }
  createOscillator() {
    const f = { value: 440, setTargetAtTime(v) { this.value = v; } };
    return this._src("osc", { type: "sine", frequency: f });
  }
}

function makeBus(Ctx = FullMockCtx) {
  const ctx = new Ctx();
  const node = ctx._n("bus", { gain: rparam(1) });
  ctx.made.length = 0;
  return { ctx, node, sliderGain: () => 1, isActive: () => true };
}

console.log("=== Pallet Jack Model, Runtime setStowed & Audio Suite ===");

check("T_PJ_01 Exports, Manifest & lintSource() across pallet_jack/deployable/radar models", () => {
  assert.equal(PALLET_JACK_WCID, 4000035);
  assert.equal(PALLET_JACK_SPECS.forkLength, 1.150);
  assert.equal(PALLET_JACK_SPECS.forkWidth, 0.160);
  assert.equal(PALLET_JACK_SPECS.forkSpread, 0.685);
  assert.equal(PALLET_JACK_SPECS.forkLoweredZ, 0.085);
  assert.equal(PALLET_JACK_SPECS.forkRaisedZ, 0.200);
  assert.equal(PALLET_JACK_SPECS.tillerHeight, 1.22);
  assert.equal(PALLET_JACK_SPECS.wheelbase, 1.18);
  assert.equal(PALLET_JACK_SPECS.cargoCenterY, 0.250);
  assert.equal(lintManifest(pjManifest).length, 0);

  for (const rel of [
    "scene3d/vehicle/pallet_jack_model.js",
    "scene3d/vehicle/deployable_models.js",
    "scene3d/vehicle/radar_model.js",
  ]) {
    const hits = lintSource(readFileSync(join(ROOT, rel), "utf8"));
    assert.equal(hits.length, 0, `${rel} lintSource hits: ${JSON.stringify(hits)}`);
  }
});

check("T_PJ_02 Draw Calls (<= 6 unloaded), 0 Lights, AGX PBR + CSM, WebGL2 render", () => {
  const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));

  try {
    const jack = buildPalletJack(THREE, { csmState: fakeCsm });
    const draws = countDrawCalls(jack.root);
    const lights = countLights(jack.root);
    assert.ok(draws >= 4 && draws <= 6, `unloaded pallet jack draw calls (${draws}) <= 6`);
    assert.equal(lights, 0, "0 THREE.Light instances");

    jack.root.traverse((o) => {
      if (o.isMesh) {
        assert.equal(o.castShadow, true, `${o.name} castShadow`);
        assert.equal(o.receiveShadow, true, `${o.name} receiveShadow`);
        assert.ok(o.material.isMeshStandardMaterial, `${o.name} MeshStandardMaterial`);
        assert.equal(o.material.vertexColors, true, `${o.name} vertexColors`);
        assert.equal(o.material.userData?.csmEnabled, true, `${o.name} CSM patched`);
      }
    });

    const gl = createFakeWebGL2({ maxTextures: 16 });
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1.33, 0.1, 1000);
    camera.position.set(2, -3, 1.5);
    camera.lookAt(0, 0, 0.5);
    scene.add(jack.root);

    gl.__fake.reset();
    renderer.render(scene, camera);
    const emitted = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
    assert.ok(emitted > 0, `WebGL2 executed ${emitted} draw commands`);
    assert.equal(errors.length, 0, `console errors: ${errors.join(" | ")}`);

    scene.remove(jack.root);
    jack.dispose();
    renderer.dispose();
  } finally {
    console.error = origError;
  }
});

check("T_PJ_03 ISO 3691-5 Dimensions, fork lift clamping, tiller steer & pump stroke", () => {
  const jack = buildPalletJack(THREE);
  jack.root.updateMatrixWorld(true);

  const forkBox = new THREE.Box3().setFromObject(jack.forksGroup);
  near(forkBox.max.y - forkBox.min.y, 1.150, 0.005, "fork length 1.150m");
  near(forkBox.max.x - forkBox.min.x, 0.685, 0.005, "fork spread 0.685m");

  const rootBox = new THREE.Box3().setFromObject(jack.root);
  near(rootBox.min.z, 0.0, 0.005, "wheels sit on ground z=0");
  near(rootBox.max.z, 1.22, 0.01, "tiller height 1.22m");

  // Clamping forkHeightM & dynamic fork-tunnel threading on cargoMount
  jack.update({ forkHeightM: 0.05 });
  near(jack.forkHeightM, 0.085, 1e-6, "min forkHeightM clamped to 0.085");
  near(jack.forksGroup.position.z, 0.085, 1e-6);

  const wpLowered = new THREE.Vector3();
  jack.root.updateMatrixWorld(true);
  jack.cargoMount.getWorldPosition(wpLowered);
  near(wpLowered.y, 0.250, 1e-6, "cargoMount Y === 0.250");
  near(wpLowered.z, 0.000, 1e-6, "cargoMount world Z === 0.000 when lowered (never sinks underground)");

  jack.update({ forkHeightM: 0.50 });
  near(jack.forkHeightM, 0.200, 1e-6, "max forkHeightM clamped to 0.200");
  near(jack.forksGroup.position.z, 0.200, 1e-6);

  const wp = new THREE.Vector3();
  jack.root.updateMatrixWorld(true);
  jack.cargoMount.getWorldPosition(wp);
  near(wp.z, 0.077, 1e-6, "cargoMount world Z === 0.077 (forks threaded inside z in [0.018, 0.123] tunnel)");

  // Fork blades & beveled tips (y > -0.30 in forksGroup local space) must stay strictly at/below z = 0
  // so they never overshoot the pallet deck underside (z_pallet = 0.123) when raised
  const forksMesh = jack.forksGroup.getObjectByName("pallet-jack-forks-mesh");
  assert.ok(forksMesh && forksMesh.geometry, "pallet-jack-forks-mesh exists");
  const fkPos = forksMesh.geometry.getAttribute("position");
  let forkBladeMaxZ = -Infinity;
  for (let i = 0; i < fkPos.count; i++) {
    if (fkPos.getY(i) > -0.30) {
      const vz = fkPos.getZ(i);
      if (vz > forkBladeMaxZ) forkBladeMaxZ = vz;
    }
  }
  assert.ok(forkBladeMaxZ <= 0.0, `forksMesh max z (${forkBladeMaxZ.toFixed(6)}) <= 0.0 for y > -0.30`);

  // Ground wheels remain at z = 0 when forks raised; tiller grip anchor geometry preserved
  const raisedBox = new THREE.Box3().setFromObject(jack.root);
  near(raisedBox.min.z, 0.0, 0.005, "wheels stay at z=0 when forks raised");
  near(jack.steerPivot.position.y, -0.52, 1e-6, "steerPivotY preserved at -0.52");
  near(jack.tillerPivot.position.z, 0.38, 1e-6, "tillerPivot.z preserved at 0.38");

  // Tiller angle & pump stroke
  jack.update({ tillerAngle: 3.0, pumpStroke: 0.8 });
  near(jack.steerPivot.rotation.z, 1.65, 1e-6, "tillerAngle clamped +1.65 rad");
  assert.ok(jack.tillerPivot.rotation.x > 0, "pumpStroke tilts tillerPivot.rotation.x > 0");

  jack.update({ tillerAngle: -3.0 });
  near(jack.steerPivot.rotation.z, -1.65, 1e-6, "tillerAngle clamped -1.65 rad");

  jack.update({ stowed: true });
  assert.equal(jack.stowed, true);
  assert.equal(jack.steerPivot.rotation.z, 0, "stowed parks tiller yaw at 0");
  assert.equal(jack.tillerPivot.rotation.x, 0, "stowed parks tiller pitch at 0");

  jack.dispose();
});

check("T_PJ_04 cargoMount mount & clean disposal across 0 -> 4000012 -> 4000002 -> 0", () => {
  const jack = buildPalletJack(THREE);
  assert.equal(jack.cargoMount.children.length, 0);
  assert.ok(countDrawCalls(jack.root) <= 6);

  // Mount PowerGenerator (4000012)
  jack.update({ carriedWcid: 4000012 });
  assert.equal(jack.carriedWcid, 4000012);
  assert.equal(jack.cargoMount.children.length, 1);
  assert.equal(countLights(jack.root), 0);
  const firstChildRef = jack.cargoMount.children[0];

  // Idempotent re-update keeps exact child reference
  jack.update({ carriedWcid: 4000012, forkHeightM: 0.16 });
  assert.equal(jack.cargoMount.children[0], firstChildRef, "idempotent carriedWcid keeps same child");

  // Spy on 4000012 disposal and swap to DeployedRadar (4000002)
  const spyGen = spyDisposal(jack.cargoMount);
  assert.ok(spyGen.geoms.length > 0 && spyGen.mats.length > 0);
  jack.update({ carriedWcid: 4000002 });
  assert.ok(spyGen.geoms.every((g) => g.disposed), "all 4000012 geometries disposed on swap");
  assert.ok(spyGen.mats.every((m) => m.disposed), "all 4000012 materials disposed on swap");
  assert.equal(jack.carriedWcid, 4000002);
  assert.equal(jack.mountedCargo.model.stowed, true, "mounted radar starts stowed");

  const radarBox = new THREE.Box3().setFromObject(jack.mountedCargo.model.root);
  assert.ok(radarBox.max.z - radarBox.min.z <= 2.10, `mounted stowed radar height <= 2.10m`);

  // Spy on 4000002 disposal and clear back to 0
  const spyRad = spyDisposal(jack.cargoMount);
  jack.update({ carriedWcid: 0 });
  assert.ok(spyRad.geoms.every((g) => g.disposed), "all 4000002 geometries disposed on clear");
  assert.ok(spyRad.mats.every((m) => m.disposed), "all 4000002 materials disposed on clear");
  assert.equal(jack.cargoMount.children.length, 0);
  assert.ok(countDrawCalls(jack.root) <= 6, "unloaded draw calls return <= 6");

  // All 9 deployables (4000002, 4000010..4000017) mount with unified palletSize==="full",
  // fork-tunnel threading at raised/lowered heights, <= 2.05m stowed height, and zero fork-tip/backrest overhang
  const ALL_9_WCIDS = [4000002, 4000010, 4000011, 4000012, 4000013, 4000014, 4000015, 4000016, 4000017];
  for (const wcid of ALL_9_WCIDS) {
    jack.update({ carriedWcid: wcid, forkHeightM: 0.200 });
    assert.equal(jack.cargoMount.children.length, 1);
    assert.equal(jack.mountedCargo.model.palletSize, "full", `WCID ${wcid} unified palletSize === "full"`);

    jack.root.updateMatrixWorld(true);
    const raisedCargoBox = new THREE.Box3().setFromObject(jack.mountedCargo.model.root);
    near(raisedCargoBox.min.z, 0.077, 1e-3, `WCID ${wcid} raised pallet bottom at +0.077m`);
    assert.ok(raisedCargoBox.max.z - raisedCargoBox.min.z <= 2.05, `WCID ${wcid} stowed height <= 2.05m`);
    assert.ok(raisedCargoBox.max.y <= 0.805, `WCID ${wcid} max.y (${raisedCargoBox.max.y.toFixed(4)}) <= 0.805m`);
    assert.ok(raisedCargoBox.min.y >= -0.305, `WCID ${wcid} min.y (${raisedCargoBox.min.y.toFixed(4)}) >= -0.305m`);
    assert.ok(raisedCargoBox.min.x >= -0.555 && raisedCargoBox.max.x <= 0.555, `WCID ${wcid} X inside ±0.555m`);

    jack.update({ forkHeightM: 0.085 });
    jack.root.updateMatrixWorld(true);
    const loweredCargoBox = new THREE.Box3().setFromObject(jack.mountedCargo.model.root);
    assert.ok(loweredCargoBox.min.z >= -1e-4, `WCID ${wcid} lowered min.z (${loweredCargoBox.min.z.toFixed(4)}) >= 0`);
  }

  // Bare-pallet fallback mounts standard stowed pallet and jack.dispose() cleans up active cargo
  jack.update({ carriedWcid: 4000099, forkHeightM: 0.200 });
  assert.equal(jack.cargoMount.children.length, 1);
  assert.equal(jack.mountedCargo.model.size, "standard", "bare fallback mounts standard pallet");
  assert.equal(jack.mountedCargo.model.stowed, true, "bare fallback pallet jacks stowed");
  const spyLast = spyDisposal(jack.cargoMount);
  jack.dispose();
  assert.ok(spyLast.geoms.every((g) => g.disposed), "jack.dispose() disposes active cargo geometries");
  assert.ok(spyLast.mats.every((m) => m.disposed), "jack.dispose() disposes active cargo materials");
});

check("T_PJ_05 Runtime setStowed(bool) across all 9 deployables (4000002, 4000010..4000017)", () => {
  const WCIDS = [
    4000002,
    DEPLOYABLE_WCID.FluxPod,
    DEPLOYABLE_WCID.SolarPanels,
    DEPLOYABLE_WCID.PowerGenerator,
    DEPLOYABLE_WCID.BatteryUnit,
    DEPLOYABLE_WCID.MissileTurret,
    DEPLOYABLE_WCID.GroundRadar,
    DEPLOYABLE_WCID.MortarTurret,
    DEPLOYABLE_WCID.HeavyLaserTurret,
  ];

  for (const wcid of WCIDS) {
    const unit = wcid === 4000002
      ? buildDeployedRadar(THREE, { stowed: false })
      : buildDeployable(THREE, wcid, { stowed: false });

    assert.equal(unit.stowed, false, `WCID ${wcid} starts active`);
    const baseDraws = countDrawCalls(unit.root);
    const maxDraws = wcid === 4000002 ? 8 : 10;
    assert.ok(baseDraws > 0 && baseDraws <= maxDraws, `WCID ${wcid} draws (${baseDraws}) <= ${maxDraws}`);
    assert.equal(countLights(unit.root), 0, `WCID ${wcid} has 0 lights`);

    // Exercise active state update
    unit.update(
      wcid === 4000002
        ? 1.0
        : {
            simTimeSec: 1.5,
            dt: 0.1,
            sunAzimuthRad: 1.1,
            sunPitchRad: 0.7,
            fuelRemaining: 40,
            energyJoules: 480000,
            deployElevation: 0.9,
            yawRad: 0.8,
            pitchRad: 0.3,
            ammoRemaining: 2,
          },
    );

    // Runtime stow
    unit.setStowed(true);
    assert.equal(unit.stowed, true, `WCID ${wcid} stowed === true`);
    assert.equal(countDrawCalls(unit.root), baseDraws, `WCID ${wcid} draw calls unchanged after setStowed(true)`);

    unit.root.updateMatrixWorld(true);
    const stowedBox = new THREE.Box3().setFromObject(unit.root);
    const stowedH = stowedBox.max.z - stowedBox.min.z;
    const ceiling = 2.05;
    assert.ok(stowedH <= ceiling, `WCID ${wcid} stowed height (${stowedH.toFixed(3)}) <= ${ceiling}`);

    // Subsequent update while stowed must not move parked parts
    if (wcid === 4000002) {
      near(unit.dishPivot.rotation.z, 0, 1e-6);
      unit.update(1.0);
      near(unit.dishPivot.rotation.z, 0, 1e-6, "radar stays parked while stowed");
    } else if (wcid === DEPLOYABLE_WCID.SolarPanels) {
      near(unit.trunnion.rotation.x, 0, 1e-6);
      unit.update({ sunPitchRad: 0.9, sunAzimuthRad: 1.4 });
      near(unit.trunnion.rotation.x, 0, 1e-6, "solar stays flat while stowed");
    } else if (wcid === DEPLOYABLE_WCID.MissileTurret) {
      near(unit.turntable.rotation.z, 0, 1e-6);
      near(unit.gimbal.rotation.x, 0, 1e-6);
    } else if (wcid === DEPLOYABLE_WCID.MortarTurret) {
      near(unit.cradle.rotation.x, -Math.PI / 2, 1e-6);
    } else if (wcid === DEPLOYABLE_WCID.HeavyLaserTurret) {
      near(unit.turretHead.rotation.z, 0, 1e-6);
      near(unit.barrelGimbal.rotation.x, 0, 1e-6);
    }

    // Unstow at runtime and resume updates
    unit.setStowed(false);
    assert.equal(unit.stowed, false, `WCID ${wcid} unstowed === false`);
    unit.update(wcid === 4000002 ? 1.0 : { simTimeSec: 2.0, dt: 0.1, yawRad: 0.5, pitchRad: 0.25, sunPitchRad: 0.6, fuelRemaining: 20, energyJoules: 360000 });
    if (wcid === 4000002) near(unit.currentAzimuth, 0.5 * Math.PI, 1e-4, "radar resumes 15 RPM");
    if (wcid === DEPLOYABLE_WCID.SolarPanels) near(unit.trunnion.rotation.x, 0.6, 1e-4, "solar resumes tracking");
    if (wcid === DEPLOYABLE_WCID.HeavyLaserTurret) near(unit.turretHead.rotation.z, 0.5, 1e-4, "laser resumes aiming");

    // Constructor { stowed: true } parity
    const ctorStowed = wcid === 4000002
      ? buildDeployedRadar(THREE, { stowed: true })
      : buildDeployable(THREE, wcid, { stowed: true });
    assert.equal(ctorStowed.stowed, true);
    const ctorBox = new THREE.Box3().setFromObject(ctorStowed.root);
    assert.ok(ctorBox.max.z - ctorBox.min.z <= ceiling, `WCID ${wcid} ctor stowed <= ${ceiling}`);

    unit.dispose();
    ctorStowed.dispose();
  }
});

check("T_PJ_06 Logistics Audio: Pallet Jack pumpRatchet, releaseHiss, surface roll & bareCtx fallback", () => {
  assert.ok(Object.isFrozen(PALLET_JACK_SURFACE_PROFILES));
  assert.ok(PALLET_JACK_SURFACE_PROFILES.ramp);
  assert.ok(PALLET_JACK_SURFACE_PROFILES.floor);
  assert.ok(PALLET_JACK_SURFACE_PROFILES.terrain);

  // Gating
  const gatedBus = makeBus();
  for (const dis of [
    createLogisticsAudio({ bus: gatedBus, search: "?vehicleAudio=off" }),
    createLogisticsAudio({ bus: gatedBus, liveScene3d: { nullRender: true } }),
    createLogisticsAudio({ bus: null }),
  ]) {
    assert.equal(dis.pumpRatchet({ pos: [1, 2, 0] }), false);
    assert.equal(dis.releaseHiss({ pos: [1, 2, 0] }), false);
    assert.equal(dis.updateWheelRoll(1, { speed: 1.5, surface: "ramp" }), false);
    assert.equal(dis.stats.totalNodes, 0);
    dis.dispose();
  }
  assert.equal(gatedBus.ctx.made.length, 0);

  let tSec = 1;
  const bus = makeBus(FullMockCtx);
  const au = createLogisticsAudio({ bus, clock: () => tSec });

  assert.equal(au.pumpRatchet({ pos: [1, 2, 0] }), true);
  assert.equal(au.releaseHiss({ pos: [1, 2, 0] }), true);
  assert.equal(au.stats.activeOneShots, 2);
  for (const n of [...bus.ctx.made]) {
    if (typeof n.onended === "function") { n.stopped = true; n.onended(); }
  }
  assert.equal(au.stats.activeOneShots, 0);

  // Surface-modulated wheel roll loop: ramp -> floor -> terrain -> stopped/stowed
  assert.equal(au.updateWheelRoll(7, { speed: 1.6, surface: "ramp", loaded: true, pos: [0, 0, 0] }), true);
  assert.equal(au.stats.rollVoices, 1);
  const biquads = bus.ctx.made.filter((n) => n.kind === "biquad");
  assert.ok(biquads.length >= 1);
  const rollF = biquads[biquads.length - 1];
  assert.equal(rollF.type, "bandpass");
  assert.ok(rollF.frequency.value >= 380, `ramp filter freq (${rollF.frequency.value}) >= 380`);

  assert.equal(au.updateWheelRoll(7, { speed: 1.0, surface: "floor", loaded: false, pos: [0, 0, 0] }), true);
  assert.equal(rollF.type, "bandpass");
  assert.ok(rollF.frequency.value >= 210 && rollF.frequency.value <= 330, `floor filter freq (${rollF.frequency.value})`);

  assert.equal(au.updateWheelRoll(7, { speed: 1.2, surface: "terrain", pos: [0, 0, 0] }), true);
  assert.equal(rollF.type, "lowpass");

  // Speed 0 or stowed mutes roll gain
  assert.equal(au.updateWheelRoll(7, { speed: 0, surface: "ramp" }), true);
  const rollMaster = bus.ctx.made.find((n) => n.kind === "gain" && n.connections.some((c) => c.kind === "panner"));
  assert.equal(rollMaster.gain.value, 0, "speed 0 drops roll masterGain to 0");

  au.updateWheelRoll(7, { speed: 1.5, surface: "ramp" });
  assert.ok(rollMaster.gain.value > 0);
  au.updateWheelRoll(7, { speed: 1.5, surface: "ramp", stowed: true });
  assert.equal(rollMaster.gain.value, 0, "stowed drops roll masterGain to 0");

  au.stopWheelRoll(7);
  assert.equal(au.stats.rollVoices, 0);
  au.dispose();
  assert.equal(au.stats.totalNodes, 0);
  for (const n of bus.ctx.made) {
    assert.equal(n.connections.length, 0, `disconnected ${n.kind}`);
    if (n.kind === "osc" || n.kind === "bufsrc") assert.equal(n.stopped, true);
  }

  // Bare context without createBiquadFilter, createPanner, or ramp methods must never throw
  const bareBus = makeBus(BareMockCtx);
  const bareAu = createLogisticsAudio({ bus: bareBus, clock: () => tSec });
  tSec += 1;
  assert.equal(bareAu.pumpRatchet({ pos: [0, 0, 0] }), true);
  assert.equal(bareAu.releaseHiss({ pos: [0, 0, 0] }), true);
  assert.equal(bareAu.updateWheelRoll(1, { speed: 1.4, surface: "ramp", pos: [0, 0, 0] }), true);
  bareAu.dispose();
  assert.equal(bareAu.stats.totalNodes, 0);
});

console.log(`\nvehicle_pallet_jack_model: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
