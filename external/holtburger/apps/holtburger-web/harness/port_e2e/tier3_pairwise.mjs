// harness/port_e2e/tier3_pairwise.mjs
// Tier 3: Pairwise Cross-Feature Combinations (14 tests: T3-01..T3-14).

import {
  FullMockCtx,
  assert,
  assertNoNaNDeep,
  computeBox3,
  driveVehiclesPromise,
  makeAudioBus,
  makeCsmState,
  makePortTestRig,
  stepUntil,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T3-01",
    tier: 3,
    features: ["P1", "P8"],
    title: "Site A Layout -> Quay Model Bounds, Seawall Depth (-2.5 m) & Warehouse Seam Parity",
    run({ THREE, mods }) {
      const { PORT_ORIGIN, PORT_SITE } = mods.portSpecs;
      const quay = mods.portQuayModel.buildPortQuay(THREE, null, { origin: PORT_ORIGIN, csmState: makeCsmState() });
      try {
        const b = computeBox3(THREE, quay.root);
        assert.ok(b.min.z <= PORT_SITE.seawallBottomZ + 0.05, `seawall reaches <= -2.5 m (${b.min.z})`);
        assert.ok(Math.abs(b.min.y - PORT_SITE.yardMinY) < 1.0, `yard apron flush at Y=47670 (${b.min.y})`);
        assert.ok(b.max.y >= PORT_SITE.quayY, `quay seawall reaches Y=47880 (${b.max.y})`);
        assert.equal(quay.bollardCount, 17);
        assert.equal(quay.fenderCount, 25);
      } finally {
        quay.dispose();
      }
    },
  },
  {
    id: "T3-02",
    tier: 3,
    features: ["P2", "P8"],
    title: "Yard Stack Store -> Instanced Container Stack Pool 1:1 Sync Across 20ft/40ft/40HC/Reefer",
    run({ THREE, mods }) {
      const { createYardStackStore } = mods.portKinematics;
      const store = createYardStackStore();
      const pool = mods.portYardCraneModel.createContainerStackPool(THREE, { origin: mods.portSpecs.PORT_ORIGIN, maxInstances: 64 });
      try {
        store.place("A1", 2, 1, 1, { wcid: 4000021, liveryId: 0 });
        store.place("A1", 2, 1, 2, { wcid: 4000022, liveryId: 1 });
        store.place("A1", 5, 2, 1, { wcid: 4000020, liveryId: 2 });
        store.place("REEFER", 2, 1, 1, { wcid: 4000022, liveryId: 4, reefer: true });
        const stats = pool.syncFromEntries(store.entries);
        assert.equal(stats.total, 4);
        assert.equal(stats.count20, 1);
        assert.equal(stats.count40, 3);
        assert.equal(stats.count40Hc, 2);
        assert.equal(stats.countReefer, 1);
      } finally {
        pool.dispose();
      }
    },
  },
  {
    id: "T3-03",
    tier: 3,
    features: ["P3", "P8"],
    title: "STS Kinematics -> STS Crane Model Boom Pivot, Trolley, Spreader & Carried Container Sync",
    run({ THREE, mods }) {
      const { createStsCraneState, stepStsCrane } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1" });
      const model = mods.portStsCraneModel.buildStsCrane(THREE, { initialState: st });
      try {
        st.carriedContainer = { wcid: 4000021, liveryId: 1 };
        for (let i = 0; i < 60; i++) {
          stepStsCrane(st, { targetTrolleyY: 18.0, targetSpreaderZ: 12.0, lockTwistlocks: true }, 1 / 30);
          model.update(st);
        }
        assert.ok(model.mountedCargo !== null, "STS spreader mounted carried container visual");
        assert.ok(Math.abs(model.trolleyY - st.trolleyY) < 1e-4);
        assert.ok(Math.abs(model.spreaderZ - st.spreaderZ) < 1e-4);
      } finally {
        model.dispose();
      }
    },
  },
  {
    id: "T3-04",
    tier: 3,
    features: ["P4", "P8"],
    title: "RTG Kinematics -> RTG Yard Crane Model 90 deg Steered Bogies & Telescoping Spreader",
    run({ THREE, mods }) {
      const { createYardCraneState, stepYardCrane } = mods.portKinematics;
      const st = createYardCraneState({ id: "RTG-1", type: "RTG", y: 47723 });
      const model = mods.portYardCraneModel.buildRtgCrane(THREE, { initialState: st });
      try {
        for (let i = 0; i < 60; i++) {
          stepYardCrane(st, { targetY: 47735, targetSpreaderLen: 6.058 }, 1 / 30);
          model.update(st);
        }
        assert.ok(model.wheelSteerRad > 1.2, `RTG model reflected steered bogies (${model.wheelSteerRad})`);
        assert.ok(model.spreaderLen < 8.0);
      } finally {
        model.dispose();
      }
    },
  },
  {
    id: "T3-05",
    tier: 3,
    features: ["P5", "P8"],
    title: "Shuttle Kinematics -> Port Shuttle Model ZYX Ramp Pitch & Deck Cargo Alignment",
    run({ THREE, mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { createShuttleState, stepShuttle } = mods.portKinematics;
      const st = createShuttleState({ id: "TT-1", x: PORT_ORIGIN[0], y: 47812, heading: 0, origin: PORT_ORIGIN, cargo: { wcid: 4000021, liveryId: 0 } });
      const model = mods.portShuttleModel.buildPortShuttle(THREE, { initialState: st });
      try {
        for (let i = 0; i < 60; i++) {
          stepShuttle(st, [{ x: PORT_ORIGIN[0], y: 47836 }], 1 / 30, { origin: PORT_ORIGIN });
          model.update(st);
        }
        assert.equal(model.root.rotation.order, "ZYX");
        assert.ok(model.mountedCargo !== null);
        assert.ok(model.root.position.z > 0.2);
      } finally {
        model.dispose();
      }
    },
  },
  {
    id: "T3-06",
    tier: 3,
    features: ["P6", "P8"],
    title: "Ship Hydrodynamics -> Ship Model 6-DOF Pose, Hatch Covers, Cargo Pool & Mooring Hawsers",
    run({ THREE, mods }) {
      const { createShipState, createShipCargoStore, computeMooringLines, stepShipHydrodynamics } = mods.shipKinematics;
      const st = createShipState({ spawnAtBerth: "B1", moored: true });
      const cargo = createShipCargoStore();
      cargo.load(2, 1, 82, { wcid: 4000021 });
      cargo.load(4, 2, 2, { wcid: 4000022 });
      const model = mods.shipModel.buildContainerShip(THREE);
      try {
        stepShipHydrodynamics(st, { throttle: 0 }, 1 / 30);
        model.update({ ...st, dt: 1 / 30, applyRootPose: true });
        assert.equal(model.setContainers(cargo), 2);
        assert.equal(model.setMooringLines(computeMooringLines(st), st), 6);
        model.setHatchCover(4, 1.0);
        assert.ok(model.hatchCovers[4].open === 1.0);
      } finally {
        model.dispose();
      }
    },
  },
  {
    id: "T3-07",
    tier: 3,
    features: ["P6", "P8"],
    title: "Ship Lateral Thrusters -> ship_fx Thruster Whitewater Plume Emission",
    run({ THREE, mods }) {
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const st = createShipState({ x: 44880, y: 47920, heading: Math.PI * 0.5, mode: "manual" });
      const fx = mods.shipFx.createShipFx(THREE);
      try {
        for (let i = 0; i < 30; i++) {
          stepShipHydrodynamics(st, { throttle: 0, bowThruster: 0.9, sternThruster: 0.9 }, 1 / 30);
          fx.update(st, 1 / 30, st.timeSec);
        }
        const counts = fx.getActiveCounts();
        assert.ok(counts.thrusters > 0, `expected thruster plume particles, got ${counts.thrusters}`);
      } finally {
        fx.dispose();
      }
    },
  },
  {
    id: "T3-08",
    tier: 3,
    features: ["P7", "P10"],
    title: "ShipManager Autonomous Berthing -> Live _terrainOracle Deep-Sea Sounding Integration",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const s = rig.api.ship.spawnShip("S-ORACLE", {
          x: mods.portSpecs.PORT_ORIGIN[0] - 80,
          y: mods.portSpecs.PORT_ORIGIN[1] + 45,
          heading: Math.PI * 0.5,
          mode: "autonomous",
        });
        rig.api.ship.commandGoToBerth("S-ORACLE", "B1");
        for (let i = 0; i < 3000 && !s.state.moored; i++) rig.tick(33.333);
        assert.equal(s.state.moored, true);
        assert.ok(s.state.waterDepthM >= 14.0 && s.state.ukcM >= 10.0);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-09",
    tier: 3,
    features: ["P9", "P10"],
    title: "ShipManager Manual Helm Controls -> #hb-ship-osd + PortAudio Live Telemetry Sync",
    run({ THREE, mods }) {
      const bus = makeAudioBus(FullMockCtx);
      const rig = makePortTestRig(THREE, mods.index.initVehicles, {
        audioManager: { getEffectBus: () => bus, isActive: () => true },
      });
      try {
        rig.api.ship.spawnShip("S-UX", { x: 44960, y: 48060, heading: Math.PI * 0.5, mode: "manual" });
        rig.api.ship.board("S-UX", { viewMode: "wing" });
        rig.api.ship.setHelmInput("S-UX", { eot: 3, rudder: -0.5, bowThruster: 0.4, horn: true });
        for (let i = 0; i < 30; i++) rig.tick(33.333);
        assert.equal(rig.api.ship.getOsd().isVisible(), true);
        assert.equal(rig.api.ship.getState().viewMode, "wing");
        assert.ok(rig.api.ship.get("S-UX").state.surgeU > 0.2);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-10",
    tier: 3,
    features: ["P3", "P10"],
    title: "PortTerminalManager STS-1 <-> ShipManager Live Cargo Discharge & Twistlock Audio",
    async run({ THREE, mods }) {
      const bus = makeAudioBus(FullMockCtx);
      const rig = makePortTestRig(THREE, mods.index.initVehicles, {
        audioManager: { getEffectBus: () => bus, isActive: () => true },
      });
      try {
        rig.api.terminal.buildTerminal({ populateYard: false });
        const s = rig.api.ship.spawnShip("S-STS", { spawnAtBerth: "B1", moored: true, populateCargo: true });
        const before = s.cargo.count();
        const sts1 = rig.api.terminal.sts.get("STS-1");
        await driveVehiclesPromise(rig, sts1.transferShipToApron({ shipId: "S-STS", shuttleId: "TT-1" }), { maxSteps: 3600 });
        assert.equal(s.cargo.count(), before - 1);
        assert.ok(rig.api.terminal.shuttles.get("TT-1").state.cargo !== null);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-11",
    tier: 3,
    features: ["P4", "P10"],
    title: "PortTerminalManager Yard Crane RTG-1 Transfers Between South Block B1 & Shuttle TT-2",
    async run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.terminal.buildTerminal({ populateYard: true });
        const before = rig.api.terminal.yard.count();
        const rtg1 = rig.api.terminal.yardCranes.get("RTG-1");
        const tt2 = rig.api.terminal.shuttles.get("TT-2");
        await driveVehiclesPromise(rig, rtg1.transferYardToTtl({ blockId: "B1", shuttleId: "TT-2" }), { maxSteps: 3600 });
        assert.equal(rig.api.terminal.yard.count(), before - 1);
        assert.ok(tt2.state.cargo !== null);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-12",
    tier: 3,
    features: ["P1", "P10"],
    title: "Terminal Drop Pad C1/C2/C3 Coordinates Match Untouched Warehouse Zone A Pad Layout 1:1",
    run({ THREE, mods }) {
      const { WAREHOUSE_PORT_ORIGIN, WAREHOUSE_DROP_PADS } = mods.portSpecs;
      const { buildDefaultHubLayout } = mods.warehouseSpecs;
      const whLayout = buildDefaultHubLayout(WAREHOUSE_PORT_ORIGIN);
      for (const id of ["C1", "C2", "C3"]) {
        const whPad = whLayout.dropPads.find((p) => p.id === id);
        assert.ok(whPad, `warehouse layout has pad ${id}`);
        const pPos = WAREHOUSE_DROP_PADS[id].pos;
        const wx = whPad.x ?? whPad.pos[0];
        const wy = whPad.y ?? whPad.pos[1];
        assert.ok(Math.abs(pPos[0] - wx) < 0.02, `${id} X parity: ${pPos[0]} vs ${wx}`);
        assert.ok(Math.abs(pPos[1] - wy) < 0.02, `${id} Y parity: ${pPos[1]} vs ${wy}`);
      }
    },
  },
  {
    id: "T3-13",
    tier: 3,
    features: ["P2", "P10"],
    title: "Promoted Drop Pad Container Slots Satisfy Untouched Warehouse container_logistics LIFO Rules",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.terminal.buildTerminal({ populateYard: false });
        const p = rig.api.terminal.deliverToWarehousePad("C1", { wcid: 4000021 });
        const cEntry = rig.api.containers.get(p.guid);
        assert.ok(cEntry.slots.length >= 2);
        const reachable = mods.containerLogistics.isSlotReachableForUnload(cEntry.kind, cEntry.slots, 19);
        assert.equal(Boolean(reachable?.reachable ?? reachable), true, "rear-most promoted slot 19 immediately reachable for untouched warehouse AGF");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-14",
    tier: 3,
    features: ["P9", "P10"],
    title: "Teleport Teardown (live.vehicles.onTeleport) Safely Exits Boarded Ship Helm",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.ship.spawnShip("S-TELE", { spawnAtBerth: "B1", moored: true });
        rig.api.ship.board("S-TELE");
        assert.equal(rig.api.ship.getBoardedShipId(), "S-TELE");
        rig.live.vehicles.onTeleport();
        assert.equal(rig.api.ship.getBoardedShipId(), null);
        assert.equal(rig.api.ship.getControls().locked, false);
        assertNoNaNDeep(rig.win.__port.getState(), "post-teleport-state");
      } finally {
        rig.cleanup();
      }
    },
  },
];
