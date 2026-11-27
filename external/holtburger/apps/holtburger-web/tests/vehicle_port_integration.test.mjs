// tests/vehicle_port_integration.test.mjs — Marine Container Terminal + Container Ship + Untouched Warehouse Integration Suite (B4)
// Covers:
//   1. Additive window.__vehicles.{terminal,ship} & window.__port facade lifecycle (`buildPortAndWarehouse`, `runFullDemo`, `dispose`)
//   2. Autonomous ship offshore -> Berth 1 (B1) berthing + simultaneous dual-berth B1/B2 ops + STS-1/STS-2 anti-collision (>= 26 m)
//   3. Full STS-1 ship discharge -> TT-1 ramp pitch/Z -> RMG-1 ISO 9711 yard stack -> Warehouse Zone A Drop Pad C1 promotion
//      -> untouched warehouseManager AGF `pickFromContainer` + `placeInRack`
//   4. Reverse outbound warehouse AGF `loadIntoContainer` -> `pickupFromWarehousePad` demotion (`0` containers pollution)
//      -> shuttle up ramp -> STS-1 apron-to-ship load -> ship unmoor & departure
//   5. Human helm override (`board`/`exit`, `setHelmInput`, keyboard `W/A/Q/E/Tab/P/X`, proximity gangway `[B]`, `#hb-ship-osd`, `port_audio`)
//   6. Zero `window.__vehicles.containers` pollution across 150+ yard & ship stacks
//   7. Combined Terminal + Ship + Automated Warehouse real `three` + FakeWebGL2 render (0 lights, 0 errors) & 100% disposal spy audit
//   8. Static `lintSource` hygiene on `port_terminal_manager.js` & `ship_manager.js`

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { initVehicles } from "../scene3d/vehicle/index.js";
import {
  PORT_ORIGIN,
  WAREHOUSE_PORT_ORIGIN,
  WAREHOUSE_DROP_PADS,
  STS_CRANE_SPECS,
  SHIP_SPECS,
  quayRampZ,
  quayRampPitch,
} from "../scene3d/vehicle/port_specs.js";
import { CAPTAIN_STATE, SHIP_MODE } from "../scene3d/vehicle/ship_kinematics.js";
import { SHIP_OSD_ID } from "../scene3d/vehicle/ship_osd.js";
import { lintSource } from "../scene3d/vfx/lint_caps.js";
import {
  makePortTestRig,
  makeAudioBus,
  FullMockCtx,
  countLights,
  spyDisposal,
  renderWithFakeWebGL2,
  driveVehiclesPromise,
  assertNoNaNDeep,
} from "../harness/port_e2e/e2e_helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}

check("1. window.__vehicles.{terminal,ship} & window.__port facade + buildPortAndWarehouse + 0 containers pollution", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    assert.ok(rig.win.__vehicles.terminal, "__vehicles.terminal exposed");
    assert.ok(rig.win.__vehicles.ship, "__vehicles.ship exposed");
    assert.ok(rig.win.__vehicles.warehouse, "__vehicles.warehouse exposed");
    assert.ok(rig.win.__port, "window.__port unified facade exposed");

    const built = rig.win.__port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: true });
    assert.deepEqual([...built.warehouseOrigin], [...WAREHOUSE_PORT_ORIGIN]);

    const tStats = rig.win.__port.terminal.stats;
    assert.equal(tStats.built, true);
    assert.ok(tStats.yardContainerCount >= 100, `expected >= 100 yard containers, got ${tStats.yardContainerCount}`);
    assert.equal(tStats.yardPoolCount, tStats.yardContainerCount, "instanced yard pool matches yard store count");
    assert.equal(tStats.stsCount, 2);
    assert.equal(tStats.yardCraneCount, 3);
    assert.equal(tStats.shuttleCount, 3);

    const sStats = rig.win.__port.ship.stats;
    assert.equal(sStats.shipCount, 1);
    assert.equal(sStats.mooredCount, 1);
    assert.ok(sStats.totalContainers >= 20, `expected >= 20 ship containers, got ${sStats.totalContainers}`);

    // CRITICAL INVARIANT: 100+ yard stacks & 20+ ship stacks MUST NOT pollute window.__vehicles.containers!
    assert.equal(rig.api.containers.list().length, 0, "yard & ship stacks must not pollute __vehicles.containers");
    assert.equal(rig.win.__port.warehouse.stats.built, true, "untouched warehouse built adjacent south");
    assert.deepEqual([...rig.win.__port.warehouse.getState().origin], [...WAREHOUSE_PORT_ORIGIN]);

    for (let i = 0; i < 30; i++) rig.tick(33.333);
    assertNoNaNDeep(rig.win.__port.getState(), "port-full-state");
  } finally {
    rig.cleanup();
  }
  assert.equal(rig.win.__port, undefined, "window.__port cleaned up on dispose");
});

check("2. Full Inbound Maritime-to-Warehouse Handoff (STS-1 -> TT-1 Ramp -> RMG-1 Yard -> Pad C1 -> Untouched Warehouse AGF)", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    const port = rig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: false });

    const ship = port.ship.get("MV-DERETH-1");
    assert.ok(ship, "default ship spawned moored at B1");
    const initShipCargo = ship.cargo.count();
    const initYardCount = port.terminal.yard.count();

    // Position TT-1 at quay portal B1 & discharge top container via STS-1
    const tt1 = port.terminal.shuttles.get("TT-1");
    const sts1 = port.terminal.sts.get("STS-1");
    const rmg1 = port.terminal.yardCranes.get("RMG-1");

    await driveVehiclesPromise(rig, tt1.driveToNode("quay_lane_b1", { finalHeading: Math.PI * 0.5 }), { maxSteps: 2400 });
    const disRes = await driveVehiclesPromise(rig, sts1.transferShipToApron({ shipId: "MV-DERETH-1", shuttleId: "TT-1" }), { maxSteps: 3600 });
    assert.equal(ship.cargo.count(), initShipCargo - 1, "STS-1 unloaded 1 container from ship");
    assert.ok(tt1.state.cargo, "TT-1 received discharged container on chassis");

    // Drive TT-1 down the 4.76 deg quay approach ramp (Y in [47810, 47834]) to Block A1 TTL, observing smooth pitch & Z!
    let sawRampPitch = false;
    let sawMidRampZ = false;
    await driveVehiclesPromise(rig, tt1.driveToNode("ttl_A1_mid", { finalHeading: Math.PI * 0.5 }), {
      maxSteps: 3600,
      onStep() {
        const st = tt1.state;
        if (st.y > 47811 && st.y < 47833) {
          if (Math.abs(st.pitch) > 0.03) sawRampPitch = true;
          if (st.z > 0.25 && st.z < 1.75) sawMidRampZ = true;
          const expectedZ = quayRampZ(st.y, PORT_ORIGIN);
          assert.ok(Math.abs(st.z - expectedZ) < 1e-4, `shuttle ramp Z mismatch: ${st.z} vs ${expectedZ}`);
        }
      },
    });
    assert.equal(sawRampPitch, true, "TT-1 pitched smoothly along quay ramp");
    assert.equal(sawMidRampZ, true, "TT-1 interpolated Z smoothly from +2.0 m to 0.0 m down ramp");

    // RMG-1 transfers discharged box off TT-1 into ISO 9711 yard stack A1
    await driveVehiclesPromise(rig, rmg1.transferTtlToYard({ blockId: "A1", shuttleId: "TT-1" }), { maxSteps: 3600 });
    assert.equal(tt1.state.cargo, null, "TT-1 unloaded at A1 TTL");
    assert.equal(port.terminal.yard.count(), initYardCount + 1, "RMG-1 stacked discharged container in yard A1");
    assert.equal(rig.api.containers.list().length, 0, "still 0 containers in __vehicles.containers before pad promotion");

    // Promote container onto Warehouse Zone A Drop Pad C1 (doors open, ISO 6780 2-wide pallets)
    const promoted = port.terminal.deliverToWarehousePad("C1", {
      ...disRes.value.container,
      wcid: 4000021,
      doorProgress: 1.0,
      slots: [
        { slotIndex: 18, palletSize: "full", cargoWcid: 4000014 },
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000011 },
      ],
    });
    assert.equal(rig.api.containers.list().length, 1, "ONLY the promoted Drop Pad C1 container enters __vehicles.containers");
    assert.deepEqual(promoted.pos, [...WAREHOUSE_DROP_PADS.C1.pos]);

    // Untouched automated warehouse AGF unloads pallet slot 18 from promoted Drop Pad C1 container & racks it!
    const wh = port.warehouse;
    const [wox, woy] = WAREHOUSE_PORT_ORIGIN;
    const agf = wh.spawnAgf("agf-port-bridge", { pos: [wox - 40, woy + 20, 0], heading: 0 });
    await driveVehiclesPromise(rig, agf.enqueue({ type: "pickFromContainer", containerGuid: promoted.guid, slotIndex: 18 }), { maxSteps: 4800 });
    assert.equal(agf.carriedWcid ?? wh.getState().agfs["agf-port-bridge"].carriedWcid, 4000014, "untouched AGF picked pallet 4000014 from promoted C1 container");
    assert.equal(rig.api.containers.get(promoted.guid).slots.some((s) => s.slotIndex === 18), false, "slot 18 removed from C1 container");

    const rackId = [...wh.racks.keys()][0];
    await driveVehiclesPromise(rig, agf.enqueue({ type: "placeInRack", rackId, bay: 0, tier: 1, side: 0, slotInBay: 0 }), { maxSteps: 4800 });
    assert.equal(wh.racks.get(rackId).loadedSlots.size, 1, "untouched warehouse AGF racked maritime pallet");
  } finally {
    rig.cleanup();
  }
});

check("3. Reverse Outbound Warehouse-to-Ship Handoff (AGF Load -> Pad Demote -> Shuttle Up Ramp -> STS-1 Load -> Ship Depart)", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    const port = rig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: false, populateDemoCargo: false });
    const ship = port.ship.get("MV-DERETH-1");
    const wh = port.warehouse;
    const [wox, woy] = WAREHOUSE_PORT_ORIGIN;

    // Stage an empty 40ft container on Drop Pad C1 with open doors
    const promoted = port.terminal.deliverToWarehousePad("C1", {
      wcid: 4000021,
      liveryId: 2,
      doorProgress: 1.0,
      slots: [],
    });
    assert.equal(rig.api.containers.list().length, 1);

    // Untouched warehouse AGF picks a pallet from Rack R1 and loads it into slot 0 of Drop Pad C1 container
    const rackId = [...wh.racks.keys()][0];
    wh.racks.get(rackId).loadSlot(0, 1, 0, 0, 4000015);
    const agf = wh.spawnAgf("agf-outbound", { pos: [wox - 20, woy + 20, 0], heading: 0 });
    await driveVehiclesPromise(rig, agf.enqueue({ type: "pickFromRack", rackId, bay: 0, tier: 1, side: 0, slotInBay: 0 }), { maxSteps: 4800 });
    await driveVehiclesPromise(rig, agf.enqueue({ type: "loadIntoContainer", containerGuid: promoted.guid, slotIndex: 0 }), { maxSteps: 4800 });
    assert.equal(rig.api.containers.get(promoted.guid).slots.length, 1, "untouched AGF stuffed outbound pallet into C1");

    // Pick up outbound container from Drop Pad C1 -> demotes cleanly out of __vehicles.containers!
    const picked = port.terminal.pickupFromWarehousePad("C1");
    assert.ok(picked, "pickupFromWarehousePad returned outbound container");
    assert.equal(picked.slots.length, 1, "stuffed pallet manifest preserved across demotion");
    assert.equal(rig.api.containers.list().length, 0, "demoted C1 container completely removed from __vehicles.containers");

    // Shuttle carries outbound box up the quay ramp to STS-1 -> loads onto ship -> ship departs!
    const tt1 = port.terminal.shuttles.get("TT-1");
    tt1.setPoseImmediate({ x: PORT_ORIGIN[0] - 40, y: PORT_ORIGIN[1] - 196, heading: 0, cargo: picked });
    await driveVehiclesPromise(rig, tt1.driveToNode("quay_lane_b1", { finalHeading: Math.PI * 0.5 }), { maxSteps: 3600 });
    assert.ok(Math.abs(tt1.state.z - 2.0) < 0.01, "TT-1 climbed ramp onto z=+2.0 m quay apron");

    const beforeLoad = ship.cargo.count();
    const sts1 = port.terminal.sts.get("STS-1");
    await driveVehiclesPromise(rig, sts1.transferApronToShip({ shipId: "MV-DERETH-1", shuttleId: "TT-1" }), { maxSteps: 3600 });
    assert.equal(ship.cargo.count(), beforeLoad + 1, "STS-1 loaded outbound container onto vessel");
    assert.equal(tt1.state.cargo, null, "TT-1 emptied after STS-1 hoist");

    port.ship.commandDepart("MV-DERETH-1", { exit: "W" });
    for (let i = 0; i < 600; i++) rig.tick(33.333);
    assert.equal(ship.state.moored, false, "vessel cast off lines");
    assert.ok(ship.state.y > PORT_ORIGIN[1] + 25.0, `vessel crabbed off quay into channel (y=${ship.state.y})`);
  } finally {
    rig.cleanup();
  }
});

check("4. Simultaneous Dual-Berth Operations (B1 & B2) + STS-1/STS-2 Shared-Rail Anti-Collision (>= 26 m)", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    const port = rig.win.__port;
    port.terminal.buildTerminal({ origin: PORT_ORIGIN, populateYard: false });

    const s1 = port.ship.spawnShip("DUAL-1", {
      x: PORT_ORIGIN[0] - 80,
      y: PORT_ORIGIN[1] + 55,
      heading: Math.PI * 0.5,
      mode: SHIP_MODE.AUTONOMOUS,
      populateCargo: true,
    });
    const s2 = port.ship.spawnShip("DUAL-2", {
      x: PORT_ORIGIN[0] + 120,
      y: PORT_ORIGIN[1] + 55,
      heading: Math.PI * 0.5,
      mode: SHIP_MODE.AUTONOMOUS,
      populateCargo: true,
    });
    port.ship.commandGoToBerth("DUAL-1", "B1");
    port.ship.commandGoToBerth("DUAL-2", "B2");

    // Deliberately command STS-1 and STS-2 to converging X targets to verify >= 26 m anti-collision clamp
    const sts1 = port.terminal.sts.get("STS-1");
    const sts2 = port.terminal.sts.get("STS-2");
    sts1.state.targetX = PORT_ORIGIN[0] + 5;
    sts2.state.targetX = PORT_ORIGIN[0] - 5;

    let minShipSep = Infinity;
    let minStsGap = Infinity;
    for (let i = 0; i < 3600; i++) {
      rig.tick(33.333);
      const dShip = Math.hypot(s2.state.x - s1.state.x, s2.state.y - s1.state.y);
      if (dShip < minShipSep) minShipSep = dShip;
      const gap = Math.abs(sts2.state.x - sts1.state.x);
      if (gap < minStsGap) minStsGap = gap;
      if (s1.state.moored && s2.state.moored && i > 180) break;
    }

    assert.equal(s1.state.moored, true, "Ship 1 autonomously moored at Berth 1");
    assert.equal(s1.state.mooredBerthId, "B1");
    assert.equal(s2.state.moored, true, "Ship 2 autonomously moored at Berth 2");
    assert.equal(s2.state.mooredBerthId, "B2");
    assert.ok(minShipSep > 150, `dual-berth vessels maintained safe separation (${minShipSep.toFixed(1)} m)`);
    assert.ok(minStsGap >= STS_CRANE_SPECS.minCraneSeparationM - 1e-4, `STS rail anti-collision maintained >= 26 m (min=${minStsGap.toFixed(2)})`);
  } finally {
    rig.cleanup();
  }
});

check("5. Human Helm Override, Proximity Gangway [B] Boarding, #hb-ship-osd, 4-View Camera & Audio", async () => {
  const bus = makeAudioBus(FullMockCtx);
  const rig = makePortTestRig(THREE, initVehicles, {
    audioManager: { getEffectBus: () => bus, isActive: () => true },
    playerPos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] - 2.0, 2.0], // standing on quay right next to B1 gangway
  });
  try {
    const port = rig.win.__port;
    port.terminal.buildTerminal({ origin: PORT_ORIGIN, populateYard: false });
    const ship = port.ship.spawnShip("HELM-1", {
      spawnAtBerth: "B1",
      moored: true,
      mode: SHIP_MODE.AUTONOMOUS,
      populateCargo: true,
    });

    // Tick once -> proximity gangway prompt should appear on quay
    rig.tick(33.333);
    const promptEl = rig.doc.getElementById("hb-ship-prompt");
    assert.ok(promptEl && promptEl.textContent.includes("[B] Board"), "quay gangway prompt displayed");

    // Press KeyB -> boards ship helm immediately & switches to MANUAL override
    rig.win.dispatch("keydown", { code: "KeyB", key: "b" });
    assert.equal(port.ship.getBoardedShipId(), "HELM-1", "KeyB boarded ship from quay gangway");
    assert.equal(ship.state.mode, SHIP_MODE.MANUAL, "boarding triggers instant manual override");

    const osdEl = rig.doc.getElementById(SHIP_OSD_ID);
    assert.ok(osdEl && osdEl.style.display === "block", "#hb-ship-osd visible while boarded");

    // Press M to unmoor, W twice for Half Ahead, Tab to cycle camera view, H for foghorn
    rig.win.dispatch("keydown", { code: "KeyM", key: "m" });
    rig.win.dispatch("keyup", { code: "KeyM", key: "m" });
    assert.equal(ship.state.moored, false, "KeyM cast off lines");

    rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
    rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
    rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
    rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
    rig.win.dispatch("keydown", { code: "KeyH", key: "h" });
    rig.win.dispatch("keyup", { code: "KeyH", key: "h" });

    const prevView = port.ship.getState().viewMode;
    rig.win.dispatch("keydown", { code: "Tab", key: "Tab" });
    rig.win.dispatch("keyup", { code: "Tab", key: "Tab" });
    assert.notEqual(port.ship.getState().viewMode, prevView, "Tab cycled nautical camera view");

    for (let i = 0; i < 90; i++) rig.tick(33.333);
    assert.ok(ship.state.speed > 0.5, `ship accelerated under human helm (speed=${ship.state.speed.toFixed(2)})`);

    // Press P to hand back to Autonomous Captain
    rig.win.dispatch("keydown", { code: "KeyP", key: "p" });
    rig.win.dispatch("keyup", { code: "KeyP", key: "p" });
    assert.equal(ship.state.mode, SHIP_MODE.AUTONOMOUS, "KeyP handed helm back to Autonomous Captain");

    // Press X to exit helm
    rig.win.dispatch("keydown", { code: "KeyX", key: "x" });
    rig.win.dispatch("keyup", { code: "KeyX", key: "x" });
    assert.equal(port.ship.getBoardedShipId(), null, "KeyX exited helm cleanly");
    assert.equal(osdEl.style.display, "none", "#hb-ship-osd hidden after exit");
  } finally {
    rig.cleanup();
  }
});

check("6. Combined Terminal + Ship + Automated Warehouse FakeWebGL2 Render, 0 Dynamic Lights & 100% Disposal Spy", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  let renderRes = null;
  try {
    const port = rig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: true });
    port.ship.spawnShip("MV-DERETH-2", { spawnAtBerth: "B2", moored: true, populateCargo: true });
    port.terminal.deliverToWarehousePad("C1", { wcid: 4000021, doorProgress: 1.0 });

    for (let i = 0; i < 15; i++) rig.tick(33.333);

    // Zero dynamic THREE.Light instances across the entire combined port + ship + warehouse scene!
    assert.equal(countLights(rig.worldRoot), 0, "0 dynamic THREE.Light instances in combined worldRoot");

    // Render full scene through FakeWebGL2 with zero errors
    renderRes = renderWithFakeWebGL2(THREE, rig.scene, {
      cameraPos: [PORT_ORIGIN[0] - 40, PORT_ORIGIN[1] - 90, 95],
      lookAt: [PORT_ORIGIN[0], PORT_ORIGIN[1] - 40, 2],
    });
    assert.equal(renderRes.capturedErrors.length, 0, `FakeWebGL2 render errors: ${renderRes.capturedErrors.join("; ")}`);
    assert.ok(renderRes.emittedDraws > 0, "FakeWebGL2 emitted draw calls");

    // Spy every geometry & material across terminal root & ships root before dispose()
    const termSpy = spyDisposal(port.terminal.getRoot());
    const shipSpy = spyDisposal(port.ship.getRoot());

    rig.cleanup();
    termSpy.assertAllDisposed("PortTerminalManager");
    shipSpy.assertAllDisposed("ShipManager");
    assert.equal(port.terminal.stats.disposed, true);
    assert.equal(port.ship.stats.disposed, true);
    assert.equal(rig.api.containers.list().length, 0, "all promoted pad containers cleaned up on dispose");
  } finally {
    try { renderRes?.dispose?.(); } catch (_) {}
    rig.cleanup();
  }
});

check("7. Static lintSource Determinism & Zero-Timer Hygiene on B4 Managers", () => {
  for (const rel of ["scene3d/vehicle/port_terminal_manager.js", "scene3d/vehicle/ship_manager.js"]) {
    const src = readFileSync(path.join(APP_ROOT, rel), "utf8");
    const hits = lintSource(src);
    assert.equal(hits.length, 0, `${rel} lintSource hits: ${JSON.stringify(hits)}`);
    assert.equal(/\bsetTimeout\s*\(/.test(src), false, `${rel} must not use setTimeout`);
    assert.equal(/\bsetInterval\s*\(/.test(src), false, `${rel} must not use setInterval`);
  }
});

check("8. Regression: Lateral thruster key release zeros thrusters & A/D/Q/E trigger instant AUTONOMOUS -> MANUAL override", () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    const port = rig.win.__port;
    port.terminal.buildTerminal({ origin: PORT_ORIGIN, populateYard: false });
    const ship = port.ship.spawnShip("HELM-REG-1", {
      x: PORT_ORIGIN[0] - 80,
      y: PORT_ORIGIN[1] + 95,
      heading: Math.PI * 0.5,
      moored: false,
      mode: SHIP_MODE.MANUAL,
      populateCargo: false,
    });
    port.ship.board("HELM-REG-1", { viewMode: "bridge" });

    // Hold KeyE (starboard parallel thrusters) -> ramps up positive
    rig.win.dispatch("keydown", { code: "KeyE", key: "e" });
    for (let i = 0; i < 20; i++) rig.tick(33.333);
    assert.ok(ship.state.bowThruster > 0.5 && ship.state.sternThruster > 0.5, "KeyE fired bow & stern thrusters");

    // Release KeyE -> manualInput AND state thrusters must decay cleanly back to exact 0.0 (no sticking!)
    rig.win.dispatch("keyup", { code: "KeyE", key: "e" });
    for (let i = 0; i < 40; i++) rig.tick(33.333);
    assert.ok(Math.abs(ship.state.bowThruster) < 1e-4, `bowThruster stuck non-zero after KeyE release (${ship.state.bowThruster})`);
    assert.ok(Math.abs(ship.state.sternThruster) < 1e-4, `sternThruster stuck non-zero after KeyE release (${ship.state.sternThruster})`);

    // Switch to AUTONOMOUS via KeyP, verify A/D rudder triggers instant MANUAL override
    rig.win.dispatch("keydown", { code: "KeyP", key: "p" });
    rig.win.dispatch("keyup", { code: "KeyP", key: "p" });
    assert.equal(ship.state.mode, SHIP_MODE.AUTONOMOUS, "KeyP entered AUTONOMOUS");
    for (let i = 0; i < 5; i++) rig.tick(33.333);
    assert.equal(ship.state.mode, SHIP_MODE.AUTONOMOUS, "idle keys keep AUTONOMOUS active");

    rig.win.dispatch("keydown", { code: "KeyD", key: "d" });
    for (let i = 0; i < 6; i++) rig.tick(33.333);
    rig.win.dispatch("keyup", { code: "KeyD", key: "d" });
    assert.equal(ship.state.mode, SHIP_MODE.MANUAL, "KeyD triggered instant AUTONOMOUS -> MANUAL override");
    assert.ok(ship.state.targetRudderRad > 0.02, "KeyD deflected rudder starboard");

    // Switch back to AUTONOMOUS via KeyP, verify Q lateral thruster triggers instant MANUAL override & releases to 0
    rig.win.dispatch("keydown", { code: "KeyP", key: "p" });
    rig.win.dispatch("keyup", { code: "KeyP", key: "p" });
    assert.equal(ship.state.mode, SHIP_MODE.AUTONOMOUS);

    rig.win.dispatch("keydown", { code: "KeyQ", key: "q" });
    for (let i = 0; i < 15; i++) rig.tick(33.333);
    assert.equal(ship.state.mode, SHIP_MODE.MANUAL, "KeyQ triggered instant AUTONOMOUS -> MANUAL override");
    assert.ok(ship.state.bowThruster < -0.4 && ship.state.sternThruster < -0.4, "KeyQ fired port thrusters");

    rig.win.dispatch("keyup", { code: "KeyQ", key: "q" });
    for (let i = 0; i < 40; i++) rig.tick(33.333);
    assert.ok(Math.abs(ship.state.bowThruster) < 1e-4 && Math.abs(ship.state.sternThruster) < 1e-4, "KeyQ release zeroed thrusters");
  } finally {
    rig.cleanup();
  }
});

check("9. Regression: port-import-to-warehouse conserves container BIC (0 duplicate in A1, TT-3 cargo cleared)", async () => {
  const rig = makePortTestRig(THREE, initVehicles);
  try {
    const port = rig.win.__port;
    port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: false });
    const initYardCount = port.terminal.yard.count();
    const tt3 = port.terminal.shuttles.get("TT-3");

    const scRes = await driveVehiclesPromise(
      rig,
      port.terminal.runScenario("port-import-to-warehouse", { shipId: "MV-DERETH-1", padId: "C1" }),
      { maxSteps: 9000 }
    );
    assert.equal(scRes.value.ok, true, "port-import-to-warehouse completed cleanly");
    assert.ok(scRes.value.bic, "promoted container BIC returned");

    // Yard count must return to initYardCount (stacked into A1, then picked out of A1 onto TT-3!)
    assert.equal(port.terminal.yard.count(), initYardCount, "container removed from A1 when loaded onto TT-3");
    const dupInA1 = port.terminal.yard.list("A1").filter((e) => e.bic === scRes.value.bic);
    assert.equal(dupInA1.length, 0, `no duplicate BIC ${scRes.value.bic} left in yard block A1`);
    assert.equal(tt3.state.cargo, null, "TT-3 chassis cargo cleared upon Drop Pad C1 handoff");
    assert.equal(rig.api.containers.list().length, 1, "only promoted Drop Pad C1 container registered in __vehicles.containers");
  } finally {
    rig.cleanup();
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
  console.log(`\nvehicle_port_integration: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
