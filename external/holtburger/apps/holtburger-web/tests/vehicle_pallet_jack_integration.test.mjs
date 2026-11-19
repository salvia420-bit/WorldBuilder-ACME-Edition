// tests/vehicle_pallet_jack_integration.test.mjs — End-to-end Milestone M4 integration tests
// for ISO 3874 Sidelifter Trailer (WCID 4000032), ISO 3691-5 Walk-Behind Pallet Jack (WCID 4000035),
// container BSP collider lifecycle, tractor drive lock, input-funnel isolation, capture-phase
// proximity keybindings, arm IK, OSD prompts, and window.__vehicles API.
//
// Run from apps/holtburger-web/: node tests/vehicle_pallet_jack_integration.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

installFakeAudio();

const { initVehicles, TRAILER_ACTION, PALLET_JACK_ACTION } = await import("../scene3d/vehicle/index.js");
const FM = await import("../scene3d/vehicle/flight_model.js");
const TK = await import("../scene3d/vehicle/trailer_kinematics.js");
const TM = await import("../scene3d/vehicle/trailer_models.js");
const CR = await import("../scene3d/vehicle/camera_rig.js");
const OSD = await import("../scene3d/vehicle/osd.js");
const SK = await import("../scene3d/vehicle/sidelifter_kinematics.js");
const CL = await import("../scene3d/vehicle/container_logistics.js");
const PJ = await import("../scene3d/vehicle/pallet_jack_controller.js");
const { lintSource } = await import("../scene3d/vfx/lint_caps.js");

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
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : e}`);
    }
  });
}

function makeFakeWindowDocCanvas() {
  const winListeners = new Map(); // type -> Array<{ fn, capture }>
  const docListeners = new Map();
  const canvasListeners = new Map();
  const byId = new Map();

  const makeEl = (tag = "div") => {
    const cls = new Set();
    let idVal = "";
    const el = {
      tagName: tag.toUpperCase(),
      get id() { return idVal; },
      set id(v) {
        if (idVal && byId.get(idVal) === el) byId.delete(idVal);
        idVal = String(v || "");
        if (idVal) byId.set(idVal, el);
      },
      style: {},
      textContent: "",
      innerHTML: "",
      children: [],
      parentNode: null,
      dataset: {},
      isConnected: true,
      isContentEditable: false,
      contentEditable: "false",
      _modal: false,
      classList: {
        add(...xs) { xs.forEach((x) => cls.add(x)); },
        remove(...xs) { xs.forEach((x) => cls.delete(x)); },
        toggle(x, f) {
          if (f === undefined) { if (cls.has(x)) cls.delete(x); else cls.add(x); }
          else if (f) cls.add(x); else cls.delete(x);
        },
        contains(x) { return cls.has(x); },
      },
      appendChild(c) {
        c.parentNode = el;
        this.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      remove() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          const i = this.parentNode.children.indexOf(this);
          if (i >= 0) this.parentNode.children.splice(i, 1);
        }
        if (this.id && byId.get(this.id) === this) byId.delete(this.id);
      },
      closest(sel) {
        if (sel === '[aria-modal="true"]' && this._modal) return this;
        return null;
      },
      querySelector() { return null; },
      setAttribute(k, v) {
        if (k === "aria-modal" && v === "true") this._modal = true;
      },
      getAttribute(k) { return this[k] ?? null; },
      addEventListener() {},
      removeEventListener() {},
    };
    return el;
  };

  const canvas = {
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    requestPointerLock() {},
    addEventListener(type, fn) {
      if (!canvasListeners.has(type)) canvasListeners.set(type, new Set());
      canvasListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      canvasListeners.get(type)?.delete(fn);
    },
  };

  const doc = {
    body: makeEl("body"),
    head: makeEl("head"),
    activeElement: null,
    pointerLockElement: null,
    visibilityState: "visible",
    createElement(tag) { return makeEl(tag); },
    getElementById(id) { return byId.get(id) ?? null; },
    querySelectorAll(sel) {
      if (sel !== '[aria-modal="true"]') return [];
      const out = [];
      const walk = (node) => {
        if (!node || !Array.isArray(node.children)) return;
        for (const c of node.children) {
          if (c._modal) out.push(c);
          walk(c);
        }
      };
      walk(doc.body);
      return out;
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] ?? null;
    },
    exitPointerLock() { doc.pointerLockElement = null; },
    addEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, capture: cap });
    },
    removeEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const arr = docListeners.get(type);
      if (!arr) return;
      const idx = arr.findIndex((x) => x.fn === fn && x.capture === cap);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatch(type, ev = {}) {
      return dispatchTo(docListeners, type, ev);
    },
  };

  function dispatchTo(map, type, ev = {}) {
    const arr = [...(map.get(type) || [])];
    const caps = arr.filter((x) => x.capture);
    const bubs = arr.filter((x) => !x.capture);
    let defaultPrevented = false;
    let immediateStopped = false;
    let propagationStopped = false;
    const e = {
      type,
      target: null,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      ...ev,
      get defaultPrevented() { return defaultPrevented; },
      preventDefault() { defaultPrevented = true; },
      stopImmediatePropagation() { immediateStopped = true; propagationStopped = true; },
      stopPropagation() { propagationStopped = true; },
    };
    for (const h of caps) {
      if (immediateStopped) break;
      h.fn(e);
    }
    if (!propagationStopped) {
      for (const h of bubs) {
        if (immediateStopped) break;
        h.fn(e);
      }
    }
    return { event: e, defaultPrevented, immediateStopped, propagationStopped };
  }

  const funnelLog = [];
  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    location: { search: "?vehicles=on" },
    document: doc,
    getLocalPlayerGuid: () => 0,
    __jumpChargeActive: false,
    cancelJumpChargeCalls: 0,
    cancelJumpCharge() { win.cancelJumpChargeCalls++; win.__jumpChargeActive = false; },
    __inputFunnel: {
      installed: true,
      _fault: null,
      poison(v) { this._fault = v; funnelLog.push({ op: "poison", v }); },
      unpoison() { this._fault = null; funnelLog.push({ op: "unpoison" }); },
      releaseHeld(r) { funnelLog.push({ op: "releaseHeld", r }); },
      snapshot() { return { fault: this._fault }; },
    },
    addEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture: cap });
    },
    removeEventListener(type, fn, opts) {
      const cap = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const arr = winListeners.get(type);
      if (!arr) return;
      const idx = arr.findIndex((x) => x.fn === fn && x.capture === cap);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatch(type, ev = {}) {
      return dispatchTo(winListeners, type, ev);
    },
    listenerCount(type) {
      return (winListeners.get(type) || []).length;
    },
  };

  return { win, doc, canvas, makeEl, byId, funnelLog };
}

function makeHumanoidEntity(setupId = 0x02000001) {
  const mkPart = (z = 0) => ({
    position: new THREE.Vector3(0, 0, z),
    quaternion: new THREE.Quaternion(),
    rotation: new THREE.Euler(),
  });
  const parts = Array.from({ length: 34 }, (_, i) => mkPart(i === 10 || i === 13 ? 1.38 : 0.9));
  parts[10].position.set(-0.19, 0, 1.38);
  parts[11].position.set(-0.20, 0.05, 1.06);
  parts[12].position.set(-0.20, 0.12, 0.78);
  parts[13].position.set(+0.19, 0, 1.38);
  parts[14].position.set(+0.20, 0.05, 1.06);
  parts[15].position.set(+0.20, 0.12, 0.78);
  return {
    root: new THREE.Group(),
    setupId,
    parts,
    _filmHidden: false,
    _wireCellId: 0,
    _wireCellIdx: 0,
  };
}

function makeTestRig(opts = {}) {
  const { win, doc, canvas, makeEl, byId, funnelLog } = makeFakeWindowDocCanvas();
  const worldRoot = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 4000);
  const entityMap = new Map();
  const standInHiddenCalls = [];

  const localPlayerGuid = opts.localPlayerGuid ?? 0x50000001;
  win.getLocalPlayerGuid = () => localPlayerGuid;
  const localEntity = makeHumanoidEntity(opts.setupId ?? 0x02000001);
  entityMap.set(localPlayerGuid, localEntity);

  const inbox = [];
  const calls = {
    trailerActions: [],
    palletJackActions: [],
    containerActions: [],
    upserts: [],
    removals: [],
    inputs: [],
    seats: [],
    boards: [],
    motions: [],
    clearSeats: 0,
    chats: [],
  };

  let surfaceOracle = opts.surfaceOracle ?? (() => null);
  let pushoutOracle = opts.pushoutOracle ?? (() => null);
  let terrainOracle = opts.terrainOracle ?? (() => 0);
  let deathHeld = false;

  const sessionHandle = {
    vehicleCapabilities() {},
    drainVehicleMessages() {
      const out = JSON.stringify(inbox);
      inbox.length = 0;
      return out;
    },
    terrainHeightAt(x, y) { return terrainOracle(x, y); },
    probeContainerSurface(wx, wy, ceilZ) { return surfaceOracle(wx, wy, ceilZ); },
    resolveContainerPushout(wx, wy, wz, radius) { return pushoutOracle(wx, wy, wz, radius); },
    setVehicleSeat(guid, cell, x, y, z, heading) {
      calls.seats.push({ guid, cell, x, y, z, heading });
      return opts.seatReturn !== undefined ? opts.seatReturn : true;
    },
    clearVehicleSeat() { calls.clearSeats++; },
    vehicleBoard(guid, seat) { calls.boards.push({ guid, seat }); },
    vehicleExit() {},
    vehicleInput(guid, flat) { calls.inputs.push({ guid, flat: Array.from(flat) }); },
    vehicleTrailerAction(trailerGuid, vehicleGuid, containerGuid, action, slot, flags = 0) {
      calls.trailerActions.push({ trailerGuid, vehicleGuid, containerGuid, action, slot, flags });
    },
    vehicleContainerAction(containerGuid, action, slotIndex, subSlot, cargoWcid) {
      calls.containerActions.push({ containerGuid, action, slotIndex, subSlot, cargoWcid });
    },
    vehiclePalletJackAction(jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle) {
      calls.palletJackActions.push({
        jackGuid, action, slotIndex, subSlot, flags, targetGuid, cell, x, y, z, heading, tillerAngle,
      });
    },
    upsertContainerCollider(guid, cell, x, y, z, heading, kind, doorOpen) {
      calls.upserts.push({ guid, cell, x, y, z, heading, kind, doorOpen });
    },
    removeContainerCollider(guid) {
      calls.removals.push(guid);
      return true;
    },
    sendChat(msg) { calls.chats.push(msg); },
    jumpChargeAbort() { win.__jumpChargeActive = false; },
  };

  const csmState = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
  const live = {
    sessionHandle,
    renderer: { domElement: canvas },
    worldRoot,
    camera,
    localPlayerGuid,
    csmState,
    nullRender: false,
    entityManager: {
      entityMap,
      localPlayerGuid,
      isDeathHeld() { return deathHeld; },
      setMotion(guid, cmd, stance, speed) {
        calls.motions.push({ guid: guid >>> 0, cmd, stance, speed });
      },
      setFilmHidden(guid, hidden) {
        standInHiddenCalls.push({ guid: guid >>> 0, hidden: !!hidden });
        const ent = entityMap.get(guid >>> 0);
        if (!ent) return false;
        ent._filmHidden = !!hidden;
        return true;
      },
    },
  };

  const api = initVehicles(live, { window: win, document: doc, canvas, THREE });
  const push = (m) => { inbox.push(m); };
  const tick = (tMs = 16, dtMs = 16) => live.vehicles.afterTick(tMs, dtMs);

  return {
    win, doc, canvas, makeEl, byId, funnelLog, worldRoot, camera, entityMap, localEntity,
    standInHiddenCalls, localPlayerGuid, calls, live, api, push, tick,
    setSurfaceOracle(fn) { surfaceOracle = fn; },
    setPushoutOracle(fn) { pushoutOracle = fn; },
    setTerrainOracle(fn) { terrainOracle = fn; },
    setDeathHeld(v) { deathHeld = Boolean(v); },
  };
}

function makeSemiProfile(guid) {
  return {
    type: "profile",
    vehicle: guid,
    displayName: "Ironhorse 379",
    profileKey: "semi-379",
    vehicleClass: 3,
    liveryId: 0,
    locomotion: 2,
    vMax: 27.0,
    vMaxRoad: 27.0,
    wheelbase: 4.66,
    fifthWheelOffsetY: -2.01,
    fifthWheelOffsetZ: 0.96,
    seats: [
      { role: 0, motion: 0x41000013, offset: [-0.52, 0.28, 1.72] },
      { role: 1, motion: 0x41000013, offset: [0.52, 0.28, 1.72] },
    ],
  };
}

function makeSemiState(guid, x = 0, y = 0, z = 0, heading = 0, extra = {}) {
  return {
    type: "state",
    vehicle: guid,
    cell: 0,
    x,
    y,
    z,
    position: [x, y, z],
    heading,
    pitch: 0,
    bank: 0,
    speed: 0,
    mode: 0,
    groundFlags: 0,
    surfaceFamily: 0,
    steerAngle: 0,
    flags: 0x01,
    step: 1,
    ack: 0,
    ...extra,
  };
}

console.log("Running vehicle_pallet_jack_integration tests...");

await test("1. Sidelifter kind 15 / 4000032 resolution across trailer_models, trailer_kinematics, camera_rig, osd, and index.js", () => {
  for (const k of [15, 4000032, "sidelifter40", "Sidelifter40", "TrailerSidelifter40"]) {
    assert.equal(TM.resolveTrailerKind(k), "40ft", `trailer_models resolveTrailerKind(${k})`);
    assert.equal(TM.isSidelifterKind(k), true, `isSidelifterKind(${k})`);
    const spec = TK.resolveTrailerSpec(k);
    assert.equal(spec.kind, "40ft", `trailer_kinematics resolveTrailerSpec(${k})`);
    assert.equal(spec.wheelbase, 9.795);
    assert.equal(spec.kpY, 5.35);
  }

  const rig = CR.createPilotCameraRig({ locomotion: 2, profileKey: "semi-379", vehicleClass: 3 });
  const res15 = rig.step({
    pose: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0 },
    seat: { x: -0.52, y: 0.28, z: 1.72 },
    dt: 0.016,
    hitchedTrailerKind: 15,
    profileKey: "semi-379",
    vehicleClass: 3,
  });
  // 40ft trailer chase back is 22.5 m (versus 10.8 m bobtail)
  assert(Math.abs(res15.cam.pos[1]) > 18.0, `Sidelifter kind 15 pulls chase camera back > 18m (got ${res15.cam.pos[1]})`);

  const rigDoc = makeFakeWindowDocCanvas().doc;
  const osd = OSD.createVehicleOsd({ document: rigDoc });
  osd.update({
    locomotion: 2,
    vehicleClass: 3,
    profileKey: "semi-379",
    hitchedTrailerGuid: 900,
    trailerKind: 4000032,
    trailerFlags: 0x03,
    sideliftPhase: 5,
  });
  const osdText = rigDoc.getElementById(OSD.OSD_ID)?.textContent || "";
  assert(osdText.includes("COUPLED 40FT"), `OSD preserves COUPLED 40FT for kind 4000032: ${osdText}`);
  assert(osdText.includes("SIDELIFT ACTIVE"), `OSD shows sidelift active badge: ${osdText}`);
  const slBadge = rigDoc.getElementById("hb-trailer-sidelift");
  assert(slBadge && slBadge.style.display === "inline-block", "#hb-trailer-sidelift visible during active sidelift");
  osd.dispose();

  const env = makeTestRig();
  env.push({
    type: "trailer_state",
    trailerGuid: 0x800a0001,
    kind: 15,
    cell: 0,
    position: [10, 20, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    containerSlot: 0,
    trailerFlags: 0,
    ownerGuid: 0,
    sideliftPhase: 0,
    sideliftSide: 1,
    sideliftFlags: 0x09,
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0x800b0001,
    transferContainerGuid: 0,
  });
  env.tick(16, 16);
  const tr = env.api.trailers.get(0x800a0001);
  assert(tr && tr.isSidelifter === true, "entry.isSidelifter === true");
  assert.equal(tr.specKind, "40ft");
  assert.equal(tr.wcid, 4000032);
  assert.equal(tr.model.isSidelifter, true);
  assert.equal(tr.model.stowedPalletJackMesh.visible, true);
  env.api.dispose();
});

await test("2. Sidelifter animation, container BSP collider suppression (phases 3..9), re-upsert on touchdown, and tractor drive lock", () => {
  const env = makeTestRig();
  const semiGuid = 0x80010001;
  const trGuid = 0x800a0002;
  const cGuid = 0x80090002;

  env.push({ type: "ack", granted: 3 });
  env.push(makeSemiProfile(semiGuid));
  env.push(makeSemiState(semiGuid, 0, 0, 0, 0, { hitchedTrailerGuid: trGuid }));
  env.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: env.localPlayerGuid });
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, -7.36, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: semiGuid,
    mountedContainerGuid: cGuid,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 0,
    sideliftSide: 1,
    sideliftFlags: 0x01,
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: 0,
  });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 11,
    cell: 0,
    position: [0, -7.36, 1.32],
    heading: 0,
    doorProgress: 0,
    doorState: 0,
    slots: [],
  });
  env.tick(16, 16);

  // During idle coupled parked state, mounted container collider is active
  const upsertsBefore = env.calls.upserts.length;
  assert(upsertsBefore >= 1, "mounted parked container upserted collider");

  // Advance past boarding hop (0.5s) so tickPilot is actively driving
  const origNow = performance.now;
  let fakeNowMs = 1000;
  performance.now = () => fakeNowMs;
  try {
    for (let i = 0; i < 6; i++) {
      fakeNowMs += 100;
      env.tick(fakeNowMs, 100);
    }

    // Transition to Swinging (phase 6): collider must be removed and tractor throttle clamped!
    env.push({
      type: "trailer_state",
      trailerGuid: trGuid,
      kind: 15,
      cell: 0,
      position: [0, -7.36, 0],
      heading: 0,
      pitch: 0,
      bank: 0,
      coupledTractorGuid: semiGuid,
      mountedContainerGuid: cGuid,
      containerSlot: 0,
      trailerFlags: 0x05,
      ownerGuid: env.localPlayerGuid,
      sideliftPhase: 6,
      sideliftSide: 1,
      sideliftFlags: 0x07,
      sideliftProgress: 0.5,
      outriggerProgress: 1.0,
      craneSpanY: 5.9925,
      stowedPalletJackGuid: 0,
      transferContainerGuid: cGuid,
    });

    // Hold W (throttle) while seated in Semi during active sidelift
    env.api.setSticks({ throttle: 1.0 }, 500);
    const prevRemovals = env.calls.removals.length;
    const prevInputs = env.calls.inputs.length;

    fakeNowMs += 50;
    env.tick(fakeNowMs, 50);

    assert(env.calls.removals.length > prevRemovals && env.calls.removals.includes(cGuid), "collider removed during sidelift swing phase 6");
    const cEntry = env.api.containers.get(cGuid);
    assert(cEntry.model.root.position.x > 0.5, `lifted container moved laterally (+X) mid-swing: x=${cEntry.model.root.position.x}`);

    assert(env.calls.inputs.length > prevInputs, "tickPilot sent input frames");
    const lastFrame = env.calls.inputs[env.calls.inputs.length - 1].flat;
    // recentFrames(3) puts newest frame at index 0: [seq, throttle, pitch, roll, yaw, buttons]
    assert.equal(lastFrame[1], 0, "tractor throttle clamped to 0 while sidelift active");
    assert((lastFrame[5] & 0x20) !== 0, "handbrake bit (0x20) forced while sidelift active");
  } finally {
    performance.now = origNow;
  }

  // Complete offload: mountedContainerGuid=0, transferContainerGuid=0, phase=0, container_state at ground
  const upsertsMid = env.calls.upserts.length;
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, -7.36, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: semiGuid,
    mountedContainerGuid: 0,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 0,
    sideliftSide: 1,
    sideliftFlags: 0x01,
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: 0,
  });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 11,
    cell: 0,
    position: [3.85, -7.36, 0],
    heading: 0,
    doorProgress: 0,
    doorState: 0,
    slots: [],
  });
  env.tick(1100, 16);
  assert(env.calls.upserts.length > upsertsMid, "ground container collider re-upserted on touchdown");
  assert.equal(env.api.containers.get(cGuid).colliderActive, true);
  env.api.dispose();
});

await test("3. Deployable csmState propagation & runtime setStowed via deployable_state onlineFlags & 0x10", () => {
  const env = makeTestRig();
  const dGuid = 0x800c0001;
  env.push({
    type: "deployable_state",
    deployable: dGuid,
    kind: 6, // MissileTurret
    palletSize: 2,
    onlineFlags: 0x01, // active, not stowed
    ammo: 4,
    owner: env.localPlayerGuid,
    parentVehicle: 0,
    cell: 0,
    x: 5,
    y: 5,
    z: 0,
    heading: 0,
  });
  env.tick(16, 16);
  const dEntry = env.api.deployables.list().find((d) => d.guid === dGuid);
  assert(dEntry, "deployable spawned");

  // Stow via deployable_state onlineFlags & 0x10
  env.push({
    type: "deployable_state",
    deployable: dGuid,
    kind: 6,
    palletSize: 2,
    onlineFlags: 0x10,
    ammo: 4,
    owner: env.localPlayerGuid,
    parentVehicle: 0,
    cell: 0,
    x: 5,
    y: 5,
    z: 0,
    heading: 0,
  });
  env.tick(32, 16);
  const led = env.worldRoot.getObjectByName("sam-status-led");
  assert(led && led.material.color.getHex() === 0xffaa22, "deployable visual stowed amber LED set");

  // Unstow
  env.push({
    type: "deployable_state",
    deployable: dGuid,
    kind: 6,
    palletSize: 2,
    onlineFlags: 0x01,
    ammo: 4,
    owner: env.localPlayerGuid,
    parentVehicle: 0,
    cell: 0,
    x: 5,
    y: 5,
    z: 0,
    heading: 0,
  });
  env.tick(48, 16);
  assert(led.material.color.getHex() === 0x22ff66, "deployable visual unstowed green LED restored");
  env.api.dispose();
});

await test("4. Walk-behind pallet jack controller lifecycle: input isolation, tricycle kinematics, ramp speed, pushout, bay highlights (subSlot=null for full), arm IK, camera, clean exit", () => {
  let probeHit = null;
  let pushoutDelta = null;
  const env = makeTestRig({
    surfaceOracle: () => probeHit,
    pushoutOracle: () => pushoutDelta,
  });

  const cGuid = 0x80090010;
  const pjGuid = 0x800b0010;
  const dGuid = 0x800c0010;

  // Spawn an open grounded 20ft container with slot 9 occupied (full pallet) and a deployable nearby
  env.push({ type: "ack", granted: 3 });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 10,
    cell: 0,
    position: [0, 5, 0],
    heading: 0,
    doorProgress: 1.0,
    doorState: 2,
    slots: [{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }],
  });
  env.push({
    type: "deployable_state",
    deployable: dGuid,
    kind: 2, // FluxPod
    palletSize: 2,
    onlineFlags: 0x10,
    ammo: 0,
    owner: env.localPlayerGuid,
    parentVehicle: 0,
    cell: 0,
    x: 0.0,
    y: 0.225, // directly in front of pallet jack forks at (0,0)
    z: 0,
    heading: 0,
  });

  // Spy on container_models setHighlightedSlot calls
  env.tick(16, 16);
  const cEntry = env.api.containers.get(cGuid);
  const hlCalls = [];
  const origHl = cEntry.model.setHighlightedSlot;
  cEntry.model.setHighlightedSlot = (slotIdx, subSlot, state) => {
    hlCalls.push({ slotIdx, subSlot, state });
    return origHl(slotIdx, subSlot, state);
  };

  // Arm jump charge to verify lock() cancels it
  env.win.__jumpChargeActive = true;

  // Retail bubble listener to prove zero key leakage
  let leakedToRetail = 0;
  const retailBubble = () => { leakedToRetail++; };
  env.win.addEventListener("keydown", retailBubble, false);

  // Server grants walk-behind operator control
  env.push({
    type: "pallet_jack_state",
    palletJackGuid: pjGuid,
    operatorGuid: env.localPlayerGuid,
    stowedOnTrailerGuid: 0,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.085,
    forkState: 0,
    carriedPalletSize: 0,
    flags: 0,
    carriedWcid: 0,
    ownerGuid: env.localPlayerGuid,
  });

  const origNow = performance.now;
  let fakeNowMs = 1000;
  performance.now = () => fakeNowMs;
  try {
    env.tick(fakeNowMs, 16);
    assert.equal(env.api.palletJacks.active, pjGuid, "controller active on operatorGuid === localPlayerGuid");
    assert.equal(env.win.__inputFunnel._fault, "gate", "__inputFunnel poisoned with gate");
    assert(env.win.cancelJumpChargeCalls >= 1 && env.win.__jumpChargeActive === false, "jump charge cancelled");
    assert(env.calls.seats.some((s) => s.guid === pjGuid), "setVehicleSeat called with jackGuid");

    // Verify camera toggle V
    const vRes = env.win.dispatch("keydown", { code: "KeyV" });
    assert(vRes.defaultPrevented && vRes.immediateStopped, "KeyV captured");
    assert.equal(leakedToRetail, 0, "KeyV did not leak to retail");

    // Hold W + D for 0.5s -> moves forward, turns right (+heading), switches avatar to WALK, drives arm IK
    env.win.dispatch("keydown", { code: "KeyW" });
    env.win.dispatch("keydown", { code: "KeyD" });
    assert.equal(leakedToRetail, 0, "W/D did not leak to retail");

    for (let i = 0; i < 6; i++) {
      fakeNowMs += 80; // 80ms steps -> > 15 Hz UpdatePose threshold
      env.tick(fakeNowMs, 50);
    }

    const pjList = env.api.palletJacks.list();
    assert.equal(pjList.length, 1);
    assert(pjList[0].pos[1] > 0.2, `jack moved forward (+Y): y=${pjList[0].pos[1]}`);
    assert(pjList[0].heading > 0.05 && pjList[0].heading < Math.PI, `D key turned right (+heading): h=${pjList[0].heading}`);
    assert(pjList[0].tillerAngle < 0, `tillerAngle negative on right turn: ${pjList[0].tillerAngle}`);
    assert(env.calls.motions.some((m) => m.cmd === PJ.PALLET_JACK_MOTION.WALK), "avatar transitioned to WALK");

    // Verify 15 Hz UpdatePose throttle (action=3)
    const poseUpdates = env.calls.palletJackActions.filter((a) => a.action === PALLET_JACK_ACTION.UpdatePose);
    assert(poseUpdates.length >= 4 && poseUpdates.length <= 8, `15 Hz UpdatePose count in 480ms = ${poseUpdates.length}`);

    // Test ramp speed limit via probeContainerSurface
    probeHit = { z: 0.10, normalX: 0, normalY: -Math.sin(0.19), normalZ: Math.cos(0.19) };
    const rampKin = PJ.stepPalletJackKinematics(
      { x: 0, y: 0, heading: 0, speed: 2.2, tillerAngle: 0, surface: "ramp" },
      { throttle: 1, steer: 0 },
      0.1
    );
    assert(rampKin.maxSpeed === 1.1 && Math.abs(rampKin.speed) <= 1.6, "ramp speed capped at 1.1 m/s");

    // Test wall pushout via resolveContainerPushout
    const beforeX = pjList[0].pos[0];
    pushoutDelta = { x: -0.25, y: 0, z: 0 };
    fakeNowMs += 50;
    env.tick(fakeNowMs, 50);
    assert(env.api.palletJacks.list()[0].pos[0] < beforeX - 0.1, "resolveContainerPushout applied to jack");
    pushoutDelta = null;

    // Test Space raises forks / engages nearby target
    env.win.dispatch("keydown", { code: "Space", key: " " });
    assert.equal(leakedToRetail, 0, "Space did not leak to retail");
    assert(
      env.calls.palletJackActions.some((a) => a.action === PALLET_JACK_ACTION.RaiseForks || a.action === PALLET_JACK_ACTION.PickGroundDeployable || a.action === PALLET_JACK_ACTION.PickContainerSlot),
      "Space triggered fork raise or pick"
    );

    // Verify carrying full pallet highlights container slot with subSlot === null (NEVER 0!)
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 3.0, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.200,
      forkState: 2,
      carriedPalletSize: 2, // Full!
      flags: 0x03,
      carriedWcid: 4000010,
      ownerGuid: env.localPlayerGuid,
    });
    hlCalls.length = 0;
    fakeNowMs += 50;
    env.tick(fakeNowMs, 50);
    const loadHl = hlCalls.find((c) => c.slotIdx !== null && c.state !== null);
    assert(loadHl, "container slot highlighted while carrying cargo near open container");
    assert.equal(loadHl.subSlot, null, "CRITICAL: subSlot MUST be null for full pallets (never 0)");

    // Pressing Escape when NO modal is open releases pallet jack and consumes Escape
    const escRes = env.win.dispatch("keydown", { code: "Escape", key: "Escape" });
    assert(escRes.defaultPrevented && escRes.immediateStopped, "Escape consumed on walk-behind exit");
    assert.equal(env.api.palletJacks.active, null, "Escape exited walk-behind mode");
    assert.equal(env.win.__inputFunnel._fault, null, "__inputFunnel unpoisoned after exit");
    assert(env.calls.clearSeats >= 1, "clearVehicleSeat called on exit");
    assert(env.calls.motions.some((m) => m.cmd === PJ.PALLET_JACK_MOTION.READY), "avatar restored to READY");
    assert(env.calls.palletJackActions.some((a) => a.action === PALLET_JACK_ACTION.Release), "Release action sent on Escape");
    assert(hlCalls[hlCalls.length - 1].slotIdx === null, "slot highlight cleared on exit");

    // Re-enter and verify modal Escape pass-through + onTeleport + death release
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    fakeNowMs += 50;
    env.tick(fakeNowMs, 16);
    assert.equal(env.api.palletJacks.active, pjGuid);

    const modalInput = env.makeEl("button");
    modalInput._modal = true;
    const modalEsc = env.win.dispatch("keydown", { code: "Escape", key: "Escape", target: modalInput });
    assert.equal(modalEsc.defaultPrevented, false, "Escape inside open [aria-modal='true'] passed through");
    assert.equal(env.api.palletJacks.active, pjGuid, "jack still active when modal consumed Escape");

    env.live.vehicles.onTeleport();
    assert.equal(env.api.palletJacks.active, null, "onTeleport cleanly stops pallet jack controller");
  } finally {
    performance.now = origNow;
    env.win.removeEventListener("keydown", retailBubble, false);
  }
  env.api.dispose();
});

await test("5. Pure 2D Bay OBB pushout & Olthoi no-hands arm IK safety", () => {
  // Verify pure 2D pinwheel bay OBB pushout pushes jack hull outside occupied slot 9
  const spec20 = CL.resolveContainerLogisticsSpec(10);
  const box9 = CL.getSlotSubBox(spec20.slots[9], "full", 0);
  const pushed = PJ.resolveBayObbPushout(box9.x, box9.y, 0.3425, [box9]);
  assert.equal(pushed.hit, true, "occupied bay OBB detected overlap");
  assert(
    pushed.x <= box9.x0 - 0.34 + 1e-6 || pushed.x >= box9.x1 + 0.34 - 1e-6 ||
    pushed.y <= box9.y0 - 0.34 + 1e-6 || pushed.y >= box9.y1 + 0.34 - 1e-6,
    "jack pushed clear of occupied bay box"
  );

  // Olthoi setupId 0x02001A21 skips humanoid arm IK without throwing
  const env = makeTestRig({ setupId: 0x02001A21 });
  const pjGuid = 0x800b0099;
  env.push({
    type: "pallet_jack_state",
    palletJackGuid: pjGuid,
    operatorGuid: env.localPlayerGuid,
    stowedOnTrailerGuid: 0,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.085,
    forkState: 0,
    carriedPalletSize: 0,
    flags: 0,
    carriedWcid: 0,
    ownerGuid: env.localPlayerGuid,
  });
  env.tick(16, 16);
  assert.equal(env.api.palletJacks.active, pjGuid);
  env.api.dispose();
});

await test("6. Window-capture proximity keybindings (J/K/L/Shift+L/U/E/R/B) & disambiguation + typing guard", () => {
  const env = makeTestRig();
  env.push({ type: "ack", granted: 3 });

  let retailBubbleCount = 0;
  const bubbleFn = () => { retailBubbleCount++; };
  env.win.addEventListener("keydown", bubbleFn, false);

  const trGuid = 0x800a0020;
  const cMountedGuid = 0x8009001f;
  const cGuid = 0x80090020;
  const dGuid = 0x800c0020;
  const pjGuid = 0x800b0020;
  const semiGuid = 0x80010020;

  env.push(makeSemiProfile(semiGuid));
  env.push(makeSemiState(semiGuid, 4.0, 0, 0, 0));
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [5.0, 0, 0], // within 12m
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: cMountedGuid,
    containerSlot: 0,
    trailerFlags: 0,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 0,
    sideliftSide: 1,
    sideliftFlags: 0x09, // isSidelifter + hasStowedPalletJack
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: pjGuid,
    transferContainerGuid: 0,
  });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 10,
    cell: 0,
    position: [0, 2.0, 0], // grounded within 4m
    heading: 0,
    doorProgress: 0,
    doorState: 0,
    slots: [],
  });
  env.push({
    type: "deployable_state",
    deployable: dGuid,
    kind: 6,
    palletSize: 2,
    onlineFlags: 0x01,
    ammo: 4,
    owner: env.localPlayerGuid,
    parentVehicle: 0,
    cell: 0,
    x: 1.5,
    y: 0,
    z: 0, // within 3.5m
    heading: 0,
  });
  env.push({
    type: "pallet_jack_state",
    palletJackGuid: pjGuid,
    operatorGuid: 0,
    stowedOnTrailerGuid: 0,
    cell: 0,
    position: [1.0, 0, 0], // within 3.0m
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.085,
    forkState: 0,
    carriedPalletSize: 0,
    flags: 0,
    carriedWcid: 0,
    ownerGuid: env.localPlayerGuid,
  });
  env.tick(16, 16);

  // Combined prompt must expose Sidelifter J/K/L/U AND Jack B
  const promptEl = env.doc.getElementById(OSD.PROMPT_ID);
  assert(promptEl && /\[J\]/.test(promptEl.textContent) && /\[B\]/.test(promptEl.textContent), `combined prompt: ${promptEl?.textContent}`);

  // Typing in INPUT must NOT intercept any logistics keys
  const inputEl = env.makeEl("input");
  const typedJ = env.win.dispatch("keydown", { code: "KeyJ", target: inputEl });
  assert.equal(typedJ.defaultPrevented, false, "typing in INPUT does not intercept KeyJ");
  assert.equal(retailBubbleCount, 1);
  retailBubbleCount = 0;

  // Trigger J, K, L, Shift+L, U, E, R, B
  for (const ev of [
    { code: "KeyJ" },
    { code: "KeyK" },
    { code: "KeyL" },
    { code: "KeyL", shiftKey: true },
    { code: "KeyU" },
    { code: "KeyE" },
    { code: "KeyR" },
    { code: "KeyB" },
  ]) {
    const r = env.win.dispatch("keydown", ev);
    assert(r.defaultPrevented && r.immediateStopped, `${ev.code} prevented & stopped`);
  }
  assert.equal(retailBubbleCount, 0, "no downstream TurnRight/Autorun/Emote listener fired when in range");
  assert.deepEqual(
    env.calls.trailerActions.map((a) => a.action),
    [
      TRAILER_ACTION.DeployOutriggers,
      TRAILER_ACTION.ToggleTwistlock,
      TRAILER_ACTION.SideliftOffload,
      TRAILER_ACTION.AutoOffload,
      TRAILER_ACTION.DeployPalletJack,
    ]
  );
  assert.equal(env.calls.containerActions.length, 1);
  assert.equal(env.calls.containerActions[0].action, 1); // OpenDoors
  assert.equal(env.calls.palletJackActions.filter((a) => a.action === PALLET_JACK_ACTION.ToggleDeployableStow).length, 1);
  // KeyB prioritized Pallet Jack (<= 3m) over Semi boarding (<= 8m)
  assert.equal(env.calls.palletJackActions.filter((a) => a.action === PALLET_JACK_ACTION.Grab).length, 1);
  assert.equal(env.calls.boards.length, 0);

  // Move player 20m away (out of range) -> E/R/J/B pass through cleanly!
  env.localEntity.root.position.set(50, 50, 0);
  env.tick(32, 16);
  const outE = env.win.dispatch("keydown", { code: "KeyE" });
  const outR = env.win.dispatch("keydown", { code: "KeyR" });
  assert.equal(outE.defaultPrevented, false, "out-of-range KeyE passes through");
  assert.equal(outR.defaultPrevented, false, "out-of-range KeyR passes through");
  assert.equal(retailBubbleCount, 2);

  // Move player 5m from semi (4m -> <=8m) and >3m from jack -> KeyB boards Semi!
  env.localEntity.root.position.set(7.5, 0, 0); // dist to semi(4,0)=3.5m, dist to pj(1,0)=6.5m > 3m
  env.tick(48, 16);
  const bSemi = env.win.dispatch("keydown", { code: "KeyB" });
  assert(bSemi.defaultPrevented && bSemi.immediateStopped, "KeyB captured for semi boarding when jack > 3m");
  assert.equal(env.calls.boards.length, 1);
  assert.equal(env.calls.boards[0].guid, semiGuid);

  env.win.removeEventListener("keydown", bubbleFn, false);
  env.api.dispose();
});

await test("7. Events 22..25 OSD prompts, window.__vehicles API surface/null-safety, hb- DOM IDs, lintSource & dispose", () => {
  const env = makeTestRig();
  const trGuid = 0x800a0030;
  const pjGuid = 0x800b0030;
  const cGuid = 0x80090030;
  const dGuid = 0x800c0030;

  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    containerSlot: 0,
    trailerFlags: 0,
    ownerGuid: 0,
    sideliftPhase: 0,
    sideliftSide: 1,
    sideliftFlags: 0x01,
  });
  env.push({
    type: "pallet_jack_state",
    palletJackGuid: pjGuid,
    operatorGuid: 0,
    stowedOnTrailerGuid: 0,
    cell: 0,
    position: [1, 1, 0],
    heading: 0,
    tillerAngle: 0,
    forkHeightM: 0.085,
    forkState: 0,
    carriedPalletSize: 0,
    flags: 0,
    carriedWcid: 0,
    ownerGuid: 0,
  });
  env.tick(16, 16);

  // Events 22..25
  env.push({ type: "event", kind: 22, vehicle: trGuid, subject: 0, aux: 0 });
  env.tick(32, 16);
  const promptEl = env.doc.getElementById(OSD.PROMPT_ID);
  assert(promptEl && /ISO 3874/i.test(promptEl.textContent), "event 22 displays SideliftStarted prompt");

  env.push({ type: "event", kind: 24, vehicle: trGuid, subject: 0, aux: 2 });
  env.tick(48, 16);
  assert(/twistlock/i.test(promptEl.textContent), `event 24 displays twistlock refusal: ${promptEl.textContent}`);

  env.push({ type: "event", kind: 25, vehicle: pjGuid, subject: 0, aux: 4 });
  env.tick(64, 16);
  assert(/LIFO|blocked/i.test(promptEl.textContent), `event 25 displays LIFO message: ${promptEl.textContent}`);

  // Null-safety & API surface + top-level camelCase fields on get() and list()
  assert.equal(env.api.palletJacks.get(0xdeadbeef), null, "palletJacks.get(invalid) === null");
  assert.equal(env.api.palletJacks.grab(0xdeadbeef), false, "palletJacks.grab(invalid) === false");
  const pjGot = env.api.palletJacks.get(pjGuid);
  const pjListed = env.api.palletJacks.list()[0];
  for (const field of [
    "palletJackGuid", "operatorGuid", "stowedOnTrailerGuid", "forkHeightM", "carriedWcid",
    "flags", "forkState", "carriedPalletSize", "cell", "pos", "rawPos", "heading",
    "tillerAngle", "ownerGuid", "last",
  ]) {
    assert(field in pjGot, `palletJacks.get() missing ${field}`);
    assert(field in pjListed, `palletJacks.list()[0] missing ${field}`);
  }
  assert.equal(pjGot.palletJackGuid, pjGuid);
  assert.equal(pjGot.operatorGuid, 0);
  assert.equal(env.api.trailers.sidelift(trGuid, "offload", "left"), true);
  assert.equal(env.api.trailers.deployOutriggers(trGuid, "right"), true);
  assert.equal(env.api.trailers.retractOutriggers(trGuid), true);
  assert.equal(env.api.trailers.deployPalletJack(trGuid), true);
  assert.equal(env.api.trailers.stowPalletJack(trGuid, pjGuid), true);

  assert.equal(env.api.palletJacks.grab(pjGuid), true);
  assert.equal(env.api.palletJacks.raise(pjGuid), true);
  assert.equal(env.api.palletJacks.lower(pjGuid), true);
  assert.equal(env.api.palletJacks.pickGround(dGuid, pjGuid), true);
  assert.equal(env.api.palletJacks.dropGround(pjGuid), true);
  assert.equal(env.api.palletJacks.pickContainer(cGuid, 9, 0, pjGuid), true);
  assert.equal(env.api.palletJacks.loadContainer(cGuid, 9, 0, pjGuid), true);
  assert.equal(env.api.palletJacks.toggleDeployableStow(dGuid), true);

  // Verify every created DOM node under doc.body uses id="hb-..."
  for (const child of env.doc.body.children) {
    assert(child.id && child.id.startsWith("hb-"), `HUD node must use id="hb-...", got "${child.id}"`);
  }

  // Verify lintSource() cleanliness on new pallet_jack_controller.js
  const pjcPath = path.resolve(import.meta.dirname, "../scene3d/vehicle/pallet_jack_controller.js");
  const pjcSrc = readFileSync(pjcPath, "utf8");
  const lintErrs = lintSource(pjcSrc);
  assert.deepEqual(lintErrs, [], `lintSource(pallet_jack_controller.js) clean: ${lintErrs.join("; ")}`);

  env.api.dispose();
  assert.equal(env.worldRoot.children.length, 0, "worldRoot emptied on dispose");
  assert.equal(env.doc.body.children.length, 0, "HUD DOM nodes removed on dispose");
  assert.equal(env.win.listenerCount("keydown"), 0, "window keydown listeners removed on dispose");
});

await test("8. Regression: Left-side (sideliftSide = -1) crane spreader x < 0 & post-phase-9 collider re-upsert without trailing container_state", () => {
  const env = makeTestRig();
  const trGuid = 0x800a0040;
  const cGuid = 0x80090040;

  env.push({ type: "ack", granted: 3 });
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: cGuid,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 0,
    sideliftSide: -1,
    sideliftFlags: 0x01,
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: 0,
  });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 11,
    cell: 0,
    position: [0, 0, 1.32],
    heading: 0,
    doorProgress: 0,
    doorState: 0,
    slots: [],
  });
  env.tick(16, 16);

  // Advance to Lowering (phase 7, progress 1.0) on left side (-1):
  // Outriggers, container, AND crane spreaders must ALL be on the -X (left) side!
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: cGuid,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 7,
    sideliftSide: -1,
    sideliftFlags: 0x07,
    sideliftProgress: 1.0,
    outriggerProgress: 1.0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: cGuid,
  });
  env.tick(32, 16);

  const tr = env.api.trailers.get(trGuid);
  const cEntry = env.api.containers.get(cGuid);
  assert(tr.model.frontOutriggerGroup.position.x < -3.0, `left outrigger x < -3.0 (got ${tr.model.frontOutriggerGroup.position.x})`);
  assert(cEntry.model.root.position.x < -3.0, `left container x < -3.0 (got ${cEntry.model.root.position.x})`);

  const spreaders = tr.model.root.getObjectByName("sidelifter-crane-spreaders-instanced");
  const mSpreader = new THREE.Matrix4();
  spreaders.getMatrixAt(0, mSpreader);
  const spreaderPos = new THREE.Vector3().setFromMatrixPosition(mSpreader);
  assert(spreaderPos.x < -3.0, `CRITICAL: left-side crane spreader x < -3.0 (got ${spreaderPos.x})`);

  // Also test phase 8/9 touchdown container_state followed by 9 -> 0 transition WITHOUT a trailing container_state
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 9,
    sideliftSide: -1,
    sideliftFlags: 0x07,
    sideliftProgress: 0.5,
    outriggerProgress: 1.0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: cGuid,
  });
  env.push({
    type: "container_state",
    containerGuid: cGuid,
    containerKind: 11,
    cell: 0,
    position: [-3.85, 0, 0],
    heading: 0,
    doorProgress: 0,
    doorState: 0,
    slots: [],
  });
  env.tick(48, 16);
  assert.equal(cEntry.colliderActive, false, "collider still suppressed during phase 9 CranesStowing");

  const upsertsBeforePhase0 = env.calls.upserts.length;
  env.push({
    type: "trailer_state",
    trailerGuid: trGuid,
    kind: 15,
    cell: 0,
    position: [0, 0, 0],
    heading: 0,
    pitch: 0,
    bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    containerSlot: 0,
    trailerFlags: 0x05,
    ownerGuid: env.localPlayerGuid,
    sideliftPhase: 0,
    sideliftSide: -1,
    sideliftFlags: 0x01,
    sideliftProgress: 0,
    outriggerProgress: 0,
    craneSpanY: 5.9925,
    stowedPalletJackGuid: 0,
    transferContainerGuid: 0,
  });
  env.tick(64, 16);
  assert(env.calls.upserts.length > upsertsBeforePhase0, "grounded container collider re-upserted after phase 9 -> 0 without trailing container_state");
  assert.equal(cEntry.colliderActive, true, "colliderActive restored to true after phase 9 -> 0");
  env.api.dispose();
});

await test("9. Regression: Driving pallet jack into open container picks full Y-oriented (slot 9), full X-oriented (slot 6), and half-pallet (slot 9:0) via F/Space", () => {
  const runDriveAndPick = (slots, startX, startY, keyCode, expectedSlot, expectedSub = 0) => {
    const env = makeTestRig({
      surfaceOracle: (_wx, wy) => (wy >= -3.8 ? { z: 0.162, normalX: 0, normalY: 0, normalZ: 1 } : null),
    });
    const cGuid = 0x80090050;
    const pjGuid = 0x800b0050;
    env.push({ type: "ack", granted: 3 });
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10, // 20ft container centered at (0, 0, 0)
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots,
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [startX, startY, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });

    const origNow = performance.now;
    let fakeNowMs = 1000;
    performance.now = () => fakeNowMs;
    try {
      env.tick(fakeNowMs, 16);
      env.win.dispatch("keydown", { code: "KeyW" });
      for (let i = 0; i < 30; i++) {
        fakeNowMs += 50;
        env.tick(fakeNowMs, 50);
      }
      env.win.dispatch("keyup", { code: "KeyW" });
      env.win.dispatch("keydown", { code: keyCode, key: keyCode === "Space" ? " " : "f" });

      const picks = env.calls.palletJackActions.filter((a) => a.action === PALLET_JACK_ACTION.PickContainerSlot);
      assert(picks.length >= 1, `Expected PickContainerSlot for slot ${expectedSlot}:${expectedSub} using ${keyCode}, got ${JSON.stringify(env.calls.palletJackActions.map((a) => a.action))}`);
      assert.equal(picks[0].slotIndex, expectedSlot);
      assert.equal(picks[0].subSlot, expectedSub);
    } finally {
      performance.now = origNow;
      env.api.dispose();
    }
  };

  // Full pallet Y-oriented slot 9 (x=+0.5080, y=-2.2873) via KeyF and Space
  runDriveAndPick([{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }], 0.5080, -3.5, "KeyF", 9, 0);
  runDriveAndPick([{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }], 0.5080, -3.5, "Space", 9, 0);
  // Full pallet X-oriented slot 6 (x=+0.5080, y=-1.1176) via KeyF
  runDriveAndPick([{ slotIndex: 6, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }], 0.5080, -2.5, "KeyF", 6, 0);
  // Half pallet slot 9:0 (4000013) via KeyF
  runDriveAndPick([{ slotIndex: 9, subSlot: 0, palletSize: 1, cargoWcid: 4000013 }], 0.5080, -3.5, "KeyF", 9, 0);
});

await test("10. Regression: Death guard (CQ-06), container wall clamp + Z-proximity guard, steep >12 deg resistance, keyup in input, KeyX drain, aria-modal Escape on body", () => {
  // 10a. CQ-06: isDeathHeld -> stop("death") does NOT emit setMotion(..., READY, ...)
  {
    const env = makeTestRig();
    const pjGuid = 0x800b0060;
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    env.calls.motions.length = 0;
    env.setDeathHeld(true);
    env.tick(32, 16);
    assert.equal(env.api.palletJacks.active, null, "jack deactivated on death");
    assert.equal(
      env.calls.motions.some((m) => m.cmd === PJ.PALLET_JACK_MOTION.READY),
      false,
      "CQ-06: stop('death') MUST NOT call setMotion(..., READY)"
    );
    env.api.dispose();
  }

  // 10b. Squeezed between occupied slot 9 and right wall -> loc.x + JACK_HULL_RADIUS_M <= halfW
  {
    const pushoutCalls = [];
    const env = makeTestRig({
      surfaceOracle: () => ({ z: 0.162, normalX: 0, normalY: 0, normalZ: 1 }),
      pushoutOracle: (wx, wy, wz, r) => {
        pushoutCalls.push({ wx, wy, wz, r });
        return null;
      },
    });
    const cGuid = 0x80090061;
    const pjGuid = 0x800b0061;
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10, // halfW = 1.176
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0.83, -2.0, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    const pos = env.api.palletJacks.list()[0].pos;
    const spec20 = CL.resolveContainerLogisticsSpec(10);
    assert(
      Math.abs(pos[0]) + PJ.JACK_HULL_RADIUS_M <= spec20.interior.halfW + 1e-6,
      `jack must stay inside container wall: |${pos[0]}| + ${PJ.JACK_HULL_RADIUS_M} <= ${spec20.interior.halfW}`
    );
    assert(pushoutCalls.length >= 1 && Math.abs(pushoutCalls[0].wx) <= spec20.interior.halfW - PJ.JACK_HULL_RADIUS_M + 1e-6, "resolveContainerPushout runs AFTER clamped bay OBB pushout");
    env.api.dispose();
  }

  // 10c. Overhead container (z = +2.0m) does NOT trigger bay OBB or containerBaseZ + 0.20 pushout
  {
    const pushoutCalls = [];
    const env = makeTestRig({
      pushoutOracle: (wx, wy, wz, r) => {
        pushoutCalls.push({ wx, wy, wz, r });
        return null;
      },
    });
    const cGuid = 0x80090062;
    const pjGuid = 0x800b0062;
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 2.0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0.508, -2.2873, 0.0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    assert(pushoutCalls.length >= 1);
    assert(pushoutCalls[0].wz < 0.5, `overhead container must not raise pushout wz (got ${pushoutCalls[0].wz})`);
    const pos = env.api.palletJacks.list()[0].pos;
    assert(Math.abs(pos[0] - 0.508) < 1e-4 && Math.abs(pos[1] - -2.2873) < 1e-4, "overhead container did not push jack in XY");
    env.api.dispose();
  }

  // 10d. Steep >12 deg surface blocks XY motion, zeroes speed, and reports surface === "terrain"
  {
    let steep = false;
    const env = makeTestRig({
      surfaceOracle: () => (steep ? { z: 0.15, normalX: 0, normalY: -Math.sin((15 * Math.PI) / 180), normalZ: Math.cos((15 * Math.PI) / 180) } : null),
    });
    const pjGuid = 0x800b0063;
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    steep = true;
    env.win.dispatch("keydown", { code: "KeyW" });
    env.tick(66, 50);
    env.tick(116, 50);
    const pos = env.api.palletJacks.list()[0].pos;
    assert.equal(pos[0], 0, "steep >12 deg surface prevented X advance");
    assert.equal(pos[1], 0, "steep >12 deg surface prevented Y advance");
    assert.equal(pos[2], 0, "steep >12 deg surface kept ground Z");
    const pjHud = env.doc.getElementById(OSD.PALLETJACK_HUD_ID)?.textContent || "";
    assert(!/RAMP/i.test(pjHud), `steep rejected surface must not report RAMP: ${pjHud}`);
    env.api.dispose();
  }

  // 10e. keyup while focused in INPUT clears held WASD; KeyX drain swallows orphan keyup; aria-modal with focus on body passes Escape
  {
    const env = makeTestRig();
    const pjGuid = 0x800b0064;
    let retailKeyups = [];
    const onRetailKeyup = (ev) => { retailKeyups.push(ev.code); };
    env.win.addEventListener("keyup", onRetailKeyup, false);

    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);

    // Focus INPUT while KeyW is held, then release KeyW -> jack must stop moving!
    env.win.dispatch("keydown", { code: "KeyW" });
    env.tick(66, 50);
    const yBeforeRelease = env.api.palletJacks.list()[0].pos[1];
    assert(yBeforeRelease > 0);
    const inputEl = env.makeEl("input");
    const upInInput = env.win.dispatch("keyup", { code: "KeyW", target: inputEl });
    assert.equal(upInInput.defaultPrevented, false, "keyup in INPUT passes through without preventDefault");
    for (let i = 0; i < 10; i++) env.tick(100 + i * 50, 50);
    const yAfterDecel = env.api.palletJacks.list()[0].pos[1];
    env.tick(700, 50);
    const ySettled = env.api.palletJacks.list()[0].pos[1];
    assert(Math.abs(ySettled - yAfterDecel) < 1e-6, `KeyW released while typing stopped jack (delta=${ySettled - yAfterDecel})`);

    // Open [aria-modal="true"] attached to doc.body with ev.target === doc.body -> Escape passes through
    const modal = env.makeEl("div");
    modal.setAttribute("aria-modal", "true");
    env.doc.body.appendChild(modal);
    const bodyEsc = env.win.dispatch("keydown", { code: "Escape", key: "Escape", target: env.doc.body });
    assert.equal(bodyEsc.defaultPrevented, false, "Escape with open [aria-modal='true'] and target=body passes through");
    assert.equal(env.api.palletJacks.active, pjGuid, "jack remains active when modal open");
    modal.remove();

    // Release via KeyX -> matching KeyX keyup MUST be drained and NOT leak to retail!
    retailKeyups = [];
    env.win.dispatch("keydown", { code: "KeyX" });
    assert.equal(env.api.palletJacks.active, null, "KeyX released pallet jack");
    const xUp = env.win.dispatch("keyup", { code: "KeyX" });
    assert(xUp.defaultPrevented && xUp.immediateStopped, "KeyX keyup swallowed by drain");
    assert.deepEqual(retailKeyups, [], "zero orphan KeyX keyup leaked to retail");

    env.win.removeEventListener("keyup", onRetailKeyup, false);
    env.api.dispose();
  }
});

// 11. Steep-ramp rejection while already on a valid ramp preserves ramp Z/surface,
//     and 3-pass wall-clamp recovery clears multi-box corner overlap without wall ejection.
tests.push(async () => {
  // 11a. Steep >12 deg boundary hit while already on valid ramp preserves ramp Z and surface
  {
    const validRamp = { z: 0.12, normalX: 0, normalY: -Math.sin((8 * Math.PI) / 180), normalZ: Math.cos((8 * Math.PI) / 180) };
    const steepWall = { z: 0.25, normalX: 0, normalY: -Math.sin((20 * Math.PI) / 180), normalZ: Math.cos((20 * Math.PI) / 180) };
    const env = makeTestRig({
      surfaceOracle: (_wx, wy) => (wy > 0.08 ? steepWall : validRamp),
    });
    const pjGuid = 0x800b0071;
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0.04, 0.12],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    assert.equal(env.api.palletJacks.list()[0].pos[2], 0.12, "jack starts on valid ramp at z=0.12");

    // Drive forward onto the steep >12 deg step -> XY rejected, Z remains 0.12 (never drops to ground 0)
    env.win.dispatch("keydown", { code: "KeyW" });
    env.tick(66, 50);
    const pos = env.api.palletJacks.list()[0].pos;
    assert(Math.abs(pos[2] - 0.12) < 1e-6, `ramp Z must stay 0.12 on steep rejection (got ${pos[2]})`);
    const pjHud = env.doc.getElementById(OSD.PALLETJACK_HUD_ID)?.textContent || "";
    assert(/RAMP/i.test(pjHud), `jack still on ramp must keep RAMP surface in HUD: ${pjHud}`);
    env.api.dispose();
  }

  // 11b. Multi-box wall-clamp recovery inside 20ft container stays within interior walls and outside all slot boxes
  {
    const env = makeTestRig();
    const cGuid = 0x800c0072;
    const pjGuid = 0x800b0072;
    // Populate rear-corner slots 6, 7, 9 inside a 20ft container
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [
        { slotIndex: 6, subSlot: 0, palletSize: 2, cargoWcid: 4000010 },
        { slotIndex: 7, subSlot: 0, palletSize: 2, cargoWcid: 4000011 },
        { slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000012 },
      ],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [-0.95, -2.6, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    env.win.dispatch("keydown", { code: "KeyW" });
    env.win.dispatch("keydown", { code: "KeyD" });
    for (let i = 0; i < 6; i++) env.tick(66 + i * 50, 50);
    const pos = env.api.palletJacks.list()[0].pos;
    assert(Math.abs(pos[0]) <= 1.176 - 0.3425 + 1e-3, `jack stayed inside container X walls (x=${pos[0]})`);
    assert(pos[1] <= 2.949 - 0.3425 + 1e-3, `jack stayed inside container +Y wall (y=${pos[1]})`);
    env.api.dispose();
  }
});

// 12. Tier-5 Adversarial Regression Suite (T5_01..T5_07)
await test("12. Tier-5 Adversarial Regression Suite (T5_01..T5_07)", async () => {
  // T5_01: Multi-slot wall-clamp recovery at (0.90, -1.65) with Slots 6, 7, 9 occupied
  //        AND (1.18, -2.30) near right wall with resolveContainerPushout mock
  {
    const env = makeTestRig({
      pushoutOracle: (wx, _wy, _wz, r) => (wx > 1.176 ? { x: (1.219 + r) - wx, y: 0 } : null),
    });
    const cGuid = 0x800c0501;
    const pjGuid = 0x800b0501;
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [
        { slotIndex: 6, subSlot: 0, palletSize: 2, cargoWcid: 4000010 },
        { slotIndex: 7, subSlot: 0, palletSize: 2, cargoWcid: 4000011 },
        { slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000012 },
      ],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0.90, -1.65, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    env.tick(32, 16);
    const posA = env.api.palletJacks.list()[0].pos;
    const maxInsideX = 1.176 - 0.3425;
    assert(Math.abs(posA[0]) <= maxInsideX + 1e-4, `T5_01a stayed inside X wall (x=${posA[0]})`);
    for (const slotIdx of [6, 7, 9]) {
      const box = CL.getSlotSubBox(CL.PINWHEEL_SLOTS_20[slotIdx], "full", 0);
      const cx = Math.max(box.x0, Math.min(posA[0], box.x1));
      const cy = Math.max(box.y0, Math.min(posA[1], box.y1));
      const d = Math.hypot(posA[0] - cx, posA[1] - cy);
      assert(d >= 0.3425 - 1e-3, `T5_01a zero overlap with slot ${slotIdx} (dist=${d})`);
    }
    env.api.dispose();
  }
  {
    const env = makeTestRig({
      pushoutOracle: (wx, _wy, _wz, r) => (wx > 1.176 ? { x: (1.219 + r) - wx, y: 0 } : null),
    });
    const cGuid = 0x800c0502;
    const pjGuid = 0x800b0502;
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [{ slotIndex: 9, subSlot: 0, palletSize: 2, cargoWcid: 4000012 }],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [1.18, -2.30, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    env.tick(32, 16);
    const posB = env.api.palletJacks.list()[0].pos;
    assert(Math.abs(posB[0]) <= 1.176 - 0.3425 + 1e-4, `T5_01b stayed inside X wall (x=${posB[0]})`);
    const box9 = CL.getSlotSubBox(CL.PINWHEEL_SLOTS_20[9], "full", 0);
    const cx = Math.max(box9.x0, Math.min(posB[0], box9.x1));
    const cy = Math.max(box9.y0, Math.min(posB[1], box9.y1));
    assert(Math.hypot(posB[0] - cx, posB[1] - cy) >= 0.3425 - 1e-3, "T5_01b zero overlap with slot 9");
    env.api.dispose();
  }

  // T5_02: Adjacent 40ft Container A + 20ft Container B -> jack inside Container A near Slot 18 picks Slot 18 in A
  {
    const env = makeTestRig();
    const cA = 0x800c0503;
    const cB = 0x800c0504;
    const pjGuid = 0x800b0503;
    env.push({
      type: "container_state",
      containerGuid: cA,
      containerKind: 11,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [{ slotIndex: 18, subSlot: 0, palletSize: 2, cargoWcid: 4000010 }],
    });
    env.push({
      type: "container_state",
      containerGuid: cB,
      containerKind: 10,
      cell: 0,
      position: [3.6, -5.5, 0],
      heading: 0,
      doorProgress: 1.0,
      doorState: 2,
      slots: [],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [-0.5368, -6.01, 0.162],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0x02,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    env.win.dispatch("keydown", { code: "KeyF" });
    const picks = env.calls.palletJackActions.filter((a) => a.action === PALLET_JACK_ACTION.PickContainerSlot);
    assert.equal(picks.length, 1, "T5_02 PickContainerSlot sent for Container A");
    assert.equal(picks[0].targetGuid, cA, "T5_02 targeted Container A (not closer-center Container B)");
    assert.equal(picks[0].slotIndex, 18, "T5_02 picked Slot 18");
    env.api.dispose();
  }

  // T5_03: api.board() refusal & startPiloting() cleanup when palletJackController.isActive() is true
  {
    const env = makeTestRig();
    const vGuid = 0x80010501;
    const pjGuid = 0x800b0504;
    env.push({ type: "ack", granted: 3 });
    env.push(makeSemiProfile(vGuid));
    env.push(makeSemiState(vGuid, 1.0, 0, 0, 0, { seats: [0, 0] }));
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    assert.equal(env.api.palletJacks.active, pjGuid);

    const boardRes = env.api.board(vGuid, 0);
    assert.equal(boardRes.ok, false, "T5_03 api.board refused while pallet jack active");
    assert.equal(boardRes.reason, "busy");

    // Server forced seat transition must cleanly release & stop active pallet jack controller
    env.push({ type: "seat", vehicle: vGuid, seat: 0, occupant: env.localPlayerGuid, state: 1 });
    env.tick(32, 16);
    assert.equal(env.api.palletJacks.active, null, "T5_03 startPiloting stopped palletJackController");
    assert(
      env.calls.palletJackActions.some((a) => a.action === PALLET_JACK_ACTION.Release && a.jackGuid === pjGuid),
      "T5_03 startPiloting sent Release for active pallet jack"
    );
    env.api.dispose();
  }

  // T5_04: Open [aria-modal="true"] passes KeyE/KeyB/KeyJ in onLogisticsKeyDown and Space/KeyX in pallet_jack_controller
  {
    const env = makeTestRig();
    const cGuid = 0x800c0505;
    const pjGuid = 0x800b0505;
    env.push({ type: "ack", granted: 3 });
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      doorProgress: 0,
      doorState: 0,
      slots: [],
    });
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: 0,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0.5, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);

    const modal = env.makeEl("div");
    modal.setAttribute("aria-modal", "true");
    env.doc.body.appendChild(modal);

    const eRes = env.win.dispatch("keydown", { code: "KeyE", target: env.doc.body });
    const bRes = env.win.dispatch("keydown", { code: "KeyB", target: env.doc.body });
    assert.equal(eRes.defaultPrevented, false, "T5_04 KeyE passes when modal open");
    assert.equal(bRes.defaultPrevented, false, "T5_04 KeyB passes when modal open");
    assert.equal(env.calls.containerActions.length, 0, "T5_04 no container action emitted while modal open");

    modal.remove();

    // Now activate pallet jack and test Space / KeyX while modal open
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0.5, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(32, 16);
    assert.equal(env.api.palletJacks.active, pjGuid);

    env.doc.body.appendChild(modal);
    const spRes = env.win.dispatch("keydown", { code: "Space", target: env.doc.body });
    const xRes = env.win.dispatch("keydown", { code: "KeyX", target: env.doc.body });
    assert.equal(spRes.defaultPrevented, false, "T5_04 Space passes when modal open");
    assert.equal(xRes.defaultPrevented, false, "T5_04 KeyX passes when modal open");
    assert.equal(env.api.palletJacks.active, pjGuid, "T5_04 KeyX did not release jack while modal open");
    modal.remove();
    env.api.dispose();
  }

  // T5_05: Stale promptVehicle during active promptTimer still boards nearestBoardable() (semiB) on KeyB
  {
    const env = makeTestRig();
    const semiA = 0x80010510;
    const semiB = 0x80010511;
    env.push({ type: "ack", granted: 3 });
    env.push(makeSemiProfile(semiA));
    env.push(makeSemiProfile(semiB));
    env.push(makeSemiState(semiA, 0, 0, 0, 0, { seats: [0, 0] }));
    env.push(makeSemiState(semiB, 20, 0, 0, 0, { seats: [0, 0] }));
    env.localEntity.root.position.set(1, 0, 0);
    env.tick(16, 16); // sets promptVehicle = semiA

    // Trigger transient promptTimer via SideliftRefused event, then move next to semiB while promptTimer active
    env.push({ type: "event", vehicle: semiA, kind: 24, step: 1, subject: env.localPlayerGuid, cell: 0, x: 0, y: 0, z: 0, value: 0 });
    env.localEntity.root.position.set(20, 0, 0);
    env.tick(32, 16);

    env.win.dispatch("keydown", { code: "KeyB" });
    assert.equal(env.calls.boards.length, 1, "T5_05 KeyB boarded one vehicle");
    assert.equal(env.calls.boards[0].guid, semiB, "T5_05 KeyB boarded semiB instead of stale promptVehicle semiA");
    env.api.dispose();
  }

  // T5_06: In-flight pallet_jack_state while isDeathHeld() === true causes zero __inputFunnel.poison calls
  {
    const env = makeTestRig();
    const pjGuid = 0x800b0506;
    env.setDeathHeld(true);
    env.push({
      type: "pallet_jack_state",
      palletJackGuid: pjGuid,
      operatorGuid: env.localPlayerGuid,
      stowedOnTrailerGuid: 0,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      tillerAngle: 0,
      forkHeightM: 0.085,
      forkState: 0,
      carriedPalletSize: 0,
      flags: 0,
      carriedWcid: 0,
      ownerGuid: env.localPlayerGuid,
    });
    env.tick(16, 16);
    assert.equal(env.api.palletJacks.active, null, "T5_06 jack does not start while dead");
    assert.equal(
      env.funnelLog.filter((e) => e.op === "poison").length,
      0,
      "T5_06 zero __inputFunnel.poison churn while dead"
    );
    env.api.dispose();
  }

  // T5_07: sidelifter20 rear-mounted 20ft container aligns frontRig/rearRig around slotY = -2.9295 via index.js
  {
    const env = makeTestRig();
    const trGuid = 0x80040501;
    const cGuid = 0x800c0507;
    env.push({
      type: "container_state",
      containerGuid: cGuid,
      containerKind: 10,
      cell: 0,
      position: [0, 0, 1.32],
      heading: 0,
      doorProgress: 0,
      doorState: 0,
      slots: [],
    });
    env.push({
      type: "trailer_state",
      trailerGuid: trGuid,
      kind: 15,
      cell: 0,
      position: [0, 0, 0],
      heading: 0,
      pitch: 0,
      bank: 0,
      coupledTractorGuid: 0,
      mountedContainerGuid: cGuid,
      containerSlot: 0,
      trailerFlags: 0,
      ownerGuid: env.localPlayerGuid,
      sideliftPhase: 6,
      sideliftSide: 1,
      sideliftFlags: 0x05,
      sideliftProgress: 0.5,
      outriggerProgress: 1.0,
      craneSpanY: 2.9265,
      stowedPalletJackGuid: 0,
      transferContainerGuid: cGuid,
    });
    env.tick(16, 16);
    const frontCrane = env.worldRoot.getObjectByName("sidelifter-crane-front");
    const rearCrane = env.worldRoot.getObjectByName("sidelifter-crane-rear");
    assert(frontCrane && rearCrane, "T5_07 sidelifter crane groups present in scene");
    assert(
      Math.abs(frontCrane.position.y - (-2.9295 + 2.9265)) < 1e-3,
      `T5_07 frontCrane Y aligned to 20ft rear slot (got ${frontCrane.position.y})`
    );
    assert(
      Math.abs(rearCrane.position.y - (-2.9295 - 2.9265)) < 1e-3,
      `T5_07 rearCrane Y aligned to 20ft rear slot (got ${rearCrane.position.y})`
    );

    // Also verify lintSource() stays 0 hits on touched standalone logistics modules
    const hereDir = path.dirname(new URL(import.meta.url).pathname);
    for (const rel of ["../scene3d/vehicle/pallet_jack_controller.js", "../scene3d/vehicle/sidelifter_model.js"]) {
      const hits = lintSource(readFileSync(path.resolve(hereDir, rel), "utf8"));
      assert.equal(hits.length, 0, `${rel} lintSource hits: ${JSON.stringify(hits)}`);
    }
    env.api.dispose();
  }
});

for (const run of tests) {
  await run();
}

console.log(`vehicle_pallet_jack_integration: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
