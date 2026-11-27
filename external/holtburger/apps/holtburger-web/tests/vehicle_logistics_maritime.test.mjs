// tests/vehicle_logistics_maritime.test.mjs — F15 Client Maritime & Terminal HBV1 v8 Wiring Suite
// Covers:
//   1. 0x0915 logistics_convoy_state (vehicleClass=4) Macro <-> Micro Dual-LOD lifecycle
//      (Dereth + Dericost 0x8000 cells + cell=0) while preserving offline local ships (MV-DERETH-1)
//   2. VehicleLocomotion.Marine=3 / VehicleClass.ContainerShipFeeder=4 profile + state + event(4) despawn
//      (no airframe/aeroFx misclassification, stand-in hidden, wave-locked buoyancy, clean disposal)
//   3. C2S 0x0915 logisticsConvoyOrder via window.__vehicles.economy.convoyOrder (BigInt convoyId)
//      and shipManager.dispatchConvoyOrder + graceful offline fallback
//   4. DeployableKind 23..29 (4000051..4000057) deployable_state routing in standalone & built-terminal
//      modes (ReeferRackBay powered/stowed, despawn, api.deployables.list() null-safety, 0 lights, FakeWebGL2, spyDisposal)
//   5. Untouched Warehouse Drop Pads C1/C2/C3 bridge alongside server terminal deployables
//      (0 window.__vehicles.containers pollution from yard stacks, ship cargo, or terminal deployables)
//   6. Strict Item 2 exclusion (Port Yaraq, Port Direlands-East, 0x7A63, 0x4866, inner_sea, innerSea)
//      while allowing overland Town Yaraq (townId 7), plus lintSource (0 hits) & zero-timer check

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { initVehicles } from "../scene3d/vehicle/index.js";
import {
  PORT_ORIGIN,
  PORT_WCID,
  PORT_DEPLOYABLE_KIND,
  PORT_VEHICLE_CLASS,
  PORT_LOCOMOTION,
} from "../scene3d/vehicle/port_specs.js";
import { OUTER_OCEAN_PORTS, isExcludedItem2Convoy } from "../scene3d/vehicle/ship_manager.js";
import { ECONOMY_HUD_ID } from "../scene3d/vehicle/economy_hud.js";
import { lintSource } from "../scene3d/vfx/lint_caps.js";
import {
  fakeCanvas,
  installFakeAudio,
  countLights,
  spyDisposal,
  renderWithFakeWebGL2,
  assertNoNaNDeep,
} from "../harness/port_e2e/e2e_helpers.mjs";

installFakeAudio();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

function makeFakeDom() {
  const byId = new Map();
  function makeNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      style: {},
      children: [],
      parentNode: null,
      _textContent: "",
      get textContent() { return this._textContent; },
      set textContent(v) { this._textContent = String(v); },
      appendChild(ch) {
        if (ch.parentNode && ch.parentNode !== this) ch.parentNode.removeChild(ch);
        ch.parentNode = this;
        if (!this.children.includes(ch)) this.children.push(ch);
        if (ch.id) byId.set(ch.id, ch);
        return ch;
      },
      removeChild(ch) {
        const idx = this.children.indexOf(ch);
        if (idx >= 0) this.children.splice(idx, 1);
        ch.parentNode = null;
        if (ch.id) byId.delete(ch.id);
        return ch;
      },
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll() { return []; },
    };
    return node;
  }
  const head = makeNode("head");
  const body = makeNode("body");
  const doc = {
    head,
    body,
    createElement(tag) {
      const n = makeNode(tag);
      const p = new Proxy(n, {
        set(target, prop, val) {
          if (prop === "id") {
            if (target.id) byId.delete(target.id);
            target.id = val;
            if (val) byId.set(val, p);
            return true;
          }
          target[prop] = val;
          return true;
        },
      });
      return p;
    },
    getElementById(id) { return byId.get(id) ?? null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
  };
  return { doc, byId };
}

function collectTexts(node, out = []) {
  if (!node) return out;
  if (typeof node.textContent === "string" && node.textContent) out.push(node.textContent);
  if (Array.isArray(node.children)) {
    for (const ch of node.children) collectTexts(ch, out);
  }
  return out;
}

function makeMaritimeRig({ offline = false, nullRender = true } = {}) {
  const { doc, byId } = makeFakeDom();
  const canvas = fakeCanvas(1280, 720);
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  scene.add(worldRoot);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 4000);
  const entityMap = new Map();
  const inbox = [];
  const calls = {
    convoyOrders: [],
    upserts: [],
    removals: [],
  };
  const frameTime = { tsSec: 0, tsMs: 0 };

  const localPlayerGuid = 0x50000001;
  entityMap.set(localPlayerGuid, {
    root: new THREE.Group(),
    _filmHidden: false,
  });

  const sessionHandle = offline ? null : {
    vehicleCapabilities() {},
    drainVehicleMessages() {
      const out = JSON.stringify(inbox);
      inbox.length = 0;
      return out;
    },
    terrainHeightAt() { return 0; },
    upsertContainerCollider(...args) { calls.upserts.push(args); },
    removeContainerCollider(...args) { calls.removals.push(args); },
    setVehicleSeat() { return true; },
    clearVehicleSeat() {},
    logisticsConvoyOrder(...args) { calls.convoyOrders.push(args); },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    document: doc,
    location: { search: "?vehicles=on" },
    __sessionHandle: sessionHandle,
    __bootState: "in-world",
    getLocalPlayerGuid: () => localPlayerGuid,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };

  const liveScene3d = {
    sessionHandle,
    renderer: { domElement: canvas },
    scene,
    worldRoot,
    camera,
    csmState: null,
    frameTime,
    nullRender,
    entityManager: {
      entityMap,
      localPlayerGuid,
      setMotion() {},
      setFilmHidden(guid, hidden) {
        const ent = entityMap.get(guid >>> 0);
        if (!ent) return false;
        ent._filmHidden = Boolean(hidden);
        return true;
      },
    },
  };

  const api = initVehicles({ liveScene3d, THREE, window: win });
  let simMs = 0;
  const tick = (dtMs = 33.333) => {
    simMs += dtMs;
    frameTime.tsMs = simMs;
    frameTime.tsSec = simMs / 1000;
    liveScene3d.vehicles.afterTick(simMs, dtMs);
  };

  return {
    win,
    doc,
    byId,
    scene,
    worldRoot,
    entityMap,
    inbox,
    calls,
    liveScene3d,
    api,
    tick,
    cleanup() {
      try { api.dispose(); } catch (_) {}
    },
  };
}

check("1. 0x0915 logistics_convoy_state Dual-LOD (Macro <-> Micro) + Dereth/Dericost/cell=0 + local ship preservation", () => {
  const rig = makeMaritimeRig();
  try {
    // Spawn an offline local ship first — must NEVER be disturbed by server Macro/Micro transitions
    const localShip = rig.win.__port.ship.spawnShip("MV-DERETH-1", {
      origin: PORT_ORIGIN,
      spawnAtBerth: "B1",
      moored: true,
      populateCargo: false,
    });
    assert.ok(localShip, "local MV-DERETH-1 spawned");
    assert.equal(rig.win.__port.ship.list().length, 1);

    // 1a. Macro-LOD (lodState=0) for ContainerShipFeeder (vehicleClass=4) -> stores telemetry, does NOT spawn ship
    rig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 4294967301,
      ownerMonarchId: 101,
      vehicleGuid: 0x71000010,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 0,
      status: 1,
      originTownId: 1,
      destTownId: 61,
      originLandblock: 0xEAF90000,
      splineSM: 1200.5,
      fuelLiters: 420.0,
      cell: 0,
      position: [44952, 47960, 0],
      heading: 0.25,
    });
    rig.tick();

    assert.equal(rig.win.__port.ship.list().length, 1, "Macro-LOD does not spawn physical ship");
    assert.equal(rig.win.__port.ship.getConvoyStates().length, 1, "Macro convoy telemetry stored");
    assert.equal(rig.api.economy.convoys().length, 1);

    const hudRoot = rig.byId.get(ECONOMY_HUD_ID);
    assert.ok(hudRoot, "economy HUD mounted");
    const macroTexts = collectTexts(hudRoot).join("\n");
    assert.ok(macroTexts.includes("MACRO") && macroTexts.includes("SHIP"), `HUD shows MACRO SHIP: ${macroTexts}`);

    // 1b. Promote same convoy to Micro-LOD (lodState=1) using Dericost 0x8000 cell (Dericost Landing 0x600D8001)
    rig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 4294967301,
      ownerMonarchId: 101,
      vehicleGuid: 0x71000010,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 1,
      status: 2,
      originTownId: 1,
      destTownId: 61,
      originLandblock: 0xEAF90000,
      splineSM: 4820.25,
      fuelLiters: 395.5,
      cell: 0x600D8001,
      position: [12.0, 24.0, 0.0],
      heading: 1.57,
    });
    rig.tick();

    assert.equal(rig.win.__port.ship.list().length, 2, "Micro-LOD materialized server feeder ship");
    const srvShip = rig.win.__port.ship.list().find((s) => s.serverDriven);
    assert.ok(srvShip, "serverDriven ship entry exists");
    assert.equal(srvShip.convoyId, "4294967301");
    assert.equal(srvShip.vehicleGuid, 0x71000010);
    assert.equal(srvShip.lodState, 1);
    assert.equal(srvShip.originTownId, 1);
    assert.equal(srvShip.destTownId, 61);
    assert.ok(srvShip.y > 68928, `Dericost 0x8000 cell resolved north of 68928 m (got y=${srvShip.y})`);

    // Update at cell===0 global coordinates & verify pose tracks cleanly
    rig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 4294967301,
      ownerMonarchId: 101,
      vehicleGuid: 0x71000010,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 1,
      status: 2,
      originTownId: 1,
      destTownId: 61,
      originLandblock: 0xEAF90000,
      splineSM: 4910.0,
      fuelLiters: 390.0,
      cell: 0,
      position: [44960, 48020, 0],
      heading: 0.75,
    });
    for (let i = 0; i < 20; i++) rig.tick(33.333);
    const updatedSnap = rig.win.__port.ship.list().find((s) => s.serverDriven);
    assert.ok(Math.abs(updatedSnap.x - 44960) < 2.0 && Math.abs(updatedSnap.y - 48020) < 2.0, "ship converged to cell=0 global pose");
    assertNoNaNDeep(updatedSnap, "server-ship-snapshot");

    // 1c. Demote back to Macro-LOD (lodState=0) -> removes server ship, leaves MV-DERETH-1 untouched!
    rig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 4294967301,
      ownerMonarchId: 101,
      vehicleGuid: 0x71000010,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 0,
      status: 1,
      originTownId: 1,
      destTownId: 61,
      originLandblock: 0xEAF90000,
      splineSM: 5100.0,
      fuelLiters: 380.0,
      cell: 0,
      position: [44960, 48020, 0],
      heading: 0.75,
    });
    rig.tick();

    assert.equal(rig.win.__port.ship.list().length, 1, "Macro-LOD removed server ship");
    assert.ok(rig.win.__port.ship.get("MV-DERETH-1"), "local offline ship MV-DERETH-1 preserved");
    assert.equal(rig.api.containers.list().length, 0, "0 containers pollution");
  } finally {
    rig.cleanup();
  }
});

check("2. VehicleLocomotion.Marine=3 / ContainerShipFeeder=4 profile + state + event(4) despawn (no aircraft path)", () => {
  const rig = makeMaritimeRig();
  try {
    const shipGuid = 0x72000050;
    const standIn = { root: new THREE.Group(), _filmHidden: false };
    rig.entityMap.set(shipGuid, standIn);

    // Local offline ship remains untouched
    rig.win.__port.ship.spawnShip("MV-DERETH-1", { origin: PORT_ORIGIN, spawnAtBerth: "B1", moored: true, populateCargo: false });

    rig.inbox.push({
      type: "profile",
      vehicle: shipGuid,
      profileKey: "container-ship-feeder",
      displayName: "M/V Outer Ocean Feeder",
      locomotion: PORT_LOCOMOTION.Marine,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      vMin: 0,
      vCruise: 8.5,
      vMax: 11.5,
      leadSeconds: 6,
    });
    rig.tick();

    const veh = rig.api.vehicles().find((v) => v.guid === shipGuid);
    assert.ok(veh, "marine vehicle tracked in vehicles map");
    assert.equal(veh.locomotion, PORT_LOCOMOTION.Marine, "locomotion === 3 (Marine), never 1 (Air)");
    assert.equal(standIn._filmHidden, true, "stand-in entity hidden for marine vessel");
    assert.equal(rig.api.status().airframes.live, 0, "airframe pipeline created 0 instances");
    assert.equal(rig.api.status().airframes.templates.length, 0, "airframe pipeline created 0 templates");

    // Push server state updates in Dereth outer sea
    rig.inbox.push({
      type: "state",
      vehicle: shipGuid,
      step: 10,
      ack: 0,
      cell: 0xEAF90001,
      x: 40.0,
      y: 80.0,
      z: 0.0,
      heading: 1.5708,
      pitch: 0.0,
      bank: 0.0,
      speed: 7.5,
      vCap: 11.5,
      mode: 6,
      flags: 0,
    });
    for (let i = 0; i < 15; i++) rig.tick(33.333);

    const srvShip = rig.win.__port.ship.list().find((s) => s.vehicleGuid === shipGuid);
    assert.ok(srvShip && srvShip.serverDriven, "server marine vehicle synced to shipManager");
    assert.ok(Math.abs(srvShip.speed - 7.5) < 0.01, "speed synced from state message");
    assert.ok(Number.isFinite(srvShip.z) && Number.isFinite(srvShip.pitch) && Number.isFinite(srvShip.roll), "buoyancy finite");

    // Event kind=4 despawn cleans server ship & restores standIn visibility while leaving MV-DERETH-1 intact
    rig.inbox.push({ type: "event", kind: 4, vehicle: shipGuid, subject: 0 });
    rig.tick();

    assert.equal(rig.win.__port.ship.list().filter((s) => s.serverDriven).length, 0, "server ship removed on despawn");
    assert.ok(rig.win.__port.ship.get("MV-DERETH-1"), "local ship preserved on server despawn");
    assert.equal(standIn._filmHidden, false, "stand-in visibility restored on despawn");
  } finally {
    rig.cleanup();
  }
});

check("3. C2S 0x0915 logisticsConvoyOrder (BigInt convoyId) via economy.convoyOrder & shipManager.dispatchConvoyOrder + offline fallback", () => {
  const rig = makeMaritimeRig();
  try {
    const res1 = rig.api.economy.convoyOrder({
      convoyId: 4294967399,
      action: 1,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      flags: 0,
      originTownId: 1,
      destTownId: 61,
      containerKind: 30,
      commodityId: 4000060,
    });
    assert.equal(res1, true);
    assert.equal(rig.calls.convoyOrders.length, 1);
    assert.equal(typeof rig.calls.convoyOrders[0][0], "bigint");
    assert.equal(rig.calls.convoyOrders[0][0], 4294967399n);
    assert.equal(rig.calls.convoyOrders[0][2], PORT_VEHICLE_CLASS.ContainerShipFeeder);

    const res2 = rig.win.__port.ship.dispatchConvoyOrder({
      convoyId: "7000000055",
      action: 1,
      originTownId: 1,
      destTownId: 2,
      containerKind: 31,
      commodityId: 4000061,
    });
    assert.equal(res2.ok, true);
    assert.equal(rig.calls.convoyOrders.length, 2);
    assert.equal(rig.calls.convoyOrders[1][0], 7000000055n);
    assert.equal(rig.calls.convoyOrders[1][2], PORT_VEHICLE_CLASS.ContainerShipFeeder);

    // Reject Item 2 targets in dispatchConvoyOrder
    const badRes = rig.win.__port.ship.dispatchConvoyOrder({
      convoyId: 99,
      originLandblock: 0x7A630000,
      originTownId: 7,
      destTownId: 10,
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.reason, "excluded_item2");
    assert.equal(rig.calls.convoyOrders.length, 2, "excluded order did not hit wire");
  } finally {
    rig.cleanup();
  }

  // Offline graceful fallback
  const offRig = makeMaritimeRig({ offline: true });
  try {
    const offRes = offRig.win.__port.ship.dispatchConvoyOrder({ convoyId: 12, originTownId: 1, destTownId: 2 });
    assert.equal(offRes.ok, false);
    assert.equal(offRes.reason, "offline");
    assert.equal(offRig.api.economy.convoyOrder({ convoyId: 12 }), false);
  } finally {
    offRig.cleanup();
  }
});

check("4. DeployableKind 23..29 (4000051..4000057) standalone & built-terminal routing + FakeWebGL2 + spyDisposal", () => {
  // 4a. Standalone mode (unbuilt terminal) with all 7 kinds 23..29
  const rig = makeMaritimeRig();
  let renderRes = null;
  try {
    const baseGuid = 0x73000001;
    const kinds = [
      PORT_DEPLOYABLE_KIND.StsGantryCrane,         // 23 -> 4000051
      PORT_DEPLOYABLE_KIND.RmgYardCrane,           // 24 -> 4000052
      PORT_DEPLOYABLE_KIND.RtgYardCrane,           // 25 -> 4000053
      PORT_DEPLOYABLE_KIND.TerminalTractorShuttle, // 26 -> 4000054
      PORT_DEPLOYABLE_KIND.ReeferRackBay,          // 27 -> 4000055
      PORT_DEPLOYABLE_KIND.QuayBollard,            // 28 -> 4000056
      PORT_DEPLOYABLE_KIND.MarineFender,           // 29 -> 4000057
    ];

    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      const guid = baseGuid + i;
      rig.entityMap.set(guid, { root: new THREE.Group(), _filmHidden: false });
      rig.inbox.push({
        type: "deployable_state",
        deployable: guid,
        kind: k,
        onlineFlags: k === PORT_DEPLOYABLE_KIND.ReeferRackBay ? 0x05 : 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] + i * 24,
        y: PORT_ORIGIN[1] - 20,
        z: 2.0,
        heading: 0.0,
        powerWatts: k === PORT_DEPLOYABLE_KIND.ReeferRackBay ? -15000 : -120000,
        energyJoules: 0,
        energyCapacity: 0,
        fuelSec: 0,
      });
    }
    rig.tick();

    const term = rig.win.__port.terminal;
    assert.equal(term.stats.serverDeployableCount, 7, "all 7 DeployableKind 23..29 tracked");
    assert.equal(term.stats.reeferRacksPowered, 1, "ReeferRackBay powered counted");
    assert.equal(rig.api.containers.list().length, 0, "0 __vehicles.containers pollution");
    assert.doesNotThrow(() => rig.api.deployables.list(), "api.deployables.list() safe");

    for (let i = 0; i < kinds.length; i++) {
      assert.equal(rig.entityMap.get(baseGuid + i)._filmHidden, true, `stand-in hidden for kind ${kinds[i]}`);
    }

    // Stow ReeferRackBay (0x10) -> powered flips false
    rig.inbox.push({
      type: "deployable_state",
      deployable: baseGuid + 4,
      kind: PORT_DEPLOYABLE_KIND.ReeferRackBay,
      onlineFlags: 0x11,
      cell: 0,
      x: PORT_ORIGIN[0] + 96,
      y: PORT_ORIGIN[1] - 20,
      z: 2.0,
      heading: 0.0,
    });
    rig.tick();
    assert.equal(term.stats.reeferRacksPowered, 0, "stowed ReeferRackBay is no longer powered");

    // Render standalone Kind 23..29 in FakeWebGL2: 0 dynamic lights, 0 errors
    assert.equal(countLights(rig.worldRoot), 0, "0 dynamic THREE.Light instances");
    renderRes = renderWithFakeWebGL2(THREE, rig.scene, {
      cameraPos: [PORT_ORIGIN[0] + 40, PORT_ORIGIN[1] - 80, 55],
      lookAt: [PORT_ORIGIN[0] + 60, PORT_ORIGIN[1] - 20, 4],
    });
    assert.equal(renderRes.capturedErrors.length, 0, `FakeWebGL2 errors: ${renderRes.capturedErrors.join("; ")}`);
    assert.ok(renderRes.emittedDraws > 0, "FakeWebGL2 emitted draws for Kind 23..29");

    // Despawn one server deployable via event kind=4 and verify rest clean up on dispose with spyDisposal
    const rootSpy = spyDisposal(term.getRoot());
    rig.inbox.push({ type: "event", kind: 4, vehicle: baseGuid + 6, subject: 0 });
    rig.tick();
    assert.equal(term.stats.serverDeployableCount, 6);
    assert.equal(rig.entityMap.get(baseGuid + 6)._filmHidden, false, "despawned stand-in restored");

    rig.cleanup();
    rootSpy.assertAllDisposed("PortServerDeployablesStandalone");
    assert.equal(term.stats.serverDeployableCount, 0);
  } finally {
    try { renderRes?.dispose?.(); } catch (_) {}
    rig.cleanup();
  }

  // 4b. Built-terminal mode binds without spawning duplicate crane/shuttle meshes
  const builtRig = makeMaritimeRig();
  try {
    const port = builtRig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: false });
    const term = port.terminal;
    const beforeRootChildren = term.getRoot().children.length;

    builtRig.inbox.push(
      {
        type: "deployable_state",
        deployable: 0x74000001,
        kind: PORT_DEPLOYABLE_KIND.StsGantryCrane,
        onlineFlags: 0x11, // stowed
        cell: 0,
        x: PORT_ORIGIN[0] - 80,
        y: PORT_ORIGIN[1] - 14,
        z: 2.0,
        heading: 0,
      },
      {
        type: "deployable_state",
        deployable: 0x74000002,
        kind: PORT_DEPLOYABLE_KIND.RmgYardCrane,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] - 60,
        y: PORT_ORIGIN[1] - 99,
        z: 0,
        heading: 0,
      },
      {
        type: "deployable_state",
        deployable: 0x74000003,
        kind: PORT_DEPLOYABLE_KIND.ReeferRackBay,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] + 120,
        y: PORT_ORIGIN[1] - 160,
        z: 0,
        heading: 0,
      }
    );
    builtRig.tick();

    assert.equal(term.getRoot().children.length, beforeRootChildren, "bound terminal deployables do not spawn duplicate meshes");
    assert.equal(term.stats.serverDeployableCount, 3);
    assert.equal(term.stats.reeferRacksPowered, 1);
    assert.equal(term.sts.get("STS-1").state.boomStowed, true, "STS-1 bound and stowed from server flags");

    // Trigger disconnect teardown -> clears server deployables & convoys cleanly
    builtRig.win.__lastDisconnect = { ts: 12345 };
    builtRig.tick();
    assert.equal(term.stats.serverDeployableCount, 0, "teardownSession cleared serverDeployables");
  } finally {
    builtRig.cleanup();
  }
});

check("5. Untouched Warehouse Drop Pads C1/C2/C3 bridge works alongside server terminal deployables with 0 pollution", () => {
  const rig = makeMaritimeRig();
  try {
    const port = rig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: false });
    assert.equal(rig.api.containers.list().length, 0);

    // Sync server terminal deployables + Micro-LOD ship
    rig.inbox.push(
      {
        type: "deployable_state",
        deployable: 0x75000001,
        kind: PORT_DEPLOYABLE_KIND.ReeferRackBay,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] + 110,
        y: PORT_ORIGIN[1] - 160,
        z: 0,
      },
      {
        type: "logistics_convoy_state",
        convoyId: 8801,
        ownerMonarchId: 10,
        vehicleGuid: 0x75000099,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
        lodState: 1,
        status: 1,
        originTownId: 1,
        destTownId: 61,
        originLandblock: 0xEAF90000,
        splineSM: 50,
        fuelLiters: 500,
        cell: 0,
        position: [PORT_ORIGIN[0] + 60, PORT_ORIGIN[1] + 55, 0],
        heading: Math.PI * 0.5,
      }
    );
    rig.tick();

    assert.equal(rig.api.containers.list().length, 0, "server ship & terminal deployables never pollute __vehicles.containers");

    // Deliver onto Pad C1 -> ONLY Pad C1 container enters __vehicles.containers
    const promoted = port.terminal.deliverToWarehousePad("C1", { wcid: 4000021, doorProgress: 1.0 });
    assert.equal(rig.api.containers.list().length, 1);
    assert.equal(rig.api.containers.get(promoted.guid).wcid, 4000021);

    const picked = port.terminal.pickupFromWarehousePad("C1");
    assert.ok(picked);
    assert.equal(rig.api.containers.list().length, 0, "pickupFromWarehousePad demoted cleanly");
  } finally {
    rig.cleanup();
  }
});

check("6. Strict Item 2 exclusion, 11 Outer Ocean ports, lintSource (0 hits) & zero-timer check", () => {
  assert.equal(OUTER_OCEAN_PORTS.length, 11, "11 canonical Outer Ocean ports");

  // Guard rejects Item 2 variants (landblock 16-bit/32-bit, strings, basin)
  assert.equal(isExcludedItem2Convoy({ originLandblock: 0x7A63 }), true);
  assert.equal(isExcludedItem2Convoy({ originLandblock: 0x7A630000 }), true);
  assert.equal(isExcludedItem2Convoy({ cell: 0x48660001 }), true);
  assert.equal(isExcludedItem2Convoy({ destLandblock: "0x4866" }), true);
  assert.equal(isExcludedItem2Convoy({ portName: "Port Yaraq" }), true);
  assert.equal(isExcludedItem2Convoy({ destName: "Port Direlands-East" }), true);
  assert.equal(isExcludedItem2Convoy({ basin: "inner_sea" }), true);
  assert.equal(isExcludedItem2Convoy({ lane: "innerSea" }), true);

  // Overland Town Yaraq (townId 7 / landblock 0x7D640001) MUST be allowed
  assert.equal(isExcludedItem2Convoy({ originTownId: 7, originName: "Yaraq", originLandblock: 0x7D640001, basin: "overland" }), false);
  assert.equal(isExcludedItem2Convoy({ originLandblock: 0xEAF90000, portName: "NE Marine Terminal", basin: "outer_ocean" }), false);

  // Verify handleMsg ignores Item 2 logistics_convoy_state
  const rig = makeMaritimeRig();
  try {
    rig.inbox.push(
      {
        type: "logistics_convoy_state",
        convoyId: 9001,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
        lodState: 1,
        status: 1,
        originTownId: 7,
        destTownId: 13,
        originLandblock: 0x7A630000,
        cell: 0x7A630001,
        position: [10, 10, 0],
        heading: 0,
      },
      {
        type: "logistics_convoy_state",
        convoyId: 9002,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
        lodState: 1,
        status: 1,
        originTownId: 7,
        destTownId: 13,
        portName: "Port Direlands-East",
        basin: "inner_sea",
        cell: 0,
        position: [10, 10, 0],
        heading: 0,
      }
    );
    rig.tick();
    assert.equal(rig.api.economy.convoys().length, 0, "Item 2 convoys rejected in handleMsg");
    assert.equal(rig.win.__port.ship.list().length, 0, "Item 2 ships never spawned");
    assert.equal(rig.win.__port.ship.getConvoyStates().length, 0);
  } finally {
    rig.cleanup();
  }

  // Static check: zero Item 2 tokens in client vehicle files
  const forbiddenRes = [
    /port[\s_-]*yaraq/i,
    /port[\s_-]*direlands[\s_-]*east/i,
    /inner[\s_-]*sea/i,
    /0x7a63/i,
    /0x4866/i,
  ];
  for (const rel of [
    "scene3d/vehicle/ship_manager.js",
    "scene3d/vehicle/port_terminal_manager.js",
    "scene3d/vehicle/port_specs.js",
    "scene3d/vehicle/index.js",
    "scene3d/vehicle/economy_hud.js",
  ]) {
    const src = readFileSync(path.join(APP_ROOT, rel), "utf8");
    for (const re of forbiddenRes) {
      assert.equal(re.test(src), false, `${rel} must not contain Item 2 token ${re}`);
    }
  }

  // lintSource + zero-timer check on ship_manager.js & port_terminal_manager.js
  for (const rel of ["scene3d/vehicle/ship_manager.js", "scene3d/vehicle/port_terminal_manager.js"]) {
    const src = readFileSync(path.join(APP_ROOT, rel), "utf8");
    const hits = lintSource(src);
    assert.equal(hits.length, 0, `${rel} lintSource hits: ${JSON.stringify(hits)}`);
    assert.equal(/\bsetTimeout\s*\(/.test(src), false, `${rel} must not use setTimeout`);
    assert.equal(/\bsetInterval\s*\(/.test(src), false, `${rel} must not use setInterval`);
  }
});

check("7. Challenger & Reviewer regressions: unbuilt->built deployables, demoted ship stale packets, Item 2 bypasses, null-safety & HUD/boarding polish", () => {
  // 7a. Unbuilt onDeployableState(23..26) at Site A -> buildPortAndWarehouse leaves terminalRoot children identical to clean build (0 orphans)
  const cleanRig = makeMaritimeRig();
  const preRig = makeMaritimeRig();
  try {
    cleanRig.win.__port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: false, populateDemoCargo: false });
    const cleanRootCount = cleanRig.win.__port.terminal.getRoot().children.length;

    preRig.inbox.push(
      {
        type: "deployable_state",
        deployable: 0x76000001,
        kind: PORT_DEPLOYABLE_KIND.StsGantryCrane,
        onlineFlags: 0x11,
        cell: 0,
        x: PORT_ORIGIN[0] - 80,
        y: PORT_ORIGIN[1] - 14,
        z: 2.0,
        heading: 0,
      },
      {
        type: "deployable_state",
        deployable: 0x76000002,
        kind: PORT_DEPLOYABLE_KIND.RmgYardCrane,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] - 60,
        y: PORT_ORIGIN[1] - 99,
        z: 0,
        heading: 0,
      },
      {
        type: "deployable_state",
        deployable: 0x76000003,
        kind: PORT_DEPLOYABLE_KIND.RtgYardCrane,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] - 20,
        y: PORT_ORIGIN[1] - 145,
        z: 0,
        heading: 0,
      },
      {
        type: "deployable_state",
        deployable: 0x76000004,
        kind: PORT_DEPLOYABLE_KIND.TerminalTractorShuttle,
        onlineFlags: 0x01,
        cell: 0,
        x: PORT_ORIGIN[0] - 50,
        y: PORT_ORIGIN[1] - 42,
        z: 2.0,
        heading: Math.PI * 0.5,
      }
    );
    preRig.tick();
    assert.equal(preRig.win.__port.terminal.getRoot().children.length, 4, "4 standalone meshes created before buildTerminal");

    preRig.win.__port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: false, populateDemoCargo: false });
    const term = preRig.win.__port.terminal;
    assert.equal(term.getRoot().children.length, cleanRootCount, "buildTerminal disposes standalone meshes and leaves 0 orphan duplicates");
    assert.equal(term.stats.serverDeployableCount, 4, "serverDeployables state preserved across buildTerminal");
    assert.equal(term.sts.get("STS-1").state.boomStowed, true, "STS-1 re-bound with stowed state after buildTerminal");
  } finally {
    cleanRig.cleanup();
    preRig.cleanup();
  }

  // 7b. Macro-LOD demotion (lod=1 -> lod=0) blocks stale state & profile resurrection until fresh lod=1 arrives
  const demoteRig = makeMaritimeRig();
  try {
    const shipGuid = 0x71005002;
    demoteRig.inbox.push(
      {
        type: "profile",
        vehicle: shipGuid,
        profileKey: "container-ship-feeder",
        locomotion: PORT_LOCOMOTION.Marine,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      },
      {
        type: "state",
        vehicle: shipGuid,
        step: 1,
        ack: 0,
        cell: 0,
        x: PORT_ORIGIN[0],
        y: PORT_ORIGIN[1] + 50,
        z: 0,
        heading: 0,
        pitch: 0,
        bank: 0,
        speed: 4,
        mode: 0,
        flags: 0,
      },
      {
        type: "logistics_convoy_state",
        convoyId: 5002,
        ownerMonarchId: 101,
        vehicleGuid: shipGuid,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
        lodState: 1,
        status: 1,
        originTownId: 1,
        destTownId: 2,
        originLandblock: 0xEAF90000,
        cell: 0,
        position: [PORT_ORIGIN[0], PORT_ORIGIN[1] + 50, 0],
        heading: 0,
      }
    );
    demoteRig.tick();
    assert.equal(demoteRig.win.__port.ship.stats.serverShipCount, 1, "ship materialized at lod=1");

    // Verify Reviewer minor #1: Marine=3 ship in MODE.PARKED at player position never triggers [B] Board
    const localPlayer = demoteRig.entityMap.get(demoteRig.win.getLocalPlayerGuid());
    localPlayer.root.position.set(PORT_ORIGIN[0], PORT_ORIGIN[1] + 50, 0);
    assert.equal(demoteRig.api.nearest(), null, "Marine=3 ship excluded from nearestBoardable()");

    // Demote to Macro-LOD
    demoteRig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 5002,
      ownerMonarchId: 101,
      vehicleGuid: shipGuid,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 0,
      status: 1,
      originTownId: 1,
      destTownId: 2,
      originLandblock: 0xEAF90000,
      cell: 0,
      position: [PORT_ORIGIN[0], PORT_ORIGIN[1] + 50, 0],
      heading: 0,
    });
    demoteRig.tick();
    assert.equal(demoteRig.win.__port.ship.stats.serverShipCount, 0, "ship removed on lod=0");

    // Delayed state and profile packets must NOT resurrect demoted ship
    demoteRig.inbox.push(
      {
        type: "state",
        vehicle: shipGuid,
        step: 2,
        ack: 0,
        cell: 0,
        x: PORT_ORIGIN[0] + 10,
        y: PORT_ORIGIN[1] + 50,
        z: 0,
        heading: 0,
        pitch: 0,
        bank: 0,
        speed: 4,
        mode: 6,
        flags: 0,
      },
      {
        type: "profile",
        vehicle: shipGuid,
        profileKey: "container-ship-feeder",
        locomotion: PORT_LOCOMOTION.Marine,
        vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      }
    );
    demoteRig.tick();
    assert.equal(demoteRig.win.__port.ship.stats.serverShipCount, 0, "stale state/profile must not resurrect Macro-demoted ship");

    // Fresh lodState=1 re-materializes cleanly
    demoteRig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 5002,
      ownerMonarchId: 101,
      vehicleGuid: shipGuid,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 1,
      status: 1,
      originTownId: 1,
      destTownId: 2,
      originLandblock: 0xEAF90000,
      cell: 0,
      position: [PORT_ORIGIN[0] + 20, PORT_ORIGIN[1] + 50, 0],
      heading: 0,
    });
    demoteRig.tick();
    assert.equal(demoteRig.win.__port.ship.stats.serverShipCount, 1, "fresh lod=1 re-materializes ship cleanly");
  } finally {
    demoteRig.cleanup();
  }

  // 7c. Item 2 exclusion in api.economy.convoyOrder + unprefixed 8-char hex & BigInt + null-safety + HUD whitespace + late standIn
  const guardRig = makeMaritimeRig();
  try {
    assert.equal(isExcludedItem2Convoy({ originLandblock: "00007a63" }), true, "catches unprefixed 8-char hex low-16");
    assert.equal(isExcludedItem2Convoy({ originLandblock: "7a630000" }), true, "catches unprefixed 8-char hex high-16");
    assert.equal(isExcludedItem2Convoy({ originLandblock: 0x7A630000n }), true, "catches BigInt shifted landblock");
    assert.equal(isExcludedItem2Convoy({ originLandblock: 31331n }), true, "catches BigInt 16-bit landblock");
    assert.equal(isExcludedItem2Convoy({ destLandblock: 18534n }), true, "catches BigInt 16-bit dest landblock");
    assert.equal(isExcludedItem2Convoy({ originTownId: 7, originName: "Yaraq", originLandblock: 0x7D640001, basin: "overland" }), false, "overland Town Yaraq remains allowed");

    const blockedDirect = guardRig.api.economy.convoyOrder({
      convoyId: 999,
      action: 1,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      originTownId: 7,
      destTownId: 13,
      originLandblock: 0x7A630000,
      destLandblock: 0x48660000,
      portName: "Port Yaraq",
      basin: "inner_sea",
    });
    assert.equal(blockedDirect, false, "api.economy.convoyOrder blocks Item 2 directly");
    assert.equal(guardRig.calls.convoyOrders.length, 0, "0 C2S calls on Item 2 convoyOrder");

    // api.economy.*(null) returns false without throwing
    for (const mName of ["siegeAction", "prospect", "facilityAction", "convoyOrder", "monarchOrder"]) {
      assert.equal(guardRig.api.economy[mName](null), false, `api.economy.${mName}(null) returns false`);
      assert.equal(guardRig.api.economy[mName](undefined), false, `api.economy.${mName}(undefined) returns false`);
    }

    // economy_hud ignores whitespace fuelLiters: "   "
    guardRig.inbox.push({
      type: "logistics_convoy_state",
      convoyId: 777,
      ownerMonarchId: 101,
      vehicleGuid: 0x71000777,
      vehicleClass: PORT_VEHICLE_CLASS.ContainerShipFeeder,
      lodState: 0,
      status: 1,
      originTownId: 1,
      destTownId: 2,
      originLandblock: 0xEAF90000,
      fuelLiters: "   ",
      cell: 0,
      position: [PORT_ORIGIN[0], PORT_ORIGIN[1], 0],
      heading: 0,
    });
    guardRig.tick();
    const hudText = collectTexts(guardRig.byId.get(ECONOMY_HUD_ID)).join("\n");
    assert.equal(hudText.includes("0L"), false, `whitespace fuelLiters omitted from HUD: ${hudText}`);

    // Reviewer minor #2: late-arriving retail stand-in in entityMap after Kind 23..29 deployable_state gets hidden on next tick
    const lateGuid = 0x77000023;
    guardRig.inbox.push({
      type: "deployable_state",
      deployable: lateGuid,
      kind: PORT_DEPLOYABLE_KIND.QuayBollard,
      onlineFlags: 0x01,
      cell: 0,
      x: PORT_ORIGIN[0] + 15,
      y: PORT_ORIGIN[1] - 10,
      z: 2.0,
      heading: 0,
    });
    guardRig.tick();
    const lateStandIn = { root: new THREE.Group(), _filmHidden: false };
    guardRig.entityMap.set(lateGuid, lateStandIn);
    guardRig.tick();
    assert.equal(lateStandIn._filmHidden, true, "late-arriving stand-in hidden cleanly on next tick");
  } finally {
    guardRig.cleanup();
  }
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const item of queue) {
    try {
      await item.fn();
      passed++;
      console.log(`  [PASS] ${item.name}`);
    } catch (err) {
      failed++;
      console.error(`  [FAIL] ${item.name}\n         ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\nvehicle_logistics_maritime: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
