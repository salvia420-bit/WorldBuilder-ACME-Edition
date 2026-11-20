// tests/vehicle_semi_integration.test.mjs — End-to-end Milestone M3 integration tests for Semi-379,
// articulated trailers, ISO containers, colliders, ground FX, and driver/co-driver seat poses.
//
// Run from apps/holtburger-web/: node tests/vehicle_semi_integration.test.mjs

import assert from "node:assert/strict";
import * as THREE from "three";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";

installFakeAudio();

const { initVehicles } = await import("../scene3d/vehicle/index.js");
const FM = await import("../scene3d/vehicle/flight_model.js");
const TK = await import("../scene3d/vehicle/trailer_kinematics.js");
const { createGroundFx, SEMI_FX_DIMENSIONS, POOL_SIZE } = await import("../scene3d/vehicle/ground_fx.js");
const {
  SEMI_SEAT_CONSTANTS,
  getSeatOffset,
  computeSeatPose,
  interpolateSeatHotSwap,
  evaluateBoardingSpline,
  applySeatPoseToEntity,
} = await import("../scene3d/vehicle/seat_poses.js");

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
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
    }
  });
}

function makeFakeWindowDocCanvas() {
  const winListeners = new Map();
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
      dataset: {},
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
        this.children.push(c);
        if (c && c.id) byId.set(c.id, c);
        return c;
      },
      remove() {
        if (idVal && byId.get(idVal) === el) byId.delete(idVal);
      },
      querySelector() { return null; },
      setAttribute() {},
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
    createElement(tag) { return makeEl(tag); },
    getElementById(id) { return byId.get(id) ?? null; },
    exitPointerLock() { doc.pointerLockElement = null; },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      const e = { type, ...ev };
      for (const fn of [...(docListeners.get(type) || [])]) fn(e);
    },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    location: { search: "?vehicles=on" },
    document: doc,
    getLocalPlayerGuid: () => 0,
    __inputFunnel: {
      _fault: null,
      poison(v) { this._fault = v; },
      unpoison() { this._fault = null; },
      releaseHeld() {},
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      const e = { type, ...ev };
      for (const fn of [...(winListeners.get(type) || [])]) fn(e);
    },
  };

  return { win, doc, canvas };
}

function makeTestRig() {
  const { win, doc, canvas } = makeFakeWindowDocCanvas();
  const worldRoot = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 4000);
  const entityMap = new Map();
  const standInHiddenCalls = [];

  const localPlayerGuid = 0x50000001;
  win.getLocalPlayerGuid = () => localPlayerGuid;
  const makeStandIn = () => ({
    root: new THREE.Group(),
    _filmHidden: false,
    _wireCellId: 0,
    _wireCellIdx: 0,
  });
  entityMap.set(localPlayerGuid, makeStandIn());

  const inbox = [];
  const calls = {
    trailerActions: [],
    upserts: [],
    removals: [],
    inputs: [],
    seats: [],
    boards: [],
    clearSeats: 0,
  };

  const sessionHandle = {
    vehicleCapabilities() {},
    drainVehicleMessages() {
      const out = JSON.stringify(inbox);
      inbox.length = 0;
      return out;
    },
    terrainHeightAt() { return 0; },
    setVehicleSeat(guid, cell, x, y, z, heading) {
      calls.seats.push({ guid, cell, x, y, z, heading });
    },
    clearVehicleSeat() { calls.clearSeats++; },
    vehicleBoard(guid, seat) { calls.boards.push({ guid, seat }); },
    vehicleExit() {},
    vehicleInput(guid, flat) { calls.inputs.push({ guid, flat }); },
    vehicleTrailerAction(trailerGuid, vehicleGuid, containerGuid, action, slot) {
      calls.trailerActions.push({ trailerGuid, vehicleGuid, containerGuid, action, slot });
    },
    upsertContainerCollider(guid, cell, x, y, z, heading, kind, doorOpen) {
      calls.upserts.push({ guid, cell, x, y, z, heading, kind, doorOpen });
    },
    removeContainerCollider(guid) {
      calls.removals.push(guid);
    },
  };

  const live = {
    sessionHandle,
    renderer: { domElement: canvas },
    worldRoot,
    camera,
    localPlayerGuid,
    nullRender: false,
    entityManager: {
      entityMap,
      localPlayerGuid,
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
    win, doc, canvas, worldRoot, camera, entityMap, standInHiddenCalls,
    localPlayerGuid, calls, live, api, push, tick, makeStandIn,
  };
}

function makeSemiProfile(guid, liveryId = 0) {
  return {
    type: "profile",
    vehicle: guid,
    displayName: "Ironhorse 379",
    profileKey: "semi-379",
    vehicleClass: 3,
    liveryId,
    locomotion: 2,
    maxSeats: 2,
    vMax: 27.0,
    vMaxRoad: 27.0,
    steerSlewRateLow: 4.5,
    steerSlewRateHigh: 2.2,
    seats: [
      { offset: [-0.52, 0.28, 1.72] },
      { offset: [0.52, 0.28, 1.72] },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. index.js Semi-379 Lifecycle, Model Dispatch & Seat/Camera Isolation
// ---------------------------------------------------------------------------

test("Semi-379 spawns procedural 6x4 model, hides stand-in, rebuilds on livery change", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000101;
  rig.entityMap.set(semiGuid, rig.makeStandIn());

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 2));
  const c0 = FM.toCellLocal(100, 200, 0);
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: c0.cell, x: c0.x, y: c0.y, z: c0.z,
    heading: 0, pitch: 0, bank: 0,
    speed: 0, steerAngle: 0,
    groundFlags: 0x01, surfaceFamily: 0,
    flags: 0,
  });
  rig.tick(16, 16);

  const model = rig.api.semi.get(semiGuid);
  assert.ok(model, "api.semi.get returns built semi model");
  assert.equal(model.root.userData.profileKey, "semi-379");
  assert.equal(model.livery.id, 2);
  assert.equal(rig.api.semi.list().length, 1);
  assert.equal(rig.entityMap.get(semiGuid)._filmHidden, true, "0x0200026B stand-in hidden");

  // Livery change rebuilds model cleanly without leaking old root in worldRoot
  const rootsBefore = rig.worldRoot.children.length;
  rig.push(makeSemiProfile(semiGuid, 4));
  rig.tick(32, 16);
  const rebuilt = rig.api.semi.get(semiGuid);
  assert.equal(rebuilt.livery.id, 4, "livery rebuilt to ID 4");
  assert.equal(rig.worldRoot.children.length, rootsBefore, "old semi model removed before adding rebuilt model");

  rig.api.dispose();
});

test("Semi-379 pilot mode uses 2-seat clamp and ground chase camera (no Hellcat CHASE override)", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000102;
  rig.entityMap.set(semiGuid, rig.makeStandIn());

  const c0 = FM.toCellLocal(120, 220, 0);
  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: c0.cell, x: c0.x, y: c0.y, z: c0.z,
    heading: 0, pitch: 0, bank: 0,
    speed: 0, steerAngle: 0,
    groundFlags: 0x00, surfaceFamily: 0,
    flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  rig.tick(16, 16);

  assert.equal(rig.api.piloting, true);
  assert.equal(rig.api.semi.active(), semiGuid);
  const st = rig.api.status();
  assert.equal(st.pilot.controls.maxSeats, 2, "Semi controls clamp seats to 2");
  assert.equal(st.pilot.controls.vehicleClass, 3);
  assert.equal(st.pilot.controls.profileKey, "semi-379");

  // Digit3 must clamp to seat 1 (not 2) on semi
  rig.win.dispatch("keydown", { code: "Digit3", key: "3", repeat: false });
  rig.tick(32, 16);
  const ctrlAfterDigit3 = rig.api.status().pilot.controls;
  assert.equal(ctrlAfterDigit3.maxSeats, 2, "2-seat max enforced");
  rig.win.dispatch("keyup", { code: "Digit3", key: "3" });

  // Ground chase camera sits behind semi (not Hellcat 21 m fighter chase)
  rig.tick(48, 16);
  const camAc = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
  const distFromSemi = Math.hypot(camAc[0] - 120, camAc[1] - 220);
  assert.ok(distFromSemi >= 8.0 && distFromSemi <= 15.0, `Semi chase dist expected ~10.8 m, got ${distFromSemi.toFixed(2)}`);

  rig.api.dispose();
});

// ---------------------------------------------------------------------------
// 2. Trailers (0x090F), Coupled 60 FPS Tracking, towMassMul & Camera Zoom
// ---------------------------------------------------------------------------

test("trailer_state spawns 40ft trailer at FM.toGlobal, couples at 60 FPS, updates towMassMul and chase zoom", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000103;
  const trailerGuid = 0x70000201;
  rig.entityMap.set(semiGuid, rig.makeStandIn());
  rig.entityMap.set(trailerGuid, rig.makeStandIn());

  const semiCell = FM.toCellLocal(300, 400, 0);
  const trCell = FM.toCellLocal(300, 390, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 1));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0,
    speed: 0, steerAngle: 0,
    flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14, // 40ft
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    trailerFlags: 0,
  });
  rig.tick(16, 16);

  // Unhitched checks
  const trList0 = rig.api.trailers.list();
  assert.equal(trList0.length, 1);
  assert.equal(trList0[0].coupledTractorGuid, 0);
  assert.equal(rig.entityMap.get(trailerGuid)._filmHidden, true, "trailer 0x0200026B stand-in hidden");
  const trEntry = rig.api.trailers.get(trailerGuid);
  assert.ok(Math.abs(trEntry.model.root.position.y - 390) < 0.05, "trailer placed via FM.toGlobal");
  assert.equal(rig.api.semi.list()[0].towMassMul, TK.TOW_MASS_MUL.BOBTAIL);

  // Couple trailer to tractor (retracted gear + brake lights)
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: semiGuid,
    mountedContainerGuid: 0,
    trailerFlags: 0x05, // GEAR_RETRACTED | BRAKE_LIGHTS
  });
  rig.tick(32, 16);

  assert.equal(rig.api.trailers.get(trailerGuid).coupledTractorGuid, semiGuid);
  assert.equal(rig.api.semi.list()[0].towMassMul, TK.TOW_MASS_MUL.EMPTY_CHASSIS, "empty chassis towMassMul = 0.72");
  assert.equal(rig.api.semi.list()[0].coupled, true);

  // Drive tractor forward/turning — 60 FPS coupled kinematics tracks tractor and pulls chase camera back for 40ft
  rig.api.setSticks({ throttle: 0.8, roll: 0.35 }, 400);
  const trYBefore = trEntry.model.root.position.y;
  for (let i = 0; i < 15; i++) {
    rig.tick(48 + i * 16, 16);
  }
  const semiCamAc = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
  const semiPos = rig.api.status().pilot.state;
  const chaseDist40 = Math.hypot(semiCamAc[0] - semiPos.x, semiCamAc[1] - semiPos.y);
  assert.ok(chaseDist40 > 15.0, `40ft trailer zoom pulls chase back toward 22.5 m (got ${chaseDist40.toFixed(2)})`);
  assert.ok(trEntry.model.root.position.y !== trYBefore || trEntry.renderedPose !== null, "60 FPS trailer pose active");

  rig.api.dispose();
});

// ---------------------------------------------------------------------------
// 3. Mounted Container Sync, container_state Guard & Collider Toggle
// ---------------------------------------------------------------------------

test("Mounted container attaches under containerMount, blocks stale container_state, toggles collider moving vs parked", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000104;
  const trailerGuid = 0x70000202;
  const contGuid = 0x70000301;

  const semiCell = FM.toCellLocal(400, 400, 0);
  const trCell = FM.toCellLocal(400, 390, 0);
  const cCell = FM.toCellLocal(900, 900, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0,
    speed: 6.0, mode: FM.MODE.DRIVING, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  // Container starts on ground (collider upserted)
  rig.push({
    type: "container_state",
    containerGuid: contGuid,
    containerKind: 11, // 40ft container
    cell: cCell.cell, position: [cCell.x, cCell.y, cCell.z],
    heading: 0, doorProgress: 0, doorState: 0,
  });
  rig.tick(16, 16);
  assert.ok(rig.calls.upserts.some((u) => u.guid === contGuid), "ground container upserts collider");

  // Mount onto coupled driving trailer -> attach + removeContainerCollider
  rig.calls.removals.length = 0;
  rig.calls.upserts.length = 0;
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: semiGuid,
    mountedContainerGuid: contGuid,
    trailerFlags: 0x03, // GEAR_RETRACTED | TWISTLOCKS_LOCKED
  });
  rig.tick(32, 16);

  const trEntry = rig.api.trailers.get(trailerGuid);
  const contEntry = rig.api.containers.get(contGuid);
  assert.ok(trEntry && contEntry, "trailer and container entries exist");
  assert.equal(contEntry.model.root.parent, trEntry.model.containerMount, "container attached directly under trailer containerMount");
  assert.equal(rig.api.semi.list()[0].towMassMul, TK.TOW_MASS_MUL.LOADED_40FT, "loaded 40ft towMassMul = 0.58");
  assert.ok(rig.calls.removals.includes(contGuid), "collider removed while trailer is coupled & moving");

  // Stale container_state MUST NOT displace mounted container
  rig.calls.upserts.length = 0;
  rig.push({
    type: "container_state",
    containerGuid: contGuid,
    containerKind: 11,
    cell: cCell.cell, position: [cCell.x, cCell.y, cCell.z],
    heading: 1.5, doorProgress: 0,
  });
  rig.tick(48, 16);
  assert.equal(contEntry.model.root.parent, trEntry.model.containerMount, "container_state guard keeps container mounted");
  assert.equal(rig.calls.upserts.length, 0, "no collider upserted while actively hauling");

  // Uncouple & park trailer -> collider MUST be re-upserted via TK.computeMountedContainerPose
  rig.calls.upserts.length = 0;
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0.4, pitch: 0, bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: contGuid,
    trailerFlags: 0x02,
  });
  rig.tick(64, 16);
  assert.ok(rig.calls.upserts.some((u) => u.guid === contGuid), "parked mounted container upserts world collider");

  // Unmount container -> detaches back to worldRoot
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0.4, pitch: 0, bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    trailerFlags: 0,
  });
  rig.tick(80, 16);
  assert.equal(contEntry.model.root.parent, rig.worldRoot, "unmounted container detached back to worldRoot");

  rig.api.dispose();
});

// ---------------------------------------------------------------------------
// 4. KeyG Hitch / Unhitch Action, Events 19/20/21 & Cleanup
// ---------------------------------------------------------------------------

test("KeyG sends hitch within 3.5 m and unhitch when coupled; events 19/20/21 and despawn clean up", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000105;
  const trailerGuid = 0x70000203;
  const semiPos = [500, 500, 0];
  const fifthWheel = TK.computeFifthWheelPose({ x: semiPos[0], y: semiPos[1], z: semiPos[2], heading: 0, pitch: 0, bank: 0 });
  const trPos = [fifthWheel.x + 1.2, fifthWheel.y, fifthWheel.z]; // kingpin within 3.5 m of fifth wheel

  const sCell = FM.toCellLocal(...semiPos);
  const tCell = FM.toCellLocal(...trPos);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: sCell.cell, x: sCell.x, y: sCell.y, z: sCell.z,
    heading: 0, pitch: 0, bank: 0,
    speed: 0, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 13, // 20ft
    cell: tCell.cell, position: [tCell.x, tCell.y, tCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: 0,
    mountedContainerGuid: 0,
    trailerFlags: 0,
  });
  rig.tick(16, 16);

  // Press KeyG while bobtail near trailer -> action 1 (Hitch)
  rig.win.dispatch("keydown", { code: "KeyG", key: "g", repeat: false });
  rig.tick(60, 44);
  rig.win.dispatch("keyup", { code: "KeyG", key: "g" });
  assert.ok(rig.calls.trailerActions.some((a) => a.trailerGuid === trailerGuid && a.vehicleGuid === semiGuid && a.action === 1), "KeyG emits hitch action (1)");

  // Server confirms coupling + events 19/21
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 13,
    cell: tCell.cell, position: [tCell.x, tCell.y, tCell.z],
    heading: 0, coupledTractorGuid: semiGuid, mountedContainerGuid: 0, trailerFlags: 0x01,
  });
  rig.push({ type: "event", kind: 19, vehicle: semiGuid, subject: rig.localPlayerGuid, aux: trailerGuid });
  rig.push({ type: "event", kind: 21, vehicle: semiGuid, subject: rig.localPlayerGuid, value: 0, aux: trailerGuid });
  rig.tick(96, 36);
  assert.equal(rig.doc.getElementById("hb-vehicle-prompt")?.textContent, "Twistlocks UNLOCKED", "kind 21 value=0 aux=trailerGuid displays UNLOCKED");

  rig.push({ type: "event", kind: 21, vehicle: semiGuid, subject: rig.localPlayerGuid, value: 1, aux: trailerGuid });
  rig.tick(112, 16);
  assert.equal(rig.doc.getElementById("hb-vehicle-prompt")?.textContent, "Twistlocks LOCKED", "kind 21 value=1 aux=trailerGuid displays LOCKED");

  // Press KeyG while coupled -> action 2 (Unhitch)
  rig.calls.trailerActions.length = 0;
  rig.win.dispatch("keydown", { code: "KeyG", key: "g", repeat: false });
  rig.tick(140, 44);
  rig.win.dispatch("keyup", { code: "KeyG", key: "g" });
  assert.ok(rig.calls.trailerActions.some((a) => a.trailerGuid === trailerGuid && a.vehicleGuid === semiGuid && a.action === 2), "KeyG emits unhitch action (2) when coupled");

  rig.push({ type: "event", kind: 20, vehicle: semiGuid, subject: rig.localPlayerGuid, aux: trailerGuid });
  rig.push({ type: "event", kind: 4, vehicle: trailerGuid, subject: trailerGuid });
  rig.push({ type: "event", kind: 4, vehicle: semiGuid, subject: 0 });
  rig.tick(172, 32);

  assert.equal(rig.api.trailers.list().length, 0, "trailer despawn event 4 cleans trailer entry");
  assert.equal(rig.api.semi.list().length, 0, "semi despawn event 4 cleans vehicle entry");

  rig.api.dispose();
  assert.equal(rig.worldRoot.children.length, 0, "zero leaked meshes in worldRoot after dispose");
});

// ---------------------------------------------------------------------------
// 5. ground_fx.js Semi-379 6-Wheel & Dual Stack Exhaust Plume Integration
// ---------------------------------------------------------------------------

test("ground_fx.js spawns 6-wheel dust and dual vertical diesel exhaust plumes for semi-379", () => {
  assert.equal(SEMI_FX_DIMENSIONS.wheelOffsets.length, 6, "6 wheel offsets defined");
  assert.equal(SEMI_FX_DIMENSIONS.exhaustOffsets.length, 2, "2 exhaust stack tips defined");

  const worldRoot = new THREE.Group();
  const fx = createGroundFx({ root: worldRoot, THREE });

  // Drive semi at 15 m/s over dust/gravel surface (surfaceFamily = 2)
  for (let i = 0; i < 6; i++) {
    fx.update({
      x: i * 0.25, y: 0, z: 0,
      heading: 0, pitch: 0, bank: 0,
      speed: 15,
      throttle: 0.9,
      groundFlags: 0x01,
      surfaceFamily: 2,
      vehicleClass: 3,
      profileKey: "semi-379",
    }, 1 / 60);
  }

  assert.equal(fx.pool.length, POOL_SIZE);
  assert.equal(fx.lightCountDelta, 0, "zero dynamic lights allocated");
  const activeCount = fx.getActiveCount();
  assert.ok(activeCount > 0, `pooled semi dust/exhaust particles emitted (${activeCount})`);
  const hasUpwardPlume = fx.pool.some((p) => p.active && p.vz > 0.5 && p.z >= 3.5);
  assert.equal(hasUpwardPlume, true, "vertical exhaust stack plumes spawn around z >= 3.72 with vz > 0");

  fx.dispose();
  assert.equal(worldRoot.children.length, 0, "ground_fx disposes cleanly");
});

// ---------------------------------------------------------------------------
// 6. seat_poses.js Semi-379 2-Seat IK & Hot-Swap Interpolation
// ---------------------------------------------------------------------------

test("seat_poses.js solves semi-379 driver IK across ±38° steering, hot-swap, and skeleton application", () => {
  assert.equal(SEMI_SEAT_CONSTANTS.seatOffsets.length, 2);
  assert.deepEqual(SEMI_SEAT_CONSTANTS.seatOffsets[0], [-0.52, 0.28, 1.72]);
  assert.deepEqual(SEMI_SEAT_CONSTANTS.seatOffsets[1], [0.52, 0.28, 1.72]);

  const prof = { vehicleClass: 3, profileKey: "semi-379" };
  assert.deepEqual(getSeatOffset(0, prof), [-0.52, 0.28, 1.72]);
  assert.deepEqual(getSeatOffset(1, prof), [0.52, 0.28, 1.72]);

  for (const steer of [-0.663, 0, 0.663]) {
    const p0 = computeSeatPose(0, 0x2000014, { speed: 12, steerAngle: steer, profile: prof });
    const [wx, wy, wz] = SEMI_SEAT_CONSTANTS.steeringWheelCenter;
    const lTarget = p0.leftArmIK.vehicleTarget;
    const rTarget = p0.rightArmIK.vehicleTarget;
    const dL = Math.hypot(lTarget[0] - wx, lTarget[1] - wy, lTarget[2] - wz);
    const dR = Math.hypot(rTarget[0] - wx, rTarget[1] - wy, rTarget[2] - wz);
    assert.ok(Math.abs(dL - SEMI_SEAT_CONSTANTS.steeringWheelRadius) < 0.08, `driver left hand grips 0.24 m rim (d=${dL.toFixed(3)})`);
    assert.ok(Math.abs(dR - SEMI_SEAT_CONSTANTS.steeringWheelRadius) < 0.08, `driver right hand grips 0.24 m rim (d=${dR.toFixed(3)})`);
  }

  const p1 = computeSeatPose(1, 0x2000014, { speed: 12, steerAngle: 0.2, profile: prof, accelLat: 5.0 });
  assert.equal(p1.braceActive, true, "co-driver braceActive === true under lateral acceleration");
  assert.ok(p1.leftArmIK.vehicleTarget[0] > 0.3 && p1.leftArmIK.vehicleTarget[1] > 0.7, "co-driver braces against dash grab handle");

  const swap = interpolateSeatHotSwap(0, 1, 0.5, prof);
  assert.ok(Array.isArray(swap) && swap.every(Number.isFinite));
  assert.ok(Math.abs(swap[0]) < 0.1, "midpoint of cab hot-swap crosses x ~ 0");

  const splinePt = evaluateBoardingSpline(0, "board", 0.5, "?vehicles=on", prof);
  assert.equal(splinePt.pos.length, 3);
  assert.ok(splinePt.pos.every(Number.isFinite));

  // Skeleton application sanity (34-part rig)
  const mkPart = () => ({
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    quaternion: { x: 0, y: 0, z: 0, w: 1, set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; } },
  });
  const fakeInst = {
    root: new THREE.Group(),
    parts: Array.from({ length: 34 }, mkPart),
    setupId: 0x2000014,
  };
  applySeatPoseToEntity(fakeInst, 0, { x: 10, y: 20, z: 0, heading: 0, pitch: 0, bank: 0 }, { speed: 10, steerAngle: 0.3, profile: prof }, 1 / 60);
  const headQuat = fakeInst.parts[16].quaternion;
  assert.ok(Math.abs(fakeInst.root.position.x - (10 - 0.52)) < 0.01, "entity root placed at driver semi seat");
  assert.ok(Number.isFinite(headQuat.y) && Math.abs(headQuat.y) > 0.05, "driver head quaternion turns with steering");
});

// ---------------------------------------------------------------------------
// 7. Iteration 2 Regression Tests (Hot-swap camera, despawn gear, heading=0, KeyS brake lights)
// ---------------------------------------------------------------------------

test("Driver -> co-driver (Digit2) hot-swap preserves camera ownership & bobtail zoom recovery on unhitch", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000110;
  const trailerGuid = 0x70000210;
  const semiCell = FM.toCellLocal(200, 300, 0);
  const trCell = FM.toCellLocal(200, 290, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01, hitchedTrailerGuid: trailerGuid, trailerHeading: 0, trailerFlags: 0x05,
  });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: semiGuid, mountedContainerGuid: 0, trailerFlags: 0x05,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });

  let t = 16;
  for (let i = 0; i < 60; i++) {
    rig.tick(t, 16);
    t += 16;
  }
  const cam40 = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
  const dist40 = Math.hypot(cam40[0] - 200, cam40[1] - 300);
  assert.ok(dist40 > 18.0, `40ft coupled chase pulls back > 18m (got ${dist40.toFixed(2)})`);

  // Hot-swap driver (0) -> co-driver (1) via Digit2
  rig.calls.clearSeats = 0;
  rig.win.dispatch("keydown", { code: "Digit2", key: "2", repeat: false });
  rig.win.dispatch("keyup", { code: "Digit2", key: "2" });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 0, occupant: 0 });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });
  rig.tick(t, 16);
  t += 16;

  assert.equal(rig.api.piloting, false);
  assert.equal(rig.api.riding, true);
  assert.equal(rig.calls.clearSeats, 0, "stopPiloting(keepCamera=true) does NOT clearVehicleSeat on hot-swap");

  // Unhitch while riding in seat 1 -> chase camera must smoothly recover toward bobtail 10.8 m
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01, hitchedTrailerGuid: 0, trailerHeading: 0, trailerFlags: 0,
  });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: 0, mountedContainerGuid: 0, trailerFlags: 0,
  });
  for (let i = 0; i < 80; i++) {
    rig.tick(t, 16);
    t += 16;
  }
  const camBob = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
  const distBob = Math.hypot(camBob[0] - 200, camBob[1] - 300);
  assert.ok(distBob < 13.0, `live passenger camera recovers toward bobtail 10.8m (got ${distBob.toFixed(2)})`);

  rig.api.dispose();
});

test("Tractor-only despawn clears trailer COUPLED/GEAR_RETRACTED/BRAKE_LIGHTS flags so landing gear stays extended", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000111;
  const trailerGuid = 0x70000211;
  const semiCell = FM.toCellLocal(250, 350, 0);
  const trCell = FM.toCellLocal(250, 340, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, speed: 0, flags: 0,
  });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: semiGuid, mountedContainerGuid: 0,
    trailerFlags: 0x0F, // COUPLED | TWISTLOCKS_LOCKED | GEAR_RETRACTED | BRAKE_LIGHTS
  });
  rig.tick(16, 16);

  const trBefore = rig.api.trailers.get(trailerGuid);
  assert.equal(trBefore.model.landingGearRetracted, true);

  // Despawn ONLY the tractor (event kind 4 on semiGuid)
  rig.push({ type: "event", kind: 4, vehicle: semiGuid, subject: 0 });
  rig.tick(32, 16);

  const trAfter = rig.api.trailers.get(trailerGuid);
  assert.ok(trAfter, "trailer survives tractor despawn");
  assert.equal(trAfter.coupledTractorGuid, 0);
  assert.equal(trAfter.model.landingGearRetracted, false, "landing gear remains extended after tickTrailers");
  assert.equal(trAfter.trailerFlags & 0x0D, 0, "COUPLED | GEAR_RETRACTED | BRAKE_LIGHTS bits cleared");
  assert.equal(trAfter.trailerFlags & 0x02, 0x02, "TWISTLOCKS_LOCKED bit preserved");

  rig.api.dispose();
});

test("Coupling trailer at heading=0 when tractor has heading=0.22 and hitchedTrailerGuid=0 preserves 0 rad trailer heading", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000112;
  const trailerGuid = 0x70000212;
  const semiCell = FM.toCellLocal(320, 420, 0);
  const trCell = FM.toCellLocal(320, 410, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0.22, pitch: 0, bank: 0, speed: 10, flags: 0, hitchedTrailerGuid: 0,
  });
  rig.push({
    type: "trailer_state",
    trailerGuid,
    kind: 14,
    cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
    heading: 0, pitch: 0, bank: 0,
    coupledTractorGuid: semiGuid, mountedContainerGuid: 0, trailerFlags: 0x05,
  });
  rig.tick(16, 16);

  const trEntry = rig.api.trailers.get(trailerGuid);
  assert.ok(Math.abs(trEntry.renderedPose.heading) < 0.05, `expected initial trailer heading ~0 rad, got ${trEntry.renderedPose.heading}`);

  rig.api.dispose();
});

test("KeyS forward service braking illuminates tractor & trailer brake lights immediately without server trailerFlags", () => {
  const origPerfNow = performance.now.bind(performance);
  let fakeNowMs = 1000;
  Object.defineProperty(performance, "now", { value: () => fakeNowMs, configurable: true, writable: true });
  let rig = null;
  try {
    rig = makeTestRig();
    const semiGuid = 0x70000113;
    const trailerGuid = 0x70000213;
    const semiCell = FM.toCellLocal(420, 520, 0);
    const trCell = FM.toCellLocal(420, 510, 0);

    rig.push({ type: "ack", granted: 3 });
    rig.push(makeSemiProfile(semiGuid, 0));
    rig.push({
      type: "state",
      vehicle: semiGuid,
      cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
      heading: 0, pitch: 0, bank: 0, speed: 15, mode: FM.MODE.DRIVING, flags: 0x01,
      hitchedTrailerGuid: trailerGuid, trailerHeading: 0, trailerFlags: 0x05, // BRAKE_LIGHTS bit 0x08 is OFF
    });
    rig.push({
      type: "trailer_state",
      trailerGuid,
      kind: 14,
      cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
      heading: 0, coupledTractorGuid: semiGuid, mountedContainerGuid: 0, trailerFlags: 0x05,
    });
    rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
    let t = 16;
    rig.tick(t, 16);
    // Complete boarding hop (maxSec = 1.2s) so pilot predictor accepts live KeyS control input
    for (let i = 0; i < 65; i++) {
      fakeNowMs += 20;
      t += 20;
      rig.tick(t, 20);
    }

    // Engage KeyS service braking while moving forward (~14+ m/s)
    rig.win.dispatch("keydown", { code: "KeyS", key: "s", repeat: false });
    fakeNowMs += 34;
    t += 34;
    rig.tick(t, 34);
    fakeNowMs += 16;
    t += 16;
    rig.tick(t, 16);
    rig.win.dispatch("keyup", { code: "KeyS", key: "s" });

    const trEntry = rig.api.trailers.get(trailerGuid);
    const semiModel = rig.api.semi.get(semiGuid);
    assert.equal(trEntry.model.brakeLights, true, "trailer brake lights illuminate on KeyS forward braking");
    assert.equal(semiModel.materials.matLamps.emissiveIntensity, 2.2, "tractor brake lamps illuminate on KeyS forward braking");
  } finally {
    rig?.api?.dispose();
    Object.defineProperty(performance, "now", { value: origPerfNow, configurable: true, writable: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Iteration 3 Regression Tests (rigHidden / rigComposite across Pilot/Passenger/Foot)
// ---------------------------------------------------------------------------

test("rigHidden & rigComposite stay consistent across pilot(cockpit) <-> passenger(Digit2/Digit1) -> chase/hood -> foot", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000120;
  rig.entityMap.set(semiGuid, rig.makeStandIn());
  const semiCell = FM.toCellLocal(500, 600, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });

  let t = 16;
  rig.tick(t, 16);
  const localPlayer = rig.entityMap.get(rig.localPlayerGuid);
  const semiEnt = rig.entityMap.get(semiGuid);
  assert.equal(localPlayer._filmHidden, false, "chase pilot keeps localPlayer visible");
  assert.equal(semiEnt._filmHidden, true, "procedural semi hides stand-in");

  // Switch pilot to cockpit
  rig.api.setView("cockpit");
  t += 16;
  rig.tick(t, 16);
  assert.equal(localPlayer._filmHidden, true, "cockpit pilot hides localPlayer");
  assert.equal(semiEnt._filmHidden, true, "semi stand-in remains hidden in cockpit");

  // Hot-swap pilot(cockpit) -> passenger (Digit2)
  rig.win.dispatch("keydown", { code: "Digit2", key: "2", repeat: false });
  rig.win.dispatch("keyup", { code: "Digit2", key: "2" });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 0, occupant: 0 });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });
  t += 16;
  rig.tick(t, 16);
  assert.equal(rig.api.riding, true);
  assert.equal(localPlayer._filmHidden, true, "passenger inherits cockpit and keeps localPlayer hidden");
  assert.equal(semiEnt._filmHidden, true, "semi stand-in remains hidden after Digit2");

  // Switch passenger to chase -> localPlayer unhidden
  rig.api.setView("chase");
  t += 16;
  rig.tick(t, 16);
  assert.equal(localPlayer._filmHidden, false, "passenger chase unhides localPlayer");
  assert.equal(semiEnt._filmHidden, true, "semi stand-in remains hidden in chase");

  // Switch passenger to hood -> localPlayer hidden
  rig.api.setView("hood");
  t += 16;
  rig.tick(t, 16);
  assert.equal(localPlayer._filmHidden, true, "passenger hood hides localPlayer");
  assert.equal(semiEnt._filmHidden, true, "semi stand-in remains hidden in hood");

  // Hot-swap passenger(hood) -> pilot (Digit1)
  rig.win.dispatch("keydown", { code: "Digit1", key: "1", repeat: false });
  rig.win.dispatch("keyup", { code: "Digit1", key: "1" });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 0, occupant: 0 });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  t += 16;
  rig.tick(t, 16);
  assert.equal(rig.api.piloting, true);
  assert.equal(localPlayer._filmHidden, true, "pilot inherits hood and keeps localPlayer hidden");
  assert.equal(semiEnt._filmHidden, true, "semi stand-in remains hidden after Digit1");

  // Exit to foot -> localPlayer unhidden, procedural semi stand-in stays hidden
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 0, occupant: 0 });
  t += 16;
  rig.tick(t, 16);
  assert.equal(rig.api.piloting, false);
  assert.equal(localPlayer._filmHidden, false, "exit to foot restores localPlayer visibility");
  assert.equal(semiEnt._filmHidden, true, "procedural semi stand-in remains hidden while spawned");

  rig.api.dispose();
});

test("Passenger foot -> chase -> cockpit -> foot and onTeleport restore localPlayer visibility", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000121;
  rig.entityMap.set(semiGuid, rig.makeStandIn());
  const semiCell = FM.toCellLocal(520, 620, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });

  let t = 16;
  rig.tick(t, 16);
  const localPlayer = rig.entityMap.get(rig.localPlayerGuid);
  assert.equal(rig.api.riding, true);
  assert.equal(localPlayer._filmHidden, false, "passenger starts in chase with localPlayer visible");

  rig.api.setView("cockpit");
  t += 16;
  rig.tick(t, 16);
  assert.equal(localPlayer._filmHidden, true, "passenger cockpit hides localPlayer");

  // Exit passenger to foot -> localPlayer restored
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 0, occupant: 0 });
  t += 16;
  rig.tick(t, 16);
  assert.equal(rig.api.riding, false);
  assert.equal(localPlayer._filmHidden, false, "passenger exit to foot restores localPlayer visibility");

  // Re-board passenger, enter cockpit, then teleport -> onTeleport calls stopRiding and restores localPlayer
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });
  t += 16;
  rig.tick(t, 16);
  rig.api.setView("cockpit");
  t += 16;
  rig.tick(t, 16);
  assert.equal(localPlayer._filmHidden, true, "passenger cockpit hides localPlayer before teleport");

  rig.live.vehicles.onTeleport();
  assert.equal(rig.api.riding, false, "onTeleport stops riding");
  assert.equal(localPlayer._filmHidden, false, "onTeleport restores localPlayer visibility");

  rig.api.dispose();
});

test("Same-tick pilot(cockpit) -> Digit2 hot-swap + despawn before tickPassenger restores localPlayer visibility", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000122;
  rig.entityMap.set(semiGuid, rig.makeStandIn());
  const semiCell = FM.toCellLocal(540, 640, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });

  let t = 16;
  rig.tick(t, 16);
  rig.api.setView("cockpit");
  t += 16;
  rig.tick(t, 16);
  const localPlayer = rig.entityMap.get(rig.localPlayerGuid);
  assert.equal(localPlayer._filmHidden, true, "pilot cockpit hides localPlayer");

  // Same tick: seat 0 -> seat 1 hot-swap followed immediately by vehicle despawn (before tickPassenger runs)
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 0, occupant: 0 });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });
  rig.push({ type: "event", kind: 4, vehicle: semiGuid, subject: 0 });
  t += 16;
  rig.tick(t, 16);

  assert.equal(rig.api.piloting, false);
  assert.equal(rig.api.riding, false);
  assert.equal(localPlayer._filmHidden, false, "same-tick hot-swap + despawn restores localPlayer visibility");

  rig.api.dispose();
});

// ---------------------------------------------------------------------------
// 9. Tier 5 Hardening Regression Tests (Trailer Despawn & Reverse Ground FX)
// ---------------------------------------------------------------------------

test("Coupled trailer despawn (event kind 4) and removeLocal() immediately restore bobtail state, towMassMul, and chase camera", () => {
  for (const mode of ["event", "removeLocal"]) {
    const rig = makeTestRig();
    const semiGuid = mode === "event" ? 0x70000901 : 0x70000911;
    const trGuid = mode === "event" ? 0x70000902 : 0x70000912;
    rig.entityMap.set(semiGuid, rig.makeStandIn());
    rig.entityMap.set(trGuid, rig.makeStandIn());

    const semiCell = FM.toCellLocal(600, 700, 0);
    const trCell = FM.toCellLocal(600, 690, 0);

    rig.push({ type: "ack", granted: 3 });
    rig.push(makeSemiProfile(semiGuid, 0));
    rig.push({
      type: "state",
      vehicle: semiGuid,
      cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
      heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01,
      hitchedTrailerGuid: trGuid, trailerHeading: 0, trailerFlags: 0x05,
    });
    rig.push({
      type: "trailer_state",
      trailerGuid: trGuid,
      kind: 14,
      cell: trCell.cell, position: [trCell.x, trCell.y, trCell.z],
      heading: 0, pitch: 0, bank: 0,
      coupledTractorGuid: semiGuid, mountedContainerGuid: 0, trailerFlags: 0x05,
    });
    rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });

    let t = 16;
    for (let i = 0; i < 60; i++) {
      rig.tick(t, 16);
      t += 16;
    }

    const before = rig.api.semi.list().find((s) => s.guid === semiGuid);
    assert.equal(before.coupled, true, `${mode}: coupled before despawn`);
    assert.equal(before.hitchedTrailerGuid, trGuid, `${mode}: hitchedTrailerGuid before despawn`);
    assert.equal(before.towMassMul, TK.TOW_MASS_MUL.EMPTY_CHASSIS, `${mode}: towMassMul 0.72 before despawn`);
    const cam40 = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
    const dist40 = Math.hypot(cam40[0] - 600, cam40[1] - 700);
    assert.ok(dist40 > 18.0, `${mode}: 40ft chase camera > 18m before despawn (got ${dist40.toFixed(2)})`);

    // Despawn or removeLocal trailer WITHOUT any new tractor state message
    if (mode === "event") {
      rig.push({ type: "event", vehicle: trGuid, subject: 0, kind: 4 });
    } else {
      rig.api.trailers.removeLocal(trGuid);
    }
    rig.tick(t, 16);
    t += 16;

    const afterImm = rig.api.semi.list().find((s) => s.guid === semiGuid);
    assert.equal(afterImm.coupled, false, `${mode}: coupled === false immediately`);
    assert.equal(afterImm.hitchedTrailerGuid, 0, `${mode}: hitchedTrailerGuid === 0 immediately`);
    assert.equal(afterImm.towMassMul, TK.TOW_MASS_MUL.BOBTAIL, `${mode}: towMassMul === 1.0 immediately`);
    assert.equal(rig.api.trailers.list().length, 0, `${mode}: trailer removed`);

    // Tick so chase camera converges back to bobtail 10.8 m
    for (let i = 0; i < 80; i++) {
      rig.tick(t, 16);
      t += 16;
    }
    const camBob = [rig.camera.position.x, -rig.camera.position.z, rig.camera.position.y];
    const distBob = Math.hypot(camBob[0] - 600, camBob[1] - 700);
    assert.ok(distBob < 13.0, `${mode}: chase camera recovers toward bobtail 10.8m (got ${distBob.toFixed(2)})`);

    rig.api.dispose();
  }
});

test("ground_fx.js spawns wheel dust plumes and handbrake skid smoke in reverse (speed < 0)", () => {
  const worldRoot = new THREE.Group();
  const fx = createGroundFx({ root: worldRoot, THREE });

  for (let i = 0; i < 10; i++) {
    fx.update({
      x: 0, y: -i * 0.75, z: 0,
      heading: 0, pitch: 0, bank: 0,
      speed: -15,
      throttle: -0.5,
      handbrake: true,
      groundFlags: 0x01,
      surfaceFamily: 1,
      vehicleClass: 3,
      profileKey: "semi-379",
    }, 0.05);
  }

  const active = fx.getActiveCount();
  assert.ok(active > 10, `reverse dust plumes + handbrake skid smoke emitted (${active} active > 5 exhaust-only)`);
  fx.dispose();
});

test("ground_fx.js transforms semi wheel dust, skid smoke, dual exhaust, and terrain ruts by AC compass heading (PI/2 & PI)", () => {
  const stamped = [];
  const prevWin = globalThis.window;
  globalThis.window = {
    __terrainVfx: {
      trail: {
        stamp(wx, wy, radius, strength) {
          stamped.push({ wx, wy, radius, strength });
        },
      },
    },
  };
  try {
    for (const heading of [Math.PI / 2, Math.PI]) {
      stamped.length = 0;
      const worldRoot = new THREE.Group();
      const fx = createGroundFx({ root: worldRoot, THREE });
      const px = 100;
      const py = 200;
      const pz = 5;
      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);

      fx.update({
        x: px, y: py, z: pz,
        heading, pitch: 0, bank: 0,
        speed: 14,
        throttle: 0.8,
        handbrake: true,
        groundFlags: 0x03,
        surfaceFamily: 1, // Dirt (deformable)
        vehicleClass: 3,
        profileKey: "semi-379",
      }, 0.12);

      // 1. Terrain ruts stamped for all 6 semi wheels at AC compass transform
      assert.equal(stamped.length, 6, `heading=${heading.toFixed(2)}: 6 semi wheel ruts stamped`);
      for (let i = 0; i < 6; i++) {
        const [lx, ly] = SEMI_FX_DIMENSIONS.wheelOffsets[i];
        const ex = px + lx * cosH + ly * sinH;
        const ey = py - lx * sinH + ly * cosH;
        assert.ok(Math.abs(stamped[i].wx - ex) < 1e-4, `rut[${i}] wx=${stamped[i].wx} vs ${ex}`);
        assert.ok(Math.abs(stamped[i].wy - ey) < 1e-4, `rut[${i}] wy=${stamped[i].wy} vs ${ey}`);
      }

      // 2. Dual exhaust wisps emitted at rotated stack tops
      const activeSlots = fx.pool.filter((s) => s.active);
      for (let e = 0; e < 2; e++) {
        const [txOff, tyOff, tzOff] = SEMI_FX_DIMENSIONS.exhaustOffsets[e];
        const ex = px + txOff * cosH + tyOff * sinH;
        const ey = py - txOff * sinH + tyOff * cosH;
        const ez = pz + tzOff;
        const hit = activeSlots.find((s) => Math.hypot(s.x - ex, s.y - ey) < 0.25 && Math.abs(s.z - ez) < 0.5);
        assert.ok(hit, `heading=${heading.toFixed(2)}: exhaust stack ${e} spawned near (${ex.toFixed(2)}, ${ey.toFixed(2)})`);
      }

      // 3. Wheel dust (6 wheels) and rear skid smoke (4 tandem wheels) spawned near rotated wheel coords
      const [flX, flY] = SEMI_FX_DIMENSIONS.wheelOffsets[0];
      const flWx = px + flX * cosH + flY * sinH;
      const flWy = py - flX * sinH + flY * cosH;
      const flDust = activeSlots.find((s) => Math.hypot(s.x - flWx, s.y - flWy) < 0.25 && Math.abs(s.z - (pz + 0.05)) < 0.3);
      assert.ok(flDust, `heading=${heading.toFixed(2)}: FL wheel dust spawned near (${flWx.toFixed(2)}, ${flWy.toFixed(2)})`);

      const [rrX, rrY] = SEMI_FX_DIMENSIONS.wheelOffsets[5];
      const rrWx = px + rrX * cosH + rrY * sinH;
      const rrWy = py - rrX * sinH + rrY * cosH;
      const rrSkid = activeSlots.find((s) => s.mat.color.getHex() === 0xdddddd && Math.hypot(s.x - rrWx, s.y - rrWy) < 0.25);
      assert.ok(rrSkid, `heading=${heading.toFixed(2)}: RR skid smoke spawned near (${rrWx.toFixed(2)}, ${rrWy.toFixed(2)})`);

      fx.dispose();
    }
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

test("Adversarial (Finding 2): Digit2 hot-swap immediately followed by api.exit(0) clears hotSwapTarget so server state=0 releases seat", () => {
  const rig = makeTestRig();
  const semiGuid = 0x70000951;
  rig.entityMap.set(semiGuid, rig.makeStandIn());
  const semiCell = FM.toCellLocal(650, 750, 0);

  rig.push({ type: "ack", granted: 3 });
  rig.push(makeSemiProfile(semiGuid, 0));
  rig.push({
    type: "state",
    vehicle: semiGuid,
    cell: semiCell.cell, x: semiCell.x, y: semiCell.y, z: semiCell.z,
    heading: 0, pitch: 0, bank: 0, speed: 0, flags: 0x01,
  });
  rig.push({ type: "seat", vehicle: semiGuid, seat: 0, state: 1, occupant: rig.localPlayerGuid });
  rig.tick(16, 16);
  assert.equal(rig.api.piloting, true, "pilot seated initially");

  // Request hot-swap to seat 1 via Digit2, then immediately request exit before server answers seat 1
  rig.win.dispatch("keydown", { code: "Digit2", key: "2", repeat: false });
  rig.win.dispatch("keyup", { code: "Digit2", key: "2" });
  rig.api.exit(0);

  // Server releases seat 0 (state=0)
  rig.push({ type: "seat", vehicle: semiGuid, occupant: rig.localPlayerGuid, seat: 0, state: 0 });
  rig.tick(32, 16);
  assert.equal(rig.api.piloting, false, "server state=0 releases pilot seat after Digit2 -> exit(0)");

  // Same race from passenger seat 1: Digit1 hot-swap -> immediate api.exit(0) -> server state=0 on seat 1
  rig.push({ type: "seat", vehicle: semiGuid, seat: 1, state: 1, occupant: rig.localPlayerGuid });
  rig.tick(48, 16);
  assert.equal(rig.api.riding, true, "passenger seated in seat 1");
  rig.win.dispatch("keydown", { code: "Digit1", key: "1", repeat: false });
  rig.win.dispatch("keyup", { code: "Digit1", key: "1" });
  rig.api.exit(0);
  rig.push({ type: "seat", vehicle: semiGuid, occupant: rig.localPlayerGuid, seat: 1, state: 0 });
  rig.tick(64, 16);
  assert.equal(rig.api.riding, false, "server state=0 releases passenger seat after Digit1 -> exit(0)");

  rig.api.dispose();
});

test("Adversarial (Finding 7): ground_fx.js clamps dt<=0 / NaN, guards non-finite poses, and disposes baseSpriteMat (65/65)", () => {
  let createdMats = 0;
  let disposedMats = 0;
  class TrackedSpriteMaterial extends THREE.SpriteMaterial {
    constructor(params) {
      super(params);
      createdMats++;
      this._trackedDisposed = false;
    }
    dispose() {
      if (!this._trackedDisposed) {
        this._trackedDisposed = true;
        disposedMats++;
      }
      super.dispose();
    }
  }
  const trackedTHREE = { ...THREE, SpriteMaterial: TrackedSpriteMaterial };
  const worldRoot = new THREE.Group();
  const fx = createGroundFx({ root: worldRoot, THREE: trackedTHREE });

  // Prime active particles with valid step
  fx.update({
    x: 10, y: 20, z: 0,
    heading: 0, speed: 12, throttle: 0.8,
    handbrake: true, groundFlags: 0x03, surfaceFamily: 1,
    vehicleClass: 3, profileKey: "semi-379",
  }, 0.1);
  assert.ok(fx.getActiveCount() > 0, "particles spawned before invalid dt");

  // Negative and NaN dt + non-finite pose fields must not corrupt pool slots
  fx.update({
    x: NaN, y: Infinity, z: NaN,
    heading: NaN, speed: NaN, throttle: NaN,
    handbrake: false, groundFlags: 0x01, surfaceFamily: 1,
    vehicleClass: 3, profileKey: "semi-379",
  }, -0.5);
  fx.update({
    x: 10, y: 20, z: 0,
    heading: 0, speed: 12, throttle: 0.8,
    handbrake: false, groundFlags: 0x01, surfaceFamily: 1,
    vehicleClass: 3, profileKey: "semi-379",
  }, NaN);

  for (const slot of fx.pool) {
    assert.ok(slot.t >= 0 && Number.isFinite(slot.t), `slot.t must stay finite >= 0, got ${slot.t}`);
    assert.ok(
      Number.isFinite(slot.sprite.position.x) &&
      Number.isFinite(slot.sprite.position.y) &&
      Number.isFinite(slot.sprite.position.z),
      "sprite position must stay finite"
    );
  }

  fx.dispose();
  assert.equal(createdMats, POOL_SIZE + 1, "created 64 cloned + 1 base SpriteMaterial");
  assert.equal(disposedMats, createdMats, `all ${createdMats} SpriteMaterials disposed (no baseSpriteMat leak)`);
});

test("Tier-5 regression (Gap 2): ground_fx.js post-dispose update(), getActiveCount(), and dispose() are safe no-ops", () => {
  let disposedMats = 0;
  class TrackedMat extends THREE.SpriteMaterial {
    dispose() {
      disposedMats++;
      super.dispose();
    }
  }
  const trackedTHREE = { ...THREE, SpriteMaterial: TrackedMat };
  const root = new THREE.Group();
  const fx = createGroundFx(trackedTHREE, root);

  fx.update(0x80001001, { x: 0, y: 0, z: 0, heading: 0 }, { speed: 10 }, 0.05);
  assert.ok(fx.getActiveCount() > 0, "particles spawned before dispose");

  fx.dispose();
  const matsAfterFirstDispose = disposedMats;
  assert.equal(matsAfterFirstDispose, POOL_SIZE + 1, "first dispose cleaned all SpriteMaterials");

  assert.doesNotThrow(() => {
    fx.update(0x80001001, { x: 0, y: 0, z: 0, heading: 0 }, { speed: 10 }, 0.05);
    fx.update({ x: 1, y: 2, z: 0, heading: 0, speed: 5 }, 0.05);
  }, "post-dispose update() must not throw TypeError");

  assert.equal(fx.getActiveCount(), 0, "post-dispose getActiveCount() returns 0 without throwing");

  assert.doesNotThrow(() => {
    fx.dispose();
  }, "second dispose() is idempotent");
  assert.equal(disposedMats, matsAfterFirstDispose, "second dispose() does not double-dispose materials");
});

// ---------------------------------------------------------------------------

for (const run of tests) await run();
console.log(`\nvehicle_semi_integration: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
