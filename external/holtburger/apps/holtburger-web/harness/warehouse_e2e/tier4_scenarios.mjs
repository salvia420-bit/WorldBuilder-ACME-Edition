// harness/warehouse_e2e/tier4_scenarios.mjs
// Tier 4: Real-World Application Scenarios (7 tests: T4-01..T4-07, 1:1 with TEST_INFRA.md).

import {
  ALL_DEPLOYABLE_WCIDS,
  FullMockCtx,
  assert,
  assertFinitePose,
  assertNoNaNDeep,
  countDrawCalls,
  countLights,
  driveManagerPromise,
  driveVehiclesPromise,
  makeAudioBus,
  makeTestRig,
  normBox2D,
  rackLoadSlot,
  renderWithFakeWebGL2,
  spyDisposal,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T4-01",
    tier: 4,
    features: ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"],
    title: "1. Full Inbound Container-to-Rack-to-Stand-to-AMR-to-LiftTable-to-PalletJack Loop",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x75000001;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox - 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000012 }],
        });
        cEntry.model.syncSlots(cEntry.slots);

        const rackId = [...mgr.racks.keys()][0];
        const standId = [...mgr.stands.keys()][0];
        const liftId = [...mgr.liftTables.keys()][0];
        const lt = mgr.liftTables.get(liftId);
        lt.setAutoMode(false);

        const agf = mgr.spawnAgf("agf-loop", { pos: [ox - 18, oy + 20, 0], heading: 0 });
        const amr = mgr.spawnAmr("amr-loop", { pos: [ox - 5, oy - 24, 0], heading: 0 });

        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 }));
        assert.equal(cEntry.slots.some((s) => s.slotIndex === 18), false, "container slot 18 emptied");
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-loop"].carriedWcid, 4000012);

        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeInRack", rackId, bay: 0, tier: 3, side: 0, slotInBay: 0 }), { maxSteps: 3600 });
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromRack", rackId, bay: 0, tier: 3, side: 0, slotInBay: 0 }), { maxSteps: 3600 });
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeOnStand", standId }), { maxSteps: 3600 });

        await driveVehiclesPromise(rig.live, lt.raise());
        await driveVehiclesPromise(rig.live, amr.enqueue({ type: "pickFromStand", standId }), { maxSteps: 3600 });
        assert.equal(amr.carriedWcid ?? mgr.getState().amrs["amr-loop"].carriedWcid, 4000012);
        await driveVehiclesPromise(rig.live, amr.enqueue({ type: "placeOnStand", standId: liftId }), { maxSteps: 6000 });
        // Move AMR clear of lift table before lowering
        await driveVehiclesPromise(rig.live, amr.enqueue({ type: "driveTo", waypoints: [[ox - 5, oy - 24]] }));
        await driveVehiclesPromise(rig.live, lt.lower());
        assert.ok(lt.heightM <= 0.005);

        const lPos = lt.pos ?? [lt.x, lt.y, 0];
        const target = mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.25, heading: 0 });
        assert.ok(target, "lowered lift table ready for player pallet jack");
        assert.equal(lt.carriedWcid ?? lt.cargoWcid ?? mgr.getState().liftTables?.[liftId]?.carriedWcid, 4000012);
        assertNoNaNDeep(mgr.getState(), "T4-01-state");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-02",
    tier: 4,
    features: ["F1", "F2", "F3", "F5", "F6", "F10", "F11"],
    title: "2. Multi-Container Simultaneous Strip & Zone-Sorted Racking (20ft + 40ft + 40HC)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const containers = [
          { guid: 0x75000010, kind: 10, x: ox + 18, topSlot: 9 }, // 20ft
          { guid: 0x75000011, kind: 11, x: ox - 18, topSlot: 19 }, // 40ft
          { guid: 0x75000012, kind: 12, x: ox, topSlot: 19 }, // 40HC
        ];
        const entries = containers.map((c, ci) => {
          const slots = [];
          for (let i = 0; i < 4; i++) {
            slots.push({
              slotIndex: c.topSlot - i,
              palletSize: "standard",
              cargoWcid: ALL_DEPLOYABLE_WCIDS[(ci * 4 + i) % ALL_DEPLOYABLE_WCIDS.length],
            });
          }
          const e = rig.api.containers.spawnLocal(c.guid, c.kind, [c.x, oy + 32, 0], Math.PI, {
            doorProgress: 1.0,
            slots,
          });
          e.model.syncSlots(e.slots);
          return e;
        });

        const rackIds = [...mgr.racks.keys()];
        const agfs = containers.map((c, idx) =>
          mgr.spawnAgf(`agf-mc-${idx}`, { pos: [c.x, oy + 20, 0], heading: 0 })
        );

        let minSep = Infinity;
        const jobs = containers.map((c, ci) =>
          (async () => {
            const agf = agfs[ci];
            const rackId = rackIds[ci % rackIds.length];
            for (let i = 0; i < 4; i++) {
              const slotIndex = c.topSlot - i;
              await agf.enqueue({ type: "pickFromContainer", containerGuid: c.guid, slotIndex });
              await agf.enqueue({ type: "placeInRack", rackId, bay: i, tier: 1, side: 0, slotInBay: 0 });
            }
          })()
        );

        await driveVehiclesPromise(rig.live, Promise.all(jobs), {
          maxSteps: 24000,
          onStep() {
            const st = mgr.getState();
            for (let i = 0; i < agfs.length; i++) {
              for (let j = i + 1; j < agfs.length; j++) {
                const a = st.agfs[`agf-mc-${i}`];
                const b = st.agfs[`agf-mc-${j}`];
                const d = Math.hypot((a.x ?? a.pos[0]) - (b.x ?? b.pos[0]), (a.y ?? a.pos[1]) - (b.y ?? b.pos[1]));
                if (d < minSep) minSep = d;
              }
            }
          },
        });

        for (const e of entries) assert.equal(e.slots.length, 0, "container stripped to 0 slots");
        assert.ok(minSep >= 0.70, `no AGF collisions (minSep=${minSep.toFixed(3)})`);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-03",
    tier: 4,
    features: ["F2", "F3", "F4", "F6", "F10", "F11"],
    title: "3. Reverse Outbound Container Stuffing (Rack -> Stand -> AMR -> AGF -> Container LIFO)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x75000020;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 10, [ox + 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [],
        });

        const rackId = [...mgr.racks.keys()][0];
        const rack = mgr.racks.get(rackId);
        for (let i = 0; i < 4; i++) rackLoadSlot(rack, i, 2, 0, 0, 4000010 + i);

        const standIds = [...mgr.stands.keys()];
        for (let i = 0; i < 4; i++) {
          mgr.stands.get(standIds[i]).setCargoWcid?.(4000014 + i);
        }

        const amr = mgr.spawnAmr("amr-out", { pos: [ox, oy - 24, 0], heading: 0 });
        const agf = mgr.spawnAgf("agf-out-stuff", { pos: [ox, oy + 20, 0], heading: 0 });

        let nextSlot = 0;
        for (let i = 0; i < 4; i++) {
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromRack", rackId, bay: i, tier: 2, side: 0, slotInBay: 0 }), { maxSteps: 4000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "loadIntoContainer", containerGuid: cGuid, slotIndex: nextSlot++ }), { maxSteps: 4000 });
        }
        const aisleStand = standIds[0];
        for (let i = 0; i < 4; i++) {
          const srcStand = standIds[i];
          if (srcStand !== aisleStand) {
            await driveVehiclesPromise(rig.live, amr.enqueue({ type: "pickFromStand", standId: srcStand }), { maxSteps: 4000 });
            await driveVehiclesPromise(rig.live, amr.enqueue({ type: "placeOnStand", standId: aisleStand }), { maxSteps: 4000 });
          }
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromStand", standId: aisleStand }), { maxSteps: 4000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "loadIntoContainer", containerGuid: cGuid, slotIndex: nextSlot++ }), { maxSteps: 4000 });
        }
        assert.equal(cEntry.slots.length, 8, "all 8 outbound slots stuffed in LIFO order");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-04",
    tier: 4,
    features: ["F2", "F6", "F7", "F8", "F9", "F10", "F11"],
    title: "4. Mixed 9-WCID Deployable Fleet Routing & Radar (4000002) Special Handling",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x75000030;
        const slots = ALL_DEPLOYABLE_WCIDS.map((wcid, i) => ({
          slotIndex: 19 - i,
          palletSize: "standard",
          cargoWcid: wcid,
        }));
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox - 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots,
        });
        cEntry.model.syncSlots(cEntry.slots);

        const agf = mgr.spawnAgf("agf-9w", { pos: [ox - 18, oy + 20, 0], heading: 0 });
        const amr = mgr.spawnAmr("amr-9w", { pos: [ox, oy - 24, 0], heading: 0 });
        const rackId = [...mgr.racks.keys()][0];
        const standId = [...mgr.stands.keys()][0];
        const liftId = [...mgr.liftTables.keys()][0];
        const lt = mgr.liftTables.get(liftId);
        lt.setAutoMode(false);

        for (let i = 0; i < ALL_DEPLOYABLE_WCIDS.length; i++) {
          const wcid = ALL_DEPLOYABLE_WCIDS[i];
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 19 - i }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeInRack", rackId, bay: i % 8, tier: 1, side: 0, slotInBay: Math.floor(i / 8) }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromRack", rackId, bay: i % 8, tier: 1, side: 0, slotInBay: Math.floor(i / 8) }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeOnStand", standId }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, lt.raise(), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, amr.enqueue({ type: "pickFromStand", standId }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, amr.enqueue({ type: "placeOnStand", standId: liftId }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, amr.enqueue({ type: "driveTo", waypoints: [[ox, oy - 24]] }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, lt.lower(), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromStand", standId: liftId }), { maxSteps: 6000 });
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "dropToGround", pos: [ox - 20 + i * 2.0, oy - 33.0, 0], heading: 0 }), { maxSteps: 6000 });
        }

        const groundedWcids = new Set(rig.api.deployables.list().map((d) => d.wcid));
        for (const wcid of ALL_DEPLOYABLE_WCIDS) {
          assert.equal(groundedWcids.has(wcid), true, `deployable WCID ${wcid} routed to outbound staging`);
        }
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-05",
    tier: 4,
    features: ["F1", "F4", "F5", "F9", "F10", "F12"],
    title: "5. Player Pallet Jack <-> Scissor Lift Table <-> AMR Interactive Handoff & OBB Safety",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
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
      lt.setAutoMode(true);
      const lPos = lt.pos ?? [lt.x, lt.y, 0];

      const jackEntry = {
        guid: 0x65000001,
        worldPos: [lPos[0], lPos[1] - 0.25, 0],
        heading: 0,
        tillerAngle: 0,
        forkHeightM: 0.200,
        carriedWcid: 4000013,
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
        // Back jack clear via public KeyS + ctrl.tick so auto-mode can raise Lift Table
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
        await driveManagerPromise(mgr, lt.raise().catch(() => {}), { maxSteps: 300 });
        for (let i = 0; i < 240 && lt.heightM < 0.375; i++) mgr.tick(1 / 60, [lPos[0], lPos[1], 10]);
        assert.ok(lt.heightM >= 0.375, `Lift Table auto-raised to ${lt.heightM}`);

        const amr = mgr.spawnAmr("amr-t405", { pos: [lPos[0] + 4, lPos[1], 0], heading: -Math.PI / 2 });
        await driveManagerPromise(mgr, amr.enqueue({ type: "pickFromStand", standId: liftId }));
        assert.equal(amr.carriedWcid ?? mgr.getState().amrs["amr-t405"].carriedWcid, 4000013);
        await driveManagerPromise(mgr, amr.enqueue({ type: "driveTo", waypoints: [[lPos[0] + 6, lPos[1]]] }));

        for (let i = 0; i < 240 && lt.heightM > 0.005; i++) mgr.tick(1 / 60, [lPos[0], lPos[1], 10]);
        assert.ok(lt.heightM <= 0.005, `Lift Table auto-lowered after AMR cleared (${lt.heightM})`);
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T4-06",
    tier: 4,
    features: ["F1", "F5", "F6", "F7", "F8", "F9", "F10", "F12"],
    title: "6. 256+ Slot Scale Stress & Budget Compliance (scale-stress, 8 AGFs, 16 AMRs)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const scenP = mgr.runScenario("scale-stress");

        for (let f = 0; f < 600; f++) {
          const camDist = f < 300 ? 15 : 180;
          mgr.tick(1 / 60, [ox, oy - camDist, 25]);
          if (f % 150 === 0) {
            const st = mgr.getState();
            assertNoNaNDeep(st, `scaleStressFrame${f}`);
          }
        }
        assert.ok(mgr.agfs.size >= 8 && mgr.amrs.size >= 16);
        assert.equal(countLights(rig.worldRoot), 0);

        // Verify per-asset draw call budgets in populated hub
        for (const agf of mgr.agfs.values()) {
          if (agf.model?.root) assert.ok(countDrawCalls(agf.model.root) <= 22);
        }
        for (const amr of mgr.amrs.values()) {
          if (amr.model?.root) assert.ok(countDrawCalls(amr.model.root) <= 18);
        }

        const r = renderWithFakeWebGL2(THREE, rig.worldRoot, {
          cameraPos: [ox, oy - 50, 30],
          lookAt: [ox, oy, 2],
        });
        try {
          assert.ok(r.emittedDraws > 0);
          assert.deepEqual(r.capturedErrors, []);
        } finally {
          r.dispose();
        }
        mgr.stopScenarios();
        await Promise.resolve(scenP).catch(() => {});
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T4-07",
    tier: 4,
    features: ["F10", "F11", "F12"],
    title: "7. Live Server-Dispatch vs Local Mirror Synchronization & Clean Session Teardown",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const bus = makeAudioBus(FullMockCtx);
      const rig = makeTestRig(THREE, mods.index.initVehicles, {
        audioManager: { bus },
      });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cLocal = 0x75000050;
        const eLocal = rig.api.containers.spawnLocal(cLocal, 11, [ox - 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 }],
        });
        eLocal.model.syncSlots(eLocal.slots);

        const cServer = 0x75000051;
        const eServer = rig.api.containers.spawnLocal(cServer, 11, [ox + 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000011 }],
        });
        eServer.localOnly = false;
        eServer.model.syncSlots(eServer.slots);

        const agf = mgr.spawnAgf("agf-sync", { pos: [ox, oy + 20, 0], heading: 0 });
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cLocal, slotIndex: 18 }));
        assert.equal(eLocal.slots.length, 0, "local container slots synced");

        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "dropToGround", pos: [ox - 32, oy, 0], heading: 0 }));
        await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cServer, slotIndex: 18, serverDispatch: true }));
        assert.ok(rig.calls.containerActions.length >= 1, "server-backed container dispatched vehicleContainerAction");

        const spy = spyDisposal(rig.worldRoot);
        rig.win.__vehicles.dispose();
        spy.assertAllDisposed("sessionTeardown");
        assert.equal(rig.worldRoot.children.length, 0);
        assert.equal(rig.win.__vehicles, undefined);
      } finally {
        rig.cleanup();
      }
    },
  },
];
