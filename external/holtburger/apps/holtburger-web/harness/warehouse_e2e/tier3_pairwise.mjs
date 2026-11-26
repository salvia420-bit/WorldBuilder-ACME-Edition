// harness/warehouse_e2e/tier3_pairwise.mjs
// Tier 3: Pairwise Cross-Feature Combinations (16 tests: T3-01..T3-16).

import {
  ALL_DEPLOYABLE_WCIDS,
  FullMockCtx,
  assert,
  assertFinitePose,
  assertNoNaNDeep,
  computeBox3,
  countDrawCalls,
  countLights,
  countVisibleDrawCalls,
  driveManagerPromise,
  driveVehiclesPromise,
  gridClaim,
  gridQueryProximity,
  localBoxInParent,
  makeAudioBus,
  makeCsmState,
  makeTestRig,
  normBox2D,
  rackGetSlotWorldPos,
  rackLoadSlot,
  renderWithFakeWebGL2,
  spyDisposal,
  stepUntil,
  wrapAngle,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T3-01",
    tier: 3,
    features: ["F1", "F2", "F6"],
    title: "NE Flatland Blueprint -> Rack Model Geometric Parity",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE, RACK_SPECS, buildDefaultHubLayout, computeRackSlotLocalPose } = mods.specs;
      const { buildRackRow } = mods.rackModel;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const minEdge = NE_FLATLAND_SITE.bodyEdgeMin ?? 193.0;
      const maxEdge = NE_FLATLAND_SITE.bodyEdgeMax ?? 48767.0;

      const builtRows = [];
      try {
        for (const rDef of layout.rackRows) {
          const row = buildRackRow(THREE, rDef, { csmState: makeCsmState() });
          if (rDef.pos) row.root.position.set(rDef.pos[0], rDef.pos[1], rDef.pos[2] ?? 0);
          else if (Number.isFinite(rDef.x) && Number.isFinite(rDef.y)) row.root.position.set(rDef.x, rDef.y, rDef.z ?? 0);
          if (Number.isFinite(rDef.heading)) row.root.rotation.z = -rDef.heading;
          builtRows.push({ row, rDef });

          const b = computeBox3(THREE, row.root);
          assert.ok(b.min.x >= minEdge && b.max.x <= maxEdge, "rack row within BodyEdge X");
          assert.ok(b.min.y >= minEdge && b.max.y <= maxEdge, "rack row within BodyEdge Y");

          const wp = rackGetSlotWorldPos(row, 0, 2, 0, 1);
          const lp = computeRackSlotLocalPose(0, 2, 1, RACK_SPECS);
          assert.ok(Math.abs((wp.z ?? wp[2]) - lp.z) < 0.002, `tier 2 slot z parity (${wp.z ?? wp[2]} vs ${lp.z})`);
        }
      } finally {
        for (const { row } of builtRows) row.dispose();
      }
    },
  },
  {
    id: "T3-02",
    tier: 3,
    features: ["F2", "F3", "F7"],
    title: "3-Stage Kinematics -> AGF 3D Model (4000017 HeavyLaserTurret)",
    async run({ THREE, mods }) {
      const { stepAgfKinematics, computeMastStages } = mods.kinematics;
      const { buildAgfForklift } = mods.agfModel;
      const { ISO_CONTAINER_SPECS, CONTAINER_WCID } = mods.containerModels;
      const doorH = ISO_CONTAINER_SPECS[CONTAINER_WCID.IsoContainer40].door.height;

      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        let st = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.045, speed: 0 };
        for (const targetH of [0.045, 1.700, 7.250]) {
          stepUntil(
            (_, dt) => {
              st = stepAgfKinematics(st, { forkHeightM: targetH }, dt, {});
            },
            () => Math.abs(st.forkHeightM - targetH) <= 0.01,
            600,
            1 / 60
          );
          const mast = computeMastStages(st.forkHeightM);
          agf.update({ forkHeightM: st.forkHeightM, carriedWcid: 4000017, supportSurfaceZ: 0 });
          if (targetH <= 1.700) {
            assert.equal(mast.freeliftActive, true);
            agf.update({ forkHeightM: st.forkHeightM, mastTiltRad: 0, carriedWcid: 0, supportSurfaceZ: 0 });
            agf.root.updateMatrixWorld(true);
            const outerMesh = agf.root.getObjectByName("agf-mast-outer-mesh");
            assert.ok(outerMesh, "agf-mast-outer-mesh present");
            const outerBox = computeBox3(THREE, outerMesh);
            const unloadedRootBox = computeBox3(THREE, agf.root);
            assert.ok(outerBox.max.z < doorH, `outer mast max.z=${outerBox.max.z} >= doorH=${doorH}`);
            assert.ok(unloadedRootBox.max.z < doorH, `unloaded root max.z=${unloadedRootBox.max.z} >= doorH=${doorH}`);
            agf.update({ forkHeightM: st.forkHeightM, carriedWcid: 4000017, supportSurfaceZ: 0 });
            const box = computeBox3(THREE, agf.root);
            // Mast outer structure stays <= 2.165 < 2.280 door height
            assert.ok(mast.outerH < doorH);
            assert.ok(Number.isFinite(box.max.z));
          }
          const cargoBox = localBoxInParent(THREE, agf.cargoMount, agf.root);
          assert.ok(cargoBox.max.z - cargoBox.min.z <= 2.06, "stowed 4000017 height <= 2.05 m");
        }
        const wp = new THREE.Vector3();
        agf.root.updateMatrixWorld(true);
        agf.cargoMount.getWorldPosition(wp);
        // At targetH = 7.250 with supportSurfaceZ = 0, cargoMount sits -DECK_UNDERSIDE_Z (-0.123 m)
        // below fork blade top: 7.250 - 0.123 = 7.127 m, clearing Level 3 rack (7.050 m).
        assert.ok(wp.z >= 7.10 && wp.z <= 7.265, `L3 reach cargoMount z=${wp.z}`);
        const l3CargoBox = computeBox3(THREE, agf.cargoMount);
        assert.ok(
          l3CargoBox.max.z > 7.050 + 1.0,
          `stowed 4000017 cargo top max.z=${l3CargoBox.max.z} <= 8.050`
        );
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T3-03",
    tier: 3,
    features: ["F3", "F11"],
    title: "AGF Container Strip with Roof-Strike & LIFO Interlocks",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { stepAgfKinematics } = mods.kinematics;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x74000001;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [
            { slotIndex: 16, palletSize: "standard", cargoWcid: 4000010 },
            { slotIndex: 17, palletSize: "standard", cargoWcid: 4000011 },
            { slotIndex: 18, palletSize: "standard", cargoWcid: 4000012 },
            { slotIndex: 19, palletSize: "standard", cargoWcid: 4000013 },
          ],
        });
        cEntry.model.syncSlots(cEntry.slots);

        // Verify roof-strike block inside container
        const kinRoof = stepAgfKinematics(
          { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 1.5, speed: 0 },
          { forkHeightM: 2.5 },
          1 / 60,
          { insideContainer: true }
        );
        assert.equal(kinRoof.roofStrikeBlocked, true);
        assert.ok(kinRoof.forkHeightM <= 1.7001);

        const agf = mgr.spawnAgf("agf-t303", { pos: [ox, oy + 20, 0], heading: 0 });
        await assert.rejects(
          async () =>
            driveVehiclesPromise(
              rig.live,
              agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 16 }),
              { maxSteps: 600 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 })
        );
        assert.equal(cEntry.slots.some((s) => s.slotIndex === 18), false, "slot 18 stripped");
        assert.equal(cEntry.slots.some((s) => s.slotIndex === 16), true, "blocked slot 16 preserved");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-04",
    tier: 3,
    features: ["F2", "F4", "F8", "F9"],
    title: "AMR Underride Through P&D Stand Tunnel + Turntable Hold",
    async run({ THREE, mods }) {
      const { STAND_SPECS, AMR_SPECS } = mods.specs;
      const { stepAmrKinematics } = mods.kinematics;
      const { buildTransferStand } = mods.infraModel;
      const { buildAmrUnderride } = mods.amrModel;

      const standTW = STAND_SPECS.tunnelWidthM ?? STAND_SPECS.tunnelWidth;
      const standTH = STAND_SPECS.tunnelHeightM ?? STAND_SPECS.tunnelHeight;
      const standRZ = STAND_SPECS.railHeightM ?? STAND_SPECS.railZ;
      const amrW = AMR_SPECS.widthM ?? AMR_SPECS.width;
      const amrLow = AMR_SPECS.loweredHeightM ?? AMR_SPECS.loweredHeight;
      const amrHigh = AMR_SPECS.raisedHeightM ?? AMR_SPECS.raisedHeight;
      assert.ok((standTW - amrW) / 2 >= 0.039);
      assert.ok(standTH - amrLow >= 0.099);
      assert.ok(amrHigh - standRZ >= 0.069);

      const stand = buildTransferStand(THREE, { csmState: makeCsmState() });
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        stand.setSlotCargo?.(0, 4000010);
        let st = { x: 0, y: -2, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0, loaded: false };
        // Drive under stand at 0.260 m
        stepUntil(
          (_, dt) => {
            st = stepAmrKinematics(st, { targetPose: { x: 0, y: 0, heading: 0 }, targetLiftHeightM: 0.260 }, dt);
          },
          () => Math.hypot(st.x, st.y) <= 0.02,
          300,
          1 / 60
        );
        amr.update({ liftHeightM: st.liftHeightM, turntableYawRad: st.turntableYawRad });
        assert.ok(computeBox3(THREE, amr.root).max.z < standTH);

        // Lift to 0.450 m and exit + rotate 90 deg keeping cargo heading
        stepUntil(
          (_, dt) => {
            st = stepAmrKinematics(st, { targetLiftHeightM: 0.450, loaded: true }, dt);
          },
          () => Math.abs(st.liftHeightM - 0.450) <= 1e-4,
          180,
          1 / 60
        );
        stand.setSlotCargo?.(0, 0);
        const worldHeading0 = wrapAngle(st.heading + st.turntableYawRad);
        stepUntil(
          (_, dt) => {
            st = stepAmrKinematics(st, { targetPose: { x: 0, y: -3, heading: Math.PI / 2 }, keepCargoHeading: true, heldCargoHeading: worldHeading0 }, dt);
            assert.ok(Math.abs(wrapAngle(st.heading + st.turntableYawRad - worldHeading0)) <= 0.015);
          },
          () => Math.abs(wrapAngle(st.heading - Math.PI / 2)) <= 0.02 && Math.hypot(st.x, st.y + 3) <= 0.05,
          600,
          1 / 60
        );
        amr.update({
          liftHeightM: st.liftHeightM,
          turntableYawRad: st.turntableYawRad,
          wheelSpinL: st.wheelSpinL,
          wheelSpinR: st.wheelSpinR,
          carriedWcid: 4000010,
        });
      } finally {
        stand.dispose();
        amr.dispose();
      }
    },
  },
  {
    id: "T3-05",
    tier: 3,
    features: ["F4", "F9", "F12"],
    title: "Player Pallet Jack -> Split-Rail Lift Table -> AMR Handoff",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { stepLiftTable } = mods.kinematics;
      const { createPalletJackController } = mods.palletJackController;
      const { createWarehouseManager } = mods.manager;

      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const liftId = [...mgr.liftTables.keys()][0];
      const lt = mgr.liftTables.get(liftId);
      const lPos = lt.pos ?? [lt.x, lt.y, 0];

      // Interlock prevents raise while jack is on deck
      const blocked = stepLiftTable({ heightM: 0, moving: false, interlockBlocked: false }, { targetHeightM: 0.380 }, 1 / 60, { palletJackOnDeck: true });
      assert.equal(blocked.interlockBlocked, true);
      assert.equal(blocked.heightM, 0);

      const jackEntry = {
        guid: 0x61000001,
        worldPos: [lPos[0], lPos[1] - 0.25, 0],
        heading: 0,
        tillerAngle: 0,
        forkHeightM: 0.200,
        carriedWcid: 4000011,
        model: { root: new THREE.Group(), update() {}, dispose() {} },
      };
      const ctrl = createPalletJackController({
        liveScene3d: rig.live,
        THREE,
        window: rig.win,
        sh: () => rig.sessionHandle,
        em: rig.live.entityManager,
        localGuid: rig.localPlayerGuid,
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
        mgr.tick(1 / 60, [lPos[0], lPos[1], 10]);
        // Move jack clear of Lift Table deck using public KeyS + ctrl.tick
        rig.win.dispatch("keydown", { code: "KeyS", key: "s" });
        try {
          for (let i = 0; i < 180 && (ctrl.state?.y ?? lPos[1]) > lPos[1] - 2.5; i++) {
            ctrl.tick(1 / 60);
          }
        } finally {
          rig.win.dispatch("keyup", { code: "KeyS", key: "s" });
        }
        assertFinitePose(ctrl.state, "jackClearedLiftTable");
        assert.ok(ctrl.state.y <= lPos[1] - 2.5, `jack backed clear of Lift Table (y=${ctrl.state.y})`);
        lt.setAutoMode(false);
        await driveManagerPromise(mgr, lt.raise());
        assert.ok(lt.heightM >= 0.375);

        const amr = mgr.spawnAmr("amr-lt", { pos: [lPos[0] + 4, lPos[1], 0], heading: -Math.PI / 2 });
        await driveManagerPromise(mgr, amr.enqueue({ type: "pickFromStand", standId: liftId }));
        assert.equal(amr.carriedWcid ?? mgr.getState().amrs["amr-lt"].carriedWcid, 4000011);
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T3-06",
    tier: 3,
    features: ["F4", "F5", "F9", "F12"],
    title: "Lift Table Interlock + SpatialReservationGrid + Jack OBB",
    async run({ THREE, mods }) {
      const { stepLiftTable, SpatialReservationGrid } = mods.kinematics;
      const { resolveBayObbPushout } = mods.palletJackController;
      const grid = new SpatialReservationGrid();
      assert.equal(gridClaim(grid, "amr-1", 10, 10, 0.55), true);

      const ltBlocked = stepLiftTable({ heightM: 0.380, moving: false, interlockBlocked: false }, { targetHeightM: 0.0 }, 1 / 60, { amrUnderneath: true });
      assert.equal(ltBlocked.interlockBlocked, true);
      assert.equal(ltBlocked.heightM, 0.380);

      const q = gridQueryProximity(grid, "amr-2", 10.6, 10, 0.55);
      assert.equal(q.stop, true, "second AMR stops in <= 0.8 m zone");

      const push = resolveBayObbPushout(10, 10, 0.4, [{ x0: 9.3, x1: 10.7, y0: 9.3, y1: 10.7 }]);
      assert.equal(push.hit, true);
      assert.ok(push.x <= 9.3 - 0.39 || push.x >= 10.7 + 0.39 || push.y <= 9.3 - 0.39 || push.y >= 10.7 + 0.39);
    },
  },
  {
    id: "T3-07",
    tier: 3,
    features: ["F3", "F5", "F10"],
    title: "Dual-AGF Aisle Crossing & Reservation Yield",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { createWarehouseManager } = mods.manager;
      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const rackIds = [...mgr.racks.keys()];
        const agfA = mgr.spawnAgf("agf-cross-a", { pos: [ox - 10, oy + 10, 0], heading: Math.PI / 2, carriedWcid: 4000010 });
        const agfB = mgr.spawnAgf("agf-cross-b", { pos: [ox + 10, oy + 10, 0], heading: -Math.PI / 2, carriedWcid: 4000011 });

        let minSep = Infinity;
        const pBoth = Promise.all([
          agfA.enqueue({ type: "placeInRack", rackId: rackIds[0], bay: 6, tier: 1, side: 0, slotInBay: 0 }),
          agfB.enqueue({ type: "placeInRack", rackId: rackIds[0], bay: 1, tier: 1, side: 0, slotInBay: 0 }),
        ]);
        await driveManagerPromise(mgr, pBoth, {
          maxSteps: 3600,
          onStep() {
            const st = mgr.getState();
            const a = st.agfs["agf-cross-a"];
            const b = st.agfs["agf-cross-b"];
            const d = Math.hypot((a.x ?? a.pos[0]) - (b.x ?? b.pos[0]), (a.y ?? a.pos[1]) - (b.y ?? b.pos[1]));
            if (d < minSep) minSep = d;
          },
        });
        assert.ok(minSep >= 0.75, `AGFs maintained safe separation (minSep=${minSep.toFixed(3)})`);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T3-08",
    tier: 3,
    features: ["F6", "F7", "F10"],
    title: "Ground Radar (4000002) Rack Storage & LOD Lifecycle",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { createWarehouseManager } = mods.manager;
      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const rackId = [...mgr.racks.keys()][0];
        const agf = mgr.spawnAgf("agf-rad", { pos: [ox - 8, oy + 18, 0], heading: 0, carriedWcid: 4000002 });
        await driveManagerPromise(mgr, agf.enqueue({ type: "placeInRack", rackId, bay: 2, tier: 2, side: 0, slotInBay: 0 }));

        mgr.tick(1 / 60, [ox, oy, 10]);
        const nearDc = countVisibleDrawCalls(rig.worldRoot);
        mgr.tick(1 / 60, [ox, oy - 160, 20]);
        const farDc = countVisibleDrawCalls(rig.worldRoot);
        assert.ok(farDc < nearDc, `far LOD DC (${farDc}) < near (${nearDc})`);
        mgr.tick(1 / 60, [ox, oy, 10]);
        assert.equal(countVisibleDrawCalls(rig.worldRoot), nearDc, "restores near detail at 10 m");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T3-09",
    tier: 3,
    features: ["F6", "F8", "F9"],
    title: "Combined Hub GPU Budget & FakeWebGL2 Render Pass",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const { buildRackRow } = mods.rackModel;
      const { buildAgfForklift } = mods.agfModel;
      const { buildAmrUnderride } = mods.amrModel;
      const { buildConcreteApron, buildTransferStandGroup, buildScissorLiftTable, buildChargingDockGroup } = mods.infraModel;

      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const csm = makeCsmState();
      const apron = buildConcreteApron(THREE, layout, { csmState: csm });
      const stands = buildTransferStandGroup(THREE, layout.stands, { csmState: csm });
      const chargers = buildChargingDockGroup(THREE, layout.chargers, { csmState: csm });
      const lift1 = buildScissorLiftTable(THREE, { csmState: csm });
      const lift2 = buildScissorLiftTable(THREE, { csmState: csm });
      const row = buildRackRow(THREE, { bayCount: 8, doubleSided: true }, { csmState: csm });
      const agf = buildAgfForklift(THREE, { csmState: csm });
      const amr = buildAmrUnderride(THREE, { csmState: csm });

      const scene = new THREE.Scene();
      for (const m of [apron, stands, chargers, lift1, lift2, row, agf, amr]) scene.add(m.root);
      try {
        assert.ok(countDrawCalls(apron.root) <= 3);
        assert.ok(countDrawCalls(stands.root) + countDrawCalls(chargers.root) <= 3);
        assert.ok(countDrawCalls(lift1.root) <= 4);
        assert.ok(countDrawCalls(row.root) <= 4);
        assert.ok(countDrawCalls(agf.root) <= 10);
        assert.ok(countDrawCalls(amr.root) <= 6);
        assert.equal(countLights(scene), 0);

        const r = renderWithFakeWebGL2(THREE, scene, {
          cameraPos: [NE_FLATLAND_SITE.origin[0], NE_FLATLAND_SITE.origin[1] - 40, 25],
          lookAt: NE_FLATLAND_SITE.origin,
        });
        try {
          assert.ok(r.emittedDraws > 0);
          assert.deepEqual(r.capturedErrors, []);
        } finally {
          r.dispose();
        }
      } finally {
        for (const m of [apron, stands, chargers, lift1, lift2, row, agf, amr]) m.dispose();
      }
    },
  },
  {
    id: "T3-10",
    tier: 3,
    features: ["F7", "F8", "F10", "F12"],
    title: "Manager Tick -> Procedural Logistics Audio Cues & Teardown",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { createLogisticsAudio } = mods.audio;
      const { createWarehouseManager } = mods.manager;

      let tSec = 1;
      const bus = makeAudioBus(FullMockCtx);
      const au = createLogisticsAudio({ bus, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: au,
        sh: () => rig.sessionHandle,
      });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const rackId = [...mgr.racks.keys()][0];
        const agf = mgr.spawnAgf("agf-aud", { pos: [ox - 5, oy + 18, 0], heading: 0, carriedWcid: 4000010 });
        const amr = mgr.spawnAmr("amr-aud", { pos: [ox - 5, oy - 24, 0], heading: 0 });
        const p1 = agf.enqueue({ type: "placeInRack", rackId, bay: 0, tier: 2, side: 0, slotInBay: 0 });
        const p2 = amr.enqueue({ type: "driveTo", waypoints: [[ox + 5, oy - 24]] });
        await driveManagerPromise(mgr, Promise.all([p1, p2]), {
          onStep() {
            tSec += 1 / 60;
          },
        });
        assert.ok(bus.ctx.made.length > 0, "warehouse operations triggered audio nodes");
        mgr.clearHub();
      } finally {
        mgr.dispose();
        au.dispose();
      }
      assert.equal(au.stats.totalNodes, 0);
    },
  },
  {
    id: "T3-11",
    tier: 3,
    features: ["F1", "F9", "F12"],
    title: "Pallet Jack Navigation Across Concrete Apron & Rack OBBs",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { createWarehouseManager } = mods.manager;
      const { createPalletJackController } = mods.palletJackController;

      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const [ox, oy] = NE_FLATLAND_SITE.origin;
      const jackEntry = {
        guid: 0x62000001,
        worldPos: [ox - 32, oy, 0],
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
        sh: () => rig.sessionHandle,
        em: rig.live.entityManager,
        localGuid: rig.localPlayerGuid,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map([[jackEntry.guid, jackEntry]]),
        warehouseManager: mgr,
      });
      try {
        ctrl.start(jackEntry);
        rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
        try {
          for (let i = 0; i < 60; i++) ctrl.tick(1 / 60);
        } finally {
          rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
        }
        const st = ctrl.state;
        assertFinitePose(st, "jackApronNav");
        assert.ok(st.x > ox - 32, `jack advanced east across apron (${st.x})`);
        assert.ok(Math.abs(st.z) < 0.05, `jack ground z=${st.z}`);
        for (const rawBox of mgr.getObstacleBoxes()) {
          const b = normBox2D(rawBox);
          assert.ok(b, "valid obstacle box");
          assert.equal(st.x > b.x0 && st.x < b.x1 && st.y > b.y0 && st.y < b.y1, false);
        }
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T3-12",
    tier: 3,
    features: ["F3", "F10", "F11"],
    title: "Reverse Outbound Container Stuffing (Rack L3 -> Container Slot 0)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const rackId = [...mgr.racks.keys()][0];
        mgr.racks.get(rackId).loadSlot(0, 3, 0, 0, 4000016);

        const cGuid = 0x74000012;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 10, [ox + 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [],
        });

        const agf = mgr.spawnAgf("agf-out", { pos: [ox, oy + 18, 0], heading: 0 });
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromRack", rackId, bay: 0, tier: 3, side: 0, slotInBay: 0 }), { maxSteps: 3600 });
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-out"].carriedWcid, 4000016);

        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "loadIntoContainer", containerGuid: cGuid, slotIndex: 0 }), { maxSteps: 3600 });
        const slot0 = cEntry.slots.find((s) => s.slotIndex === 0);
        assert.ok(slot0 && (slot0.cargoWcid ?? slot0.wcid) === 4000016);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-13",
    tier: 3,
    features: ["F4", "F8", "F9", "F10"],
    title: "AMR Stand Delivery -> Charging Dock Engagement",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const standId = [...mgr.stands.keys()][0];
        const chargerId = [...mgr.chargers.keys()][0];

        const amr = mgr.spawnAmr("amr-chg", { pos: [ox, oy - 24, 0], heading: 0, carriedWcid: 4000010, liftHeightM: 0.450 });
        await driveVehiclesPromise(rig.live, amr.enqueue({ type: "placeOnStand", standId }));
        await driveVehiclesPromise(rig.live, amr.enqueue({ type: "dockCharge", chargerId }));

        const st = mgr.getState();
        const amrSt = st.amrs["amr-chg"];
        assert.equal(amrSt.statusMode, "charging");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-14",
    tier: 3,
    features: ["F6", "F10"],
    title: "384-Slot Rack Population (256 Pallets) + LOD + Zero-Leak Clear",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const { createWarehouseManager } = mods.manager;
      const rig = makeTestRig(THREE, null);
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables: new Map(),
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        let loaded = 0;
        for (const row of mgr.racks.values()) {
          const sides = row.doubleSided ? 2 : 1;
          for (let b = 0; b < (row.bayCount ?? 8) && loaded < 256; b++) {
            for (let t = 0; t < 4 && loaded < 256; t++) {
              for (let s = 0; s < sides && loaded < 256; s++) {
                for (let sl = 0; sl < 2 && loaded < 256; sl++) {
                  rackLoadSlot(row, b, t, s, sl, ALL_DEPLOYABLE_WCIDS[loaded % ALL_DEPLOYABLE_WCIDS.length]);
                  loaded++;
                }
              }
            }
          }
        }
        assert.equal(loaded, 256);
        mgr.tick(1 / 60, [ox, oy, 20]);
        const nearDc = countVisibleDrawCalls(rig.worldRoot);
        mgr.tick(1 / 60, [ox, oy - 160, 20]);
        const farDc = countVisibleDrawCalls(rig.worldRoot);
        assert.ok(farDc < nearDc, `256-slot LOD far (${farDc}) < near (${nearDc})`);

        const spy = spyDisposal(rig.worldRoot);
        mgr.clearHub();
        spy.assertAllDisposed("256-slot clearHub");
        assert.equal(rig.worldRoot.children.length, 0);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T3-15",
    tier: 3,
    features: ["F2", "F11"],
    title: "Trailer-Mounted vs Grounded Container Interop Guard",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGround = 0x74000020;
        const eGround = rig.api.containers.spawnLocal(cGround, 11, [ox - 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          mountedOnTrailerGuid: 0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 }],
        });
        eGround.model.syncSlots(eGround.slots);

        const cTrailer = 0x74000021;
        const eTrailer = rig.api.containers.spawnLocal(cTrailer, 11, [ox + 18, oy + 32, 1.32], Math.PI, {
          doorProgress: 1.0,
          mountedOnTrailerGuid: 0x80000001,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000011 }],
        });
        eTrailer.mountedOnTrailerGuid = 0x80000001;
        eTrailer.model.syncSlots(eTrailer.slots);

        const agf = mgr.spawnAgf("agf-tr", { pos: [ox, oy + 20, 0], heading: 0 });
        await assert.rejects(
          async () =>
            driveVehiclesPromise(
              rig.live,
              agf.enqueue({ type: "pickFromContainer", containerGuid: cTrailer, slotIndex: 18 }),
              { maxSteps: 600 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cGround, slotIndex: 18 }));
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-tr"].carriedWcid, 4000010);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T3-16",
    tier: 3,
    features: ["F10", "F12"],
    title: "initVehicles Full Hub Lifecycle (buildHub -> afterTick -> dispose)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const wh = rig.win.__vehicles.warehouse;
        wh.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        wh.spawnAgf("agf-life", { pos: [ox, oy + 18, 0], heading: 0 });
        wh.spawnAmr("amr-life", { pos: [ox, oy - 24, 0], heading: 0 });

        for (let i = 1; i <= 60; i++) {
          rig.tick(i * 16.667, 16.667);
        }
        assertNoNaNDeep(wh.getState(), "lifeState60");
        rig.api.onTeleport?.();
        for (let i = 61; i <= 70; i++) {
          rig.tick(i * 16.667, 16.667);
        }

        const spy = spyDisposal(rig.worldRoot);
        rig.win.__vehicles.dispose();
        spy.assertAllDisposed("fullLifecycleDispose");
        assert.equal(rig.worldRoot.children.length, 0);
      } finally {
        rig.cleanup();
      }
    },
  },
];
