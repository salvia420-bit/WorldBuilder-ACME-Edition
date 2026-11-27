// harness/port_e2e/tier2_boundaries.mjs
// Tier 2: Boundary Value Analysis, Rejections & Safety Guards (40 tests: 4 per Feature P1-P10).

import {
  BareMockCtx,
  assert,
  assertNoNaNDeep,
  makeAudioBus,
  makeFakeWindowDocCanvas,
  makePortTestRig,
  makeSiteAWaterOracle,
  stepUntil,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // P1 — Site & Math Boundaries
  // =========================================================================
  {
    id: "T2-P1-01",
    tier: 2,
    features: ["P1"],
    title: "buildPortLayout handles omitted, null, and NaN origins without NaN",
    run({ mods }) {
      const { buildPortLayout, PORT_ORIGIN } = mods.portSpecs;
      for (const bad of [undefined, null, [NaN, Infinity, -Infinity]]) {
        const l = buildPortLayout(bad);
        assertNoNaNDeep(l, `layout(${String(bad)})`);
        assert.deepEqual(l.origin, [...PORT_ORIGIN]);
      }
    },
  },
  {
    id: "T2-P1-02",
    tier: 2,
    features: ["P1"],
    title: "quayRampZ & quayRampPitch remain finite & exact at ramp boundary endpoints",
    run({ mods }) {
      const { PORT_ORIGIN, quayRampZ, quayRampPitch } = mods.portSpecs;
      assert.equal(quayRampZ(47810.0, PORT_ORIGIN), 0.0);
      assert.equal(quayRampZ(47834.0, PORT_ORIGIN), 2.0);
      assert.equal(quayRampPitch(47810.0, 0, PORT_ORIGIN), 0.0);
      assert.equal(quayRampPitch(47834.0, 0, PORT_ORIGIN), 0.0);
      assert.ok(Math.abs(quayRampPitch(47822.0, Math.PI * 0.5, PORT_ORIGIN)) < 1e-12); // driving E-W across ramp = 0 pitch
    },
  },
  {
    id: "T2-P1-03",
    tier: 2,
    features: ["P1"],
    title: "waterSwellAt & waterSwellLattice sanitize non-finite inputs",
    run({ mods }) {
      const { waterSwellAt, waterSwellLattice } = mods.portSpecs;
      assert.ok(Number.isFinite(waterSwellAt(NaN, Infinity, undefined)));
      assert.ok(Number.isFinite(waterSwellLattice(NaN, -Infinity, NaN)));
    },
  },
  {
    id: "T2-P1-04",
    tier: 2,
    features: ["P1"],
    title: "estimateChartDepthM returns 0 on dry land, quay box, and non-water terrain codes",
    run({ mods }) {
      const { PORT_ORIGIN, estimateChartDepthM } = mods.portSpecs;
      assert.equal(estimateChartDepthM(44960, 47879, 20, PORT_ORIGIN), 0.0);
      assert.equal(estimateChartDepthM(44960, 47950, 10, PORT_ORIGIN), 0.0);
      assert.ok(estimateChartDepthM(44960, 47950, 18, PORT_ORIGIN) < estimateChartDepthM(44960, 47950, 20, PORT_ORIGIN));
    },
  },

  // =========================================================================
  // P2 — ISO 9711 & Structural Support Rejections
  // =========================================================================
  {
    id: "T2-P2-01",
    tier: 2,
    features: ["P2"],
    title: "Yard validator rejects parity mismatch (20ft in even bay, 40ft in odd bay)",
    run({ mods }) {
      const { validateYardPlacement } = mods.portSpecs;
      assert.equal(validateYardPlacement("A1", 2, 1, 1, 4000020).ok, false);
      assert.equal(validateYardPlacement("A1", 1, 1, 1, 4000021).ok, false);
      assert.equal(validateYardPlacement("UNKNOWN", 2, 1, 1, 4000021).ok, false);
    },
  },
  {
    id: "T2-P2-02",
    tier: 2,
    features: ["P2"],
    title: "Yard validator rejects floating tier > 1 & mutual-exclusion 20ft/40ft overlaps",
    run({ mods }) {
      const { createYardStackStore } = mods.portKinematics;
      const store = createYardStackStore();
      assert.equal(store.place("A1", 2, 1, 2, { wcid: 4000021 }).ok, false, "rejects floating tier 2");
      assert.equal(store.place("A1", 2, 1, 1, { wcid: 4000021 }).ok, true);
      assert.equal(store.place("A1", 1, 1, 1, { wcid: 4000020 }).ok, false, "rejects 20ft overlapping 40ft bay 2");
      assert.equal(store.place("A1", 1, 1, 2, { wcid: 4000020 }).ok, false, "rejects 20ft overhang atop 40ft");
    },
  },
  {
    id: "T2-P2-03",
    tier: 2,
    features: ["P2"],
    title: "Yard store rejects removing buried container & rejects exceeding Reefer maxTiers=3",
    run({ mods }) {
      const { createYardStackStore } = mods.portKinematics;
      const store = createYardStackStore();
      store.place("REEFER", 2, 1, 1, { wcid: 4000022 });
      store.place("REEFER", 2, 1, 2, { wcid: 4000022 });
      store.place("REEFER", 2, 1, 3, { wcid: 4000022 });
      assert.equal(store.place("REEFER", 2, 1, 4, { wcid: 4000022 }).ok, false, "reefer maxTiers = 3");
      assert.equal(store.remove("REEFER", 2, 1, 1).ok, false, "cannot remove container with stack above");
      assert.equal(store.remove("REEFER", 2, 1, 3).ok, true, "top container removable");
    },
  },
  {
    id: "T2-P2-04",
    tier: 2,
    features: ["P2"],
    title: "Ship cargo store rejects invalid row/tier, floating deck tier, and unloading under deck cargo",
    run({ mods }) {
      const { createShipCargoStore } = mods.shipKinematics;
      const cargo = createShipCargoStore();
      assert.equal(cargo.load(2, 0, 82, { wcid: 4000021 }).ok, false, "no centerline row 00 on 4-row ship");
      assert.equal(cargo.load(2, 1, 84, { wcid: 4000021 }).ok, false, "floating tier 84 rejected");
      assert.equal(cargo.load(2, 1, 2, { wcid: 4000021 }).ok, true);
      assert.equal(cargo.load(2, 1, 82, { wcid: 4000021 }).ok, true);
      assert.equal(cargo.unload(2, 1, 2).ok, false, "hold unload blocked while deck cargo covers hatch");
      assert.equal(cargo.unload(2, 1, 82).ok, true);
      assert.equal(cargo.unload(2, 1, 2).ok, true, "hold unload succeeds once hatch clear");
    },
  },

  // =========================================================================
  // P3 — STS Crane Safety Interlocks & Limits
  // =========================================================================
  {
    id: "T2-P3-01",
    tier: 2,
    features: ["P3"],
    title: "STS boom cannot raise to stowed while carrying a container",
    run({ mods }) {
      const { createStsCraneState, stepStsCrane } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", boomStowed: false });
      st.carriedContainer = { wcid: 4000021 };
      for (let i = 0; i < 60; i++) stepStsCrane(st, { boomStowed: true }, 1 / 30);
      assert.equal(st.boomAngle, 0.0, "boom interlock holds 0 deg while carrying cargo");
    },
  },
  {
    id: "T2-P3-02",
    tier: 2,
    features: ["P3"],
    title: "STS trolley cannot travel waterside past portal while boom is stowed",
    run({ mods }) {
      const { createStsCraneState, stepStsCrane, STS_TROLLEY_PARK_MAX_Y } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", boomStowed: true });
      for (let i = 0; i < 120; i++) stepStsCrane(st, { targetTrolleyY: 36.0 }, 1 / 30);
      assert.ok(st.trolleyY <= STS_TROLLEY_PARK_MAX_Y + 1e-4);
    },
  },
  {
    id: "T2-P3-03",
    tier: 2,
    features: ["P3"],
    title: "STS spreader refuses telescoping while twistlocks are locked",
    run({ mods }) {
      const { STS_CRANE_SPECS } = mods.portSpecs;
      const { createStsCraneState, stepStsCrane } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", spreaderLen: STS_CRANE_SPECS.spreaderLen40M });
      st.twistlockAngle = Math.PI * 0.5;
      st.twistlocksLocked = true;
      for (let i = 0; i < 60; i++) stepStsCrane(st, { targetSpreaderLen: STS_CRANE_SPECS.spreaderLen20M, lockTwistlocks: true }, 1 / 30);
      assert.equal(st.spreaderLen, STS_CRANE_SPECS.spreaderLen40M);
    },
  },
  {
    id: "T2-P3-04",
    tier: 2,
    features: ["P3"],
    title: "STS rail bounds clamp extreme out-of-range targetX commands",
    run({ mods }) {
      const { createStsCraneState, stepStsCrane } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1" });
      for (let i = 0; i < 30; i++) stepStsCrane(st, { targetX: 999999 }, 1 / 30);
      assert.ok(st.targetX <= st.railMaxX && st.x <= st.railMaxX);
      for (let i = 0; i < 30; i++) stepStsCrane(st, { targetX: -999999 }, 1 / 30);
      assert.ok(st.targetX >= st.railMinX && st.x >= st.railMinX);
    },
  },

  // =========================================================================
  // P4 — Yard Crane Boundaries
  // =========================================================================
  {
    id: "T2-P4-01",
    tier: 2,
    features: ["P4"],
    title: "RMG ignores targetY lateral crab commands (rail-bound)",
    run({ mods }) {
      const { createYardCraneState, stepYardCrane } = mods.portKinematics;
      const st = createYardCraneState({ id: "RMG-1", type: "RMG", y: 47781 });
      for (let i = 0; i < 90; i++) stepYardCrane(st, { targetY: 47820 }, 1 / 30);
      assert.equal(st.y, 47781);
      assert.equal(st.wheelSteerRad, 0);
    },
  },
  {
    id: "T2-P4-02",
    tier: 2,
    features: ["P4"],
    title: "Yard crane spreaderZ & trolleyY clamp cleanly to physical limits",
    run({ mods }) {
      const { YARD_CRANE_SPECS } = mods.portSpecs;
      const { createYardCraneState, stepYardCrane, YARD_TROLLEY_MIN_Y, YARD_TROLLEY_MAX_Y } = mods.portKinematics;
      const st = createYardCraneState({ id: "RMG-1" });
      stepYardCrane(st, { targetSpreaderZ: -100, targetTrolleyY: 999 }, 0.25);
      assert.ok(st.targetSpreaderZ >= YARD_CRANE_SPECS.spreaderMinZ);
      assert.ok(st.targetTrolleyY <= YARD_TROLLEY_MAX_Y && st.targetTrolleyY >= YARD_TROLLEY_MIN_Y);
    },
  },
  {
    id: "T2-P4-03",
    tier: 2,
    features: ["P4"],
    title: "Yard crane separation leaves cranes on different runways untouched",
    run({ mods }) {
      const { createYardCraneState, enforceYardCraneSeparation } = mods.portKinematics;
      const nCrane = createYardCraneState({ id: "RMG-1", x: 44880, y: 47781 });
      const sCrane = createYardCraneState({ id: "RTG-1", type: "RTG", x: 44880, y: 47723 });
      const res = enforceYardCraneSeparation([nCrane, sCrane]);
      assert.equal(res.clamped, false);
    },
  },
  {
    id: "T2-P4-04",
    tier: 2,
    features: ["P4"],
    title: "stepYardTransferCycle handles null job cleanly without NaN",
    run({ mods }) {
      const { createYardCraneState, stepYardTransferCycle, YARD_CRANE_PHASE } = mods.portKinematics;
      const st = createYardCraneState({ id: "RMG-1" });
      const r = stepYardTransferCycle(st, null, 1 / 30);
      assert.equal(r.done, true);
      assert.equal(r.phase, YARD_CRANE_PHASE.IDLE);
      assertNoNaNDeep(st, "rmg-idle");
    },
  },

  // =========================================================================
  // P5 — Shuttle Routing & Reservation Boundaries
  // =========================================================================
  {
    id: "T2-P5-01",
    tier: 2,
    features: ["P5"],
    title: "findRoadPath returns empty array on unknown nodes and 1-node path when start===goal",
    run({ mods }) {
      const { buildPortLayout } = mods.portSpecs;
      const { findRoadPath } = mods.portKinematics;
      const g = buildPortLayout().graph;
      assert.deepEqual(findRoadPath(g, "no_such_node", "wh_pad_C1"), []);
      const same = findRoadPath(g, "wh_pad_C1", "wh_pad_C1");
      assert.equal(same.length, 1);
    },
  },
  {
    id: "T2-P5-02",
    tier: 2,
    features: ["P5"],
    title: "Shuttle decelerates to 0 speed with empty waypoints & zero/negative dt safe",
    run({ mods }) {
      const { createShuttleState, stepShuttle } = mods.portKinematics;
      const st = createShuttleState({ id: "TT-1" });
      st.speed = 6.0;
      stepShuttle(st, [], -0.5);
      assertNoNaNDeep(st, "shuttle-neg-dt");
      for (let i = 0; i < 120; i++) stepShuttle(st, [], 1 / 30);
      assert.equal(st.speed, 0.0);
    },
  },
  {
    id: "T2-P5-03",
    tier: 2,
    features: ["P5"],
    title: "PortReservationGrid ignores agents behind vehicle (only forward cone yields)",
    run({ mods }) {
      const { PortReservationGrid } = mods.portKinematics;
      const g = new PortReservationGrid();
      g.updateAgent("TT-1", 44900, 47750, 0, 5);
      g.updateAgent("TT-2", 44900, 47740, 0, 5); // 10 m BEHIND TT-1
      assert.equal(g.speedFactorFor("TT-1", 44900, 47750, 0), 1.0);
    },
  },
  {
    id: "T2-P5-04",
    tier: 2,
    features: ["P5"],
    title: "Shuttle loaded speed cap is strictly lower than empty speed cap",
    run({ mods }) {
      const { SHUTTLE_SPECS } = mods.portSpecs;
      assert.ok(SHUTTLE_SPECS.vMaxLoadedMps < SHUTTLE_SPECS.vMaxEmptyMps);
      assert.ok(SHUTTLE_SPECS.vRampMps < SHUTTLE_SPECS.vMaxLoadedMps);
    },
  },

  // =========================================================================
  // P6 — Ship Hydrodynamics, Fender & Grounding Guards
  // =========================================================================
  {
    id: "T2-P6-01",
    tier: 2,
    features: ["P6"],
    title: "Quay fender contact prevents vessel hull from penetrating quay wall Y < 47881.2",
    run({ mods }) {
      const { PORT_ORIGIN, QUAY_SPECS, SHIP_SPECS } = mods.portSpecs;
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const st = createShipState({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] + 10.5, heading: Math.PI * 0.5, mode: "manual" });
      for (let i = 0; i < 120; i++) {
        stepShipHydrodynamics(st, { throttle: 0, bowThruster: 1.0, sternThruster: 1.0 }, 1 / 30);
      }
      assert.equal(st.fenderContact, true);
      assert.ok(st.y >= PORT_ORIGIN[1] + QUAY_SPECS.fenderDepthM + SHIP_SPECS.halfBeamM - 0.05, `hull kept outside quay wall (y=${st.y})`);
    },
  },
  {
    id: "T2-P6-02",
    tier: 2,
    features: ["P6"],
    title: "Water-code grounding guard arrests vessel approaching dry land (code 10)",
    run({ mods }) {
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const oracle = makeSiteAWaterOracle();
      const st = createShipState({ x: 44600, y: 47850, heading: Math.PI, mode: "manual" });
      const waterCodeAt = (x, y) => oracle.sample(x, y).cornerCodes[0];
      let sawGrounded = false;
      for (let i = 0; i < 180; i++) {
        stepShipHydrodynamics(st, { throttle: 1.0 }, 1 / 30, { waterCodeAt });
        if (st.grounded) sawGrounded = true;
      }
      assert.equal(sawGrounded, true, "grounding guard triggered on dry terrain code 10");
      assert.ok(st.y > 47832, "vessel prevented from driving inland onto dry sand");
    },
  },
  {
    id: "T2-P6-03",
    tier: 2,
    features: ["P6"],
    title: "Manual mooring toggle rejects mooring outside berth envelope (too far / too fast)",
    run({ mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { createShipState, tryManualMoorToggle } = mods.shipKinematics;
      const farShip = createShipState({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] + 40, heading: Math.PI * 0.5 });
      assert.equal(tryManualMoorToggle(farShip).ok, false);
      const fastShip = createShipState({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] + 8.6, heading: Math.PI * 0.5 });
      fastShip.surgeU = 2.0;
      assert.equal(tryManualMoorToggle(fastShip).ok, false);
    },
  },
  {
    id: "T2-P6-04",
    tier: 2,
    features: ["P6"],
    title: "World-edge clamping keeps vessel inside safe Dereth near-ring bounds",
    run({ mods }) {
      const { PORT_SITE } = mods.portSpecs;
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const st = createShipState({ x: PORT_SITE.bodyEdgeMax + 500, y: PORT_SITE.bodyEdgeMax + 500, heading: 0, mode: "manual" });
      stepShipHydrodynamics(st, { throttle: 1.0 }, 1 / 30);
      assert.ok(st.x <= PORT_SITE.bodyEdgeMax && st.y <= PORT_SITE.bodyEdgeMax);
    },
  },

  // =========================================================================
  // P7 — Autonomous Captain Edge Cases
  // =========================================================================
  {
    id: "T2-P7-01",
    tier: 2,
    features: ["P7"],
    title: "Autonomous Captain supports port-side-to berthing (heading = 3*PI/2)",
    run({ mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { createShipState, commandShipGoToBerth, stepAutonomousCaptain } = mods.shipKinematics;
      const st = createShipState({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] + 55, heading: Math.PI * 1.5 });
      commandShipGoToBerth(st, "B1", { side: "port" });
      stepUntil(() => stepAutonomousCaptain(st, 1 / 30), () => st.moored, 3600);
      assert.equal(st.moored, true);
      assert.equal(st.mooringSide, "port");
    },
  },
  {
    id: "T2-P7-02",
    tier: 2,
    features: ["P7"],
    title: "Commanding moored B1 vessel to B2 automatically unmoors before transiting",
    run({ mods }) {
      const { CAPTAIN_STATE, createShipState, commandShipGoToBerth } = mods.shipKinematics;
      const st = createShipState({ spawnAtBerth: "B1", moored: true });
      commandShipGoToBerth(st, "B2");
      assert.equal(st.captainState, CAPTAIN_STATE.UNMOORING);
      assert.equal(st.targetBerthId, "B2");
    },
  },
  {
    id: "T2-P7-03",
    tier: 2,
    features: ["P7"],
    title: "Commanding moored B1 vessel to B1 keeps it in CARGO_OPS without unmooring",
    run({ mods }) {
      const { CAPTAIN_STATE, createShipState, commandShipGoToBerth } = mods.shipKinematics;
      const st = createShipState({ spawnAtBerth: "B1", moored: true });
      commandShipGoToBerth(st, "B1");
      assert.equal(st.captainState, CAPTAIN_STATE.CARGO_OPS);
      assert.equal(st.moored, true);
    },
  },
  {
    id: "T2-P7-04",
    tier: 2,
    features: ["P7"],
    title: "Autonomous Captain handles huge dt clamp safely without divergence or NaN",
    run({ mods }) {
      const { createShipState, commandShipGoToBerth, stepAutonomousCaptain } = mods.shipKinematics;
      const st = createShipState();
      commandShipGoToBerth(st, "B1");
      for (let i = 0; i < 20; i++) stepAutonomousCaptain(st, 5.0); // clamped to 0.25 internally
      assertNoNaNDeep(st, "ship-clamped-dt");
    },
  },

  // =========================================================================
  // P8 — Model & Pool Boundary Conditions
  // =========================================================================
  {
    id: "T2-P8-01",
    tier: 2,
    features: ["P8"],
    title: "createContainerStackPool enforces maxInstances cap without throwing",
    run({ THREE, mods }) {
      const pool = mods.portYardCraneModel.createContainerStackPool(THREE, { maxInstances: 4 });
      try {
        for (let i = 0; i < 6; i++) {
          const ok = pool.add(`C_${i}`, { x: i * 15, y: 0, z: 0, wcid: 4000021 });
          assert.equal(ok, i < 4);
        }
        assert.equal(pool.count, 4);
      } finally {
        pool.dispose();
      }
    },
  },
  {
    id: "T2-P8-02",
    tier: 2,
    features: ["P8"],
    title: "All B2/B3 model dispose() methods are idempotent when called twice",
    run({ THREE, mods }) {
      const objs = [
        mods.portQuayModel.buildPortQuay(THREE),
        mods.portStsCraneModel.buildStsCrane(THREE),
        mods.portYardCraneModel.buildRmgCrane(THREE),
        mods.portShuttleModel.buildPortShuttle(THREE),
        mods.shipModel.buildContainerShip(THREE),
        mods.shipFx.createShipFx(THREE),
      ];
      for (const o of objs) {
        o.dispose();
        o.dispose();
      }
    },
  },
  {
    id: "T2-P8-03",
    tier: 2,
    features: ["P8"],
    title: "ship_model.setMooringLines handles empty/zero-tension/invalid lines safely",
    run({ THREE, mods }) {
      const m = mods.shipModel.buildContainerShip(THREE);
      try {
        assert.equal(m.setMooringLines([]), 0);
        assert.equal(m.setMooringLines([{ from: [0, 0, 0], to: [1, 1, 1], tension: 0 }]), 0);
        assert.equal(m.setMooringLines([null, {}]), 0);
      } finally {
        m.dispose();
      }
    },
  },
  {
    id: "T2-P8-04",
    tier: 2,
    features: ["P8"],
    title: "ship_fx.reset() zeros all 4 pooled InstancedMesh counts cleanly",
    run({ THREE, mods }) {
      const fx = mods.shipFx.createShipFx(THREE);
      try {
        fx.update({ x: 0, y: 0, heading: 0, surgeU: 6, throttle: 1, bowThruster: 1, sternThruster: 1 }, 0.2, 1.0);
        assert.ok(fx.getTotalActiveCount() > 0);
        fx.reset();
        assert.equal(fx.getTotalActiveCount(), 0);
      } finally {
        fx.dispose();
      }
    },
  },

  // =========================================================================
  // P9 — Controls, OSD & Audio Edge / Safety Guards
  // =========================================================================
  {
    id: "T2-P9-01",
    tier: 2,
    features: ["P9"],
    title: "ship_controls NEVER steals chat input, open modals, Escape, or F-keys",
    run({ mods }) {
      const { win, doc, makeEl } = makeFakeWindowDocCanvas();
      const ctrl = mods.shipControls.createShipControls({ window: win, document: doc });
      try {
        ctrl.lock({ skipCamera: true });
        const input = makeEl("input");
        doc.activeElement = input;
        const chatEv = win.dispatch("keydown", { code: "KeyW", key: "w", target: input });
        assert.equal(chatEv.defaultPrevented, false, "chat input must not be stolen");
        assert.equal(ctrl.eot, 0);

        doc.activeElement = null;
        const escEv = win.dispatch("keydown", { code: "Escape", key: "Escape" });
        assert.equal(escEv.defaultPrevented, false, "Escape must pass through");
        const f1Ev = win.dispatch("keydown", { code: "F1", key: "F1" });
        assert.equal(f1Ev.defaultPrevented, false, "F-keys must pass through");
      } finally {
        ctrl.dispose();
      }
    },
  },
  {
    id: "T2-P9-02",
    tier: 2,
    features: ["P9"],
    title: "ship_controls refuses lock when another vehicle occupies player (unless force)",
    run({ mods }) {
      const { win, doc } = makeFakeWindowDocCanvas();
      const ctrl = mods.shipControls.createShipControls({
        window: win,
        document: doc,
        isOtherVehicleOccupied: () => true,
      });
      try {
        const res = ctrl.lock({ skipCamera: true });
        assert.equal(res.ok, false);
        assert.equal(res.reason, "other-vehicle-occupied");
        assert.equal(ctrl.lock({ skipCamera: true, force: true }).ok, true);
      } finally {
        ctrl.dispose();
      }
    },
  },
  {
    id: "T2-P9-03",
    tier: 2,
    features: ["P9"],
    title: "ship_osd performs 0 DOM writes after dispose() & tolerates null document",
    run({ mods }) {
      const nullOsd = mods.shipOsd.createShipOsd({ document: null });
      nullOsd.update({ heading: 0 });
      nullOsd.dispose();

      const { doc } = makeFakeWindowDocCanvas();
      const osd = mods.shipOsd.createShipOsd({ document: doc });
      osd.update({ heading: 0, eot: 1 });
      osd.dispose();
      osd.update({ heading: 1, eot: 3 });
      assert.equal(doc.getElementById("hb-ship-osd"), null);
    },
  },
  {
    id: "T2-P9-04",
    tier: 2,
    features: ["P9"],
    title: "port_audio degrades cleanly on BareMockCtx (no Biquad/Panner) & null bus",
    run({ mods }) {
      const bare = makeAudioBus(BareMockCtx);
      const a1 = mods.portAudio.createPortAudio({ bus: bare });
      assert.equal(a1.updateShip("S1", { pos: [0, 0, 0], eot: 1 }), true);
      assert.equal(a1.playFoghorn([0, 0, 0]), true);
      assert.equal(a1.playTwistlockClunk([0, 0, 0], true), true);
      a1.dispose();

      const aNull = mods.portAudio.createPortAudio({ bus: null });
      assert.equal(aNull.updateShip("S1", { pos: [0, 0, 0] }), false);
      assert.equal(aNull.playFoghorn([0, 0, 0]), false);
      aNull.dispose();
    },
  },

  // =========================================================================
  // P10 — Manager & Warehouse Bridge Rejections
  // =========================================================================
  {
    id: "T2-P10-01",
    tier: 2,
    features: ["P10"],
    title: "deliverToWarehousePad rejects unknown pad ID & before buildTerminal",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        assert.throws(() => rig.api.terminal.deliverToWarehousePad("C1"), /not built/i);
        rig.api.terminal.buildTerminal({ populateYard: false });
        assert.throws(() => rig.api.terminal.deliverToWarehousePad("C99"), /Unknown warehouse drop pad/i);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-P10-02",
    tier: 2,
    features: ["P10"],
    title: "Re-delivering to same Warehouse Drop Pad demotes old container without leaking GUIDs",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.terminal.buildTerminal({ populateYard: false });
        const first = rig.api.terminal.deliverToWarehousePad("C1", { wcid: 4000021 });
        const second = rig.api.terminal.deliverToWarehousePad("C1", { wcid: 4000022 });
        assert.equal(rig.api.containers.list().length, 1);
        assert.equal(rig.api.containers.get(first.guid), null);
        assert.ok(rig.api.containers.get(second.guid));
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-P10-03",
    tier: 2,
    features: ["P10"],
    title: "ShipManager.setHatchCover refuses opening hatch when deck cargo rests on hatch",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.ship.spawnShip("S-HATCH", { spawnAtBerth: "B1", moored: true, populateCargo: false });
        rig.api.ship.loadContainer("S-HATCH", 4, 1, 82, { wcid: 4000021 });
        const res = rig.api.ship.setHatchCover("S-HATCH", 4, true, true);
        assert.equal(res.ok, false);
        assert.equal(rig.api.ship.setHatchCover("S-HATCH", 99, true).ok, false);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-P10-04",
    tier: 2,
    features: ["P10"],
    title: "Removing boarded ship automatically exits helm & restores input funnel",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.ship.spawnShip("S-REM", { spawnAtBerth: "B1", moored: true });
        rig.api.ship.board("S-REM");
        assert.equal(rig.api.ship.getBoardedShipId(), "S-REM");
        rig.api.ship.removeShip("S-REM");
        assert.equal(rig.api.ship.getBoardedShipId(), null);
        assert.equal(rig.api.ship.getControls().locked, false);
      } finally {
        rig.cleanup();
      }
    },
  },
];
