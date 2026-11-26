// harness/warehouse_e2e/tier2_boundaries.mjs
// Tier 2: Boundary Value Analysis & Corner Cases (60 tests: 5 per Feature F1-F12).

import {
  BareMockCtx,
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
  gridRelease,
  installFakeAudio,
  localBoxInParent,
  makeAudioBus,
  makeCsmState,
  makeTestRig,
  normBox2D,
  rackLoadSlot,
  rackUnloadSlot,
  spyDisposal,
  wrapAngle,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // F1 — NE Flatland Site & Hub Blueprint Boundaries
  // =========================================================================
  {
    id: "T2-F1-01",
    tier: 2,
    features: ["F1"],
    title: "NE Flatland outer slab corner margins vs BodyEdgeMin..Max",
    run({ mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const minX = NE_FLATLAND_SITE.bx[0] * 192;
      const maxX = (NE_FLATLAND_SITE.bx[1] + 1) * 192;
      const minY = NE_FLATLAND_SITE.by[0] * 192;
      const maxY = (NE_FLATLAND_SITE.by[1] + 1) * 192;
      assert.equal(minX, 43776);
      assert.equal(maxX, 45888);
      assert.equal(minY, 46464);
      assert.equal(maxY, 47424);
      const bodyMin = NE_FLATLAND_SITE.bodyEdgeMin ?? 193.0;
      const bodyMax = NE_FLATLAND_SITE.bodyEdgeMax ?? 48767.0;
      assert.ok(minX - bodyMin > 1300);
      assert.ok(bodyMax - maxY > 1300);
      assert.ok(bodyMax - maxX > 1300);
    },
  },
  {
    id: "T2-F1-02",
    tier: 2,
    features: ["F1"],
    title: "buildDefaultHubLayout omitted/undefined arguments",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const l1 = buildDefaultHubLayout();
      const l2 = buildDefaultHubLayout(undefined, undefined);
      assertNoNaNDeep(l1, "layout()");
      assertNoNaNDeep(l2, "layout(undefined, undefined)");
      assert.deepEqual([...l1.origin], [...NE_FLATLAND_SITE.origin]);
      assert.deepEqual([...l2.origin], [...NE_FLATLAND_SITE.origin]);
    },
  },
  {
    id: "T2-F1-03",
    tier: 2,
    features: ["F1"],
    title: "buildDefaultHubLayout non-finite / malformed origin",
    run({ mods }) {
      const { buildDefaultHubLayout } = mods.specs;
      for (const bad of [[NaN, 0, 0], [Infinity, -Infinity, 0], null, "bad", {}]) {
        const l = buildDefaultHubLayout(bad);
        assertNoNaNDeep(l, `layout(${String(bad)})`);
        assert.ok(Array.isArray(l.origin) && l.origin.length >= 2);
      }
    },
  },
  {
    id: "T2-F1-04",
    tier: 2,
    features: ["F1"],
    title: "buildDefaultHubLayout near BodyEdgeMin / BodyEdgeMax",
    run({ mods }) {
      const { buildDefaultHubLayout } = mods.specs;
      for (const edge of [[193.0, 193.0, 0], [48767.0, 48767.0, 0]]) {
        const l = buildDefaultHubLayout(edge);
        assertNoNaNDeep(l, `layout(${edge[0]})`);
        const sb = normBox2D(l.slabBounds);
        assert.ok(sb && sb.x1 >= sb.x0 && sb.y1 >= sb.y0);
      }
    },
  },
  {
    id: "T2-F1-05",
    tier: 2,
    features: ["F1"],
    title: "buildDefaultHubLayout scale extremes (bayCount = 0, 1, 16)",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      for (const bayCount of [0, 1, 16]) {
        const l = buildDefaultHubLayout(NE_FLATLAND_SITE.origin, { bayCount });
        assertNoNaNDeep(l, `layout(bayCount=${bayCount})`);
        assert.ok(Array.isArray(l.rackRows));
      }
      const big = buildDefaultHubLayout(NE_FLATLAND_SITE.origin, { bayCount: 16 });
      let slots = 0;
      for (const r of big.rackRows) {
        slots += (r.bayCount ?? 16) * (r.tierCount ?? 4) * (r.slotsPerBay ?? 2) * (r.doubleSided ? 2 : 1);
      }
      assert.ok(slots >= 768, `bayCount=16 produces high-density rack slots (${slots})`);
    },
  },

  // =========================================================================
  // F2 — Reserved WCIDs & Millimeter Specs Boundaries
  // =========================================================================
  {
    id: "T2-F2-01",
    tier: 2,
    features: ["F2"],
    title: "Millimeter tunnel & clearance exact margin checks",
    run({ mods }) {
      const { AGF_SPECS, AMR_SPECS, STAND_SPECS } = mods.specs;
      const { PALLET_SPECS } = mods.deployableModels;
      const halfSpread = AGF_SPECS.forkCenterX ?? AGF_SPECS.forkSpread / 2;
      const bladeW = AGF_SPECS.forkWidthM ?? AGF_SPECS.bladeWidth ?? AGF_SPECS.forkWidth;
      const innerEdge = halfSpread - bladeW / 2;
      const outerEdge = halfSpread + bladeW / 2;
      assert.ok(innerEdge >= 0.090 + 0.06, `fork inner edge ${innerEdge} inside tunnel >= 0.090`);
      assert.ok(outerEdge <= 0.390 - 0.06, `fork outer edge ${outerEdge} inside tunnel <= 0.390`);
      const bladeThick = AGF_SPECS.forkThicknessM ?? AGF_SPECS.bladeThickness ?? AGF_SPECS.forkThickness;
      const tunnelH = PALLET_SPECS.standard.tunnelMaxZ - PALLET_SPECS.standard.tunnelMinZ;
      assert.ok(bladeThick < tunnelH, `blade thickness ${bladeThick} < ${tunnelH}`);

      const standTW = STAND_SPECS.tunnelWidthM ?? STAND_SPECS.tunnelWidth;
      const standTH = STAND_SPECS.tunnelHeightM ?? STAND_SPECS.tunnelHeight;
      const standRZ = STAND_SPECS.railHeightM ?? STAND_SPECS.railZ;
      const amrW = AMR_SPECS.widthM ?? AMR_SPECS.width;
      const amrLow = AMR_SPECS.loweredHeightM ?? AMR_SPECS.loweredHeight;
      const amrHigh = AMR_SPECS.raisedHeightM ?? AMR_SPECS.raisedHeight;
      const latClearPerSide = (standTW - amrW) / 2;
      assert.ok(latClearPerSide >= 0.039, `AMR lateral clearance/side=${latClearPerSide}`);
      assert.ok(standTH - amrLow >= 0.099, "vertical clearance >= 100mm");
      assert.ok(amrHigh - standRZ >= 0.069, "lift above rail >= 70mm");
    },
  },
  {
    id: "T2-F2-02",
    tier: 2,
    features: ["F2"],
    title: "computeRackSlotLocalPose boundary & out-of-range indices",
    run({ mods }) {
      const { RACK_SPECS, computeRackSlotLocalPose } = mods.specs;
      const p0 = computeRackSlotLocalPose(0, 0, 0, RACK_SPECS);
      const pMax = computeRackSlotLocalPose(7, 3, 1, RACK_SPECS);
      assertNoNaNDeep(p0, "pose(0,0,0)");
      assertNoNaNDeep(pMax, "pose(7,3,1)");

      for (const [b, t, s] of [[-1, 0, 0], [0, -1, 0], [0, 4, 0], [0, 0, -1], [0, 0, 2], [NaN, NaN, NaN]]) {
        let out = null;
        try {
          out = computeRackSlotLocalPose(b, t, s, RACK_SPECS);
        } catch (err) {
          assert.ok(err instanceof Error);
          continue;
        }
        if (out !== null && out !== undefined) {
          assertNoNaNDeep(out, `pose(${b},${t},${s})`);
        }
      }
    },
  },
  {
    id: "T2-F2-03",
    tier: 2,
    features: ["F2"],
    title: "computeRackRowBounds zero, negative & large bayCount",
    run({ mods }) {
      const { RACK_SPECS, computeRackRowBounds } = mods.specs;
      for (const n of [0, -3, NaN, 32]) {
        const b = computeRackRowBounds(n, false, RACK_SPECS);
        if (b !== null && b !== undefined) {
          assertNoNaNDeep(b, `rowBounds(${n})`);
          assert.ok(b.maxX >= b.minX && b.maxY >= b.minY && b.maxZ >= b.minZ);
        }
      }
    },
  },
  {
    id: "T2-F2-04",
    tier: 2,
    features: ["F2"],
    title: "Spec constants immutability (Object.isFrozen)",
    run({ mods }) {
      const specs = mods.specs;
      for (const key of [
        "WAREHOUSE_WCID",
        "WAREHOUSE_DEPLOYABLE_KIND",
        "NE_FLATLAND_SITE",
        "RACK_SPECS",
        "AGF_SPECS",
        "AMR_SPECS",
        "STAND_SPECS",
        "LIFT_TABLE_SPECS",
        "CHARGER_SPECS",
      ]) {
        assert.equal(Object.isFrozen(specs[key]), true, `${key} must be frozen`);
        assert.throws(() => {
          specs[key].__e2eMutate = 1;
        }, TypeError);
      }
    },
  },
  {
    id: "T2-F2-05",
    tier: 2,
    features: ["F2"],
    title: "computeRackSlotLocalPose / computeRackRowBounds with null/undefined rackSpec",
    run({ mods }) {
      const { computeRackSlotLocalPose, computeRackRowBounds } = mods.specs;
      const p = computeRackSlotLocalPose(0, 0, 0, null);
      const b = computeRackRowBounds(4, true, undefined);
      assertNoNaNDeep(p, "pose(null spec)");
      assertNoNaNDeep(b, "bounds(undefined spec)");
      assert.ok(b.width > 10 && b.depth >= 2.2);
    },
  },

  // =========================================================================
  // F3 — AGF Kinematics & 3-Stage Mast Boundaries
  // =========================================================================
  {
    id: "T2-F3-01",
    tier: 2,
    features: ["F3"],
    title: "computeMastStages boundary & out-of-range heights",
    run({ mods }) {
      const { computeMastStages } = mods.kinematics;
      for (const h of [-1, 0, 0.044, 0.045, 1.700, 1.701, 7.250, 7.251, 20, NaN, Infinity]) {
        const st = computeMastStages(h);
        assertNoNaNDeep(st, `mast(${h})`);
      }
      assert.equal(computeMastStages(1.700).freeliftActive, true);
      assert.equal(computeMastStages(1.700).stage2Offset, 0);
      assert.equal(computeMastStages(1.701).freeliftActive, false);
      assert.ok(computeMastStages(1.701).stage2Offset > 0);
      assert.deepEqual(computeMastStages(-1), computeMastStages(0.045));
      assert.deepEqual(computeMastStages(20), computeMastStages(7.250));
    },
  },
  {
    id: "T2-F3-02",
    tier: 2,
    features: ["F3"],
    title: "Container roof-strike interlock (> 1.700 m inside container)",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      let st = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 1.50, speed: 0 };
      for (let i = 0; i < 60; i++) {
        st = stepAgfKinematics(st, { forkHeightM: 3.0 }, 1 / 60, { insideContainer: true });
      }
      assert.ok(st.forkHeightM <= 1.7001, `forkHeightM clamped <= 1.70 inside container (got ${st.forkHeightM})`);
      assert.equal(st.roofStrikeBlocked, true);
    },
  },
  {
    id: "T2-F3-03",
    tier: 2,
    features: ["F3"],
    title: "Tip-over speed cap boundary (0.49 m vs 0.51 m fork height)",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      let sLow = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.49, speed: 0 };
      for (let i = 0; i < 120; i++) {
        sLow = stepAgfKinematics(sLow, { speed: 3.2, forkHeightM: 0.49 }, 1 / 60, {});
      }
      assert.equal(sLow.tipOverSpeedCapped, false);
      assert.ok(sLow.speed > 0.65, `0.49m speed=${sLow.speed} > 0.65`);

      for (const fh of [0.51, 4.70]) {
        let sHigh = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: fh, speed: 2.0 };
        for (let i = 0; i < 120; i++) {
          sHigh = stepAgfKinematics(sHigh, { speed: 3.2, forkHeightM: fh }, 1 / 60, {});
        }
        assert.equal(sHigh.tipOverSpeedCapped, true, `tipOverSpeedCapped at ${fh}`);
        assert.ok(Math.abs(sHigh.speed) <= 0.6005, `capped speed ${sHigh.speed} <= 0.6 at ${fh}`);
      }
    },
  },
  {
    id: "T2-F3-04",
    tier: 2,
    features: ["F3"],
    title: "Rear-steer Ackermann clamping (+-82 deg / +-1.43 rad)",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      const base = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.1, speed: 0 };
      const pos = stepAgfKinematics(base, { steer: 5.0 }, 1.0, {});
      const neg = stepAgfKinematics(base, { steer: -5.0 }, 1.0, {});
      const nanS = stepAgfKinematics(base, { steer: NaN }, 1.0, {});
      assert.ok(Math.abs(pos.steerAngleRad) <= 1.432);
      assert.ok(Math.abs(neg.steerAngleRad) <= 1.432);
      assertNoNaNDeep(nanS, "nanSteer");
    },
  },
  {
    id: "T2-F3-05",
    tier: 2,
    features: ["F3"],
    title: "stepAgfKinematics dt = 0, negative dt, NaN dt, null cmd",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      const base = { x: 3, y: 4, z: 0, heading: 0.5, steerAngleRad: 0.1, forkHeightM: 0.2, speed: 1.0 };
      for (const dt of [0, -0.1, NaN]) {
        const out = stepAgfKinematics(base, null, dt, {});
        assertNoNaNDeep(out, `agf(dt=${dt})`);
        assert.equal(out.x, 3);
        assert.equal(out.y, 4);
        assert.equal(out.heading, 0.5);
      }
    },
  },

  // =========================================================================
  // F4 — Underride AMR & Lift Table Kinematics Boundaries
  // =========================================================================
  {
    id: "T2-F4-01",
    tier: 2,
    features: ["F4"],
    title: "stepAmrKinematics lift clamp [0.260, 0.450] & transit lock during lift",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      for (const targetLiftHeightM of [0.10, 0.80, NaN]) {
        let st = { x: 0, y: 0, heading: 0, liftHeightM: 0.30, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0 };
        for (let i = 0; i < 120; i++) {
          st = stepAmrKinematics(st, { targetLiftHeightM, targetPose: { x: 10, y: 10, heading: 0 } }, 1 / 60);
          assertNoNaNDeep(st, "amrClamp");
          assert.ok(st.liftHeightM >= 0.2599 && st.liftHeightM <= 0.4501, `lift=${st.liftHeightM}`);
        }
      }
      let lifting = { x: 2, y: 2, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0 };
      lifting = stepAmrKinematics(lifting, { targetLiftHeightM: 0.450, targetPose: { x: 20, y: 20, heading: 0 } }, 1 / 60);
      assert.equal(lifting.x, 2);
      assert.equal(lifting.y, 2);
    },
  },
  {
    id: "T2-F4-02",
    tier: 2,
    features: ["F4"],
    title: "stepLiftTable AMR underride interlock blocks lowering",
    run({ mods }) {
      const { stepLiftTable } = mods.kinematics;
      const st = stepLiftTable(
        { heightM: 0.380, moving: false, interlockBlocked: false },
        { targetHeightM: 0.0 },
        1 / 60,
        { amrUnderneath: true }
      );
      assert.equal(st.heightM, 0.380);
      assert.equal(st.moving, false);
      assert.equal(st.interlockBlocked, true);
    },
  },
  {
    id: "T2-F4-03",
    tier: 2,
    features: ["F4"],
    title: "stepLiftTable Pallet Jack deck interlock blocks raising",
    run({ mods }) {
      const { stepLiftTable } = mods.kinematics;
      const st = stepLiftTable(
        { heightM: 0.0, moving: false, interlockBlocked: false },
        { targetHeightM: 0.380 },
        1 / 60,
        { palletJackOnDeck: true }
      );
      assert.equal(st.heightM, 0.0);
      assert.equal(st.moving, false);
      assert.equal(st.interlockBlocked, true);
    },
  },
  {
    id: "T2-F4-04",
    tier: 2,
    features: ["F4"],
    title: "stepLiftTable height clamp [0.000, 0.380] & dt <= 0 / NaN",
    run({ mods }) {
      const { stepLiftTable } = mods.kinematics;
      for (const targetHeightM of [-0.5, 1.0, NaN]) {
        const st = stepLiftTable({ heightM: 0.2, moving: false, interlockBlocked: false }, { targetHeightM }, 1.0, {});
        assertNoNaNDeep(st, "liftClamp");
        assert.ok(st.heightM >= 0.0 && st.heightM <= 0.380);
      }
      for (const dt of [0, -1, NaN]) {
        const st = stepLiftTable({ heightM: 0.2, moving: false, interlockBlocked: false }, { targetHeightM: 0.380 }, dt, {});
        assertNoNaNDeep(st, `liftDt(${dt})`);
        assert.equal(st.heightM, 0.2);
      }
    },
  },
  {
    id: "T2-F4-05",
    tier: 2,
    features: ["F4"],
    title: "stepAmrKinematics omegaMax = 1.8 rad/s clamp & NaN target safety",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      const base = { x: 1, y: 1, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0 };
      const turn = stepAmrKinematics(base, { targetPose: { x: 1, y: 1, heading: Math.PI } }, 0.1);
      assert.ok(Math.abs(wrapAngle(turn.heading)) <= 1.8 * 0.1 + 1e-4, `deltaHeading=${wrapAngle(turn.heading)} <= 0.18`);
      for (const dt of [0, NaN]) {
        const s = stepAmrKinematics(base, { targetPose: { x: NaN, y: Infinity, heading: NaN } }, dt);
        assertNoNaNDeep(s, `amrNaN(dt=${dt})`);
        assert.equal(s.x, 1);
        assert.equal(s.y, 1);
      }
    },
  },

  // =========================================================================
  // F5 — 2D Spatial Reservation Grid Boundaries
  // =========================================================================
  {
    id: "T2-F5-01",
    tier: 2,
    features: ["F5"],
    title: "SpatialReservationGrid conflicting claim by different owner",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      assert.equal(gridClaim(grid, "owner-a", 4, 4, 0.5), true);
      assert.equal(gridClaim(grid, "owner-b", 4, 4, 0.5), false);
      // Re-claim by owner-a still succeeds
      assert.equal(gridClaim(grid, "owner-a", 4, 4, 0.5), true);
    },
  },
  {
    id: "T2-F5-02",
    tier: 2,
    features: ["F5"],
    title: "Exact proximity boundary values (0.799 / 0.801 / 2.199 / 2.201 m) & self-ignore",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid({ cellSizeM: 0.2 });
      assert.equal(gridClaim(grid, "self", 0, 0, 0.1), true);
      // Self at (0,0) must not trigger self-yield
      const selfQ = gridQueryProximity(grid, "self", 0, 0, 0);
      assert.equal(selfQ.stop, false);
      assert.equal(selfQ.slow, false);

      assert.equal(gridClaim(grid, "other", 0.799, 0, 0.1), true);
      assert.equal(gridQueryProximity(grid, "self", 0, 0, 0).stop, true, "0.799m -> stop");

      gridRelease(grid, "other", 0.799, 0);
      assert.equal(gridClaim(grid, "other", 0.801, 0, 0.1), true);
      const q801 = gridQueryProximity(grid, "self", 0, 0, 0);
      assert.equal(q801.stop, false, "0.801m -> not stop");
      assert.equal(q801.slow, true, "0.801m -> slow");

      gridRelease(grid, "other", 0.801, 0);
      assert.equal(gridClaim(grid, "other", 2.199, 0, 0.1), true);
      const q2199 = gridQueryProximity(grid, "self", 0, 0, 0);
      assert.equal(q2199.stop, false);
      assert.equal(q2199.slow, true, "2.199m -> slow");

      gridRelease(grid, "other", 2.199, 0);
      assert.equal(gridClaim(grid, "other", 2.201, 0, 0.1), true);
      const q2201 = gridQueryProximity(grid, "self", 0, 0, 0);
      assert.equal(q2201.stop, false);
      assert.equal(q2201.slow, false, "2.201m -> clear");
    },
  },
  {
    id: "T2-F5-03",
    tier: 2,
    features: ["F5"],
    title: "SpatialReservationGrid idempotent re-claim by same owner",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      assert.equal(gridClaim(grid, "a", 1, 1, 0.6), true);
      assert.equal(gridClaim(grid, "a", 1, 1, 0.6), true);
      assert.equal(gridClaim(grid, "a", 2, 1, 0.6), true);
    },
  },
  {
    id: "T2-F5-04",
    tier: 2,
    features: ["F5"],
    title: "release of unknown owner & clear() idempotence",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      gridClaim(grid, "a", 3, 3, 0.5);
      gridRelease(grid, "unknown", 3, 3);
      assert.equal(gridClaim(grid, "b", 3, 3, 0.5), false, "still owned by a");
      grid.clear();
      grid.clear();
      assert.equal(gridClaim(grid, "b", 3, 3, 0.5), true, "claimable after clear()");
    },
  },
  {
    id: "T2-F5-05",
    tier: 2,
    features: ["F5"],
    title: "SpatialReservationGrid non-finite coordinates (NaN, Infinity)",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      gridClaim(grid, "valid", 10, 10, 0.5);
      const c = gridClaim(grid, "bad", NaN, 0, 0.5);
      assert.equal(c, false);
      const q = gridQueryProximity(grid, "bad", Infinity, -Infinity, 0.5);
      assert.equal(q.stop, false);
      assert.equal(gridClaim(grid, "intruder", 10, 10, 0.5), false, "valid claim intact");
    },
  },

  // =========================================================================
  // F6 — 4-Tier Selective Steel Racking 3D Model Boundaries
  // =========================================================================
  {
    id: "T2-F6-01",
    tier: 2,
    features: ["F6"],
    title: "loadSlot invalid bay, tier, side, slotInBay, or invalid wcid",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      const baseSpy = spyDisposal(row.root);
      let cargoSpy = null;
      let passed = false;
      try {
        const baseDc = countVisibleDrawCalls(row.root);
        const baseTotalDc = countDrawCalls(row.root);
        for (const [b, t, s, slot, wcid] of [
          [-1, 0, 0, 0, 4000010],
          [99, 0, 0, 0, 4000010],
          [0, -1, 0, 0, 4000010],
          [0, 4, 0, 0, 4000010],
          [0, 0, 0, 2, 4000010],
        ]) {
          let r = undefined;
          let threwRange = false;
          try {
            r = rackLoadSlot(row, b, t, s, slot, wcid);
          } catch (err) {
            assert.ok(
              err instanceof RangeError,
              `OOB loadSlot(${b},${t},${s},${slot}) threw non-RangeError: ${err?.name || typeof err}: ${err?.message || err}`
            );
            threwRange = true;
          }
          if (!threwRange) {
            assert.ok(r === false || r === null || r === undefined, `OOB loadSlot returned ${r}`);
          }
        }
        assert.equal(countDrawCalls(row.root), baseTotalDc, "OOB loadSlot must not silently mount meshes");
        assert.equal(countVisibleDrawCalls(row.root), baseDc, "OOB loadSlot must not alter visible draw calls");

        // Verify the rack remains uncorrupted and usable after OOB rejections
        const validRes = rackLoadSlot(row, 0, 0, 0, 0, 4000010);
        assert.notEqual(validRes, false, "valid loadSlot(0,0,0,0,4000010) after OOB rejections should succeed");
        assert.ok(countVisibleDrawCalls(row.root) > baseDc, "valid loadSlot(0,0,0,0,4000010) must mount cargo");

        // Invalid WCID on valid slot mounts fallback pallet or returns false safely without throwing
        for (const badWcid of [0, NaN, 999999]) {
          rackLoadSlot(row, 0, 0, 0, 0, badWcid);
        }
        cargoSpy = spyDisposal(row.root);
        passed = true;
      } finally {
        row.dispose();
      }
      if (passed) {
        baseSpy.assertAllDisposed("T2-F6-01 rackRow");
        cargoSpy?.assertAllDisposed("T2-F6-01 rackRow+cargo");
      }
    },
  },
  {
    id: "T2-F6-02",
    tier: 2,
    features: ["F6"],
    title: "Overwriting occupied rack slot disposes prior cargo resources",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 2, doubleSided: false }, { csmState: makeCsmState() });
      try {
        const baseRes = spyDisposal(row.root);
        rackLoadSlot(row, 0, 1, 0, 0, 4000012);
        // Collect only the newly added cargo resources
        const cargoSpy = spyDisposal(row.root);
        // Reset base items count check: only assert non-base items or overwrite and check delta
        for (const g of baseRes.geometries) cargoSpy.geomCounts.delete(g);
        for (const m of baseRes.materials) cargoSpy.matCounts.delete(m);

        rackLoadSlot(row, 0, 1, 0, 0, 4000002);
        cargoSpy.assertAllDisposed("overwritten slot 4000012");
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T2-F6-03",
    tier: 2,
    features: ["F6"],
    title: "unloadSlot on empty/OOB slot & setHighlightedSlot(null)",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      try {
        const before = countDrawCalls(row.root);
        row.unloadSlot(0, 0, 0, 0);
        row.unloadSlot(99, 9, 0, 0);
        row.setHighlightedSlot(null);
        assert.equal(countDrawCalls(row.root), before);
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T2-F6-04",
    tier: 2,
    features: ["F6"],
    title: "setCargoLodDistance threshold (119 m vs 121 m) & null/NaN camPos",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      try {
        for (let b = 0; b < 4; b++) rackLoadSlot(row, b, 1, 0, 0, 4000010);
        row.setCargoLodDistance([0, 119, 0]);
        const dc119 = countVisibleDrawCalls(row.root);
        row.setCargoLodDistance([0, 121, 0]);
        const dc121 = countVisibleDrawCalls(row.root);
        assert.ok(dc121 < dc119, `121m DC (${dc121}) < 119m DC (${dc119})`);
        row.setCargoLodDistance(null);
        row.setCargoLodDistance([NaN, NaN, NaN]);
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T2-F6-05",
    tier: 2,
    features: ["F6"],
    title: "Rack dispose() on empty row & double dispose()",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 8, doubleSided: true }, { csmState: makeCsmState() });
      const spy = spyDisposal(row.root);
      row.dispose();
      row.dispose();
      spy.assertAllDisposed("emptyRackDoubleDispose");
    },
  },

  // =========================================================================
  // F7 — AGF Forklift 3D Model Boundaries
  // =========================================================================
  {
    id: "T2-F7-01",
    tier: 2,
    features: ["F7"],
    title: "AGF update out-of-range clamping (forkHeightM, sideShiftM, mastTiltRad, steerAngleRad)",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        // Upright mast (mastTiltRad: 0): clamped low forkMinZ = 0.045 flush on supportSurfaceZ = 0
        agf.update({ forkHeightM: -1.0, sideShiftM: -0.5, mastTiltRad: 0, steerAngleRad: -3.0 });
        agf.root.updateMatrixWorld(true);
        const bLow = computeBox3(THREE, agf.root);
        assert.ok(bLow.min.z >= -0.005, `agf.root Box3.min.z=${bLow.min.z} < -0.005`);
        assert.ok(Math.abs(agf.steerAngleRad + mods.specs.AGF_SPECS.maxSteerRad) < 1e-5, "negative steerAngleRad clamped to -82 deg");
        assert.ok(Math.abs(agf.rearSteerPivot.rotation.z + mods.specs.AGF_SPECS.maxSteerRad) < 1e-5, "rearSteerPivot.rotation.z clamped to -82 deg");
        const wpLow = new THREE.Vector3();
        agf.cargoMount.getWorldPosition(wpLow);
        assert.ok(wpLow.z >= -0.005 && wpLow.z <= 0.055, `clamped low cargoMount z=${wpLow.z}`);
        assert.ok(wpLow.x >= -0.105 && wpLow.x <= -0.095, `clamped -sideShift x=${wpLow.x}`);

        // Upright mast (mastTiltRad: 0): clamped high forkMaxZ = 7.250 -> 7.250 - 0.123 = 7.127 m (> 7.050 L3 rack)
        agf.update({ forkHeightM: 10.0, sideShiftM: 0.5, mastTiltRad: 0, steerAngleRad: 3.0 });
        agf.root.updateMatrixWorld(true);
        assert.ok(Math.abs(agf.steerAngleRad - mods.specs.AGF_SPECS.maxSteerRad) < 1e-5, "positive steerAngleRad clamped to +82 deg");
        assert.ok(Math.abs(agf.rearSteerPivot.rotation.z - mods.specs.AGF_SPECS.maxSteerRad) < 1e-5, "rearSteerPivot.rotation.z clamped to +82 deg");
        const wpHigh = new THREE.Vector3();
        agf.cargoMount.getWorldPosition(wpHigh);
        assert.ok(wpHigh.z >= 7.10 && wpHigh.z <= 7.265, `clamped high cargoMount z=${wpHigh.z}`);
        assert.ok(wpHigh.x >= 0.095 && wpHigh.x <= 0.105, `clamped +sideShift x=${wpHigh.x}`);

        // Out-of-range mastTiltRad (-1.0 / +1.0 rad) at forkHeightM = 0.5 clamps to [-3 deg, +5 deg]
        for (const rawTilt of [-1.0, 1.0]) {
          agf.update({ forkHeightM: 0.5, sideShiftM: 0, mastTiltRad: rawTilt, steerAngleRad: 0 });
          agf.root.updateMatrixWorld(true);
          const wpTilt = new THREE.Vector3();
          agf.cargoMount.getWorldPosition(wpTilt);
          assert.ok(
            wpTilt.z >= 0.30 && wpTilt.z <= 0.50,
            `clamped mastTiltRad=${rawTilt} cargoMount z=${wpTilt.z} outside [0.30, 0.50]`
          );
        }
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T2-F7-02",
    tier: 2,
    features: ["F7"],
    title: "AGF update with NaN / undefined / {}",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        agf.update({ forkHeightM: NaN, sideShiftM: undefined, steerAngleRad: Infinity, mastTiltRad: -Infinity });
        agf.update({});
        agf.update();
        const b = computeBox3(THREE, agf.root);
        assert.ok(Number.isFinite(b.min.x) && Number.isFinite(b.max.z));
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T2-F7-03",
    tier: 2,
    features: ["F7"],
    title: "AGF cargoMount supportSurfaceZ parity across container/stand/rack",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        for (const sz of [0.000, 0.162, 0.380, 2.350]) {
          agf.update({ carriedWcid: 4000010, forkHeightM: sz + 0.02, supportSurfaceZ: sz });
          const box = localBoxInParent(THREE, agf.cargoMount, agf.root);
          assert.ok(box.min.z >= sz - 0.002, `supportSurfaceZ=${sz} min.z=${box.min.z}`);
        }
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T2-F7-04",
    tier: 2,
    features: ["F7"],
    title: "AGF unknown carriedWcid fallback & clear to 0",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        agf.update({ carriedWcid: 4000099, forkHeightM: 0.2 });
        const cargoBox = localBoxInParent(THREE, agf.cargoMount, agf.root);
        const sz = new THREE.Vector3();
        cargoBox.getSize(sz);
        assert.ok(Math.abs(sz.x - 1.100) < 0.03 && Math.abs(sz.y - 1.100) < 0.03);
        assert.ok(Math.abs(sz.z - 0.145) < 0.03);

        agf.update({ carriedWcid: 0 });
        assert.ok(countDrawCalls(agf.root) <= 10);
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T2-F7-05",
    tier: 2,
    features: ["F7"],
    title: "AGF dispose() while loaded + double dispose()",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      agf.update({ carriedWcid: 4000017, forkHeightM: 1.5 });
      const spy = spyDisposal(agf.root);
      agf.dispose();
      agf.dispose();
      spy.assertAllDisposed("AGF double dispose");
    },
  },

  // =========================================================================
  // F8 — Underride AMR 3D Model Boundaries
  // =========================================================================
  {
    id: "T2-F8-01",
    tier: 2,
    features: ["F8"],
    title: "AMR liftHeightM boundary clamping",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        for (const lh of [-1, 0, 0.259, 0.260, 0.450, 0.451, 2.0, NaN]) {
          amr.update({ liftHeightM: lh });
          amr.root.updateMatrixWorld(true);
          const wp = new THREE.Vector3();
          amr.cargoMount.getWorldPosition(wp);
          assert.ok(wp.z >= 0.255 && wp.z <= 0.455, `lift=${lh} -> cargoMount.z=${wp.z}`);
        }
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T2-F8-02",
    tier: 2,
    features: ["F8"],
    title: "AMR update() with NaN / unknown statusMode / empty {}",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ turntableYawRad: NaN, wheelSpinL: Infinity, wheelSpinR: -Infinity, statusMode: "unknown" });
        amr.update({});
        amr.update();
        const b = computeBox3(THREE, amr.root);
        assert.ok(Number.isFinite(b.max.z) && Number.isFinite(b.min.x));
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T2-F8-03",
    tier: 2,
    features: ["F8"],
    title: "AMR cargo swap disposal (4000014 -> 4000002 -> 0)",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ carriedWcid: 4000014, liftHeightM: 0.450 });
        const spy1 = spyDisposal(amr.cargoMount);
        amr.update({ carriedWcid: 4000002, liftHeightM: 0.450 });
        spy1.assertAllDisposed("AMR swap 4000014");

        const spy2 = spyDisposal(amr.cargoMount);
        amr.update({ carriedWcid: 0, liftHeightM: 0.260 });
        spy2.assertAllDisposed("AMR clear 4000002");
        assert.ok(countDrawCalls(amr.root) <= 6);
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T2-F8-04",
    tier: 2,
    features: ["F8"],
    title: "AMR unknown carriedWcid fallback",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ carriedWcid: 4000099, liftHeightM: 0.450 });
        const box = localBoxInParent(THREE, amr.cargoMount, amr.root);
        const s = new THREE.Vector3();
        box.getSize(s);
        assert.ok(Math.abs(s.x - 1.100) < 0.03 && Math.abs(s.y - 1.100) < 0.03);
        assert.ok(Math.abs(box.min.z - 0.450) < 0.02);
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T2-F8-05",
    tier: 2,
    features: ["F8"],
    title: "AMR dispose() while loaded & raised + double dispose()",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      amr.update({ carriedWcid: 4000015, liftHeightM: 0.450 });
      const spy = spyDisposal(amr.root);
      amr.dispose();
      amr.dispose();
      spy.assertAllDisposed("AMR double dispose");
    },
  },

  // =========================================================================
  // F9 — Concrete Apron, Stands, Lift Tables, Chargers 3D Model Boundaries
  // =========================================================================
  {
    id: "T2-F9-01",
    tier: 2,
    features: ["F9"],
    title: "Empty standDefs = [] / dockDefs = [] builders",
    async run({ THREE, mods }) {
      const { buildTransferStandGroup, buildChargingDockGroup } = mods.infraModel;
      const sg = buildTransferStandGroup(THREE, []);
      const cg = buildChargingDockGroup(THREE, []);
      assert.equal(countLights(sg.root), 0);
      assert.equal(countLights(cg.root), 0);
      sg.dispose();
      cg.dispose();
    },
  },
  {
    id: "T2-F9-02",
    tier: 2,
    features: ["F9"],
    title: "Out-of-range index on setSlotCargo / setHighlighted / setDockState",
    async run({ THREE, mods }) {
      const { buildTransferStandGroup, buildChargingDockGroup } = mods.infraModel;
      const sg = buildTransferStandGroup(THREE, [{ id: "s0", pos: [0, 0, 0], heading: 0 }]);
      const cg = buildChargingDockGroup(THREE, [{ id: "c0", pos: [3, 0, 0], heading: 0 }]);
      try {
        for (const idx of [-1, 999, NaN]) {
          sg.setSlotCargo(idx, 4000010);
          sg.setHighlighted(idx, "target");
          cg.setDockState(idx, "charging");
        }
        sg.setSlotCargo(0, 4000010);
        sg.setSlotCargo(0, 0);
      } finally {
        sg.dispose();
        cg.dispose();
      }
    },
  },
  {
    id: "T2-F9-03",
    tier: 2,
    features: ["F9"],
    title: "Lift Table heightM clamping & cargo swap disposal",
    async run({ THREE, mods }) {
      const { buildScissorLiftTable } = mods.infraModel;
      const lt = buildScissorLiftTable(THREE, { csmState: makeCsmState() });
      try {
        for (const h of [-0.2, 0.0, 0.380, 1.5, NaN]) {
          lt.update({ heightM: h });
          lt.root.updateMatrixWorld(true);
          const wp = new THREE.Vector3();
          lt.cargoMount.getWorldPosition(wp);
          assert.ok(wp.z >= -0.005 && wp.z <= 0.385, `h=${h} -> z=${wp.z}`);
        }
        lt.update({ heightM: 0.380, carriedWcid: 4000010 });
        const spy1 = spyDisposal(lt.cargoMount);
        lt.update({ heightM: 0.380, carriedWcid: 4000017 });
        spy1.assertAllDisposed("liftTable swap 4000010");
        const spy2 = spyDisposal(lt.cargoMount);
        lt.update({ heightM: 0.0, carriedWcid: 0 });
        spy2.assertAllDisposed("liftTable clear 4000017");
      } finally {
        lt.dispose();
      }
    },
  },
  {
    id: "T2-F9-04",
    tier: 2,
    features: ["F9"],
    title: "Concrete Apron polygonOffset & elevation invariant",
    async run({ THREE, mods }) {
      const { buildConcreteApron } = mods.infraModel;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const apron = buildConcreteApron(THREE, buildDefaultHubLayout(NE_FLATLAND_SITE.origin), { csmState: makeCsmState() });
      try {
        apron.root.traverse((o) => {
          if (!o.isMesh) return;
          const b = computeBox3(THREE, o);
          assert.ok(b.max.z > 0.001 && b.max.z < 0.02, `apron mesh max.z=${b.max.z}`);
          assert.equal(Boolean(o.material?.polygonOffset), true, `mesh ${o.name} missing polygonOffset`);
        });
      } finally {
        apron.dispose();
      }
    },
  },
  {
    id: "T2-F9-05",
    tier: 2,
    features: ["F9"],
    title: "Double dispose() across all 4 infra models",
    async run({ THREE, mods }) {
      const { buildConcreteApron, buildTransferStandGroup, buildScissorLiftTable, buildChargingDockGroup } = mods.infraModel;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const items = [
        buildConcreteApron(THREE, layout),
        buildTransferStandGroup(THREE, layout.stands),
        buildScissorLiftTable(THREE),
        buildChargingDockGroup(THREE, layout.chargers),
      ];
      const spies = items.map((m) => spyDisposal(m.root));
      for (const m of items) {
        m.dispose();
        m.dispose();
      }
      spies.forEach((s, i) => s.assertAllDisposed(`infraDoubleDispose[${i}]`));
    },
  },

  // =========================================================================
  // F10 — Scriptable Warehouse Manager Boundaries
  // =========================================================================
  {
    id: "T2-F10-01",
    tier: 2,
    features: ["F10"],
    title: "Idempotent buildHub() replacement without leaks",
    async run({ THREE, mods }) {
      const { createWarehouseManager } = mods.manager;
      const { NE_FLATLAND_SITE } = mods.specs;
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
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const spy = spyDisposal(rig.worldRoot);
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        spy.assertAllDisposed("first buildHub replaced");
        assert.equal(rig.worldRoot.children.length, 1, "worldRoot retains single hub root");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T2-F10-02",
    tier: 2,
    features: ["F10"],
    title: "Invalid scenario name & invalid rack/stand/charger target IDs",
    async run({ THREE, mods }) {
      const { createWarehouseManager } = mods.manager;
      const { NE_FLATLAND_SITE } = mods.specs;
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
        let badScenRejected = false;
        try {
          const r = await mgr.runScenario("bad-scenario");
          if (r === false) badScenRejected = true;
        } catch (_) {
          badScenRejected = true;
        }
        assert.equal(badScenRejected, true, "bad scenario rejected");

        const agf = mgr.spawnAgf("agf-bad", { pos: [ox, oy + 18, 0], heading: 0, carriedWcid: 4000010 });
        await assert.rejects(
          async () =>
            driveManagerPromise(
              mgr,
              agf.enqueue({ type: "placeInRack", rackId: "badRack", bay: 99, tier: 9, side: 0, slotInBay: 0 }),
              { maxSteps: 300 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        await assert.rejects(
          async () =>
            driveManagerPromise(mgr, agf.enqueue({ type: "placeOnStand", standId: "badStand" }), { maxSteps: 300 }),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        mgr.tick(1 / 60, [ox, oy, 10]);
        assertNoNaNDeep(mgr.getState(), "stateAfterInvalidTasks");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T2-F10-03",
    tier: 2,
    features: ["F10"],
    title: "tick() edge values (dt = 0, -0.05, NaN, null cameraPos, pre-buildHub)",
    async run({ THREE, mods }) {
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
        for (const dt of [0, -0.05, NaN]) mgr.tick(dt, null);
        mgr.buildHub();
        for (const dt of [0, -0.05, NaN]) mgr.tick(dt, null);
        assertNoNaNDeep(mgr.getState(), "tickEdgeState");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T2-F10-04",
    tier: 2,
    features: ["F10"],
    title: "Duplicate spawnAgf(id) / spawnAmr(id) & idle stopScenarios()",
    async run({ THREE, mods }) {
      const { createWarehouseManager } = mods.manager;
      const { NE_FLATLAND_SITE } = mods.specs;
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
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        mgr.stopScenarios(); // safe no-op when idle
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const beforeAgfNodes = new Set();
        rig.worldRoot.traverse((o) => beforeAgfNodes.add(o));
        const agf1 = mgr.spawnAgf("dup-agf", { pos: [ox, oy + 18, 0], heading: 0 });
        let agf1Root = agf1?.model?.root ?? agf1?.root ?? null;
        if (!agf1Root) {
          const added = [];
          rig.worldRoot.traverse((o) => {
            if (!beforeAgfNodes.has(o)) added.push(o);
          });
          agf1Root = { traverse(fn) { for (const o of added) fn(o); } };
        }
        const spyA = spyDisposal(agf1Root);
        assert.ok(spyA.geometries.size > 0, "first AGF has geometries");
        mgr.spawnAgf("dup-agf", { pos: [ox + 2, oy + 18, 0], heading: 0 });
        spyA.assertAllDisposed("replacedAgf");
        assert.equal(mgr.agfs.size, 1);

        const beforeAmrNodes = new Set();
        rig.worldRoot.traverse((o) => beforeAmrNodes.add(o));
        const amr1 = mgr.spawnAmr("dup-amr", { pos: [ox, oy - 24, 0], heading: 0 });
        let amr1Root = amr1?.model?.root ?? amr1?.root ?? null;
        if (!amr1Root) {
          const added = [];
          rig.worldRoot.traverse((o) => {
            if (!beforeAmrNodes.has(o)) added.push(o);
          });
          amr1Root = { traverse(fn) { for (const o of added) fn(o); } };
        }
        const spyAmr = spyDisposal(amr1Root);
        assert.ok(spyAmr.geometries.size > 0, "first AMR has geometries");
        mgr.spawnAmr("dup-amr", { pos: [ox + 2, oy - 24, 0], heading: 0 });
        spyAmr.assertAllDisposed("replacedAmr");
        assert.equal(mgr.amrs.size, 1);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T2-F10-05",
    tier: 2,
    features: ["F10"],
    title: "Empty clearHub() / dispose() & post-dispose() tick()",
    async run({ THREE, mods }) {
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
      mgr.clearHub();
      mgr.dispose();
      mgr.dispose();
      mgr.tick(1 / 60, [0, 0, 10]);
    },
  },

  // =========================================================================
  // F11 — Live Container & Deployable Bridge Boundaries
  // =========================================================================
  {
    id: "T2-F11-01",
    tier: 2,
    features: ["F11"],
    title: "Container pickup/load rejected when doors closed (doorProgress < 0.5)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        for (const dp of [0.0, 0.49]) {
          const cGuid = dp === 0 ? 0x73000001 : 0x73000002;
          const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
            doorProgress: dp,
            slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 }],
          });
          const agf = mgr.spawnAgf("agf-closed", { pos: [ox, oy + 20, 0], heading: 0, carriedWcid: 0 });
          await assert.rejects(
            async () =>
              driveVehiclesPromise(
                rig.live,
                agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 }),
                { maxSteps: 300 }
              ),
            (err) => !/did not settle within/.test(err?.message || "")
          );
          assert.equal(cEntry.slots.length, 1, "closed container slots untouched");
        }
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-F11-02",
    tier: 2,
    features: ["F11"],
    title: "Container pickup rejected on LIFO-blocked deep slot",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const cGuid = 0x73000003;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [
            { slotIndex: 0, palletSize: "standard", cargoWcid: 4000010 },
            { slotIndex: 18, palletSize: "standard", cargoWcid: 4000011 },
          ],
        });
        const agf = mgr.spawnAgf("agf-lifo", { pos: [ox, oy + 20, 0], heading: 0 });
        await assert.rejects(
          async () =>
            driveVehiclesPromise(
              rig.live,
              agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 0 }),
              { maxSteps: 300 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        assert.equal(cEntry.slots.some((s) => s.slotIndex === 0), true);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-F11-03",
    tier: 2,
    features: ["F11"],
    title: "Container load rejected on occupied, LIFO-blocked, or OOB slot",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const cGuid = 0x73000004;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 10, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [
            { slotIndex: 0, palletSize: "standard", cargoWcid: 4000010 },
            { slotIndex: 8, palletSize: "standard", cargoWcid: 4000011 },
          ],
        });
        const agf = mgr.spawnAgf("agf-load-bad", { pos: [ox, oy + 20, 0], heading: 0, carriedWcid: 4000012 });
        for (const badSlot of [0, 2, -1, 10]) {
          // slot 0 occupied, slot 2 blocked behind 8, -1/10 OOB for 20ft
          await assert.rejects(
            async () =>
              driveVehiclesPromise(
                rig.live,
                agf.enqueue({ type: "loadIntoContainer", containerGuid: cGuid, slotIndex: badSlot }),
                { maxSteps: 300 }
              ),
            (err) => !/did not settle within/.test(err?.message || "")
          );
        }
        assert.equal(cEntry.slots.length, 2);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-F11-04",
    tier: 2,
    features: ["F11"],
    title: "Missing/nonexistent containerGuid or deployableGuid",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const agf = mgr.spawnAgf("agf-miss", { pos: [ox, oy + 20, 0], heading: 0 });
        await assert.rejects(
          async () =>
            driveVehiclesPromise(
              rig.live,
              agf.enqueue({ type: "pickFromContainer", containerGuid: 99999999, slotIndex: 0 }),
              { maxSteps: 300 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        await assert.rejects(
          async () =>
            driveVehiclesPromise(
              rig.live,
              agf.enqueue({ type: "pickGroundDeployable", deployableGuid: 88888888 }),
              { maxSteps: 300 }
            ),
          (err) => !/did not settle within/.test(err?.message || "")
        );
        // Queue stays healthy for valid command afterward
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "driveTo", waypoints: [[ox + 1, oy + 20]] }),
          { maxSteps: 600 }
        );
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T2-F11-05",
    tier: 2,
    features: ["F11"],
    title: "Server-backed container with sh === null or throwing vehicleContainerAction",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles, { sessionHandle: null });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const cGuid = 0x73000005;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 }],
        });
        cEntry.localOnly = false;
        const agf = mgr.spawnAgf("agf-nosrv", { pos: [ox, oy + 20, 0], heading: 0 });
        // Must either reject cleanly or degrade gracefully without hanging or unhandled errors
        try {
          await driveVehiclesPromise(
            rig.live,
            agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18, serverDispatch: true }),
            { maxSteps: 600 }
          );
        } catch (err) {
          assert.equal(/did not settle within/.test(err?.message || ""), false, "sh === null enqueue hung");
        }
        mgr.tick(1 / 60, [ox, oy, 10]);
        assertNoNaNDeep(mgr.getState(), "noSrvState");
      } finally {
        rig.cleanup();
      }

      // Explicit throwing vehicleContainerAction sub-case
      const rig2 = makeTestRig(THREE, mods.index.initVehicles);
      rig2.setContainerActionImpl(() => { throw new Error("boom"); });
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr2 = rig2.win.__vehicles.warehouse;
        mgr2.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const cGuid2 = 0x73000006;
        const cEntry2 = rig2.api.containers.spawnLocal(cGuid2, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 }],
        });
        cEntry2.localOnly = false;
        const agf2 = mgr2.spawnAgf("agf-throw", { pos: [ox, oy + 20, 0], heading: 0 });
        try {
          await driveVehiclesPromise(
            rig2.live,
            agf2.enqueue({ type: "pickFromContainer", containerGuid: cGuid2, slotIndex: 18, serverDispatch: true }),
            { maxSteps: 2400 }
          );
        } catch (err) {
          assert.equal(/did not settle within/.test(err?.message || ""), false, "throwing vehicleContainerAction hung");
        }
        assert.ok(rig2.calls.containerActions.length >= 1, "vehicleContainerAction invoked");
        await driveVehiclesPromise(
          rig2.live,
          agf2.enqueue({ type: "driveTo", waypoints: [[ox + 1, oy + 20]] }),
          { maxSteps: 2400 }
        );
        assertNoNaNDeep(mgr2.getState(), "throwSrvState");
      } finally {
        rig2.cleanup();
      }
    },
  },

  // =========================================================================
  // F12 — Vehicle Index, Pallet Jack & Audio Wiring Boundaries
  // =========================================================================
  {
    id: "T2-F12-01",
    tier: 2,
    features: ["F12"],
    title: "createPalletJackController backward compatibility (warehouseManager: null)",
    async run({ THREE, mods }) {
      const { createPalletJackController } = mods.palletJackController;
      const rig = makeTestRig(THREE, null);
      const jackEntry = {
        guid: 0x60000010,
        worldPos: [0, 0, 0],
        heading: 0,
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
      });
      try {
        assert.equal(ctrl.start(jackEntry), true);
        assert.equal(ctrl.isActive(), true);
        rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
        for (let i = 0; i < 10; i++) ctrl.tick(1 / 60);
        rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
        assertFinitePose(ctrl.state, "jackCompatAfterKeyW");
        assert.ok(ctrl.state.y > 0, "jack advanced forward with warehouseManager omitted");

        rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
        rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
        rig.win.dispatch("keydown", { code: "Space", key: " " });
        rig.win.dispatch("keyup", { code: "Space", key: " " });
        ctrl.tick(1 / 60);
        assert.equal(ctrl.isActive(), true);
        assertFinitePose(ctrl.state, "jackCompatAfterSpace");
        assert.ok(ctrl.state.forkHeightM > 0.085, "Space raised forks");
        assert.equal(ctrl.stop(), true);
        assert.equal(ctrl.isActive(), false);
      } finally {
        ctrl.dispose();
      }
    },
  },
  {
    id: "T2-F12-02",
    tier: 2,
    features: ["F12"],
    title: "Lift Table elevation boundary for Pallet Jack engagement (0.019 vs 0.021 m)",
    async run({ THREE, mods }) {
      const { createWarehouseManager } = mods.manager;
      const { NE_FLATLAND_SITE } = mods.specs;
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
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const liftId = [...mgr.liftTables.keys()][0];
        const lt = mgr.liftTables.get(liftId);
        const lPos = lt.pos ?? [lt.x, lt.y, 0];

        lt.setHeightImmediate ? lt.setHeightImmediate(0.019) : (lt.heightM = 0.019);
        assert.ok(mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.2, heading: 0 }), "0.019 m selectable");

        lt.setHeightImmediate ? lt.setHeightImmediate(0.021) : (lt.heightM = 0.021);
        assert.equal(mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.2, heading: 0 }), null, "0.021 m excluded");

        lt.setHeightImmediate ? lt.setHeightImmediate(0.380) : (lt.heightM = 0.380);
        assert.equal(mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.2, heading: 0 }), null, "0.380 m excluded");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T2-F12-03",
    tier: 2,
    features: ["F12"],
    title: "Warehouse audio gating (?vehicleAudio=off, nullRender: true, bus: null)",
    run({ mods }) {
      const { createLogisticsAudio } = mods.audio;
      const b1 = makeAudioBus();
      const b2 = makeAudioBus();
      const gated = [
        createLogisticsAudio({ bus: b1, search: "?vehicleAudio=off" }),
        createLogisticsAudio({ bus: b2, liveScene3d: { nullRender: true }, search: "?vehicleAudio=on" }),
        createLogisticsAudio({ bus: null, search: "?vehicleAudio=on" }),
      ];
      for (const au of gated) {
        assert.equal(au.updateAgvHum("a", { speed: 1, pos: [0, 0, 0] }), false);
        assert.equal(au.mastHydraulicWhine("b", { active: true, speed: 0.5, pos: [0, 0, 0] }), false);
        assert.equal(au.safetyChime({ pos: [0, 0, 0] }), false);
        assert.equal(au.stats.totalNodes, 0);
        au.dispose();
      }
      assert.equal(b1.ctx.made.length, 0);
      assert.equal(b2.ctx.made.length, 0);
    },
  },
  {
    id: "T2-F12-04",
    tier: 2,
    features: ["F12"],
    title: "Warehouse audio BareMockCtx fallback (no biquad, panner, or ramps)",
    run({ mods }) {
      const { createLogisticsAudio } = mods.audio;
      const fakeAudio = installFakeAudio();
      let tSec = 1;
      const bareBus = makeAudioBus(BareMockCtx);
      const au = createLogisticsAudio({ bus: bareBus, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
      try {
        assert.equal(au.updateAgvHum("amr-bare", { speed: 1.2, pos: [0, 0, 0] }), true);
        assert.equal(au.mastHydraulicWhine("agf-bare", { active: true, speed: 0.3, pos: [0, 0, 0] }), true);
        assert.equal(au.safetyChime({ pos: [0, 0, 0] }), true);
      } finally {
        au.dispose();
        fakeAudio.uninstall();
      }
      assert.equal(au.stats.totalNodes, 0);
    },
  },
  {
    id: "T2-F12-05",
    tier: 2,
    features: ["F12"],
    title: "initVehicles dispose() & session teardown cleanup",
    async run({ THREE, mods }) {
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      const wh = rig.win.__vehicles.warehouse;
      wh.buildHub();
      wh.spawnAgf("agf-td", { pos: [44832, 46960, 0], heading: 0 });
      wh.spawnAmr("amr-td", { pos: [44832, 46920, 0], heading: 0 });
      rig.tick(16.667, 16.667);

      const spy = spyDisposal(rig.worldRoot);
      rig.win.__vehicles.dispose();
      spy.assertAllDisposed("initVehicles.dispose");
      assert.equal(rig.worldRoot.children.length, 0, "worldRoot emptied on dispose");
      assert.equal(rig.win.__vehicles, undefined);
      assert.equal(rig.win.listenerCount("keydown"), 0);
    },
  },
];
