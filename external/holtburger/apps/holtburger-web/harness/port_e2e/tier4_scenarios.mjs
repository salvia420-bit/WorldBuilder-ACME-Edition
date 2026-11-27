// harness/port_e2e/tier4_scenarios.mjs
// Tier 4: End-to-End Maritime-to-Warehouse Application Scenarios (8 tests: T4-01..T4-08).

import {
  FullMockCtx,
  assert,
  assertNoNaNDeep,
  countLights,
  driveVehiclesPromise,
  makeAudioBus,
  makePortTestRig,
  renderWithFakeWebGL2,
  spyDisposal,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T4-01",
    tier: 4,
    features: ["P1", "P2", "P3", "P4", "P5", "P7", "P10"],
    title: "1. End-to-End Inbound Ship -> STS-1 -> Ramp Shuttle -> RMG-1 Yard -> Pad C1 -> Untouched Warehouse AGF",
    async run({ THREE, mods }) {
      const { PORT_ORIGIN, WAREHOUSE_PORT_ORIGIN } = mods.portSpecs;
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const port = rig.win.__port;
        port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: true, populateDemoCargo: false });
        const scRes = await driveVehiclesPromise(rig, port.terminal.runScenario("port-import-to-warehouse", { shipId: "MV-DERETH-1", padId: "C1" }), { maxSteps: 9000 });
        assert.equal(scRes.value.ok, true);
        const promotedGuid = scRes.value.promotedGuid;
        assert.equal(rig.api.containers.list().length, 1, "only promoted C1 in __vehicles.containers");

        // Untouched warehouse AGF extracts a pallet from the promoted ship container
        const cEntry = rig.api.containers.get(promotedGuid);
        const topSlot = Math.max(...cEntry.slots.map((s) => s.slotIndex));
        const [wox, woy] = WAREHOUSE_PORT_ORIGIN;
        const agf = port.warehouse.spawnAgf("agf-t401", { pos: [wox - 40, woy + 20, 0], heading: 0 });
        await driveVehiclesPromise(rig, agf.enqueue({ type: "pickFromContainer", containerGuid: promotedGuid, slotIndex: topSlot }), { maxSteps: 4800 });
        assert.ok((agf.carriedWcid ?? port.warehouse.getState().agfs["agf-t401"].carriedWcid) > 0);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-02",
    tier: 4,
    features: ["P1", "P2", "P3", "P5", "P7", "P10"],
    title: "2. Reverse Outbound Warehouse AGF Stuffing -> Pad Demotion -> Shuttle Up Ramp -> STS-1 Load -> Ship Depart",
    async run({ THREE, mods }) {
      const { PORT_ORIGIN, WAREHOUSE_PORT_ORIGIN } = mods.portSpecs;
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const port = rig.win.__port;
        port.buildPortAndWarehouse({ origin: PORT_ORIGIN, populateYard: false, populateDemoCargo: false });
        const promoted = port.terminal.deliverToWarehousePad("C1", { wcid: 4000021, slots: [], doorProgress: 1.0 });
        const wh = port.warehouse;
        const rackId = [...wh.racks.keys()][0];
        wh.racks.get(rackId).loadSlot(1, 1, 0, 0, 4000016);
        const [wox, woy] = WAREHOUSE_PORT_ORIGIN;
        const agf = wh.spawnAgf("agf-t402", { pos: [wox - 20, woy + 20, 0], heading: 0 });
        await driveVehiclesPromise(rig, agf.enqueue({ type: "pickFromRack", rackId, bay: 1, tier: 1, side: 0, slotInBay: 0 }), { maxSteps: 4800 });
        await driveVehiclesPromise(rig, agf.enqueue({ type: "loadIntoContainer", containerGuid: promoted.guid, slotIndex: 0 }), { maxSteps: 4800 });

        const ship = port.ship.get("MV-DERETH-1");
        const beforeCount = ship.cargo.count();
        const scRes = await driveVehiclesPromise(
          rig,
          port.terminal.runScenario("port-outbound-to-ship", { shipId: "MV-DERETH-1", padId: "C1", departShip: true }),
          { maxSteps: 9000 }
        );
        assert.equal(scRes.value.ok, true);
        assert.equal(rig.api.containers.list().length, 0, "C1 demoted cleanly");
        assert.equal(ship.cargo.count(), beforeCount + 1);
        for (let i = 0; i < 400; i++) rig.tick(33.333);
        assert.equal(ship.state.moored, false, "ship departed after outbound loading");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-03",
    tier: 4,
    features: ["P3", "P6", "P7", "P10"],
    title: "3. Simultaneous Dual-Berth Operations (Ship 1 at B1 Discharging While Ship 2 Berths at B2)",
    async run({ THREE, mods }) {
      const { PORT_ORIGIN, STS_CRANE_SPECS } = mods.portSpecs;
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const port = rig.win.__port;
        port.terminal.buildTerminal({ origin: PORT_ORIGIN, populateYard: false });
        const s1 = port.ship.spawnShip("DUAL-B1", { spawnAtBerth: "B1", moored: true, populateCargo: true });
        const s2 = port.ship.spawnShip("DUAL-B2", { x: PORT_ORIGIN[0] + 120, y: PORT_ORIGIN[1] + 52, heading: Math.PI * 0.5, mode: "autonomous", populateCargo: true });
        port.ship.commandGoToBerth("DUAL-B2", "B2");

        const sts1 = port.terminal.sts.get("STS-1");
        const sts2 = port.terminal.sts.get("STS-2");
        const dischargeP = sts1.transferShipToApron({ shipId: "DUAL-B1", shuttleId: "TT-1" });

        let minGap = Infinity;
        await driveVehiclesPromise(rig, dischargeP, {
          maxSteps: 4800,
          onStep() {
            const g = Math.abs(sts2.state.x - sts1.state.x);
            if (g < minGap) minGap = g;
          },
        });
        for (let i = 0; i < 3000 && !s2.state.moored; i++) rig.tick(33.333);
        assert.equal(s1.state.mooredBerthId, "B1");
        assert.equal(s2.state.moored, true);
        assert.equal(s2.state.mooredBerthId, "B2");
        assert.ok(minGap >= STS_CRANE_SPECS.minCraneSeparationM - 1e-4);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-04",
    tier: 4,
    features: ["P2", "P4", "P8", "P10"],
    title: "4. High-Density 200+ Container Multi-Tier Yard + Reefer Racks (<= 6 Pool DC, 0 Containers Pollution)",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.terminal.buildTerminal({ populateYard: true, yardDensity: "dense" });
        const yCount = rig.api.terminal.yard.count();
        assert.ok(yCount >= 200, `expected >= 200 dense yard containers, got ${yCount}`);
        assert.equal(rig.api.terminal.yard.pool.count, yCount);
        assert.equal(rig.api.containers.list().length, 0, "0 pollution of __vehicles.containers");
        const reefers = rig.api.terminal.yard.list("REEFER");
        assert.ok(reefers.length >= 24 && reefers.every((r) => r.reefer === true && r.tier <= 3));
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-05",
    tier: 4,
    features: ["P6", "P7", "P9", "P10"],
    title: "5. Human Captain Instant Override Mid-Approach -> Manual Maneuvering -> Autopilot Handback to B2",
    run({ THREE, mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { SHIP_MODE } = mods.shipKinematics;
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const port = rig.win.__port;
        port.terminal.buildTerminal({ populateYard: false });
        const ship = port.ship.spawnShip("OVR-1", { x: PORT_ORIGIN[0] + 120, y: PORT_ORIGIN[1] + 75, heading: Math.PI * 0.5, mode: SHIP_MODE.AUTONOMOUS });
        port.ship.commandGoToBerth("OVR-1", "B2");
        for (let i = 0; i < 30; i++) rig.tick(33.333);

        // Human boards -> instant manual override
        port.ship.board("OVR-1", { viewMode: "bridge" });
        assert.equal(ship.state.mode, SHIP_MODE.MANUAL);
        port.ship.setHelmInput("OVR-1", { eot: 1, rudder: 0.2, bowThruster: 0.3, sternThruster: 0.3 });
        for (let i = 0; i < 45; i++) rig.tick(33.333);
        assert.ok(ship.state.speed > 0.1);

        // Press P to hand back to Autonomous Captain -> completes B2 berthing!
        rig.win.dispatch("keydown", { code: "Digit2", key: "2" });
        rig.win.dispatch("keyup", { code: "Digit2", key: "2" });
        rig.win.dispatch("keydown", { code: "KeyP", key: "p" });
        rig.win.dispatch("keyup", { code: "KeyP", key: "p" });
        assert.equal(ship.state.mode, SHIP_MODE.AUTONOMOUS);
        for (let i = 0; i < 3600 && !ship.state.moored; i++) rig.tick(33.333);
        assert.equal(ship.state.moored, true);
        assert.equal(ship.state.mooredBerthId, "B2");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-06",
    tier: 4,
    features: ["P9", "P10"],
    title: "6. Proximity Gangway Boarding on Quay, Foghorn Blast & Clean Helm Exit",
    run({ THREE, mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const bus = makeAudioBus(FullMockCtx);
      const rig = makePortTestRig(THREE, mods.index.initVehicles, {
        audioManager: { getEffectBus: () => bus, isActive: () => true },
        playerPos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] - 2.0, 2.0],
      });
      try {
        rig.api.terminal.buildTerminal({ populateYard: false });
        rig.api.ship.spawnShip("GANGWAY-1", { spawnAtBerth: "B1", moored: true });
        rig.tick(33.333);
        rig.win.dispatch("keydown", { code: "KeyB", key: "b" });
        assert.equal(rig.api.ship.getBoardedShipId(), "GANGWAY-1");
        assert.equal(rig.api.ship.soundFoghorn("GANGWAY-1"), true);
        rig.win.dispatch("keydown", { code: "KeyX", key: "x" });
        assert.equal(rig.api.ship.getBoardedShipId(), null);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-07",
    tier: 4,
    features: ["P1", "P8", "P10"],
    title: "7. Unified window.__port.runFullDemo() + Combined Port/Ship/Warehouse FakeWebGL2 Render",
    async run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      let renderRes = null;
      try {
        const res = await driveVehiclesPromise(rig, rig.win.__port.runFullDemo(), { maxSteps: 9000 });
        assert.equal(res.value.ok, true);
        assert.equal(countLights(rig.worldRoot), 0);
        renderRes = renderWithFakeWebGL2(THREE, rig.scene);
        assert.equal(renderRes.capturedErrors.length, 0);
        assert.ok(renderRes.emittedDraws > 0);
        assertNoNaNDeep(rig.win.__port.getState(), "full-demo-state");
      } finally {
        try { renderRes?.dispose?.(); } catch (_) {}
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-08",
    tier: 4,
    features: ["P8", "P9", "P10"],
    title: "8. Full Scale Stress + Zero-Leak Geometry/Material/DOM/Listener Disposal Audit",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const port = rig.win.__port;
        port.buildPortAndWarehouse({ populateYard: true, yardDensity: "dense", populateDemoCargo: true });
        port.ship.spawnShip("MV-STRESS-2", { spawnAtBerth: "B2", moored: true, populateCargo: true });
        port.terminal.deliverToWarehousePad("C1", { wcid: 4000021 });
        port.terminal.deliverToWarehousePad("C2", { wcid: 4000022 });
        port.ship.board("MV-STRESS-2");
        for (let i = 0; i < 60; i++) rig.tick(33.333);

        const termSpy = spyDisposal(port.terminal.getRoot());
        const shipSpy = spyDisposal(port.ship.getRoot());

        rig.cleanup();
        termSpy.assertAllDisposed("T4-08 Terminal");
        shipSpy.assertAllDisposed("T4-08 Ships");
        assert.equal(rig.doc.getElementById("hb-ship-osd"), null);
        assert.equal(rig.api.containers.list().length, 0);
        assert.equal(rig.win.__port, undefined);
      } finally {
        rig.cleanup();
      }
    },
  },
];
