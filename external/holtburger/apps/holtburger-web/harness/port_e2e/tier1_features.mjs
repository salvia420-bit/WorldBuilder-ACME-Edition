// harness/port_e2e/tier1_features.mjs
// Tier 1: Opaque-Box Feature Coverage Matrix (40 tests: 4 per Feature P1-P10).

import {
  FullMockCtx,
  assert,
  assertFinitePose,
  assertNoNaNDeep,
  countDrawCalls,
  countLights,
  driveVehiclesPromise,
  lintManifest,
  lintSource,
  makeAudioBus,
  makeCsmState,
  makeFakeWindowDocCanvas,
  makePortTestRig,
  readVehicleSource,
  renderWithFakeWebGL2,
  spyDisposal,
  stepUntil,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // P1 — Site A Waterfront Coordinates, Elevation, Swell & Reserved IDs
  // =========================================================================
  {
    id: "T1-P1-01",
    tier: 1,
    features: ["P1"],
    title: "Site A origin, warehouse adjacency seam Y=47670 & WCID/GUID disjointness",
    run({ mods }) {
      const { PORT_ORIGIN, WAREHOUSE_PORT_ORIGIN, PORT_SITE, PORT_WCID, PORT_DEPLOYABLE_KIND, WAREHOUSE_DROP_PADS } = mods.portSpecs;
      const { WAREHOUSE_WCID, WAREHOUSE_DEPLOYABLE_KIND } = mods.warehouseSpecs;
      assert.deepEqual([...PORT_ORIGIN], [44960, 47880, 0]);
      assert.deepEqual([...WAREHOUSE_PORT_ORIGIN], [44960, 47625, 0]);
      assert.equal(PORT_SITE.warehouseMaxY, 47670);
      assert.equal(PORT_SITE.yardMinY, 47670);
      assert.deepEqual([...WAREHOUSE_DROP_PADS.C1.pos], [44920, 47657.5, 0]);
      assert.deepEqual([...WAREHOUSE_DROP_PADS.C2.pos], [44936, 47657.5, 0]);
      assert.deepEqual([...WAREHOUSE_DROP_PADS.C3.pos], [44952, 47654.43, 0]);
      const whWcids = new Set(Object.values(WAREHOUSE_WCID));
      for (const w of Object.values(PORT_WCID)) {
        assert.ok(w >= 4000050 && w <= 4000069 && !whWcids.has(w), `clean port WCID ${w}`);
      }
      const whKinds = new Set(Object.values(WAREHOUSE_DEPLOYABLE_KIND));
      for (const k of Object.values(PORT_DEPLOYABLE_KIND)) {
        assert.ok(k >= 23 && !whKinds.has(k), `clean port kind ${k}`);
      }
    },
  },
  {
    id: "T1-P1-02",
    tier: 1,
    features: ["P1"],
    title: "Quay approach ramp smooth elevation & 4.76 deg slope profile",
    run({ mods }) {
      const { PORT_ORIGIN, quayRampZ, quayRampPitch } = mods.portSpecs;
      assert.equal(quayRampZ(47800, PORT_ORIGIN), 0.0);
      assert.equal(quayRampZ(47810, PORT_ORIGIN), 0.0);
      assert.ok(Math.abs(quayRampZ(47822, PORT_ORIGIN) - 1.0) < 1e-6);
      assert.equal(quayRampZ(47834, PORT_ORIGIN), 2.0);
      assert.equal(quayRampZ(47880, PORT_ORIGIN), 2.0);
      assert.equal(quayRampZ(47885, PORT_ORIGIN), 0.0);
      const pNorth = quayRampPitch(47822, 0.0, PORT_ORIGIN);
      const pSouth = quayRampPitch(47822, Math.PI, PORT_ORIGIN);
      assert.ok(pNorth > 0.08 && pNorth < 0.09, `north pitch ${pNorth}`);
      assert.ok(Math.abs(pNorth + pSouth) < 1e-6);
      assert.ok(Math.cos(pNorth) > 0.9945, "ramp slope stays within 6 deg sidelifter/semi limit");
    },
  },
  {
    id: "T1-P1-03",
    tier: 1,
    features: ["P1"],
    title: "Exact terrain.js waterSwellAt & 24 m waterSwellLattice parity",
    run({ mods }) {
      const { waterSwellAt, waterSwellLattice } = mods.portSpecs;
      for (let t = 0; t <= 12; t += 1.5) {
        const s = waterSwellAt(44960, 47920, t);
        const l = waterSwellLattice(44960, 47920, t);
        assert.ok(Math.abs(s) <= 0.25001, `swell within +-0.25 m (${s})`);
        assert.ok(Math.abs(l) <= 0.25001, `lattice swell within +-0.25 m (${l})`);
      }
      // Lattice corner equals continuous formula exactly
      assert.ok(Math.abs(waterSwellLattice(44976, 47904, 3.0) - waterSwellAt(44976, 47904, 3.0)) < 1e-9);
    },
  },
  {
    id: "T1-P1-04",
    tier: 1,
    features: ["P1"],
    title: "quayWallSdf, estimateChartDepthM & buildPortLayout connectivity",
    run({ mods }) {
      const { PORT_ORIGIN, quayWallSdf, estimateChartDepthM, buildPortLayout } = mods.portSpecs;
      assert.ok(quayWallSdf(44960, 47900, PORT_ORIGIN) > 19.0);
      assert.ok(quayWallSdf(44960, 47860, PORT_ORIGIN) < 0.0);
      assert.ok(estimateChartDepthM(44960, 47890, 20, PORT_ORIGIN) >= 14.0);
      assert.equal(estimateChartDepthM(44960, 47890, 10, PORT_ORIGIN), 0.0);
      const layout = buildPortLayout(PORT_ORIGIN);
      assertNoNaNDeep(layout, "portLayout");
      assert.equal(layout.bollards.length, 17);
      assert.equal(layout.fenders.length, 25);
      assert.equal(layout.stsCranes.length, 2);
      assert.equal(layout.yardCranes.length, 3);
      assert.ok(layout.graph.nodes.length >= 25 && layout.graph.edges.length >= 25);
    },
  },

  // =========================================================================
  // P2 — ISO 9711 BRT Stacking & ISO 6346 Container Specs
  // =========================================================================
  {
    id: "T1-P2-01",
    tier: 1,
    features: ["P2"],
    title: "ISO 668 container geometry parity with container_models.js & ISO 6346 BIC",
    run({ mods }) {
      const { ISO_CONTAINERS, formatIso6346Bic } = mods.portSpecs;
      const { ISO_CONTAINER_SPECS } = mods.containerModels;
      for (const wcid of [4000020, 4000021, 4000022]) {
        assert.equal(ISO_CONTAINERS[wcid].extW, ISO_CONTAINER_SPECS[wcid].external.width);
        assert.equal(ISO_CONTAINERS[wcid].extL, ISO_CONTAINER_SPECS[wcid].external.length);
        assert.equal(ISO_CONTAINERS[wcid].extH, ISO_CONTAINER_SPECS[wcid].external.height);
      }
      const bic = formatIso6346Bic(123456, "HLTB", "U");
      assert.match(bic, /^[A-Z]{3} U \d{6}-\d$/);
    },
  },
  {
    id: "T1-P2-02",
    tier: 1,
    features: ["P2"],
    title: "ISO 9711 odd=20ft / even=40ft yard stacking & cumulative 2.591/2.896 m height",
    run({ mods }) {
      const { createYardStackStore } = mods.portKinematics;
      const store = createYardStackStore();
      const r1 = store.place("A1", 2, 1, 1, { wcid: 4000022 }); // 40HC = 2.896
      const r2 = store.place("A1", 2, 1, 2, { wcid: 4000021 }); // 40ft = 2.591
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.ok(Math.abs((r2.entry.z - r1.entry.z) - 2.896) < 1e-4);
      const r20a = store.place("A1", 5, 2, 1, { wcid: 4000020 });
      const r20b = store.place("A1", 7, 2, 1, { wcid: 4000020 });
      const r40OnDual20 = store.place("A1", 4, 2, 2, { wcid: 4000021 });
      assert.equal(r20a.ok, true);
      assert.equal(r20b.ok, true);
      assert.equal(r40OnDual20.ok, true, "40ft cleanly stacks atop dual-20ft odd sub-bays 5 & 7");
    },
  },
  {
    id: "T1-P2-03",
    tier: 1,
    features: ["P2"],
    title: "Ship ISO 9711 hold tank-top z=+0.45 m (> +0.25 m max swell) & deck tiers 82..88",
    run({ mods }) {
      const { SHIP_SPECS, PORT_SITE, computeShipSlotLocalPose } = mods.portSpecs;
      assert.ok(SHIP_SPECS.holdTankTopZ > PORT_SITE.waterMaxSwellM + 0.15, "hold tank-top clears max wave crest");
      const holdP = computeShipSlotLocalPose(4, 1, 2, 4000021);
      const deckP = computeShipSlotLocalPose(4, 1, 82, 4000021);
      assert.equal(holdP.z, 0.45);
      assert.equal(deckP.z, 3.95);
      assert.equal(holdP.inHold, true);
      assert.equal(deckP.inHold, false);
    },
  },
  {
    id: "T1-P2-04",
    tier: 1,
    features: ["P2"],
    title: "formatBrtCode / parseBrtCode round-trip & yard/ship odd-even bay pairing",
    run({ mods }) {
      const { formatBrtCode, parseBrtCode, yardOddPairForEvenBay, yardEvenBayForOddBay, shipOddPairForEvenBay, shipEvenBayForOddBay } = mods.portSpecs;
      const code = formatBrtCode(4, 2, 84);
      assert.equal(code, "040284");
      assert.deepEqual(parseBrtCode(code), { bay: 4, row: 2, tier: 84, brt: "040284" });
      assert.deepEqual(yardOddPairForEvenBay(4), [5, 7]);
      assert.equal(yardEvenBayForOddBay(7), 4);
      assert.deepEqual([...shipOddPairForEvenBay(6)], [9, 11]);
      assert.equal(shipEvenBayForOddBay(11), 6);
    },
  },

  // =========================================================================
  // P3 — Ship-to-Shore (STS) Gantry Crane Kinematics & Interlocks
  // =========================================================================
  {
    id: "T1-P3-01",
    tier: 1,
    features: ["P3"],
    title: "STS crane state creation, outreach reachability over ship & gantry travel",
    run({ mods }) {
      const { PORT_ORIGIN, BERTH_MOORED_OFFSET_Y } = mods.portSpecs;
      const { createStsCraneState, stepStsCrane, worldYToStsTrolleyY } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", localX: -80, origin: PORT_ORIGIN });
      const furthestRowY = PORT_ORIGIN[1] + BERTH_MOORED_OFFSET_Y + 3.9;
      const ty = worldYToStsTrolleyY(furthestRowY, st);
      assert.ok(ty > 20 && ty < 38, `STS trolley reaches furthest ship row (ty=${ty})`);
      stepUntil(() => stepStsCrane(st, { targetX: st.x + 12, targetTrolleyY: ty }, 1 / 30), () => Math.abs(st.trolleyY - ty) < 0.05, 600);
      assert.ok(Math.abs(st.trolleyY - ty) < 0.05);
    },
  },
  {
    id: "T1-P3-02",
    tier: 1,
    features: ["P3"],
    title: "STS boom stow / deploy cycle respects 0 <-> 80 deg envelope",
    run({ mods }) {
      const { STS_CRANE_SPECS } = mods.portSpecs;
      const { createStsCraneState, stepStsCrane } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", boomStowed: false });
      stepUntil(() => stepStsCrane(st, { boomStowed: true }, 1 / 30), () => st.boomAngle >= STS_CRANE_SPECS.boomStowedAngleRad - 0.01, 600);
      assert.ok(st.boomAngle >= STS_CRANE_SPECS.boomStowedAngleRad - 0.01);
      stepUntil(() => stepStsCrane(st, { boomStowed: false }, 1 / 30), () => st.boomAngle <= 0.01, 600);
      assert.ok(st.boomAngle <= 0.01);
    },
  },
  {
    id: "T1-P3-03",
    tier: 1,
    features: ["P3"],
    title: "STS shared-rail anti-collision enforces >= 26.0 m separation",
    run({ mods }) {
      const { STS_CRANE_SPECS } = mods.portSpecs;
      const { createStsCraneState, enforceStsRailAntiCollision } = mods.portKinematics;
      const c1 = createStsCraneState({ id: "STS-1", localX: -10 });
      const c2 = createStsCraneState({ id: "STS-2", localX: +10 });
      c1.targetX = c2.x;
      c2.targetX = c1.x;
      const res = enforceStsRailAntiCollision([c1, c2]);
      assert.equal(res.clamped, true);
      assert.ok(c2.x - c1.x >= STS_CRANE_SPECS.minCraneSeparationM - 1e-4);
      assert.ok(c2.targetX - c1.targetX >= STS_CRANE_SPECS.minCraneSeparationM - 1e-4);
    },
  },
  {
    id: "T1-P3-04",
    tier: 1,
    features: ["P3"],
    title: "STS multi-phase transfer cycle picks, hoists, traverses, places & completes",
    run({ mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { createStsCraneState, stepStsTransferCycle } = mods.portKinematics;
      const st = createStsCraneState({ id: "STS-1", localX: -80, origin: PORT_ORIGIN });
      const job = {
        pickPos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] + 10, 8.5],
        placePos: [PORT_ORIGIN[0] - 80, PORT_ORIGIN[1] - 13, 5.9],
        container: { wcid: 4000021, sizeFt: 40 },
      };
      let picked = false, placed = false, done = false;
      for (let i = 0; i < 1800 && !done; i++) {
        const r = stepStsTransferCycle(st, job, 1 / 30);
        if (r.pickedEvent) picked = true;
        if (r.placedEvent) placed = true;
        done = r.done;
      }
      assert.equal(picked, true);
      assert.equal(placed, true);
      assert.equal(done, true);
      assert.equal(st.carriedContainer, null);
    },
  },

  // =========================================================================
  // P4 — Yard Cranes (RMG-1/2, RTG-1) Kinematics & Separation
  // =========================================================================
  {
    id: "T1-P4-01",
    tier: 1,
    features: ["P4"],
    title: "RMG crane gantry, trolley & telescoping 20ft/40ft spreader kinematics",
    run({ mods }) {
      const { STS_CRANE_SPECS } = mods.portSpecs;
      const { createYardCraneState, stepYardCrane } = mods.portKinematics;
      const st = createYardCraneState({ id: "RMG-1", type: "RMG" });
      stepUntil(() => stepYardCrane(st, { targetSpreaderLen: STS_CRANE_SPECS.spreaderLen20M, targetTrolleyY: -6.0 }, 1 / 30), () => Math.abs(st.spreaderLen - 6.058) < 0.05, 300);
      assert.ok(Math.abs(st.spreaderLen - 6.058) < 0.05);
    },
  },
  {
    id: "T1-P4-02",
    tier: 1,
    features: ["P4"],
    title: "RTG 90 deg wheel-steer interlock before lateral Y block-change crabbing",
    run({ mods }) {
      const { createYardCraneState, stepYardCrane } = mods.portKinematics;
      const st = createYardCraneState({ id: "RTG-1", type: "RTG", y: 47723 });
      const origY = st.y;
      stepYardCrane(st, { targetY: origY + 12 }, 1 / 30);
      assert.equal(st.y, origY, "RTG holds Y while steering bogies toward 90 deg");
      stepUntil(() => stepYardCrane(st, { targetY: origY + 12 }, 1 / 30), () => st.wheelSteerRad > 1.5 && st.y > origY + 2, 300);
      assert.ok(st.y > origY + 2, "RTG crabs laterally once wheels reach 90 deg");
    },
  },
  {
    id: "T1-P4-03",
    tier: 1,
    features: ["P4"],
    title: "Yard crane same-runway separation enforces >= 22.0 m clearance",
    run({ mods }) {
      const { YARD_CRANE_SPECS } = mods.portSpecs;
      const { createYardCraneState, enforceYardCraneSeparation } = mods.portKinematics;
      const r1 = createYardCraneState({ id: "RMG-1", x: 44950, y: 47781, minX: 44792, maxX: 45124 });
      const r2 = createYardCraneState({ id: "RMG-2", x: 44960, y: 47781, minX: 44792, maxX: 45124 });
      const res = enforceYardCraneSeparation([r1, r2]);
      assert.equal(res.clamped, true);
      assert.ok(r2.x - r1.x >= YARD_CRANE_SPECS.minCraneSeparationM - 1e-4);
    },
  },
  {
    id: "T1-P4-04",
    tier: 1,
    features: ["P4"],
    title: "Yard crane TTL-to-stack transfer cycle picks & places deterministically",
    run({ mods }) {
      const { createYardCraneState, stepYardTransferCycle } = mods.portKinematics;
      const st = createYardCraneState({ id: "RMG-1", x: 44870, y: 47781, minX: 44792, maxX: 44948 });
      const job = {
        pickPos: [44870, 47791.5, 3.91],
        placePos: [44870, 47775.7, 2.60],
        container: { wcid: 4000021, sizeFt: 40 },
      };
      let picked = false, placed = false, done = false;
      for (let i = 0; i < 1500 && !done; i++) {
        const r = stepYardTransferCycle(st, job, 1 / 30);
        if (r.pickedEvent) picked = true;
        if (r.placedEvent) placed = true;
        done = r.done;
      }
      assert.equal(picked && placed && done, true);
    },
  },

  // =========================================================================
  // P5 — Terminal Tractor Shuttles, A* Road Routing & Traffic Reservation
  // =========================================================================
  {
    id: "T1-P5-01",
    tier: 1,
    features: ["P5"],
    title: "A* road router connects quay portal B1 all the way to Warehouse Drop Pad C1",
    run({ mods }) {
      const { buildPortLayout } = mods.portSpecs;
      const { findRoadPath } = mods.portKinematics;
      const layout = buildPortLayout();
      const path = findRoadPath(layout.graph, "quay_lane_b1", "wh_pad_C1");
      assert.ok(path.length >= 6, `path length ${path.length}`);
      assert.equal(path[0].id, "quay_lane_b1");
      assert.equal(path[path.length - 1].id, "wh_pad_C1");
    },
  },
  {
    id: "T1-P5-02",
    tier: 1,
    features: ["P5"],
    title: "Shuttle kinematics follow quay approach ramp with continuous Z & pitch",
    run({ mods }) {
      const { PORT_ORIGIN, quayRampZ } = mods.portSpecs;
      const { createShuttleState, stepShuttle } = mods.portKinematics;
      const st = createShuttleState({ id: "TT-1", x: PORT_ORIGIN[0], y: 47805, heading: 0, origin: PORT_ORIGIN });
      const wps = [{ x: PORT_ORIGIN[0], y: 47840 }];
      let sawSlope = false;
      for (let i = 0; i < 600; i++) {
        const r = stepShuttle(st, wps, 1 / 30, { origin: PORT_ORIGIN });
        assert.ok(Math.abs(st.z - quayRampZ(st.y, PORT_ORIGIN)) < 1e-4);
        if (st.y > 47812 && st.y < 47832 && st.pitch > 0.04) sawSlope = true;
        if (r.arrived) break;
      }
      assert.equal(sawSlope, true);
      assert.ok(Math.abs(st.z - 2.0) < 1e-4);
    },
  },
  {
    id: "T1-P5-03",
    tier: 1,
    features: ["P5"],
    title: "PortReservationGrid slows & stops trailing shuttle behind lead shuttle",
    run({ mods }) {
      const { PortReservationGrid } = mods.portKinematics;
      const g = new PortReservationGrid();
      g.updateAgent("TT-1", 44900, 47750, 0, 5);
      g.updateAgent("TT-2", 44900, 47772, 0, 0); // 22 m ahead (between stop 18 and slow 26)
      const fSlow = g.speedFactorFor("TT-1", 44900, 47750, 0);
      assert.ok(fSlow > 0 && fSlow < 1, `expected partial slow factor, got ${fSlow}`);
      g.updateAgent("TT-2", 44900, 47765, 0, 0); // 15 m ahead (<= stop 18)
      assert.equal(g.speedFactorFor("TT-1", 44900, 47750, 0), 0.0);
    },
  },
  {
    id: "T1-P5-04",
    tier: 1,
    features: ["P5"],
    title: "Shuttle chassis deckZ === 1.32 m matches trailer_models CHASSIS_DECK_Z",
    run({ mods }) {
      const { SHUTTLE_SPECS } = mods.portSpecs;
      assert.equal(SHUTTLE_SPECS.deckZ, 1.32);
    },
  },

  // =========================================================================
  // P6 — Container Ship 3+3 Wave-Locked Hydrodynamics
  // =========================================================================
  {
    id: "T1-P6-01",
    tier: 1,
    features: ["P6"],
    title: "Ship EOT forward/astern acceleration & rudder turning circle",
    run({ mods }) {
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const st = createShipState({ x: 44960, y: 48200, heading: 0, mode: "manual" });
      for (let i = 0; i < 300; i++) stepShipHydrodynamics(st, { throttle: 1.0, targetRudderRad: 0.4 }, 1 / 30);
      assert.ok(st.surgeU > 2.5, `ship accelerated (${st.surgeU})`);
      assert.ok(st.heading > 0.15 && st.heading < Math.PI, `starboard rudder turned vessel CW (${st.heading})`);
    },
  },
  {
    id: "T1-P6-02",
    tier: 1,
    features: ["P6"],
    title: "Bow & stern tunnel thrusters produce pure lateral crabbing & counter-pivot",
    run({ mods }) {
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const stCrab = createShipState({ x: 44960, y: 48200, heading: 0, mode: "manual" });
      for (let i = 0; i < 150; i++) stepShipHydrodynamics(stCrab, { throttle: 0, targetRudderRad: 0, bowThruster: 1, sternThruster: 1 }, 1 / 30);
      assert.ok(stCrab.x > 44962, "parallel starboard thrusters crab vessel +X");

      const stPiv = createShipState({ x: 44960, y: 48200, heading: 0, mode: "manual" });
      for (let i = 0; i < 150; i++) stepShipHydrodynamics(stPiv, { throttle: 0, targetRudderRad: 0, bowThruster: 1, sternThruster: -1 }, 1 / 30);
      assert.ok(stPiv.yawRateR > 0.05, "counter-pivot thrusters rotate vessel in place");
    },
  },
  {
    id: "T1-P6-03",
    tier: 1,
    features: ["P6"],
    title: "3-DOF wave-locked buoyancy heave/pitch/roll & moored damping",
    run({ mods }) {
      const { createShipState, stepShipHydrodynamics } = mods.shipKinematics;
      const freeShip = createShipState({ x: 44960, y: 48200, heading: 0.4, mode: "manual" });
      const mooredShip = createShipState({ spawnAtBerth: "B1", moored: true, mode: "manual" });
      let maxFreeZ = 0, maxMooredZ = 0;
      for (let i = 0; i < 360; i++) {
        stepShipHydrodynamics(freeShip, { throttle: 0 }, 1 / 30);
        stepShipHydrodynamics(mooredShip, { throttle: 0 }, 1 / 30);
        maxFreeZ = Math.max(maxFreeZ, Math.abs(freeShip.z));
        maxMooredZ = Math.max(maxMooredZ, Math.abs(mooredShip.z));
      }
      assert.ok(maxFreeZ > 0.02 && maxFreeZ < 0.35, `free ship heaves with swell (${maxFreeZ})`);
      assert.ok(maxMooredZ < maxFreeZ, "moored ship heave damped relative to open sea");
    },
  },
  {
    id: "T1-P6-04",
    tier: 1,
    features: ["P6"],
    title: "computeMooringLines produces 6 taut hawser lines from bitts to quay bollards",
    run({ mods }) {
      const { createShipState, computeMooringLines } = mods.shipKinematics;
      const st = createShipState({ spawnAtBerth: "B1", moored: true });
      const lines = computeMooringLines(st);
      assert.equal(lines.length, 6);
      for (const ln of lines) {
        assertFinitePose(ln.from, "hawser.from");
        assertFinitePose(ln.to, "hawser.to");
        assert.ok(ln.tension > 0.9);
      }
    },
  },

  // =========================================================================
  // P7 — Autonomous Ship Captain State Machine (B1 / B2 / Depart)
  // =========================================================================
  {
    id: "T1-P7-01",
    tier: 1,
    features: ["P7"],
    title: "Autonomous Captain approaches, crabs laterally & moors cleanly at Berth 1",
    run({ mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { CAPTAIN_STATE, createShipState, commandShipGoToBerth, stepAutonomousCaptain } = mods.shipKinematics;
      const st = createShipState({ x: PORT_ORIGIN[0] - 80, y: PORT_ORIGIN[1] + 58, heading: Math.PI * 0.5 });
      commandShipGoToBerth(st, "B1");
      stepUntil(() => stepAutonomousCaptain(st, 1 / 30), () => st.moored && st.captainState === CAPTAIN_STATE.CARGO_OPS, 3600);
      assert.equal(st.moored, true);
      assert.equal(st.mooredBerthId, "B1");
      assert.equal(st.captainState, CAPTAIN_STATE.CARGO_OPS);
    },
  },
  {
    id: "T1-P7-02",
    tier: 1,
    features: ["P7"],
    title: "Autonomous Captain berths cleanly at Berth 2 (B2)",
    run({ mods }) {
      const { PORT_ORIGIN } = mods.portSpecs;
      const { CAPTAIN_STATE, createShipState, commandShipGoToBerth, stepAutonomousCaptain } = mods.shipKinematics;
      const st = createShipState({ x: PORT_ORIGIN[0] + 120, y: PORT_ORIGIN[1] + 58, heading: Math.PI * 0.5 });
      commandShipGoToBerth(st, "B2");
      stepUntil(() => stepAutonomousCaptain(st, 1 / 30), () => st.moored && st.captainState === CAPTAIN_STATE.CARGO_OPS, 3600);
      assert.equal(st.mooredBerthId, "B2");
    },
  },
  {
    id: "T1-P7-03",
    tier: 1,
    features: ["P7"],
    title: "signalCargoOpsComplete transitions CARGO_OPS -> UNMOORING -> DEPARTING",
    run({ mods }) {
      const { CAPTAIN_STATE, createShipState, signalCargoOpsComplete, stepAutonomousCaptain } = mods.shipKinematics;
      const st = createShipState({ spawnAtBerth: "B1", moored: true });
      signalCargoOpsComplete(st);
      stepUntil(() => stepAutonomousCaptain(st, 1 / 30), () => st.captainState === CAPTAIN_STATE.DEPARTING, 300);
      assert.equal(st.moored, false);
      assert.equal(st.captainState, CAPTAIN_STATE.DEPARTING);
    },
  },
  {
    id: "T1-P7-04",
    tier: 1,
    features: ["P7"],
    title: "Ship cargo stability summary computes finite asymmetric trim & list",
    run({ mods }) {
      const { createShipCargoStore } = mods.shipKinematics;
      const cargo = createShipCargoStore();
      cargo.load(2, 3, 82, { wcid: 4000021 }); // forward starboard
      const sum = cargo.computeStabilitySummary();
      assert.equal(sum.count, 1);
      assert.ok(sum.cargoListRad > 0 && Math.abs(sum.cargoListRad) <= 0.025);
      assert.ok(sum.cargoTrimRad < 0 && Math.abs(sum.cargoTrimRad) <= 0.02);
    },
  },

  // =========================================================================
  // P8 — Procedural 3D Models, VFX, GPU Budgets & Manifest Lint
  // =========================================================================
  {
    id: "T1-P8-01",
    tier: 1,
    features: ["P8"],
    title: "All B2/B3 manifests pass lintManifest & all 6 model/FX sources pass lintSource",
    run({ mods }) {
      const manifests = [
        mods.portQuayModel.manifest,
        mods.portStsCraneModel.manifest,
        mods.portYardCraneModel.manifest,
        mods.portShuttleModel.manifest,
        mods.shipModel.manifest,
        mods.shipFx.manifest,
      ];
      for (const m of manifests) {
        const errs = lintManifest(m);
        assert.deepEqual(errs, [], `lintManifest failed on ${m?.id}: ${errs.join(", ")}`);
      }
      for (const f of ["port_quay_model.js", "port_sts_crane_model.js", "port_yard_crane_model.js", "port_shuttle_model.js", "ship_model.js", "ship_fx.js"]) {
        assert.deepEqual(lintSource(readVehicleSource(f)), [], `lintSource failed on ${f}`);
      }
    },
  },
  {
    id: "T1-P8-02",
    tier: 1,
    features: ["P8"],
    title: "Terminal models (Quay, STS, RMG, RTG, StackPool, Shuttle) meet DC caps & 0 lights",
    run({ THREE, mods }) {
      const csm = makeCsmState();
      const quay = mods.portQuayModel.buildPortQuay(THREE, null, { csmState: csm });
      const sts = mods.portStsCraneModel.buildStsCrane(THREE, { csmState: csm });
      const rmg = mods.portYardCraneModel.buildRmgCrane(THREE, { csmState: csm });
      const rtg = mods.portYardCraneModel.buildRtgCrane(THREE, { csmState: csm });
      const pool = mods.portYardCraneModel.createContainerStackPool(THREE, { csmState: csm, maxInstances: 256 });
      const shuttle = mods.portShuttleModel.buildPortShuttle(THREE, { csmState: csm });
      try {
        assert.ok(countDrawCalls(quay.root) <= 16, `quay DC=${countDrawCalls(quay.root)}`);
        assert.ok(countDrawCalls(sts.root) <= 14, `sts DC=${countDrawCalls(sts.root)}`);
        assert.ok(countDrawCalls(rmg.root) <= 12, `rmg DC=${countDrawCalls(rmg.root)}`);
        assert.ok(countDrawCalls(rtg.root) <= 12, `rtg DC=${countDrawCalls(rtg.root)}`);
        assert.ok(countDrawCalls(pool.root) <= 6, `pool DC=${countDrawCalls(pool.root)}`);
        assert.ok(countDrawCalls(shuttle.root) <= 10, `shuttle DC=${countDrawCalls(shuttle.root)}`);
        for (const r of [quay.root, sts.root, rmg.root, rtg.root, pool.root, shuttle.root]) {
          assert.equal(countLights(r), 0);
        }
      } finally {
        quay.dispose(); sts.dispose(); rmg.dispose(); rtg.dispose(); pool.dispose(); shuttle.dispose();
      }
    },
  },
  {
    id: "T1-P8-03",
    tier: 1,
    features: ["P8"],
    title: "Container ship model & pooled ship_fx meet DC caps (<=18+6, <=4), 0 lights & full dispose",
    run({ THREE, mods }) {
      const csm = makeCsmState();
      const ship = mods.shipModel.buildContainerShip(THREE, { csmState: csm });
      const fx = mods.shipFx.createShipFx(THREE);
      const sSpy = spyDisposal(ship.root);
      const fSpy = spyDisposal(fx.root);
      try {
        assert.ok(countDrawCalls(ship.root) <= 24, `ship total DC=${countDrawCalls(ship.root)}`);
        assert.ok(countDrawCalls(fx.root) <= 4, `fx DC=${countDrawCalls(fx.root)}`);
        assert.equal(countLights(ship.root), 0);
        assert.equal(countLights(fx.root), 0);
        fx.update({ x: 44960, y: 48000, heading: 0, surgeU: 5.0, throttle: 1.0, bowThruster: 0.8, sternThruster: 0.8 }, 0.1, 1.0);
        assert.ok(fx.getTotalActiveCount() > 0, "ship_fx emitted wake/prop/thruster particles");
      } finally {
        ship.dispose();
        fx.dispose();
      }
      sSpy.assertAllDisposed("buildContainerShip");
      fSpy.assertAllDisposed("createShipFx");
    },
  },
  {
    id: "T1-P8-04",
    tier: 1,
    features: ["P8"],
    title: "FakeWebGL2 renders terminal quay + cranes + ship + fx with 0 GL/console errors",
    run({ THREE, mods }) {
      const scene = new THREE.Scene();
      const quay = mods.portQuayModel.buildPortQuay(THREE);
      const ship = mods.shipModel.buildContainerShip(THREE);
      const fx = mods.shipFx.createShipFx(THREE);
      scene.add(quay.root, ship.root, fx.root);
      const res = renderWithFakeWebGL2(THREE, scene);
      try {
        assert.equal(res.capturedErrors.length, 0);
        assert.ok(res.emittedDraws > 0);
      } finally {
        res.dispose();
        quay.dispose(); ship.dispose(); fx.dispose();
      }
    },
  },

  // =========================================================================
  // P9 — Human Helm Controls, #hb-ship-osd HUD & Maritime Audio
  // =========================================================================
  {
    id: "T1-P9-01",
    tier: 1,
    features: ["P9"],
    title: "ship_controls locks __inputFunnel, handles EOT/rudder/thrusters/Tab & restores cleanly",
    run({ mods }) {
      const { win, doc, funnelLog } = makeFakeWindowDocCanvas();
      const ctrl = mods.shipControls.createShipControls({ window: win, document: doc });
      try {
        const lk = ctrl.lock({ skipCamera: true });
        assert.equal(lk.ok, true);
        assert.ok(funnelLog.some((e) => e.op === "poison"));
        win.dispatch("keydown", { code: "KeyW", key: "w" });
        win.dispatch("keyup", { code: "KeyW", key: "w" });
        win.dispatch("keydown", { code: "KeyE", key: "e" });
        const out = ctrl.poll(0.1);
        assert.equal(out.eot, 1);
        assert.ok(out.bowThruster > 0 && out.sternThruster > 0);
        win.dispatch("keyup", { code: "KeyE", key: "e" });
        ctrl.restore();
        assert.equal(ctrl.locked, false);
        assert.ok(funnelLog.some((e) => e.op === "unpoison"));
      } finally {
        ctrl.dispose();
      }
    },
  },
  {
    id: "T1-P9-02",
    tier: 1,
    features: ["P9"],
    title: "4-mode nautical camera rig produces finite poses for chase/bridge/wing/overhead",
    run({ mods }) {
      const rig = mods.shipControls.createShipCameraRig();
      const pose = { x: 44880, y: 47888.55, z: 0, heading: Math.PI * 0.5, pitch: 0.01, roll: -0.02 };
      for (const mode of mods.shipControls.SHIP_VIEW_MODES) {
        rig.setView(mode);
        const res = rig.step({ pose, dt: 1 / 60 });
        assert.equal(res.view, mode);
        assertFinitePose(res.cam.pos, `cam-${mode}`);
        assert.ok(res.cam.fov >= 40 && res.cam.fov <= 90);
      }
    },
  },
  {
    id: "T1-P9-03",
    tier: 1,
    features: ["P9"],
    title: "#hb-ship-osd DOM HUD mounts under hb-* IDs, updates dirty-checked telemetry & disposes",
    run({ mods }) {
      const { doc } = makeFakeWindowDocCanvas();
      const osd = mods.shipOsd.createShipOsd({ document: doc });
      try {
        osd.update({
          vesselName: "M/V Dereth Feeder",
          mode: "MANUAL",
          heading: Math.PI * 0.5,
          eot: 2,
          sogMps: 4.5,
          ukcM: 12.0,
          teuCount: 48,
          rudderAngleRad: 0.25,
          bowThruster: 0.5,
          sternThruster: -0.25,
          berthAlignment: { berthId: "B1", fenderGapM: 2.0, foreAftOffsetM: 0.5, headingErrDeg: 1.0, readyToMoor: true },
        });
        assert.equal(osd.isVisible(), true);
        const root = doc.getElementById("hb-ship-osd");
        assert.ok(root && root.style.display === "block");
      } finally {
        osd.dispose();
      }
      assert.equal(doc.getElementById("hb-ship-osd"), null);
    },
  },
  {
    id: "T1-P9-04",
    tier: 1,
    features: ["P9"],
    title: "port_audio synthesizes ship diesel/thruster, foghorn, crane hum, twistlock & ambient",
    run({ mods }) {
      const bus = makeAudioBus(FullMockCtx);
      const audio = mods.portAudio.createPortAudio({ bus });
      try {
        assert.equal(audio.updateShip("S1", { pos: [44960, 47900, 0], eot: 2, bowThruster: 0.7 }, [44960, 47870, 4]), true);
        assert.equal(audio.playFoghorn([44960, 47900, 16]), true);
        assert.equal(audio.updateCrane("STS-1", { pos: [44880, 47865, 20], trolleySpeed: 3.0, active: true }, [44880, 47860, 2]), true);
        assert.equal(audio.playTwistlockClunk([44880, 47865, 10], true), true);
        assert.equal(audio.updateAmbient([44960, 47870, 2], [44960, 47880, 0], true), true);
        const st = audio.stats();
        assert.equal(st.activeShips, 1);
        assert.equal(st.activeCranes, 1);
        assert.equal(st.foghorns, 1);
        assert.equal(st.twistlocks, 1);
      } finally {
        audio.dispose();
      }
      assert.equal(audio.stats().activeShips, 0);
    },
  },

  // =========================================================================
  // P10 — Terminal + Ship Managers & Zero-Edit Warehouse Bridge
  // =========================================================================
  {
    id: "T1-P10-01",
    tier: 1,
    features: ["P10"],
    title: "window.__port facade exposes terminal, ship, warehouse & buildPortAndWarehouse",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        assert.ok(rig.win.__port);
        assert.equal(rig.win.__port.terminal, rig.api.terminal);
        assert.equal(rig.win.__port.ship, rig.api.ship);
        assert.equal(rig.win.__port.warehouse, rig.api.warehouse);
        rig.win.__port.buildPortAndWarehouse();
        assert.equal(rig.api.terminal.stats.built, true);
        assert.equal(rig.api.warehouse.stats.built, true);
        assert.equal(rig.api.ship.stats.shipCount, 1);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-P10-02",
    tier: 1,
    features: ["P10"],
    title: "Zero-Edit Warehouse Bridge promotes ONLY C1/C2/C3 pads & keeps yard out of containers",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.win.__port.buildPortAndWarehouse({ populateYard: true });
        assert.ok(rig.api.terminal.yard.count() >= 100);
        assert.equal(rig.api.containers.list().length, 0);
        const p1 = rig.api.terminal.deliverToWarehousePad("C1", { wcid: 4000021 });
        const p2 = rig.api.terminal.deliverToWarehousePad("C2", { wcid: 4000022 });
        const p3 = rig.api.terminal.deliverToWarehousePad("C3", { wcid: 4000020 });
        assert.equal(rig.api.containers.list().length, 3);
        assert.ok(rig.api.containers.get(p1.guid) && rig.api.containers.get(p2.guid) && rig.api.containers.get(p3.guid));
        rig.api.terminal.pickupFromWarehousePad("C2");
        assert.equal(rig.api.containers.list().length, 2);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-P10-03",
    tier: 1,
    features: ["P10"],
    title: "ShipManager hatch cover, loadContainer, unloadContainer & getCargoSlotWorldPos handshake",
    run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        const s = rig.api.ship.spawnShip("S-HANDSHAKE", { spawnAtBerth: "B1", moored: true, populateCargo: false });
        assert.equal(rig.api.ship.loadContainer("S-HANDSHAKE", 4, 1, 2, { wcid: 4000021 }).ok, true);
        assert.equal(rig.api.ship.setHatchCover("S-HANDSHAKE", 4, true, true).ok, true);
        const wp = rig.api.ship.getCargoSlotWorldPos("S-HANDSHAKE", 4, 1, 2);
        assert.ok(wp && wp.top[2] > 2.9 && wp.bottom[2] >= 0.40);
        assert.equal(rig.api.ship.unloadContainer("S-HANDSHAKE", 4, 1, 2).ok, true);
        assert.equal(s.cargo.count(), 0);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-P10-04",
    tier: 1,
    features: ["P10"],
    title: "PortTerminalManager shuttle + yard crane FIFO promises settle strictly via tick()",
    async run({ THREE, mods }) {
      const rig = makePortTestRig(THREE, mods.index.initVehicles);
      try {
        rig.api.terminal.buildTerminal({ populateYard: true });
        const tt2 = rig.api.terminal.shuttles.get("TT-2");
        const res = await driveVehiclesPromise(rig, tt2.driveToNode("corridor_c2"), { maxSteps: 2400 });
        assert.equal(res.value.arrived, true);
      } finally {
        rig.cleanup();
      }
    },
  },
];
