// harness/warehouse_e2e/tier1_features.mjs
// Tier 1: Opaque-Box Feature Coverage Matrix (60 tests: 5 per Feature F1-F12).

import {
  ALL_DEPLOYABLE_WCIDS,
  FullMockCtx,
  assert,
  assertFinitePose,
  assertNoNaNDeep,
  collectResources,
  computeBox3,
  countDrawCalls,
  countLayoutRackSlots,
  countLights,
  countVisibleDrawCalls,
  driveManagerPromise,
  driveVehiclesPromise,
  gridClaim,
  gridQueryProximity,
  gridRelease,
  lintManifest,
  lintSource,
  localBoxInParent,
  makeAudioBus,
  makeCsmState,
  makeTestRig,
  normBox2D,
  rackGetSlotWorldPos,
  rackHighlightSlot,
  rackLoadSlot,
  rackUnloadSlot,
  readVehicleSource,
  renderWithFakeWebGL2,
  spyDisposal,
  stepUntil,
  wrapAngle,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // F1 — NE Flatland Site & Hub Blueprint
  // =========================================================================
  {
    id: "T1-F1-01",
    tier: 1,
    features: ["F1"],
    title: "NE Flatland site constants & 0xE9F4 canonical origin",
    run({ mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      assert.ok(NE_FLATLAND_SITE && typeof NE_FLATLAND_SITE === "object");
      assert.deepEqual([...NE_FLATLAND_SITE.bx], [0xe4, 0xee]);
      assert.deepEqual([...NE_FLATLAND_SITE.by], [0xf2, 0xf6]);
      assert.equal(NE_FLATLAND_SITE.landblock, 0xe9f4);
      assert.deepEqual([...NE_FLATLAND_SITE.origin], [44832.0, 46944.0, 0.0]);
      assert.equal(NE_FLATLAND_SITE.teleCmd, "@tele 93.60N 84.80E");
      const lbSpanX = (NE_FLATLAND_SITE.bx[1] - NE_FLATLAND_SITE.bx[0] + 1) * 192;
      const lbSpanY = (NE_FLATLAND_SITE.by[1] - NE_FLATLAND_SITE.by[0] + 1) * 192;
      assert.equal(lbSpanX, 2112);
      assert.equal(lbSpanY, 960);
    },
  },
  {
    id: "T1-F1-02",
    tier: 1,
    features: ["F1"],
    title: "BodyEdgeMin..Max world-edge containment",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const minEdge = NE_FLATLAND_SITE.bodyEdgeMin ?? 193.0;
      const maxEdge = NE_FLATLAND_SITE.bodyEdgeMax ?? 48767.0;
      assert.equal(minEdge, 193.0);
      assert.equal(maxEdge, 48767.0);

      const slabMinX = NE_FLATLAND_SITE.bx[0] * 192;
      const slabMaxX = (NE_FLATLAND_SITE.bx[1] + 1) * 192;
      const slabMinY = NE_FLATLAND_SITE.by[0] * 192;
      const slabMaxY = (NE_FLATLAND_SITE.by[1] + 1) * 192;
      assert.ok(slabMinX >= minEdge && slabMaxX <= maxEdge);
      assert.ok(slabMinY >= minEdge && slabMaxY <= maxEdge);

      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const sb = normBox2D(layout.slabBounds);
      assert.ok(sb && sb.x0 >= minEdge && sb.x1 <= maxEdge, `slab X [${sb?.x0}, ${sb?.x1}]`);
      assert.ok(sb.y0 >= minEdge && sb.y1 <= maxEdge, `slab Y [${sb?.y0}, ${sb?.y1}]`);
    },
  },
  {
    id: "T1-F1-03",
    tier: 1,
    features: ["F1"],
    title: "buildDefaultHubLayout default Zones A-D inventory",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin, {});
      assertNoNaNDeep(layout, "defaultHubLayout");
      assert.deepEqual([...layout.origin], [...NE_FLATLAND_SITE.origin]);
      assert.ok(layout.dropPads.length >= 3, `dropPads ${layout.dropPads.length}`);
      assert.ok(layout.stagingBays.length >= 12, `stagingBays ${layout.stagingBays.length}`);
      assert.ok(countLayoutRackSlots(layout) >= 384, "total rack slots >= 384");
      assert.ok(layout.stands.length >= 18, `stands ${layout.stands.length}`);
      assert.ok(layout.liftTables.length >= 2, `liftTables ${layout.liftTables.length}`);
      assert.ok(layout.chargers.length >= 8, `chargers ${layout.chargers.length}`);
      assert.ok(layout.graph && Array.isArray(layout.graph.nodes) && Array.isArray(layout.graph.edges));
      for (const pad of layout.dropPads) assert.equal(pad.z ?? pad.pos?.[2] ?? 0, 0);
    },
  },
  {
    id: "T1-F1-04",
    tier: 1,
    features: ["F1"],
    title: "Zones A-D spatial partitioning & non-overlap",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const [ox, oy] = NE_FLATLAND_SITE.origin;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      for (const p of layout.dropPads) {
        const y = p.y ?? p.pos?.[1];
        assert.ok(y - oy >= 20 && y - oy <= 46, `Zone A pad relY=${y - oy}`);
      }
      for (const b of layout.stagingBays) {
        const x = b.x ?? b.pos?.[0];
        assert.ok(x - ox >= -55 && x - ox <= -25, `Zone B staging relX=${x - ox}`);
      }
      for (const l of layout.liftTables) {
        const x = l.x ?? l.pos?.[0];
        assert.ok(x - ox >= -55 && x - ox <= -25, `Zone B liftTable relX=${x - ox}`);
      }
      for (const r of layout.rackRows) {
        const x = r.x ?? r.pos?.[0];
        assert.ok(x - ox >= -28 && x - ox <= 56, `Zone C rack relX=${x - ox}`);
      }
      for (const c of layout.chargers) {
        const y = c.y ?? c.pos?.[1];
        assert.ok(y - oy <= -20 && y - oy >= -45, `Zone D charger relY=${y - oy}`);
      }
      // Verify distinct row spacing >= 3.600 m aisle clearance
      const ys = [...new Set(layout.rackRows.map((r) => Math.round((r.y ?? r.pos?.[1]) * 1000) / 1000))].sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        assert.ok(ys[i] - ys[i - 1] >= 3.59, `rack row spacing ${ys[i] - ys[i - 1]} >= 3.6m or double-row`);
      }
    },
  },
  {
    id: "T1-F1-05",
    tier: 1,
    features: ["F1"],
    title: "Waypoint graph connectivity & custom origin shift",
    run({ mods }) {
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const originA = NE_FLATLAND_SITE.origin;
      const originB = [10000, 20000, 0];
      const layoutA = buildDefaultHubLayout(originA);
      const layoutB = buildDefaultHubLayout(originB);

      const nodeIds = new Set(layoutA.graph.nodes.map((n) => n.id));
      assert.ok(nodeIds.size >= 4);
      const adj = new Map([...nodeIds].map((id) => [id, []]));
      for (const e of layoutA.graph.edges) {
        const from = e.from ?? e.a;
        const to = e.to ?? e.b;
        assert.ok(nodeIds.has(from) && nodeIds.has(to), `edge references unknown node ${from}->${to}`);
        adj.get(from).push(to);
        if (e.bidirectional !== false) adj.get(to).push(from);
      }

      // BFS from first node must reach the full connected component
      const visited = new Set([layoutA.graph.nodes[0].id]);
      const q = [layoutA.graph.nodes[0].id];
      while (q.length > 0) {
        const cur = q.shift();
        for (const nxt of adj.get(cur)) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            q.push(nxt);
          }
        }
      }
      assert.equal(visited.size, nodeIds.size, `connected nodes ${visited.size}/${nodeIds.size}`);

      // Origin shift parity
      const dx = originB[0] - originA[0];
      const dy = originB[1] - originA[1];
      const pA = layoutA.dropPads[0];
      const pB = layoutB.dropPads[0];
      assert.ok(Math.abs(((pB.x ?? pB.pos[0]) - (pA.x ?? pA.pos[0])) - dx) < 1e-4);
      assert.ok(Math.abs(((pB.y ?? pB.pos[1]) - (pA.y ?? pA.pos[1])) - dy) < 1e-4);
    },
  },

  // =========================================================================
  // F2 — Reserved WCIDs & Millimeter Specs
  // =========================================================================
  {
    id: "T1-F2-01",
    tier: 1,
    features: ["F2"],
    title: "Reserved WCIDs & DeployableKinds disjointness",
    run({ mods }) {
      const { WAREHOUSE_WCID, WAREHOUSE_DEPLOYABLE_KIND } = mods.specs;
      const { DEPLOYABLE_WCID, DEPLOYABLE_KINDS } = mods.deployableModels;
      const { CONTAINER_WCID, DEPLOYABLE_KIND: CONTAINER_KINDS } = mods.containerModels;
      const { TRAILER_WCID, TRAILER_DEPLOYABLE_KIND } = mods.trailerModels;
      const { PALLET_JACK_WCID, PALLET_JACK_SPECS } = mods.palletJackModel;

      const wcidVals = Object.values(WAREHOUSE_WCID);
      const kindVals = Object.values(WAREHOUSE_DEPLOYABLE_KIND);
      assert.equal(wcidVals.length, 6);
      assert.equal(kindVals.length, 6);
      assert.deepEqual([...wcidVals].sort((a, b) => a - b), [4000040, 4000041, 4000042, 4000043, 4000044, 4000045]);
      assert.deepEqual([...kindVals].sort((a, b) => a - b), [17, 18, 19, 20, 21, 22]);

      const shippedWcids = new Set([
        4000002,
        ...Object.values(DEPLOYABLE_WCID),
        ...Object.values(CONTAINER_WCID),
        ...Object.values(TRAILER_WCID),
        PALLET_JACK_WCID,
      ]);
      for (const w of wcidVals) assert.ok(!shippedWcids.has(w), `WCID collision: ${w}`);

      const shippedKinds = new Set([
        ...Object.values(DEPLOYABLE_KINDS),
        ...Object.values(CONTAINER_KINDS),
        ...Object.values(TRAILER_DEPLOYABLE_KIND),
        PALLET_JACK_SPECS.kind,
      ]);
      for (const k of kindVals) assert.ok(!shippedKinds.has(k), `Kind collision: ${k}`);
    },
  },
  {
    id: "T1-F2-02",
    tier: 1,
    features: ["F2"],
    title: "Millimeter-locked interop spec inequalities",
    run({ mods }) {
      const { RACK_SPECS, AGF_SPECS, AMR_SPECS, STAND_SPECS } = mods.specs;
      const { ISO_CONTAINER_SPECS, CONTAINER_WCID } = mods.containerModels;
      const door = ISO_CONTAINER_SPECS[CONTAINER_WCID.IsoContainer40].door;

      const agfW = AGF_SPECS.overallWidthM ?? AGF_SPECS.width;
      const agfColH = AGF_SPECS.collapsedMastHeightM ?? AGF_SPECS.collapsedHeight;
      const agfMaxLift = AGF_SPECS.forkMaxZ ?? AGF_SPECS.maxLift;
      assert.ok(agfW <= 1.145 && agfW < door.width, `AGF width ${agfW}`);
      assert.ok(agfColH <= 2.165 && agfColH < door.height, `AGF collapsed ${agfColH}`);
      assert.ok(agfMaxLift >= 7.250);

      const amrW = AMR_SPECS.widthM ?? AMR_SPECS.width;
      const amrLow = AMR_SPECS.loweredHeightM ?? AMR_SPECS.loweredHeight;
      const amrHigh = AMR_SPECS.raisedHeightM ?? AMR_SPECS.raisedHeight;
      const standTW = STAND_SPECS.tunnelWidthM ?? STAND_SPECS.tunnelWidth;
      const standTH = STAND_SPECS.tunnelHeightM ?? STAND_SPECS.tunnelHeight;
      const standRZ = STAND_SPECS.railHeightM ?? STAND_SPECS.railZ;
      assert.ok(amrW <= 0.785 && amrW < standTW);
      assert.ok(amrLow <= 0.265 && amrLow < standTH);
      assert.ok(amrHigh >= 0.445 && amrHigh > standRZ);

      const tierClear = RACK_SPECS.clearTierHeightM ?? RACK_SPECS.tierClearHeight ?? (RACK_SPECS.tierStep - RACK_SPECS.beamHeight);
      assert.ok(tierClear >= 2.20 && tierClear > 2.05, `tierClear=${tierClear}`);
    },
  },
  {
    id: "T1-F2-03",
    tier: 1,
    features: ["F2"],
    title: "computeRackSlotLocalPose across all 4 tiers & 2 slots/bay",
    run({ mods }) {
      const { RACK_SPECS, computeRackSlotLocalPose } = mods.specs;
      const expectedZ = [0.0, 2.35, 4.70, 7.05];
      for (let tier = 0; tier < 4; tier++) {
        const s0 = computeRackSlotLocalPose(0, tier, 0, RACK_SPECS);
        const s1 = computeRackSlotLocalPose(0, tier, 1, RACK_SPECS);
        assertFinitePose(s0, `tier${tier}-slot0`);
        assertFinitePose(s1, `tier${tier}-slot1`);
        assert.ok(Math.abs(s0.z - expectedZ[tier]) < 1e-4, `tier ${tier} z=${s0.z}`);
        assert.ok(Math.abs(s1.z - expectedZ[tier]) < 1e-4, `tier ${tier} z=${s1.z}`);
        assert.ok(Math.abs(s1.x - s0.x) >= 1.20, `slot pitch ${Math.abs(s1.x - s0.x)} >= 1.20 m`);
        assert.ok(Number.isFinite(s0.approachX) && Number.isFinite(s0.approachY) && Number.isFinite(s0.approachHeading));
      }
      const bay7 = computeRackSlotLocalPose(7, 3, 1, RACK_SPECS);
      const bay0 = computeRackSlotLocalPose(0, 3, 0, RACK_SPECS);
      assert.ok(bay7.x - bay0.x > 18.0, "8-bay span > 18 m");
    },
  },
  {
    id: "T1-F2-04",
    tier: 1,
    features: ["F2"],
    title: "computeRackRowBounds single-sided vs double-sided",
    run({ mods }) {
      const { RACK_SPECS, computeRackRowBounds } = mods.specs;
      const single = computeRackRowBounds(8, false, RACK_SPECS);
      const dbl = computeRackRowBounds(8, true, RACK_SPECS);
      assertNoNaNDeep(single, "singleRowBounds");
      assertNoNaNDeep(dbl, "doubleRowBounds");
      assert.ok(single.width >= 22.0 && single.width <= 23.0, `single width ${single.width}`);
      assert.ok(single.depth >= 1.05 && single.depth <= 1.25, `single depth ${single.depth}`);
      assert.ok(dbl.depth >= 2.35 && dbl.depth <= 2.55, `double depth ${dbl.depth}`);
      assert.ok(single.height > 7.05 && single.maxZ > 7.05);
    },
  },
  {
    id: "T1-F2-05",
    tier: 1,
    features: ["F2"],
    title: "CHARGER_SPECS & LIFT_TABLE_SPECS <-> Pallet Jack parity",
    run({ mods }) {
      const { CHARGER_SPECS, LIFT_TABLE_SPECS } = mods.specs;
      const { PALLET_JACK_SPECS } = mods.palletJackModel;
      const { PALLET_SPECS } = mods.deployableModels;

      assertNoNaNDeep(CHARGER_SPECS, "CHARGER_SPECS");
      assertNoNaNDeep(LIFT_TABLE_SPECS, "LIFT_TABLE_SPECS");
      assert.equal(LIFT_TABLE_SPECS.loweredHeight ?? LIFT_TABLE_SPECS.loweredZ, 0.0);
      assert.ok(Math.abs((LIFT_TABLE_SPECS.raisedHeight ?? LIFT_TABLE_SPECS.raisedZ) - 0.380) < 1e-4);
      const ltW = LIFT_TABLE_SPECS.outerWidthM ?? LIFT_TABLE_SPECS.width;
      const ltTW = LIFT_TABLE_SPECS.tunnelWidthM ?? LIFT_TABLE_SPECS.tunnelWidth;
      const ltTH = LIFT_TABLE_SPECS.tunnelHeightM ?? LIFT_TABLE_SPECS.tunnelHeight;
      assert.ok(ltW > PALLET_SPECS.standard.width);
      assert.ok(ltTW >= 0.860 && ltTH >= 0.360);
      assert.ok(PALLET_JACK_SPECS.forkSpread < ltW);
    },
  },

  // =========================================================================
  // F3 — AGF Kinematics & 3-Stage Mast
  // =========================================================================
  {
    id: "T1-F3-01",
    tier: 1,
    features: ["F3"],
    title: "computeMastStages freelift zone (0.045..1.700 m)",
    run({ mods }) {
      const { computeMastStages } = mods.kinematics;
      const heights = [0.045, 0.50, 1.20, 1.700];
      let prevCarriage = -Infinity;
      for (const h of heights) {
        const st = computeMastStages(h);
        assertNoNaNDeep(st, `mast(${h})`);
        assert.equal(st.freeliftActive, true, `freeliftActive at ${h}`);
        assert.ok(Math.abs(st.outerH - 2.160) < 1e-4, `outerH=${st.outerH}`);
        assert.equal(st.stage2Offset, 0);
        assert.equal(st.stage3Offset, 0);
        assert.ok(st.carriageOffset > prevCarriage, `carriageOffset monotonic at ${h}`);
        prevCarriage = st.carriageOffset;
      }
    },
  },
  {
    id: "T1-F3-02",
    tier: 1,
    features: ["F3"],
    title: "computeMastStages telescopic zone (1.700..7.250 m)",
    run({ mods }) {
      const { computeMastStages } = mods.kinematics;
      const heights = [1.75, 2.35, 4.70, 7.05, 7.250];
      let prevTotal = 0;
      for (const h of heights) {
        const st = computeMastStages(h);
        assertNoNaNDeep(st, `mast(${h})`);
        assert.equal(st.freeliftActive, false, `freeliftActive false at ${h}`);
        assert.ok(st.stage2Offset > 0 && st.stage3Offset > 0);
        const total = st.stage2Offset + st.stage3Offset + st.carriageOffset;
        assert.ok(total > prevTotal, `total reach increases at ${h}`);
        prevTotal = total;
      }
      const top = computeMastStages(7.250);
      assert.ok(top.stage2Offset <= 2.80 && top.stage3Offset > 0);
    },
  },
  {
    id: "T1-F3-03",
    tier: 1,
    features: ["F3"],
    title: "stepAgfKinematics rear-steer Ackermann & speed caps",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      // Straight north (+Y) when heading = 0
      let s0 = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.15, speed: 0 };
      for (let i = 0; i < 30; i++) {
        s0 = stepAgfKinematics(s0, { throttle: 1, speed: 5.0, steer: 0 }, 1 / 60, {});
      }
      assert.ok(s0.y > 0.1 && Math.abs(s0.x) < 1e-4, `heading 0 moves +Y (${s0.x}, ${s0.y})`);

      // Straight east (+X) when heading = +pi/2
      let sEast = { x: 0, y: 0, z: 0, heading: Math.PI / 2, steerAngleRad: 0, forkHeightM: 0.15, speed: 0 };
      for (let i = 0; i < 30; i++) {
        sEast = stepAgfKinematics(sEast, { throttle: 1, speed: 5.0, steer: 0 }, 1 / 60, {});
      }
      assert.ok(sEast.x > 0.1 && Math.abs(sEast.y) < 1e-3, `heading pi/2 moves +X (${sEast.x}, ${sEast.y})`);

      // Rear steer changes heading
      let sTurn = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0.6, forkHeightM: 0.15, speed: 1.5 };
      for (let i = 0; i < 20; i++) {
        sTurn = stepAgfKinematics(sTurn, { speed: 1.5, steerAngleRad: 0.6 }, 1 / 60, {});
      }
      assert.ok(Math.abs(sTurn.heading) > 0.05, "rear steer rotates AGF heading");

      // Mode speed caps: empty <= 3.2, loaded <= 2.2, insideContainer <= 1.2, docking <= 0.5
      const modes = [
        { loaded: false, ctx: {}, cap: 3.205 },
        { loaded: true, ctx: { loaded: true }, cap: 2.205 },
        { loaded: false, ctx: { insideContainer: true }, cap: 1.205 },
        { loaded: false, cmdExtra: { docking: true }, ctx: { docking: true }, cap: 0.505 },
      ];
      for (const m of modes) {
        let st = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.15, speed: 0, loaded: m.loaded };
        for (let i = 0; i < 180; i++) {
          st = stepAgfKinematics(st, { speed: 10.0, steerAngleRad: 0, ...(m.cmdExtra || {}) }, 1 / 60, m.ctx);
        }
        assert.ok(Math.abs(st.speed) <= m.cap, `speed ${st.speed} <= ${m.cap}`);
      }
    },
  },
  {
    id: "T1-F3-04",
    tier: 1,
    features: ["F3"],
    title: "stepAgfKinematics pure-pursuit & exact pose docking",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      let st = { x: 10, y: 17, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.15, speed: 0 };
      const targetPose = { x: 10, y: 20, heading: 0 };
      const res = stepUntil(
        (_, dt) => {
          st = stepAgfKinematics(st, { targetPose }, dt, {});
        },
        () => Math.hypot(st.x - targetPose.x, st.y - targetPose.y) <= 0.015 && Math.abs(wrapAngle(st.heading - targetPose.heading)) <= 0.01,
        900,
        1 / 60
      );
      assert.equal(res.done, true, `AGF docked dist=${Math.hypot(st.x - 10, st.y - 20).toFixed(4)}`);
      assertFinitePose(st, "dockedAgf");
    },
  },
  {
    id: "T1-F3-05",
    tier: 1,
    features: ["F3"],
    title: "stepAgfKinematics container LIFO reachability check",
    run({ mods }) {
      const { stepAgfKinematics } = mods.kinematics;
      const base = { x: 0, y: 0, z: 0, heading: 0, steerAngleRad: 0, forkHeightM: 0.15, speed: 0 };
      const slots = [
        { slotIndex: 18, palletSize: "standard", cargoWcid: 4000010 },
        { slotIndex: 19, palletSize: "standard", cargoWcid: 4000011 },
      ];
      const ok = stepAgfKinematics(
        base,
        { containerOp: { containerKind: 11, occupiedSlots: slots, slotIndex: 18, op: "unload" } },
        1 / 60,
        { containerKind: 11, containerSlots: slots }
      );
      assert.equal(ok.lifoBlocked, false, "slot 18 reachable for unload");

      const blocked = stepAgfKinematics(
        base,
        { containerOp: { containerKind: 11, occupiedSlots: slots, slotIndex: 0, op: "unload" } },
        1 / 60,
        { containerKind: 11, containerSlots: slots }
      );
      assert.equal(blocked.lifoBlocked, true, "slot 0 blocked behind 18/19");
    },
  },

  // =========================================================================
  // F4 — Underride AMR & Lift Table Kinematics
  // =========================================================================
  {
    id: "T1-F4-01",
    tier: 1,
    features: ["F4"],
    title: "stepAmrKinematics diff-drive linear transit & wheel spins",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      let stEmpty = { x: 0, y: 0, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0, speed: 0 };
      for (let i = 0; i < 120; i++) {
        stEmpty = stepAmrKinematics(stEmpty, { targetPose: { x: 0, y: 10, heading: 0 } }, 1 / 60);
      }
      assert.ok(stEmpty.y > 0.5 && Math.abs(stEmpty.x) < 1e-4, "moves along +Y without lateral slip");
      assert.ok(stEmpty.speed <= 2.005, `empty speed ${stEmpty.speed} <= 2.0`);
      assert.ok(stEmpty.wheelSpinL > 0 && Math.abs(stEmpty.wheelSpinL - stEmpty.wheelSpinR) < 1e-3);

      let stLoaded = { x: 0, y: 0, heading: 0, liftHeightM: 0.450, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0, speed: 0, loaded: true };
      for (let i = 0; i < 120; i++) {
        stLoaded = stepAmrKinematics(stLoaded, { targetPose: { x: 0, y: 10, heading: 0 } }, 1 / 60);
      }
      assert.ok(stLoaded.speed <= 1.505, `loaded speed ${stLoaded.speed} <= 1.5`);
    },
  },
  {
    id: "T1-F4-02",
    tier: 1,
    features: ["F4"],
    title: "stepAmrKinematics zero-turn-radius in-place rotation",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      let st = { x: 5, y: 5, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0, speed: 0 };
      const res = stepUntil(
        (_, dt) => {
          st = stepAmrKinematics(st, { targetPose: { x: 5, y: 5, heading: Math.PI / 2 } }, dt);
        },
        () => Math.abs(wrapAngle(st.heading - Math.PI / 2)) <= 0.01,
        300,
        1 / 60
      );
      assert.equal(res.done, true, `AMR rotated to pi/2 (got ${st.heading})`);
      assert.ok(Math.hypot(st.x - 5, st.y - 5) < 0.01, "zero-turn XY drift < 0.01 m");
      assert.ok(st.wheelSpinL * st.wheelSpinR < 0, "diff-drive wheels spin oppositely during ZTR");
    },
  },
  {
    id: "T1-F4-03",
    tier: 1,
    features: ["F4"],
    title: "stepAmrKinematics keepCargoHeading turntable hold",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      let st = { x: 0, y: 0, heading: 0, liftHeightM: 0.450, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0, loaded: true };
      const initialCargoWorldHeading = st.heading + st.turntableYawRad;
      for (let i = 0; i < 120; i++) {
        st = stepAmrKinematics(st, { targetPose: { x: 0, y: 0, heading: Math.PI / 2 }, keepCargoHeading: true, heldCargoHeading: initialCargoWorldHeading }, 1 / 60);
        const worldCargoH = wrapAngle(st.heading + st.turntableYawRad);
        assert.ok(Math.abs(wrapAngle(worldCargoH - initialCargoWorldHeading)) <= 0.015, `cargo heading drifted: ${worldCargoH}`);
      }
      assert.ok(Math.abs(wrapAngle(st.heading - Math.PI / 2)) <= 0.02);
    },
  },
  {
    id: "T1-F4-04",
    tier: 1,
    features: ["F4"],
    title: "stepAmrKinematics scissor lift stroke & motion lock",
    run({ mods }) {
      const { stepAmrKinematics } = mods.kinematics;
      let st = { x: 1, y: 2, heading: 0, liftHeightM: 0.260, turntableYawRad: 0, wheelSpinL: 0, wheelSpinR: 0 };
      const raiseRes = stepUntil(
        (_, dt) => {
          const prevX = st.x;
          const prevY = st.y;
          st = stepAmrKinematics(st, { targetLiftHeightM: 0.450, targetPose: { x: 10, y: 20, heading: 0 } }, dt);
          if (st.liftHeightM < 0.449) {
            assert.ok(Math.hypot(st.x - prevX, st.y - prevY) < 1e-6, "AMR must not translate while lifting");
          }
        },
        () => Math.abs(st.liftHeightM - 0.450) <= 1e-4,
        180,
        1 / 60
      );
      assert.equal(raiseRes.done, true, "AMR reached 0.450 m lift");
      const lowerRes = stepUntil(
        (_, dt) => {
          st = stepAmrKinematics(st, { targetLiftHeightM: 0.260 }, dt);
        },
        () => Math.abs(st.liftHeightM - 0.260) <= 1e-4,
        180,
        1 / 60
      );
      assert.equal(lowerRes.done, true, "AMR lowered back to 0.260 m");
    },
  },
  {
    id: "T1-F4-05",
    tier: 1,
    features: ["F4"],
    title: "stepLiftTable smooth hydraulic stroke 0.000 <-> 0.380 m",
    run({ mods }) {
      const { stepLiftTable } = mods.kinematics;
      let st = { heightM: 0.0, moving: false, interlockBlocked: false };
      const up = stepUntil(
        (_, dt) => {
          st = stepLiftTable(st, { targetHeightM: 0.380 }, dt, {});
          assert.equal(st.interlockBlocked, false);
        },
        () => Math.abs(st.heightM - 0.380) <= 1e-4 && !st.moving,
        300,
        1 / 60
      );
      assert.equal(up.done, true, `LiftTable raised to ${st.heightM}`);
      const dn = stepUntil(
        (_, dt) => {
          st = stepLiftTable(st, { targetHeightM: 0.0 }, dt, {});
        },
        () => Math.abs(st.heightM - 0.0) <= 1e-4 && !st.moving,
        300,
        1 / 60
      );
      assert.equal(dn.done, true, `LiftTable lowered to ${st.heightM}`);
    },
  },

  // =========================================================================
  // F5 — 2D Spatial Reservation Grid
  // =========================================================================
  {
    id: "T1-F5-01",
    tier: 1,
    features: ["F5"],
    title: "SpatialReservationGrid non-overlapping multi-agent claims",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      assert.equal(gridClaim(grid, "agf-1", 0, 0, 0.7), true);
      assert.equal(gridClaim(grid, "agf-2", 5, 0, 0.7), true);
      assert.equal(gridClaim(grid, "amr-1", 0, 5, 0.5), true);
    },
  },
  {
    id: "T1-F5-02",
    tier: 1,
    features: ["F5"],
    title: "SpatialReservationGrid release frees cell for next agent",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      assert.equal(gridClaim(grid, "agent-a", 2, 2, 0.7), true);
      assert.equal(gridClaim(grid, "agent-b", 2, 2, 0.7), false);
      gridRelease(grid, "agent-a", 2, 2);
      assert.equal(gridClaim(grid, "agent-b", 2, 2, 0.7), true);
    },
  },
  {
    id: "T1-F5-03",
    tier: 1,
    features: ["F5"],
    title: "SpatialReservationGrid queryProximity clear corridor (> 2.2 m)",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      gridClaim(grid, "agent-b", 3.0, 0, 0.5);
      const q = gridQueryProximity(grid, "agent-a", 0, 0, 0.5);
      assert.equal(q.stop, false);
      assert.equal(q.slow, false);
    },
  },
  {
    id: "T1-F5-04",
    tier: 1,
    features: ["F5"],
    title: "SpatialReservationGrid queryProximity slow zone (0.8..2.2 m)",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      gridClaim(grid, "agent-b", 1.5, 0, 0.5);
      const q = gridQueryProximity(grid, "agent-a", 0, 0, 0.5);
      assert.equal(q.slow, true);
      assert.equal(q.stop, false);
    },
  },
  {
    id: "T1-F5-05",
    tier: 1,
    features: ["F5"],
    title: "SpatialReservationGrid queryProximity stop zone (<= 0.8 m)",
    run({ mods }) {
      const { SpatialReservationGrid } = mods.kinematics;
      const grid = new SpatialReservationGrid();
      gridClaim(grid, "agent-b", 0.5, 0, 0.5);
      const q = gridQueryProximity(grid, "agent-a", 0, 0, 0.5);
      assert.equal(q.stop, true);
    },
  },

  // =========================================================================
  // F6 — 4-Tier Selective Steel Racking 3D Model
  // =========================================================================
  {
    id: "T1-F6-01",
    tier: 1,
    features: ["F6"],
    title: "Rack model manifest, lintSource, and zero lights",
    async run({ THREE, mods }) {
      const { manifest, buildRackRow } = mods.rackModel;
      assert.deepEqual(lintManifest(manifest), [], "rack manifest lint errors");
      assert.equal(manifest.lightCountDelta, 0);
      assert.equal(manifest.cacheKeyScope, "set");
      const src = readVehicleSource("warehouse_rack_model.js");
      assert.deepEqual(lintSource(src), [], "rack source lint hits");
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      try {
        assert.equal(countLights(row.root), 0);
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T1-F6-02",
    tier: 1,
    features: ["F6"],
    title: "buildRackRow merged draw calls (<= 4), CSM PBR & WebGL2 render",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      for (const doubleSided of [false, true]) {
        const row = buildRackRow(THREE, { bayCount: 8, doubleSided }, { csmState: makeCsmState() });
        try {
          const dc = countDrawCalls(row.root);
          assert.ok(dc >= 1 && dc <= 4, `rack row double=${doubleSided} drawCalls=${dc} <= 4`);
          let meshCount = 0;
          row.root.traverse((o) => {
            if (o.isMesh) {
              meshCount++;
              assert.ok(o.material.isMeshStandardMaterial, "rack uses MeshStandardMaterial");
            }
          });
          assert.ok(meshCount >= 1);
          const r = renderWithFakeWebGL2(THREE, row.root, { cameraPos: [0, -25, 10], lookAt: [10, 0, 3] });
          try {
            assert.ok(r.emittedDraws > 0);
            assert.deepEqual(r.capturedErrors, []);
          } finally {
            r.dispose();
          }
        } finally {
          row.dispose();
        }
      }
    },
  },
  {
    id: "T1-F6-03",
    tier: 1,
    features: ["F6"],
    title: "buildRackBay, getSlotWorldPos & row Box3 geometry parity",
    async run({ THREE, mods }) {
      const { buildRackBay, buildRackRow } = mods.rackModel;
      const { RACK_SPECS, computeRackRowBounds, computeRackSlotLocalPose } = mods.specs;
      const bay = buildRackBay(THREE, { csmState: makeCsmState() });
      try {
        assert.equal(countLights(bay.root), 0);
        const bayBox = computeBox3(THREE, bay.root);
        assert.ok(bayBox.max.z > 7.05);
      } finally {
        bay.dispose();
      }

      const row = buildRackRow(THREE, { bayCount: 8, doubleSided: false }, { csmState: makeCsmState() });
      try {
        const rowBox = computeBox3(THREE, row.root);
        const size = new THREE.Vector3();
        rowBox.getSize(size);
        const specBounds = computeRackRowBounds(8, false, RACK_SPECS);
        assert.ok(Math.abs(size.x - specBounds.width) < 0.25, `row width ${size.x} vs ${specBounds.width}`);
        assert.ok(Math.abs(size.z - specBounds.height) < 0.35, `row height ${size.z} vs ${specBounds.height}`);
        const expectedZ = [0.0, 2.35, 4.70, 7.05];
        for (let t = 0; t < 4; t++) {
          const wp = rackGetSlotWorldPos(row, 2, t, 0, 1);
          const lp = computeRackSlotLocalPose(2, t, 1, RACK_SPECS);
          assert.ok(Math.abs((wp.z ?? wp[2]) - expectedZ[t]) < 0.01);
          assert.ok(Math.abs((wp.z ?? wp[2]) - lp.z) < 0.01);
        }
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T1-F6-04",
    tier: 1,
    features: ["F6"],
    title: "loadSlot, unloadSlot, setHighlightedSlot across stowed WCIDs",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      try {
        const baseDc = countVisibleDrawCalls(row.root);
        rackLoadSlot(row, 0, 1, 0, 0, 4000010);
        rackLoadSlot(row, 1, 2, 0, 1, 4000002);
        rackLoadSlot(row, 2, 0, 0, 0, 4000099); // fallback pallet
        assert.ok(countVisibleDrawCalls(row.root) > baseDc, "loaded slots add cargo meshes");
        rackHighlightSlot(row, 0, 1, 0, 0, "target");
        rackHighlightSlot(row, null);
        rackUnloadSlot(row, 0, 1, 0, 0);
        rackUnloadSlot(row, 1, 2, 0, 1);
        rackUnloadSlot(row, 2, 0, 0, 0);
        assert.equal(countVisibleDrawCalls(row.root), baseDc, "unloading restores base draw calls");
      } finally {
        row.dispose();
      }
    },
  },
  {
    id: "T1-F6-05",
    tier: 1,
    features: ["F6"],
    title: "setCargoLodDistance LOD switch (> 120 m) & clean dispose()",
    async run({ THREE, mods }) {
      const { buildRackRow } = mods.rackModel;
      const row = buildRackRow(THREE, { bayCount: 4, doubleSided: false }, { csmState: makeCsmState() });
      const spy = spyDisposal(row.root);
      for (let b = 0; b < 4; b++) {
        for (let t = 0; t < 4; t++) {
          rackLoadSlot(row, b, t, 0, 0, ALL_DEPLOYABLE_WCIDS[(b + t) % ALL_DEPLOYABLE_WCIDS.length]);
        }
      }
      const cargoSpy = spyDisposal(row.root);
      row.setCargoLodDistance(new THREE.Vector3(0, -10, 2));
      const nearDc = countVisibleDrawCalls(row.root);
      row.setCargoLodDistance(new THREE.Vector3(0, -150, 10));
      const farDc = countVisibleDrawCalls(row.root);
      assert.ok(farDc < nearDc, `far LOD (${farDc}) < near (${nearDc})`);
      row.dispose();
      spy.assertAllDisposed("rackRow");
      cargoSpy.assertAllDisposed("rackRow+cargo");
    },
  },

  // =========================================================================
  // F7 — AGF Forklift 3D Model
  // =========================================================================
  {
    id: "T1-F7-01",
    tier: 1,
    features: ["F7"],
    title: "AGF model manifest, lintSource, <= 10 DC, 0 lights, WebGL2 render",
    async run({ THREE, mods }) {
      const { manifest, buildAgfForklift } = mods.agfModel;
      assert.deepEqual(lintManifest(manifest), []);
      assert.equal(manifest.lightCountDelta, 0);
      assert.deepEqual(lintSource(readVehicleSource("agf_forklift_model.js")), []);

      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        const dc = countDrawCalls(agf.root);
        assert.ok(dc >= 1 && dc <= 10, `AGF unloaded DC=${dc} <= 10`);
        assert.equal(countLights(agf.root), 0);
        const r = renderWithFakeWebGL2(THREE, agf.root, { cameraPos: [3, -5, 2], lookAt: [0, 0, 1] });
        try {
          assert.ok(r.emittedDraws > 0);
          assert.deepEqual(r.capturedErrors, []);
        } finally {
          r.dispose();
        }
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T1-F7-02",
    tier: 1,
    features: ["F7"],
    title: "AGF collapsed envelope (<= 2.160 m H, <= 1.140 m W, 0.685 m forks)",
    async run({ THREE, mods }) {
      const { AGF_SPECS } = mods.specs;
      const { buildAgfForklift } = mods.agfModel;
      const spread = AGF_SPECS.forkSpreadM ?? AGF_SPECS.forkSpread;
      assert.ok(Math.abs(spread - 0.685) <= 0.005, `AGF_SPECS fork spread=${spread} ~ 0.685 m`);

      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        for (const fh of [0.045, 1.700]) {
          agf.update({ forkHeightM: fh });
          const box = computeBox3(THREE, agf.root);
          const size = new THREE.Vector3();
          box.getSize(size);
          assert.ok(box.max.z <= 2.165, `collapsed max.z=${box.max.z} at fork=${fh}`);
          assert.ok(size.x <= 1.150, `AGF width=${size.x}`);
          assert.ok(box.max.y >= 1.10, `AGF fork tips extend forward max.y=${box.max.y}`);
        }
        agf.update({ forkHeightM: 0.045 });
        agf.root.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        let minForkX = Infinity;
        let maxForkX = -Infinity;
        let maxForkY = -Infinity;
        let forkVerts = 0;
        agf.root.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (v.y > 0.50 && v.z < 0.25) {
              forkVerts++;
              if (v.x < minForkX) minForkX = v.x;
              if (v.x > maxForkX) maxForkX = v.x;
              if (v.y > maxForkY) maxForkY = v.y;
            }
          }
        });
        assert.ok(forkVerts > 0, "AGF fork tine geometry present forward of chassis");
        const forkSpanX = maxForkX - minForkX;
        assert.ok(
          forkSpanX >= 0.60 && forkSpanX <= 0.72,
          `AGF fork outer X span=${forkSpanX.toFixed(4)} m consistent with 0.645-0.685 m`
        );
        assert.ok(maxForkY >= 1.10, `AGF fork tip Y=${maxForkY.toFixed(3)} m`);
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T1-F7-03",
    tier: 1,
    features: ["F7"],
    title: "AGF 3-stage telescopic mast extension to 7.250 m",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        let prevZ = -Infinity;
        for (const fh of [0.045, 2.35, 4.70, 7.250]) {
          agf.update({ forkHeightM: fh });
          agf.root.updateMatrixWorld(true);
          const wp = new THREE.Vector3();
          agf.cargoMount.getWorldPosition(wp);
          assert.ok(Number.isFinite(wp.z) && wp.z > prevZ, `cargoMount Z=${wp.z} at ${fh}`);
          prevZ = wp.z;
        }
        const topBox = computeBox3(THREE, agf.root);
        assert.ok(topBox.max.z >= 7.25, `AGF topBox.max.z=${topBox.max.z} >= 7.25`);
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T1-F7-04",
    tier: 1,
    features: ["F7"],
    title: "AGF side-shift, mast tilt, rear steer, wheel/LiDAR spin & status modes",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      try {
        agf.update({ sideShiftM: 0.0, forkHeightM: 0.5 });
        agf.root.updateMatrixWorld(true);
        const pCenter = new THREE.Vector3();
        agf.cargoMount.getWorldPosition(pCenter);

        agf.update({ sideShiftM: 0.10, forkHeightM: 0.5 });
        agf.root.updateMatrixWorld(true);
        const pRight = new THREE.Vector3();
        agf.cargoMount.getWorldPosition(pRight);
        assert.ok(Math.abs((pRight.x - pCenter.x) - 0.10) < 0.02, `sideShift delta=${pRight.x - pCenter.x}`);

        for (const statusMode of ["transit", "lifting", "docking", "yield", "idle"]) {
          agf.update({
            forkHeightM: 1.2,
            sideShiftM: -0.05,
            mastTiltRad: 0.05,
            steerAngleRad: 1.0,
            wheelSpinRad: 2.5,
            lidarSpinRad: 3.1,
            statusMode,
            dt: 1 / 60,
          });
        }
        const b = computeBox3(THREE, agf.root);
        assert.ok(Number.isFinite(b.max.z));
      } finally {
        agf.dispose();
      }
    },
  },
  {
    id: "T1-F7-05",
    tier: 1,
    features: ["F7"],
    title: "AGF cargoMount tunnel threading & cargo swap/disposal",
    async run({ THREE, mods }) {
      const { buildAgfForklift } = mods.agfModel;
      const agf = buildAgfForklift(THREE, { csmState: makeCsmState() });
      const baseSpy = spyDisposal(agf.root);
      agf.update({ carriedWcid: 4000012, forkHeightM: 0.045, supportSurfaceZ: 0.0 });
      const boxFloor = localBoxInParent(THREE, agf.cargoMount, agf.root);
      assert.ok(boxFloor.min.z >= -0.002, `cargo bottom >= 0 (got ${boxFloor.min.z})`);

      agf.update({ carriedWcid: 4000012, forkHeightM: 0.25, supportSurfaceZ: 0.0 });
      const boxLift = localBoxInParent(THREE, agf.cargoMount, agf.root);
      assert.ok(boxLift.min.z >= 0.12 && boxLift.min.z <= 0.26, `tunnel threaded z=${boxLift.min.z}`);

      const swapSpy = spyDisposal(agf.cargoMount);
      agf.update({ carriedWcid: 4000002, forkHeightM: 0.25, supportSurfaceZ: 0.0 });
      swapSpy.assertAllDisposed("AGF swapped cargo 4000012");

      agf.update({ carriedWcid: 0, forkHeightM: 0.045 });
      assert.ok(countDrawCalls(agf.root) <= 10);
      agf.dispose();
      baseSpy.assertAllDisposed("AGF base");
    },
  },

  // =========================================================================
  // F8 — Underride AMR 3D Model
  // =========================================================================
  {
    id: "T1-F8-01",
    tier: 1,
    features: ["F8"],
    title: "AMR model manifest, lintSource, <= 6 DC, 0 lights, WebGL2 render",
    async run({ THREE, mods }) {
      const { manifest, buildAmrUnderride } = mods.amrModel;
      assert.deepEqual(lintManifest(manifest), []);
      assert.equal(manifest.lightCountDelta, 0);
      assert.deepEqual(lintSource(readVehicleSource("amr_underride_model.js")), []);

      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        const dc = countDrawCalls(amr.root);
        assert.ok(dc >= 1 && dc <= 6, `AMR unloaded DC=${dc} <= 6`);
        assert.equal(countLights(amr.root), 0);
        const r = renderWithFakeWebGL2(THREE, amr.root, { cameraPos: [2, -2, 1.5], lookAt: [0, 0, 0.2] });
        try {
          assert.ok(r.emittedDraws > 0);
          assert.deepEqual(r.capturedErrors, []);
        } finally {
          r.dispose();
        }
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T1-F8-02",
    tier: 1,
    features: ["F8"],
    title: "AMR lowered envelope (0.780 x 1.040 x 0.260 m)",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ liftHeightM: 0.260 });
        const box = computeBox3(THREE, amr.root);
        const size = new THREE.Vector3();
        box.getSize(size);
        assert.ok(size.x <= 0.785, `AMR width ${size.x}`);
        assert.ok(size.y <= 1.045, `AMR length ${size.y}`);
        assert.ok(box.max.z <= 0.265, `AMR lowered max.z ${box.max.z}`);
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T1-F8-03",
    tier: 1,
    features: ["F8"],
    title: "AMR raised platen (0.450 m) & cargoMount elevation",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ liftHeightM: 0.450 });
        amr.root.updateMatrixWorld(true);
        const wp = new THREE.Vector3();
        amr.cargoMount.getWorldPosition(wp);
        assert.ok(Math.abs(wp.z - 0.450) <= 0.008, `cargoMount Z=${wp.z}`);
        const box = computeBox3(THREE, amr.root);
        assert.ok(box.max.z >= 0.445 && box.max.z <= 0.460, `raised max.z=${box.max.z}`);
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T1-F8-04",
    tier: 1,
    features: ["F8"],
    title: "AMR independent turntable rotation (turntableYawRad)",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      try {
        amr.update({ liftHeightM: 0.450, turntableYawRad: Math.PI / 2, carriedWcid: 4000010 });
        amr.root.updateMatrixWorld(true);
        assert.equal(amr.root.rotation.z, 0, "AMR chassis root unrotated");
        const q = new THREE.Quaternion();
        amr.cargoMount.getWorldQuaternion(q);
        const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
        assert.ok(Math.abs(Math.abs(e.z) - Math.PI / 2) < 0.02, `turntable yaw=${e.z}`);
      } finally {
        amr.dispose();
      }
    },
  },
  {
    id: "T1-F8-05",
    tier: 1,
    features: ["F8"],
    title: "AMR cargo mounting, status modes & clean dispose()",
    async run({ THREE, mods }) {
      const { buildAmrUnderride } = mods.amrModel;
      const amr = buildAmrUnderride(THREE, { csmState: makeCsmState() });
      const baseSpy = spyDisposal(amr.root);
      for (const mode of ["transit", "lifting", "charging", "yield"]) {
        for (const wcid of [4000010, 4000002, 4000017]) {
          amr.update({ liftHeightM: 0.450, statusMode: mode, carriedWcid: wcid, wheelSpinL: 1.0, wheelSpinR: 1.0 });
        }
      }
      const cargoSpy = spyDisposal(amr.cargoMount);
      amr.dispose();
      baseSpy.assertAllDisposed("AMR base");
      cargoSpy.assertAllDisposed("AMR cargo");
    },
  },

  // =========================================================================
  // F9 — Concrete Apron, P&D Stands, Lift Tables, Chargers 3D Models
  // =========================================================================
  {
    id: "T1-F9-01",
    tier: 1,
    features: ["F9"],
    title: "Infra models manifest, lintSource & 0 lights",
    run({ mods }) {
      const { manifest } = mods.infraModel;
      assert.deepEqual(lintManifest(manifest), []);
      assert.equal(manifest.lightCountDelta, 0);
      assert.deepEqual(lintSource(readVehicleSource("warehouse_infra_model.js")), []);
    },
  },
  {
    id: "T1-F9-02",
    tier: 1,
    features: ["F9"],
    title: "buildConcreteApron (<= 3 DC, z = +0.004 m, polygonOffset)",
    async run({ THREE, mods }) {
      const { buildConcreteApron } = mods.infraModel;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const apron = buildConcreteApron(THREE, layout, { csmState: makeCsmState() });
      try {
        const dc = countDrawCalls(apron.root);
        assert.ok(dc >= 1 && dc <= 3, `apron DC=${dc} <= 3`);
        assert.equal(countLights(apron.root), 0);
        const box = computeBox3(THREE, apron.root);
        assert.ok(box.max.z >= 0.001 && box.max.z <= 0.02, `apron max.z=${box.max.z}`);
        let sawPolyOffset = false;
        apron.root.traverse((o) => {
          if (o.isMesh && o.material?.polygonOffset) sawPolyOffset = true;
        });
        assert.equal(sawPolyOffset, true, "apron uses polygonOffset");
        const r = renderWithFakeWebGL2(THREE, apron.root, {
          cameraPos: [NE_FLATLAND_SITE.origin[0], NE_FLATLAND_SITE.origin[1] - 40, 30],
          lookAt: NE_FLATLAND_SITE.origin,
        });
        try {
          assert.ok(r.emittedDraws > 0);
          assert.deepEqual(r.capturedErrors, []);
        } finally {
          r.dispose();
        }
      } finally {
        apron.dispose();
      }
    },
  },
  {
    id: "T1-F9-03",
    tier: 1,
    features: ["F9"],
    title: "buildTransferStand & buildTransferStandGroup (<= 2 DC, 0.380 m rail, tunnel)",
    async run({ THREE, mods }) {
      const { buildTransferStand, buildTransferStandGroup } = mods.infraModel;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const single = buildTransferStand(THREE, { csmState: makeCsmState() });
      try {
        const b = computeBox3(THREE, single.root);
        const s = new THREE.Vector3();
        b.getSize(s);
        assert.ok(s.x <= 1.29 && s.y <= 1.15, `stand size ${s.x}x${s.y}`);
        assert.equal(countLights(single.root), 0);
      } finally {
        single.dispose();
      }

      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const grp = buildTransferStandGroup(THREE, layout.stands, { csmState: makeCsmState() });
      try {
        const dc = countDrawCalls(grp.root);
        assert.ok(dc >= 1 && dc <= 2, `standGroup DC=${dc} <= 2`);
        grp.setSlotCargo(0, 4000011);
        grp.setHighlighted(0, "target");
        assert.ok(countVisibleDrawCalls(grp.root) > dc);
        grp.setSlotCargo(0, 0);
      } finally {
        grp.dispose();
      }
    },
  },
  {
    id: "T1-F9-04",
    tier: 1,
    features: ["F9"],
    title: "buildScissorLiftTable (<= 4 DC, 0.000 <-> 0.380 m, cargo mount)",
    async run({ THREE, mods }) {
      const { buildScissorLiftTable } = mods.infraModel;
      const lt = buildScissorLiftTable(THREE, { csmState: makeCsmState() });
      try {
        const dc = countDrawCalls(lt.root);
        assert.ok(dc >= 1 && dc <= 4, `liftTable DC=${dc} <= 4`);
        assert.equal(countLights(lt.root), 0);

        lt.update({ heightM: 0.0 });
        lt.root.updateMatrixWorld(true);
        const pLow = new THREE.Vector3();
        lt.cargoMount.getWorldPosition(pLow);
        assert.ok(pLow.z <= 0.02, `lowered cargoMount z=${pLow.z}`);

        lt.update({ heightM: 0.380, carriedWcid: 4000012, highlightState: "target", statusMode: "idle" });
        lt.root.updateMatrixWorld(true);
        const pHigh = new THREE.Vector3();
        lt.cargoMount.getWorldPosition(pHigh);
        assert.ok(Math.abs(pHigh.z - 0.380) <= 0.01, `raised cargoMount z=${pHigh.z}`);
      } finally {
        lt.dispose();
      }
    },
  },
  {
    id: "T1-F9-05",
    tier: 1,
    features: ["F9"],
    title: "buildChargingDock / buildChargingDockGroup & full infra dispose()",
    async run({ THREE, mods }) {
      const { buildConcreteApron, buildTransferStandGroup, buildScissorLiftTable, buildChargingDock, buildChargingDockGroup } = mods.infraModel;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);

      const singleDock = buildChargingDock(THREE, { csmState: makeCsmState() });
      assert.equal(countLights(singleDock.root), 0);
      singleDock.dispose();

      const apron = buildConcreteApron(THREE, layout, { csmState: makeCsmState() });
      const stands = buildTransferStandGroup(THREE, layout.stands, { csmState: makeCsmState() });
      const chargers = buildChargingDockGroup(THREE, layout.chargers, { csmState: makeCsmState() });
      const lift = buildScissorLiftTable(THREE, { csmState: makeCsmState() });

      const combinedDc = countDrawCalls(stands.root) + countDrawCalls(chargers.root);
      assert.ok(combinedDc <= 3, `stands + chargers DC=${combinedDc} <= 3`);
      chargers.setDockState(0, "charging");

      const spies = [apron, stands, chargers, lift].map((m) => spyDisposal(m.root));
      apron.dispose();
      stands.dispose();
      chargers.dispose();
      lift.dispose();
      spies.forEach((s, i) => s.assertAllDisposed(`infra[${i}]`));
    },
  },

  // =========================================================================
  // F10 — Scriptable Warehouse Manager & Scenarios
  // =========================================================================
  {
    id: "T1-F10-01",
    tier: 1,
    features: ["F10"],
    title: "createWarehouseManager worldRoot attachment & buildHub",
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
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin, preset: "default" });
        assert.ok(rig.worldRoot.children.length >= 1, "hub attached to worldRoot");
        assert.equal(rig.scene.children.length, 0, "must never attach to scene directly");
        const st = mgr.getState();
        assertNoNaNDeep(st, "hubState");
        assert.ok(mgr.racks.size >= 4 || mgr.racks.length >= 4);
        assert.ok((mgr.stands.size ?? mgr.stands.length) >= 18);
        assert.ok((mgr.liftTables.size ?? mgr.liftTables.length) >= 2);
        assert.ok((mgr.chargers.size ?? mgr.chargers.length) >= 8);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F10-02",
    tier: 1,
    features: ["F10"],
    title: "spawnAgf, spawnAmr, getState(), stats telemetry",
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
        const agf = mgr.spawnAgf("agf-1", { pos: [ox - 5, oy + 18, 0], heading: 0 });
        const amr = mgr.spawnAmr("amr-1", { pos: [ox - 2, oy - 25, 0], heading: Math.PI / 2 });
        assert.ok(agf && amr);
        assert.ok(mgr.agfs.has("agf-1") && mgr.amrs.has("amr-1"));
        mgr.tick(1 / 60, [ox, oy, 20]);
        const st = mgr.getState();
        assertNoNaNDeep(st, "state");
        assert.ok(mgr.stats && typeof mgr.stats === "object");
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F10-03",
    tier: 1,
    features: ["F10"],
    title: "AGF Promise task queue (driveTo -> placeInRack -> pickFromRack -> placeOnStand)",
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
        const deployables = new Map();
        // Put a ground deployable in staging to pick up, or driveTo + placeInRack
        const agf = mgr.spawnAgf("agf-q", { pos: [ox - 10, oy + 18, 0], heading: 0, carriedWcid: 4000010 });
        const rackId = [...mgr.racks.keys()][0];
        const standId = [...mgr.stands.keys()][0];

        await driveManagerPromise(mgr, agf.enqueue({ type: "driveTo", waypoints: [[ox - 5, oy + 18]] }));
        await driveManagerPromise(mgr, agf.enqueue({ type: "placeInRack", rackId, bay: 0, tier: 1, side: 0, slotInBay: 0 }));
        await driveManagerPromise(mgr, agf.enqueue({ type: "pickFromRack", rackId, bay: 0, tier: 1, side: 0, slotInBay: 0 }));
        await driveManagerPromise(mgr, agf.enqueue({ type: "placeOnStand", standId }));

        const st = mgr.getState();
        assertNoNaNDeep(st, "agfQueueState");
        const standState = st.stands?.[standId] ?? mgr.stands.get(standId);
        assert.equal(standState.carriedWcid ?? standState.cargoWcid ?? standState.wcid, 4000010);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F10-04",
    tier: 1,
    features: ["F10"],
    title: "AMR Promise task queue & Lift Table auto/manual commands",
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
        const standId = [...mgr.stands.keys()][0];
        const liftId = [...mgr.liftTables.keys()][0];
        const chargerId = [...mgr.chargers.keys()][0];
        const agf = mgr.spawnAgf("agf-seed", { pos: [ox - 8, oy + 18, 0], heading: 0, carriedWcid: 4000012 });
        await driveManagerPromise(mgr, agf.enqueue({ type: "placeOnStand", standId }));

        const lt = mgr.liftTables.get(liftId);
        lt.setAutoMode(false);
        await driveManagerPromise(mgr, lt.raise());
        assert.ok(lt.heightM >= 0.375);

        const amr = mgr.spawnAmr("amr-q", { pos: [ox - 10, oy - 24, 0], heading: 0 });
        await driveManagerPromise(mgr, amr.enqueue({ type: "pickFromStand", standId }));
        await driveManagerPromise(mgr, amr.enqueue({ type: "driveTo", waypoints: [[ox - 20, oy - 24]], keepCargoHeading: true }));
        await driveManagerPromise(mgr, amr.enqueue({ type: "placeOnStand", standId: liftId }));
        await driveManagerPromise(mgr, amr.enqueue({ type: "dockCharge", chargerId }));

        await driveManagerPromise(mgr, lt.lower());
        assert.ok(lt.heightM <= 0.005);
        lt.setAutoMode(true);
      } finally {
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F10-05",
    tier: 1,
    features: ["F10"],
    title: "runScenario('full-intermodal-loop'), 'scale-stress', stopScenarios, clearHub, dispose",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      const mgr = rig.win.__vehicles.warehouse;
      try {
        const baseline = collectResources(rig.worldRoot);
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
        const hubRoot = rig.worldRoot.getObjectByName("WarehouseHubRoot");
        assert.ok(hubRoot, "WarehouseHubRoot attached to worldRoot after buildHub");

        const p1 = mgr.runScenario("full-intermodal-loop");
        for (let i = 0; i < 60; i++) mgr.tick(1 / 60, [NE_FLATLAND_SITE.origin[0], NE_FLATLAND_SITE.origin[1] - 30, 20]);
        assertNoNaNDeep(mgr.getState(), "full-intermodal-loop");
        assert.ok(mgr.agfs.size > 0 && mgr.amrs.size > 0, "full-intermodal-loop spawned AGFs and AMRs");
        mgr.stopScenarios();
        await Promise.resolve(p1).catch(() => {});

        const p2 = mgr.runScenario("scale-stress");
        for (let i = 0; i < 60; i++) mgr.tick(1 / 60, [NE_FLATLAND_SITE.origin[0], NE_FLATLAND_SITE.origin[1] - 30, 20]);
        const st = mgr.getState();
        assertNoNaNDeep(st, "scale-stress");
        assert.ok(mgr.agfs.size >= 8 && mgr.amrs.size >= 16);
        mgr.stopScenarios();
        await Promise.resolve(p2).catch(() => {});

        const hubSpy = spyDisposal(hubRoot);
        assert.ok(hubSpy.geometries.size > 0 && hubSpy.materials.size > 0, "WarehouseHubRoot holds disposable GPU resources");
        mgr.clearHub();
        hubSpy.assertAllDisposed("clearHub");
        assert.equal(rig.worldRoot.getObjectByName("WarehouseHubRoot") ?? null, null, "WarehouseHubRoot detached after clearHub");
        assert.equal(mgr.getState().built, false, "warehouse state built === false after clearHub");
        const postClear = collectResources(rig.worldRoot);
        assert.equal(postClear.geometries.size, baseline.geometries.size, "worldRoot geometries returned to pre-buildHub baseline");
        assert.equal(postClear.materials.size, baseline.materials.size, "worldRoot materials returned to pre-buildHub baseline");

        const worldSpy = spyDisposal(rig.worldRoot);
        rig.win.__vehicles.dispose();
        worldSpy.assertAllDisposed("vehicles.dispose");
        assert.equal(rig.worldRoot.children.length, 0, "worldRoot has 0 children after vehicles.dispose()");
        assert.equal(mgr.getState().disposed, true, "warehouse state disposed === true after vehicles.dispose()");
        assert.equal(rig.win.__vehicles, undefined, "window.__vehicles cleared after dispose()");
      } finally {
        rig.cleanup();
      }
    },
  },

  // =========================================================================
  // F11 — Live Container & Deployable Bridge
  // =========================================================================
  {
    id: "T1-F11-01",
    tier: 1,
    features: ["F11"],
    title: "Local container pickFromContainer LIFO & syncSlots",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x71000001;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox - 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [
            { slotIndex: 18, palletSize: "standard", cargoWcid: 4000012 },
            { slotIndex: 19, palletSize: "standard", cargoWcid: 4000013 },
          ],
        });
        cEntry.model.syncSlots(cEntry.slots);

        const agf = mgr.spawnAgf("agf-c1", { pos: [ox - 18, oy + 20, 0], heading: 0 });
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18 })
        );
        assert.equal(cEntry.slots.some((s) => s.slotIndex === 18), false, "slot 18 removed from entry.slots");
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-c1"].carriedWcid, 4000012);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-F11-02",
    tier: 1,
    features: ["F11"],
    title: "Local container loadIntoContainer LIFO & syncSlots",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x71000002;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 10, [ox + 18, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [],
        });

        const agf = mgr.spawnAgf("agf-c2", { pos: [ox + 18, oy + 20, 0], heading: 0, carriedWcid: 4000014 });
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "loadIntoContainer", containerGuid: cGuid, slotIndex: 0 })
        );
        const found = cEntry.slots.find((s) => s.slotIndex === 0);
        assert.ok(found && (found.cargoWcid ?? found.wcid) === 4000014, "slot 0 loaded with 4000014");
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-c2"].carriedWcid ?? 0, 0);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-F11-03",
    tier: 1,
    features: ["F11"],
    title: "Ground deployable interop (pickGroundDeployable / dropToGround)",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const dGuid = 0x72000001;
        rig.api.deployables.spawnLocal(dGuid, 4000015, [ox - 34, oy + 10, 0], 0, { stowed: true });

        const agf = mgr.spawnAgf("agf-d1", { pos: [ox - 34, oy + 16, 0], heading: Math.PI });
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "pickGroundDeployable", deployableGuid: dGuid })
        );
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-d1"].carriedWcid, 4000015);

        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "dropToGround", pos: [ox - 34, oy - 10, 0], heading: 0 })
        );
        assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-d1"].carriedWcid ?? 0, 0);
        const found = rig.api.deployables.list().some((d) => d.wcid === 4000015 && Math.hypot(d.pos[0] - (ox - 34), d.pos[1] - (oy - 10)) < 1.0);
        assert.equal(found, true, "dropped deployable visible at target ground pose");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-F11-04",
    tier: 1,
    features: ["F11"],
    title: "Server-backed container live sh().vehicleContainerAction dispatch",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x71000004;
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots: [{ slotIndex: 18, palletSize: "standard", cargoWcid: 4000016 }],
        });
        cEntry.localOnly = false;
        cEntry.model.syncSlots(cEntry.slots);

        const agf = mgr.spawnAgf("agf-srv", { pos: [ox, oy + 20, 0], heading: 0 });
        await driveVehiclesPromise(
          rig.live,
          agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex: 18, serverDispatch: true })
        );
        assert.ok(rig.calls.containerActions.length >= 1, "vehicleContainerAction dispatched");
        assert.equal(rig.calls.containerActions[0].containerGuid >>> 0, cGuid >>> 0);
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-F11-05",
    tier: 1,
    features: ["F11"],
    title: "All 9 deployable WCIDs (4000002, 4000010-4000017) end-to-end WCID preservation",
    async run({ THREE, mods }) {
      const { NE_FLATLAND_SITE } = mods.specs;
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const [ox, oy] = NE_FLATLAND_SITE.origin;
        const mgr = rig.win.__vehicles.warehouse;
        mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });

        const cGuid = 0x71000005;
        const slots = ALL_DEPLOYABLE_WCIDS.map((wcid, i) => ({
          slotIndex: 19 - i,
          palletSize: "standard",
          cargoWcid: wcid,
        }));
        const cEntry = rig.api.containers.spawnLocal(cGuid, 11, [ox, oy + 32, 0], Math.PI, {
          doorProgress: 1.0,
          slots,
        });
        cEntry.model.syncSlots(cEntry.slots);

        const agf = mgr.spawnAgf("agf-9", { pos: [ox, oy + 20, 0], heading: 0 });
        const amr = mgr.spawnAmr("amr-9", { pos: [ox, oy - 24, 0], heading: 0 });
        const rackId = [...mgr.racks.keys()][0];
        const standId = [...mgr.stands.keys()][0];

        for (let i = 0; i < ALL_DEPLOYABLE_WCIDS.length; i++) {
          const slotIndex = 19 - i;
          const expectedWcid = ALL_DEPLOYABLE_WCIDS[i];
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromContainer", containerGuid: cGuid, slotIndex }));
          assert.equal(agf.carriedWcid ?? mgr.getState().agfs["agf-9"].carriedWcid, expectedWcid);
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeInRack", rackId, bay: i % 8, tier: 1, side: 0, slotInBay: Math.floor(i / 8) }));
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromRack", rackId, bay: i % 8, tier: 1, side: 0, slotInBay: Math.floor(i / 8) }));
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "placeOnStand", standId }));
          await driveVehiclesPromise(rig.live, amr.enqueue({ type: "pickFromStand", standId }));
          assert.equal(amr.carriedWcid ?? mgr.getState().amrs["amr-9"].carriedWcid, expectedWcid);
          await driveVehiclesPromise(rig.live, amr.enqueue({ type: "placeOnStand", standId }));
          // Clear stand for next cycle via AGF drop
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "pickFromStand", standId }));
          await driveVehiclesPromise(rig.live, agf.enqueue({ type: "dropToGround", pos: [ox - 35 + i * 1.5, oy - 15, 0], heading: 0 }));
        }
      } finally {
        rig.cleanup();
      }
    },
  },

  // =========================================================================
  // F12 — Vehicle Index, Pallet Jack & Audio Wiring
  // =========================================================================
  {
    id: "T1-F12-01",
    tier: 1,
    features: ["F12"],
    title: "initVehicles wires window.__vehicles.warehouse & afterTick",
    async run({ THREE, mods }) {
      const rig = makeTestRig(THREE, mods.index.initVehicles);
      try {
        const wh = rig.win.__vehicles?.warehouse;
        assert.ok(wh && typeof wh === "object", "window.__vehicles.warehouse exposed");
        const requiredProps = [
          "buildHub", "clearHub", "spawnAgf", "spawnAmr", "agfs", "amrs",
          "racks", "stands", "liftTables", "chargers", "runScenario", "stopScenarios",
          "getState", "stats", "getObstacleBoxes", "findLoweredLiftTableTarget",
          "findStagingBayTarget", "dispose",
        ];
        for (const p of requiredProps) {
          assert.ok(p in wh, `warehouse missing property: ${p}`);
        }
        wh.buildHub();
        wh.spawnAgf("agf-t1", { pos: [44832, 46960, 0], heading: 0 });
        for (let i = 1; i <= 10; i++) {
          rig.tick(i * 16.667, 16.667);
        }
        assertNoNaNDeep(wh.getState(), "afterTickWarehouseState");
      } finally {
        rig.cleanup();
      }
    },
  },
  {
    id: "T1-F12-02",
    tier: 1,
    features: ["F12"],
    title: "Pallet Jack 2D OBB pushout against warehouseManager.getObstacleBoxes()",
    async run({ THREE, mods }) {
      const { createPalletJackController } = mods.palletJackController;
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
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const boxes = mgr.getObstacleBoxes();
      assert.ok(Array.isArray(boxes) && boxes.length > 0, "warehouseManager provides obstacle boxes");

      const normBoxes = boxes.map((raw) => {
        const b = normBox2D(raw);
        assert.ok(b, "valid obstacle box");
        return b;
      });
      const firstBox = normBoxes.reduce((best, b) => (b.x0 < best.x0 ? b : best), normBoxes[0]);
      const cy = (firstBox.y0 + firstBox.y1) * 0.5;
      const startX = firstBox.x0 - 0.65;

      const jackEntry = {
        guid: 0x60000001,
        worldPos: [startX, cy, 0],
        heading: Math.PI / 2,
        tillerAngle: 0,
        forkHeightM: 0.085,
        carriedWcid: 0,
        model: { root: new THREE.Group(), update() {}, dispose() {} },
      };
      const palletJacks = new Map([[jackEntry.guid, jackEntry]]);
      const ctrl = createPalletJackController({
        liveScene3d: rig.live,
        THREE,
        window: rig.win,
        sh: () => rig.sessionHandle,
        em: rig.live.entityManager,
        localGuid: rig.localPlayerGuid,
        containers: new Map(),
        deployables: new Map(),
        palletJacks,
        warehouseManager: mgr,
      });
      try {
        ctrl.start(jackEntry);
        rig.win.dispatch("keydown", { code: "KeyW", key: "w" });
        let maxX = startX;
        try {
          for (let i = 0; i < 45; i++) {
            ctrl.tick(1 / 60);
            const st = ctrl.state;
            assertFinitePose(st, `jackTick${i}`);
            assert.ok(st.x > startX, `jack failed to advance east on tick ${i}: ${st.x} <= ${startX}`);
            if (st.x > maxX) maxX = st.x;
            const inside = st.x > firstBox.x0 && st.x < firstBox.x1 && st.y > firstBox.y0 && st.y < firstBox.y1;
            assert.equal(inside, false, `jack entered OBB on tick ${i}: (${st.x}, ${st.y})`);
            assert.ok(
              st.x <= firstBox.x0 + 1e-4,
              `jack tunneled into/past obstacle on tick ${i}: ${st.x} > ${firstBox.x0}`
            );
          }
        } finally {
          rig.win.dispatch("keyup", { code: "KeyW", key: "w" });
        }
        assert.ok(maxX >= startX + 0.15, `jack traveled east toward OBB (${maxX} vs ${startX})`);
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F12-03",
    tier: 1,
    features: ["F12"],
    title: "Pallet Jack engages/drops on lowered Lift Table (z <= 0.02 m)",
    async run({ THREE, mods }) {
      const { createPalletJackController } = mods.palletJackController;
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
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const liftId = [...mgr.liftTables.keys()][0];
      const lt = mgr.liftTables.get(liftId);
      const lPos = lt.pos ?? [lt.x, lt.y, 0];

      const target = mgr.findLoweredLiftTableTarget({ x: lPos[0], y: lPos[1] - 0.25, heading: 0 });
      assert.ok(target, "findLoweredLiftTableTarget detects lowered table");

      const jackEntry = {
        guid: 0x60000002,
        worldPos: [lPos[0], lPos[1] - 0.25, 0],
        heading: 0,
        tillerAngle: 0,
        forkHeightM: 0.200,
        carriedWcid: 4000010,
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
        const ltWcid = lt.carriedWcid ?? lt.cargoWcid ?? mgr.getState().liftTables?.[liftId]?.carriedWcid;
        assert.equal(ltWcid, 4000010, "Lift Table received carried pallet from jack");
        assert.equal(ctrl.state.carriedWcid, 0, "Pallet jack cleared carriedWcid after Lift Table drop");
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F12-04",
    tier: 1,
    features: ["F12"],
    title: "Pallet Jack engages/drops on painted Floor Staging Bays",
    async run({ THREE, mods }) {
      const { createPalletJackController } = mods.palletJackController;
      const { createWarehouseManager } = mods.manager;
      const { NE_FLATLAND_SITE, buildDefaultHubLayout } = mods.specs;
      const layout = buildDefaultHubLayout(NE_FLATLAND_SITE.origin);
      const bay0 = layout.stagingBays[0];
      const bx = bay0.x ?? bay0.pos?.[0];
      const by = bay0.y ?? bay0.pos?.[1];

      const rig = makeTestRig(THREE, null);
      const deployables = new Map();
      const mgr = createWarehouseManager({
        THREE,
        liveScene3d: rig.live,
        containers: new Map(),
        deployables,
        palletJacks: new Map(),
        trailers: new Map(),
        logisticsAudio: null,
        sh: () => rig.sessionHandle,
      });
      mgr.buildHub({ origin: NE_FLATLAND_SITE.origin });
      const targetBefore = mgr.findStagingBayTarget({ x: bx, y: by - 0.25, heading: 0 });
      assert.ok(targetBefore, "staging bay target found");

      const jackEntry = {
        guid: 0x60000003,
        worldPos: [bx, by - 0.25, 0],
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
        deployables,
        palletJacks: new Map([[jackEntry.guid, jackEntry]]),
        warehouseManager: mgr,
      });
      try {
        ctrl.start(jackEntry);
        assert.equal(ctrl.state.carriedWcid, 4000011);
        rig.win.dispatch("keydown", { code: "KeyF", key: "f" });
        rig.win.dispatch("keyup", { code: "KeyF", key: "f" });
        ctrl.tick(1 / 60);
        mgr.tick(1 / 60, [bx, by, 10]);

        const stBays = mgr.getState()?.stagingBays;
        const bayId = targetBefore.id ?? bay0.id;
        const baySt = Array.isArray(stBays)
          ? stBays.find((b) => b.id === bayId)
          : stBays?.[bayId];
        const targetAfter = mgr.findStagingBayTarget({ x: bx, y: by - 0.25, heading: 0 });
        const bayOccupied = Boolean(
          baySt?.occupied ||
          (baySt?.carriedWcid ?? baySt?.cargoWcid) === 4000011 ||
          targetAfter === null ||
          targetAfter?.occupied === true ||
          targetAfter?.carriedWcid === 4000011
        );
        assert.equal(ctrl.state.carriedWcid, 0, "pallet jack cleared carriedWcid after staging bay drop");
        assert.equal(
          bayOccupied || deployables.size > 0,
          true,
          "staging bay occupancy or deployables reflects dropped pallet"
        );
      } finally {
        ctrl.dispose();
        mgr.dispose();
      }
    },
  },
  {
    id: "T1-F12-05",
    tier: 1,
    features: ["F12"],
    title: "createLogisticsAudio updateAgvHum, mastHydraulicWhine, safetyChime",
    run({ mods }) {
      const { createLogisticsAudio } = mods.audio;
      let tSec = 1;
      const bus = makeAudioBus(FullMockCtx);
      const au = createLogisticsAudio({ bus, clock: () => tSec, search: "?vehicles=on&vehicleAudio=on" });
      try {
        assert.equal(typeof au.updateAgvHum, "function");
        assert.equal(typeof au.mastHydraulicWhine, "function");
        assert.equal(typeof au.safetyChime, "function");

        assert.equal(au.updateAgvHum("amr-1", { speed: 1.5, pos: [0, 0, 0] }), true);
        assert.equal(au.mastHydraulicWhine("agf-1", { active: true, speed: 0.4, pos: [1, 0, 1] }), true);
        assert.equal(au.safetyChime({ pos: [0, 0, 0] }), true);
        assert.ok(bus.ctx.made.length > 0 && au.stats.totalNodes > 0);
      } finally {
        au.dispose();
      }
      assert.equal(au.stats.totalNodes, 0);
      for (const n of bus.ctx.made) {
        assert.equal(n.connections.length, 0, `disconnected ${n.kind}`);
        if (n.kind === "osc" || n.kind === "bufsrc") assert.equal(n.stopped, true);
      }
    },
  },
];
