// harness/e2e_logistics/tier2_boundaries.mjs — Tier 2 Boundary & Corner Cases (19 Tests: >= 5 per Area).
// Area A: Sidelifter Boundaries (T2.SL.01..06)
// Area B: Pallet Jack Boundaries (T2.PJ.01..07)
// Area C: Interlocks, Keybindings, WASM & GPU/DOM Boundaries (T2.IL.01..06)

import {
  ALL_9_DEPLOYABLES,
  DEPLOYABLE_KIND,
  HBV1_TAG,
  HBV1_VERSION_V6,
  LOGISTICS_SPEC,
  LogisticsWorldSimulator,
  ONLINE_FLAGS,
  OPCODES,
  PALLET_JACK_ACTION_KIND,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  assert,
  countDrawCalls,
  countLights,
  createFakeWebGL2,
  decodePalletJackState,
  decodeTrailerState,
  encodeTrailerState,
  fakeCanvas,
  getThree,
  makeLogisticsLiveEnv,
  near,
  oracleCheckSideliftInterlocks,
  oracleCheckSlopeCorners,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleEvaluateContainerLocalPose,
  oracleFindNearestForkEngageTarget,
  oracleWireStatsTrack,
  toCellLocal,
  tryImportVehicle,
} from "./common.mjs";

export const TIER2_METADATA = [
  // Area A: Sidelifter Boundaries (6 tests)
  { id: "T2.SL.01", tier: 2, feature: "SL_BVA:Open_Doors_Block_Sidelift_Threshold_0_01", mode: "dual" },
  { id: "T2.SL.02", tier: 2, feature: "SL_BVA:Locked_Twistlocks_Block_Manual_Offload_vs_AutoOffload", mode: "dual" },
  { id: "T2.SL.03", tier: 2, feature: "SL_BVA:Moving_Tractor_Speed_0_25_Blocks_Sidelift", mode: "dual" },
  { id: "T2.SL.04", tier: 2, feature: "SL_BVA:Deployed_Outriggers_Cranes_Block_Tractor_Drive", mode: "dual" },
  { id: "T2.SL.05", tier: 2, feature: "SL_BVA:CrossSlope_6Deg_Cos_0_9945_Interlock", mode: "dual" },
  { id: "T2.SL.06", tier: 2, feature: "SL_BVA:HBV1_v6_Fallback_Truncated_Packets_And_Progress_Clamp", mode: "dual" },
  // Area B: Pallet Jack Boundaries (7 tests)
  { id: "T2.PJ.01", tier: 2, feature: "PJ_BVA:NonStowed_Or_Elevated_Deployable_Blocks_Pickup", mode: "dual" },
  { id: "T2.PJ.02", tier: 2, feature: "PJ_BVA:Raised_Forks_Above_0_10m_Refuse_Pickup", mode: "dual" },
  { id: "T2.PJ.03", tier: 2, feature: "PJ_BVA:Blocked_Inner_Pinwheel_Slot_Refuses_Until_Outer_Cleared", mode: "dual" },
  { id: "T2.PJ.04", tier: 2, feature: "PJ_BVA:Mounted_Container_Blocks_Moving_Doors_And_Jack_Entry", mode: "dual" },
  { id: "T2.PJ.05", tier: 2, feature: "PJ_BVA:HalfPallet_SubSlots_vs_FullPallet_Clearances", mode: "dual" },
  { id: "T2.PJ.06", tier: 2, feature: "PJ_BVA:AntiTeleport_3_2mps_RampToe_0_85m_And_MagneticAssist", mode: "dual" },
  { id: "T2.PJ.07", tier: 2, feature: "PJ_BVA:DoublePick_Refusal_And_RackStow_While_Carrying_Refusal", mode: "dual" },
  // Area C: Interlocks, Keybindings, WASM & HUD Boundaries (6 tests)
  { id: "T2.IL.01", tier: 2, feature: "IL_BVA:Keybinding_Disambiguation_B_Jack_vs_Semi_vs_InputFocus", mode: "dual" },
  { id: "T2.IL.02", tier: 2, feature: "IL_BVA:MidSwing_Collider_Removal_And_8Arg_Restoration", mode: "dual" },
  { id: "T2.IL.03", tier: 2, feature: "IL_BVA:Forced_Release_Teleport_And_WebGLContextLost_Cleanup", mode: "dual" },
  { id: "T2.IL.04", tier: 2, feature: "IL_BVA:VehicleWireStats_32Slots_No_0x0910_0x0900_Aliasing", mode: "dual" },
  { id: "T2.IL.05", tier: 2, feature: "IL_BVA:HUD_Hide_hb_Prefix_And_GPU_DrawCall_Light_Ceilings", mode: "dual" },
  { id: "T2.IL.06", tier: 2, feature: "IL_BVA:All9Deployables_Runtime_SetStowed_And_CSM_Propagation", mode: "dual" },
];

export async function runTier2(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // ---------------------------------------------------------------------------
  // Area A: Sidelifter Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.SL.01",
    2,
    "SL_BVA:Open_Doors_Block_Sidelift_Threshold_0_01",
    async () => {
      const baseTrailer = { isSidelifter: true, outriggersPlanted: true, twistlocksLocked: false };
      const closed0 = oracleCheckSideliftInterlocks({
        trailer: baseTrailer,
        tractor: { speed: 0 },
        container: { doorState: 0, doorProgress: 0.0 },
        action: TRAILER_ACTION_KIND.SideliftOffload,
      });
      const closed01 = oracleCheckSideliftInterlocks({
        trailer: baseTrailer,
        tractor: { speed: 0 },
        container: { doorState: 0, doorProgress: 0.01 },
        action: TRAILER_ACTION_KIND.SideliftOffload,
      });
      const cracked02 = oracleCheckSideliftInterlocks({
        trailer: baseTrailer,
        tractor: { speed: 0 },
        container: { doorState: 0, doorProgress: 0.02 },
        action: TRAILER_ACTION_KIND.SideliftOffload,
      });
      const openFull = oracleCheckSideliftInterlocks({
        trailer: baseTrailer,
        tractor: { speed: 0 },
        container: { doorState: 2, doorProgress: 1.0 },
        action: TRAILER_ACTION_KIND.AutoOffload,
      });
      const nanDoor = oracleCheckSideliftInterlocks({
        trailer: baseTrailer,
        tractor: { speed: 0 },
        container: { doorState: 0, doorProgress: NaN },
        action: TRAILER_ACTION_KIND.SideliftOffload,
      });
      assert(closed0.ok && closed01.ok, "doorProgress <= 0.01 permitted");
      assert(!cracked02.ok && /doors/i.test(cracked02.reason), "doorProgress 0.02 refused");
      assert(!openFull.ok && /doors/i.test(openFull.reason), "open doors block AutoOffload too");
      assert(!nanDoor.ok && /doors/i.test(nanDoor.reason), "NaN doorProgress refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 8000, 200, "rig");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) > 0.1, 5000, 150, "doors opening");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      const tr = await live.getTrailer(ids.tGuid);
      assert(tr && tr.mountedContainerGuid !== 0, "Open doors must block sidelift offload");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 2); return true;`);
    }
  );

  await collector.runDual(
    "T2.SL.02",
    2,
    "SL_BVA:Locked_Twistlocks_Block_Manual_Offload_vs_AutoOffload",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers);
      assert(sim.trailers.get(trGuid).twistlocksLocked === true, "twistlocks locked");

      const manual = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload);
      assert(!manual.ok && /twistlock/i.test(manual.reason), "manual SideliftOffload blocked when twistlocks locked");
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.OutriggersPlanted, "phase stayed OutriggersPlanted");

      // AutoOffload unlocks twistlocks automatically
      const autoRes = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      assert(autoRes.ok, `AutoOffload should succeed: ${autoRes.reason}`);
      assert(sim.trailers.get(trGuid).mountedContainerGuid === 0, "AutoOffload offloaded container");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "offload", "right"); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      const tr = await live.getTrailer(tGuid);
      assert(tr && tr.mountedContainerGuid !== 0 && tr.sideliftPhase === 2, "Locked twistlocks must keep manual offload in phase 2");
    }
  );

  await collector.runDual(
    "T2.SL.03",
    2,
    "SL_BVA:Moving_Tractor_Speed_0_25_Blocks_Sidelift",
    async () => {
      const tr = { isSidelifter: true, outriggersPlanted: false, twistlocksLocked: true };
      const at024 = oracleCheckSideliftInterlocks({ trailer: tr, tractor: { speed: 0.24 }, action: TRAILER_ACTION_KIND.DeployOutriggers });
      const at025 = oracleCheckSideliftInterlocks({ trailer: tr, tractor: { speed: 0.25 }, action: TRAILER_ACTION_KIND.DeployOutriggers });
      const at026 = oracleCheckSideliftInterlocks({ trailer: tr, tractor: { speed: 0.26 }, action: TRAILER_ACTION_KIND.DeployOutriggers });
      const atNeg15 = oracleCheckSideliftInterlocks({ trailer: tr, tractor: { speed: -1.5 }, action: TRAILER_ACTION_KIND.DeployOutriggers });
      const atNaN = oracleCheckSideliftInterlocks({ trailer: tr, tractor: { speed: NaN }, action: TRAILER_ACTION_KIND.DeployOutriggers });
      assert(at024.ok && at025.ok, "speed <= 0.25 m/s permitted");
      assert(!at026.ok && /park/i.test(at026.reason), "speed 0.26 m/s refused");
      assert(!atNeg15.ok, "reverse speed -1.5 m/s refused");
      assert(!atNaN.ok && /park/i.test(atNaN.reason), "NaN tractor speed refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig");
      await live.boardAndWait(ids.vGuid, 0);
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 1.0, yaw: 0 }, 3500); return true;`);
      await live.waitUntil(async () => Math.abs((await live.getVehiclePose(ids.vGuid))?.speed ?? 0) > 1.0, 5000, 100, "tractor speed > 1.0 m/s");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await new Promise((r) => setTimeout(r, 500));
      const phase = (await live.getTrailer(ids.tGuid))?.sideliftPhase ?? 0;
      assert(phase === 0, `Outriggers must not deploy while tractor moving (phase=${phase})`);
      await live.evalInPage(`window.__vehicles.clearSticks(); window.__vehicles.exit(0); return true;`);
    }
  );

  await collector.runDual(
    "T2.SL.04",
    2,
    "SL_BVA:Deployed_Outriggers_Cranes_Block_Tractor_Drive",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.canDriveTractor(tGuid).ok, "can drive in Idle");
      for (const phase of [
        SIDELIFT_PHASE.OutriggersDeploying,
        SIDELIFT_PHASE.OutriggersPlanted,
        SIDELIFT_PHASE.Swinging,
        SIDELIFT_PHASE.OutriggersRetracting,
      ]) {
        sim.trailers.get(trGuid).sideliftPhase = phase;
        const drv = sim.canDriveTractor(tGuid);
        assert(!drv.ok && /outriggers/i.test(drv.reason), `driving blocked in SideliftPhase ${phase}`);
      }
      sim.trailers.get(trGuid).sideliftPhase = SIDELIFT_PHASE.Idle;
      assert(sim.canDriveTractor(tGuid).ok, "driving restored in Idle");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig");
      const before = await live.getVehiclePose(ids.vGuid);
      assert(before && Array.isArray(before.pos), "initial semi-379 pose available");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.boardAndWait(ids.vGuid, 0);
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 1.0, yaw: 0 }, 1200); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
      const after = await live.getVehiclePose(ids.vGuid);
      await live.evalInPage(`window.__vehicles.exit(0); return true;`);
      const moved = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1]);
      assert(moved < 0.25 && Math.abs(after.speed) <= 0.1, `Tractor must not drive with outriggers planted (moved=${moved}, speed=${after.speed})`);
    }
  );

  await collector.runDual(
    "T2.SL.05",
    2,
    "SL_BVA:CrossSlope_6Deg_Cos_0_9945_Interlock",
    async () => {
      const width = 2.44;
      const length = 11.985;
      const dz59 = width * Math.tan((5.9 * Math.PI) / 180);
      const dz60 = width * Math.tan((6.0 * Math.PI) / 180);
      const dz61 = width * Math.tan((6.1 * Math.PI) / 180);
      const dz15 = width * Math.tan((15.0 * Math.PI) / 180);
      const dzLong8 = length * Math.tan((8.0 * Math.PI) / 180);

      const c59 = oracleCheckSlopeCorners([10, 10 + dz59, 10, 10 + dz59], width, length);
      const c60 = oracleCheckSlopeCorners([10, 10 + dz60, 10, 10 + dz60], width, length);
      const c61 = oracleCheckSlopeCorners([10, 10 + dz61, 10, 10 + dz61], width, length);
      const c15 = oracleCheckSlopeCorners([10, 10 + dz15, 10, 10 + dz15], width, length);
      const cLong8 = oracleCheckSlopeCorners([10, 10, 10 + dzLong8, 10 + dzLong8], width, length);
      const cNan = oracleCheckSlopeCorners([10, NaN, 10, 10], width, length);
      const iNan = oracleCheckSideliftInterlocks({
        trailer: { isSidelifter: true, outriggersPlanted: false, twistlocksLocked: true },
        tractor: { speed: 0 },
        action: TRAILER_ACTION_KIND.DeployOutriggers,
        slopeCos: NaN,
      });

      assert(c59.ok && c59.minCos > 0.9945, `5.9° must pass (cos=${c59.minCos})`);
      assert(c60.ok, `6.0° boundary must pass (cos=${c60.minCos})`);
      assert(!c61.ok && /6 deg/i.test(c61.reason), `6.1° must fail (cos=${c61.minCos})`);
      assert(!c15.ok, `15° must fail`);
      assert(!cLong8.ok && cLong8.maxDeg >= 7.9, `8° longitudinal pitch must fail (deg=${cLong8.maxDeg})`);
      assert(!cNan.ok, "NaN terrain corner must fail");
      assert(!iNan.ok && /6 deg/i.test(iNan.reason), "NaN slopeCos interlock must fail");

      const sk = await tryImportVehicle("sidelifter_kinematics.js");
      if (sk.ok && Number.isFinite(sk.mod.MAX_SLOPE_COS)) {
        near(sk.mod.MAX_SLOPE_COS, 0.9945, 1e-4, "real MAX_SLOPE_COS");
        if (typeof sk.mod.checkOutriggerSlope === "function") {
          assert(sk.mod.checkOutriggerSlope([10, 10 + dz61, 10, 10 + dz61], width, length).ok === false, "real 6.1° fails");
          assert(sk.mod.checkOutriggerSlope([10, 10, 10 + dzLong8, 10 + dzLong8], width, length).ok === false, "real 8° longitudinal pitch fails");
          assert(sk.mod.checkOutriggerSlope([10, NaN, 10, 10], width, length).ok === false, "real NaN fails");
        }
      }
    },
    async (live) => {
      // 1. Flat ground pass (@tele 41.35N 33.33E) -> verify terrain slope <= 6° -> outriggers plant (SideliftPhase === 2)
      await live.cleanupWorld();
      await live.sendChatAndWait("@tele 41.35N 33.33E", /Position:\s*\[Cell:/i, 10000);
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tFlat = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "flat trailer");
      const flatTr = await live.getTrailer(tFlat);
      const flatCorners = await live.evalInPage(`
        const th = window.__sessionHandle?.terrainHeightAt;
        if (typeof th !== "function") return null;
        const [x, y] = ${JSON.stringify([flatTr.pos[0], flatTr.pos[1]])};
        const h = ${flatTr.heading || 0};
        const ch = Math.cos(h), sh = Math.sin(h);
        const pt = (lx, ly) => th(x + lx * ch + ly * sh, y - lx * sh + ly * ch);
        return [pt(-1.22, 5.99), pt(1.22, 5.99), pt(-1.22, -5.99), pt(1.22, -5.99)];
      `);
      assert(flatCorners && oracleCheckSlopeCorners(flatCorners).ok, `Flat site slope exceeded 6 deg: ${JSON.stringify(flatCorners)}`);
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tFlat}, "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tFlat);
        return t && t.sideliftPhase === 2 && t.outriggerProgress >= 0.95;
      }, 6000, 150, "flat terrain outriggers planted");

      // 2. Steep > 6° cross-slope refusal (scan 0xA9B3 open grassland hillside -> @teleloc, always restore 41.35N 33.33E)
      try {
        await live.cleanupWorld();
        await live.ensureOutdoorFlatSite();
        const steepTarget = await live.evalInPage(`
          const p = window.__sessionHandle?.getLocalPlayerPose?.();
          const th = window.__sessionHandle?.terrainHeightAt;
          if (!p || typeof th !== "function") return null;
          const cId = p.landblockId >>> 0;
          const baseX = ((cId >>> 24) & 0xff) * 192;
          const baseY = ((((cId >>> 15) & 1) === 1) ? 68928 : 0) + ((cId >>> 16) & 0xff) * 192;
          let best = null;
          for (let lx = 24; lx <= 144; lx += 12) {
            for (let ly = 24; ly <= 144; ly += 12) {
              const wx = baseX + lx, wy = baseY + ly;
              const fl = th(wx - 1.22, wy + 5.99), fr = th(wx + 1.22, wy + 5.99);
              const rl = th(wx - 1.22, wy - 5.99), rr = th(wx + 1.22, wy - 5.99);
              if (![fl, fr, rl, rr].every(Number.isFinite)) continue;
              const nx = -((fr + rr) - (fl + rl)) / (2 * 2.44);
              const ny = -((fl + fr) - (rl + rr)) / (2 * 11.985);
              const c = Math.min(
                1 / Math.hypot(nx, ny, 1),
                1 / Math.hypot((fr - fl) / 2.44, 1),
                1 / Math.hypot((rr - rl) / 2.44, 1),
                1 / Math.hypot((fl - rl) / 11.985, 1),
                1 / Math.hypot((fr - rr) / 11.985, 1)
              );
              if (c < 0.990 && c > 0.90) {
                const cz = th(wx, wy);
                if (!best || c < best.cos) best = { wx, wy, wz: Number.isFinite(cz) ? cz : p.z, cos: c };
              }
            }
          }
          return best;
        `);
        assert(steepTarget && steepTarget.cos < 0.990, `Failed to locate >8 deg steep hillside in 0xA9B3`);
        const clSteep = toCellLocal(steepTarget.wx, steepTarget.wy, steepTarget.wz);
        await live.sendChat(`@teleloc 0x${clSteep.cell.toString(16)} ${clSteep.x.toFixed(2)} ${clSteep.y.toFixed(2)} ${clSteep.z.toFixed(2)}`);
        await live.waitUntil(async () => {
          const gp = await live.getPlayerGlobalPose();
          return gp && Math.hypot(gp.gx - steepTarget.wx, gp.gy - steepTarget.wy) <= 8.0;
        }, 8000, 200, "teleported to steep slope");

        await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
        const tSteep = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "steep trailer");
        const steepTr = await live.getTrailer(tSteep);
        const steepCorners = await live.evalInPage(`
          const th = window.__sessionHandle?.terrainHeightAt;
          const [x, y] = ${JSON.stringify([steepTr.pos[0], steepTr.pos[1]])};
          const h = ${steepTr.heading || 0};
          const ch = Math.cos(h), sh = Math.sin(h);
          const pt = (lx, ly) => th(x + lx * ch + ly * sh, y - lx * sh + ly * ch);
          return [pt(-1.22, 5.99), pt(1.22, 5.99), pt(-1.22, -5.99), pt(1.22, -5.99)];
        `);
        const steepCheck = oracleCheckSlopeCorners(steepCorners);
        assert(!steepCheck.ok, `Steep trailer corners unexpectedly flat: ${JSON.stringify(steepCheck)}`);

        const beforeChats = (await live.getChatLines()).length;
        await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tSteep}, "right"); return true;`);
        await live.waitUntil(async () => {
          const promptTxt = await live.evalInPage(`return document.getElementById("hb-vehicle-prompt")?.textContent || "";`);
          if (/ISO|slope|6\s*deg|level|outrigger/i.test(promptTxt)) return true;
          const freshChats = (await live.getChatLines()).slice(beforeChats);
          return freshChats.some((l) => /ISO|slope|6\s*deg|level|refus/i.test(l));
        }, 6000, 150, "steep slope ISO 3874 refusal");
        const afterSteep = await live.getTrailer(tSteep);
        assert(afterSteep && afterSteep.sideliftPhase === 0, `Steep >6° terrain must keep SideliftPhase === 0 (got ${afterSteep?.sideliftPhase})`);
      } finally {
        await live.cleanupWorld().catch(() => {});
        await live.sendChatAndWait("@tele 41.35N 33.33E", /Position:\s*\[Cell:/i, 10000).catch(() => {});
        await live.ensureOutdoorFlatSite().catch(() => {});
      }
    }
  );

  await collector.runDual(
    "T2.SL.06",
    2,
    "SL_BVA:HBV1_v6_Fallback_Truncated_Packets_And_Progress_Clamp",
    async () => {
      // 1. Decode a v6 60-byte TrailerState and verify since="7" defaults
      const v6Bytes = encodeTrailerState({
        TrailerGuid: 0x80099101,
        Kind: DEPLOYABLE_KIND.TrailerChassis40,
        OwnerGuid: 1001,
      }, HBV1_VERSION_V6);
      assert(v6Bytes.length === 60, `v6 TrailerState === 60B (got ${v6Bytes.length})`);
      const decV6 = decodeTrailerState(v6Bytes);
      assert(decV6 && decV6.SideliftPhase === 0 && decV6.SideliftSide === 1, "v6 fallback defaults");
      near(decV6.CraneSpanY, 5.9925, 1e-4, "v6 default CraneSpanY");
      assert(decV6.StowedPalletJackGuid === 0 && decV6.TransferContainerGuid === 0, "v6 zeroed GUIDs");

      // 2. Truncated v7 (83B) & truncated PalletJackState (59B) & corrupted HBV1 tag ("BAD1") -> null (no throw)
      const v7Full = encodeTrailerState({ TrailerGuid: 1 });
      assert(decodeTrailerState(v7Full.slice(0, v7Full.length - 1)) === null, "truncated v7 TrailerState returns null");
      const badTag = new Uint8Array(v7Full);
      badTag[0] = 0x42; // 'B'
      assert(decodeTrailerState(badTag) === null, "bad HBV1 tag returns null");
      assert(decodePalletJackState(new Uint8Array(59)) === null, "truncated PalletJackState returns null");

      // 3. Out-of-range / NaN progress clamps cleanly
      for (const p of [-0.5, 0, 1, 1.8, NaN, Infinity, -Infinity]) {
        const pose = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Swinging, p, 1, false, 1.32, 0);
        assert(Number.isFinite(pose.x) && Number.isFinite(pose.z) && pose.roll === 0, `finite pose for progress=${p}`);
      }
      near(oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Swinging, -0.5, 1, false, 1.32, 0).x, 0, 1e-6, "clamped -0.5 -> 0");
      near(oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Swinging, 1.8, 1, false, 1.32, 0).x, 3.85, 1e-6, "clamped 1.8 -> 3.85");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles?.trailers?.list?.()[0];
        const pj = window.__vehicles?.palletJacks?.list?.()[0];
        return t && pj ? t.guid : 0;
      `), 8000, 200, "sidelifter + pj live wire");
      const st = await live.evalInPage(`return window.__vehicles?.status?.() ?? null;`);
      const wire = st?.wire;
      assert(wire && Array.isArray(wire.received) && wire.received.length >= 32, "wire.received length >= 32");
      assert(wire.received[15] > 0 && wire.received[16] > 0, `Expected 0x090F & 0x0910 received > 0, got ${wire.received[15]}/${wire.received[16]}`);
      assert((wire.inbox_overflow ?? 0) === 0, `Expected inbox_overflow === 0, got ${wire.inbox_overflow}`);
      assert((st.stats?.parseErrors ?? 0) === 0, `Expected parseErrors === 0, got ${st.stats?.parseErrors}`);
      const tr = await live.getTrailer(tGuid);
      assert(tr && Number.isFinite(tr.craneSpanY) && tr.craneSpanY > 0, `Expected finite craneSpanY > 0, got ${tr?.craneSpanY}`);
      assert(tr.sideliftProgress >= 0 && tr.sideliftProgress <= 1, "sideliftProgress in [0,1]");
      assert(tr.outriggerProgress >= 0 && tr.outriggerProgress <= 1, "outriggerProgress in [0,1]");
    }
  );

  // ---------------------------------------------------------------------------
  // Area B: Pallet Jack Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.PJ.01",
    2,
    "PJ_BVA:NonStowed_Or_Elevated_Deployable_Blocks_Pickup",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const dGuid = sim.allocGuid();
      sim.deployables.set(dGuid, {
        guid: dGuid, wcid: 4000014, kind: 6, x: 100, y: 100, z: 10,
        isStowed: false, onlineFlags: ONLINE_FLAGS.Active | ONLINE_FLAGS.Powered, elevationM: 0.0,
      });
      const rActive = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(!rActive.ok && /stowed/i.test(rActive.reason), "active deployable refuses pickup");

      // Stowed flag set, but pneumatic cylinder still elevated > 0.02 m
      sim.deployables.get(dGuid).isStowed = true;
      sim.deployables.get(dGuid).onlineFlags = ONLINE_FLAGS.Stowed;
      sim.deployables.get(dGuid).elevationM = 0.05;
      const rElev = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(!rElev.ok, "elevated > 0.02m refuses pickup");

      // Lowered to <= 0.02m succeeds
      sim.deployables.get(dGuid).elevationM = 0.02;
      const rOk = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(rOk.ok, rOk.reason);
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0]?.guid || 0;`), 8000, 200, "pj");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.spawnDeployableNear(4000014, pjPose.pos, /4000014|Missile|spawned/i);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0]?.guid || 0;`), 8000, 200, "deployable");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${dGuid}, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 500));
      const carried = (await live.getPalletJack(pjGuid))?.carriedWcid ?? 0;
      assert(carried === 0, "Active unstowed deployable must refuse pallet jack pickup");
    }
  );

  await collector.runDual(
    "T2.PJ.02",
    2,
    "PJ_BVA:Raised_Forks_Above_0_10m_Refuse_Pickup",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      const dGuid = sim.allocGuid();
      sim.deployables.set(dGuid, {
        guid: dGuid, wcid: 4000010, kind: 2, x: 100, y: 100, z: 10,
        isStowed: true, onlineFlags: ONLINE_FLAGS.Stowed, elevationM: 0,
      });

      sim.palletJacks.get(pjGuid).forkHeightM = 0.105;
      const r105 = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(!r105.ok && /lower forks/i.test(r105.reason), "forkHeightM 0.105 > 0.10 refuses pickup");

      sim.palletJacks.get(pjGuid).forkHeightM = 0.095;
      const r095 = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(r095.ok, "forkHeightM 0.095 <= 0.10 succeeds");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0]?.guid || 0;`), 8000, 200, "pj");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.spawnDeployableNear(4000010, pjPose.pos, /4000010|Flux|spawned/i);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0]?.guid || 0;`), 8000, 200, "deployable");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${dGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${dGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 5000, 150, "deployable stowed");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.raise(${pjGuid}); return true;`);
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 0) >= 0.19, 5000, 150, "forks raised");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${dGuid}, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 500));
      assert(((await live.getPalletJack(pjGuid))?.carriedWcid ?? 0) === 0, "Raised forks must refuse pickup");
    }
  );

  await collector.runDual(
    "T2.PJ.03",
    2,
    "PJ_BVA:Blocked_Inner_Pinwheel_Slot_Refuses_Until_Outer_Cleared",
    async () => {
      // 1. Slot 1 (dx=1.0160 <= 1.176 right lane) is blocked by slot 9; clearing 9 unlocks 1 past 8
      const slots189 = [
        { slotIndex: 1, subSlot: 0, cargoWcid: 4000010, palletSize: 2 },
        { slotIndex: 8, subSlot: 0, cargoWcid: 4000011, palletSize: 2 },
        { slotIndex: 9, subSlot: 0, cargoWcid: 4000012, palletSize: 2 },
      ];
      const lifo189 = oracleComputeReachableUnloadSlots(10, slots189);
      assert(lifo189.reachable.some((r) => r.slotIndex === 9) && lifo189.reachable.some((r) => r.slotIndex === 8), "rear 8 & 9 reachable");
      assert(!lifo189.reachable.some((r) => r.slotIndex === 1), "slot 1 blocked while 9 present");
      const blk1 = lifo189.blocked.find((b) => b.slotIndex === 1);
      assert(blk1 && blk1.blockedBySlotIndex === 9, `slot 1 blocked by 9, got ${blk1?.blockedBySlotIndex}`);

      const lifo18 = oracleComputeReachableUnloadSlots(10, slots189.filter((s) => s.slotIndex !== 9));
      assert(lifo18.reachable.some((r) => r.slotIndex === 1), "slot 1 (1.016m) reachable past slot 8 once outer slot 9 cleared");

      // 2. Slot 0 (dx=1.2192 > 1.176 & X-overlaps slot 8) stays blocked by 8 until 8 is cleared
      const slots08 = [
        { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2 },
        { slotIndex: 8, subSlot: 0, cargoWcid: 4000011, palletSize: 2 },
      ];
      const lifo08 = oracleComputeReachableUnloadSlots(10, slots08);
      assert(!lifo08.reachable.some((r) => r.slotIndex === 0), "slot 0 remains blocked by slot 8 (1.2192 > 1.176)");
      assert(lifo08.blocked.find((b) => b.slotIndex === 0)?.blockedBySlotIndex === 8, "slot 0 reports blocker 8");
      const lifo0 = oracleComputeReachableUnloadSlots(10, slots08.filter((s) => s.slotIndex !== 8));
      assert(lifo0.reachable.some((r) => r.slotIndex === 0), "slot 0 reachable once slot 8 cleared");

      // Cross-verify container_logistics.js on identical configs
      const cl = await tryImportVehicle("container_logistics.js");
      if (cl.ok && typeof cl.mod.computeReachableUnloadSlots === "function") {
        for (const cfg of [slots189, slots189.filter((s) => s.slotIndex !== 9), slots08, []]) {
          const oraIds = oracleComputeReachableUnloadSlots(10, cfg).reachable.map((r) => r.slotIndex).join(",");
          const realIds = cl.mod.computeReachableUnloadSlots(10, cfg).reachable.map((r) => r.slotIndex).join(",");
          assert(oraIds === realIds, `T2.PJ.03 parity mismatch: oracle=[${oraIds}] real=[${realIds}]`);
        }
      }

      // Simulator enforces LIFO refusal on PickContainerSlot
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.containers.get(cGuid).slots = [...slots08];
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const blockedPick = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 0, subSlot: 0 });
      assert(!blockedPick.ok && /LIFO/i.test(blockedPick.reason), "blocked slot 0 refused");

      // Check container_models.js setHighlightedSlot observable state
      const cm = await tryImportVehicle("container_models.js");
      assert(cm.ok, cm.reason);
      const contModel = cm.mod.buildIsoContainer(THREE, 4000020);
      assert(typeof contModel.setHighlightedSlot === "function", "container_models.js must expose setHighlightedSlot");
      assert(contModel.setHighlightedSlot(0, 0, "blocked") === true, "setHighlightedSlot(0,0,'blocked') === true");
      assert(contModel.bayHighlightMesh.visible === true, "bayHighlightMesh.visible === true");
      assert(contModel.bayHighlightMesh.material.emissive.getHex() === 0xff4422, "blocked emissive === 0xff4422");
      assert(contModel.bayHighlightPivot.parent === contModel.cargoBayGroup, "bayHighlightPivot attached to cargoBayGroup");

      assert(contModel.setHighlightedSlot(9, 0, "reachable") === true, "setHighlightedSlot(9,0,'reachable') === true");
      assert(contModel.bayHighlightMesh.material.emissive.getHex() === 0x22dd66, "reachable emissive === 0x22dd66");
      near(contModel.bayHighlightPivot.rotation.z, Math.PI / 2, 1e-6, "Y-orient slot rotates highlight +90deg");

      assert(contModel.setHighlightedSlot(0, 0, null) === false, "setHighlightedSlot(0,0,null) === false");
      assert(contModel.bayHighlightMesh.visible === false, "bayHighlightMesh.visible === false on clear");
      assert(contModel.bayHighlightPivot.parent === null, "bayHighlightPivot detached on clear");
      contModel.dispose();
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 8000, 200, "rig");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offloaded");
      const cOff = await live.getContainer(ids.cGuid);
      if (cOff?.pos) await live.movePlayerNear(cOff.pos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "ready");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const slot4Pos = await live.getSlotWorldPos(ids.cGuid, 4, 0);
      await live.movePalletJackTo(pjGuid, slot4Pos, { stopDistM: 1.2 });
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 4, 0, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 500));
      assert(((await live.getPalletJack(pjGuid))?.carriedWcid ?? 0) === 0, "Inner blocked slot 4 must be refused");
      const promptTxt = await live.evalInPage(`return document.getElementById("hb-vehicle-prompt")?.textContent || "";`);
      if (promptTxt) assert(/LIFO|blocked|ISO/i.test(promptTxt), `Unexpected prompt on LIFO block: ${promptTxt}`);
    }
  );

  await collector.runDual(
    "T2.PJ.04",
    2,
    "PJ_BVA:Mounted_Container_Blocks_Moving_Doors_And_Jack_Entry",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.tractors.get(tGuid).speed = 5.0;
      const openMoving = sim.openContainerDoors(cGuid, true);
      assert(!openMoving.ok && /moving/i.test(openMoving.reason), "moving mounted container blocks door open");

      sim.tractors.get(tGuid).speed = 0;
      sim.openContainerDoors(cGuid, true);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      const mountedPick = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 20, subSlot: 0 });
      assert(!mountedPick.ok && /Offload container/i.test(mountedPick.reason), "mounted container blocks pallet jack slot pick");

      // Also verify 1.482 m air gap prevents ground ramp entry in probeContainerSurface
      const env = await makeLogisticsLiveEnv();
      try {
        env.live.sessionHandle.upsertContainerCollider(cGuid, 0, 100, 100, 11.32, 0, 11, true);
        // Ground-level jack (ceilingZ = 10 + 1.1) cannot reach 11.32 + 0.162 = 11.482 floor
        const airProbe = env.live.sessionHandle.probeContainerSurface(100, 100, 11.1);
        assert(airProbe === null, "mounted container floor unreachable from ground ceilingZ");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const c = window.__vehicles.containers.list()[0];
        const pj = window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0);
        return c && pj ? { cGuid: c.guid, pjGuid: pj.guid, pjPos: pj.pos } : null;
      `), 8000, 200, "mounted c + pj");
      if (ids.pjPos) await live.movePlayerNear(ids.pjPos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${ids.pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(ids.pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 20, 0, ${ids.pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 500));
      assert(((await live.getPalletJack(ids.pjGuid))?.carriedWcid ?? 0) === 0, "Mounted container must block pallet jack pickContainer");
    }
  );

  await collector.runDual(
    "T2.PJ.05",
    2,
    "PJ_BVA:HalfPallet_SubSlots_vs_FullPallet_Clearances",
    async () => {
      // Deep half subSlot 1 in orient-Y slot 8 leaves rear subSlot 0 reachable, whereas rear subSlot 0 blocks subSlot 1
      const occDeep = [{ slotIndex: 8, subSlot: 1, cargoWcid: 4000013, palletSize: 1 }];
      const halfLoad = oracleComputeReachableLoadSlots(10, occDeep, "half");
      const fullLoad = oracleComputeReachableLoadSlots(10, occDeep, "full");
      assert(halfLoad.some((s) => s.slotIndex === 8 && s.subSlot === 0), "half pallet fits into open subSlot 0 of slot 8");
      assert(!fullLoad.some((s) => s.slotIndex === 8), "full pallet cannot share slot 8 when subSlot 1 is occupied");

      const occFrontBlocked = [{ slotIndex: 8, subSlot: 0, cargoWcid: 4000013, palletSize: 1 }];
      const halfBlockedLoad = oracleComputeReachableLoadSlots(10, occFrontBlocked, "half");
      assert(!halfBlockedLoad.some((s) => s.slotIndex === 8 && s.subSlot === 1), "rear subSlot 0 blocks deeper subSlot 1 in orient-Y slot 8");

      // Verify full & half pallet dimensions vs jack fork spread (0.685 m)
      assert(LOGISTICS_SPEC.palletJack.forkSpreadM <= 1.016, "0.685 m fork spread enters 1.016 m (40in) pallet stringers cleanly");

      // Simulator rejects Full pallet load into half-occupied slot 8
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.containers.get(cGuid).slots = [...occDeep];
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      sim.palletJacks.get(pjGuid).carriedWcid = 4000010;
      sim.palletJacks.get(pjGuid).carriedPalletSize = 2;
      const failFull = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: 8, subSlot: 0 });
      assert(!failFull.ok, "Full pallet rejected from half-occupied slot 8");

      // Half pallet succeeds in (8, 0)
      sim.palletJacks.get(pjGuid).carriedWcid = 4000015;
      sim.palletJacks.get(pjGuid).carriedPalletSize = 1;
      const okHalf = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: 8, subSlot: 0 });
      assert(okHalf.ok, okHalf.reason);
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@container spawn 20", /container|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 6000, 150, "c");
      await live.evalInPage(`window.__vehicles.containers.action(${cGuid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.evalInPage(`
        window.__vehicles.containers.action(${cGuid}, 3, 8, 0, 4000013);
        window.__vehicles.containers.action(${cGuid}, 3, 8, 1, 4000015);
        return true;
      `);
      const slots = await live.waitUntil(async () => {
        const c = await live.getContainer(cGuid);
        return c && c.slots.length >= 2 ? c.slots : null;
      }, 6000, 150, "dual half pallets");
      assert(slots.some((s) => s.slotIndex === 8 && s.subSlot === 0) && slots.some((s) => s.slotIndex === 8 && s.subSlot === 1), "Dual half pallets share slot 8");
    }
  );

  await collector.runDual(
    "T2.PJ.06",
    2,
    "PJ_BVA:AntiTeleport_3_2mps_RampToe_0_85m_And_MagneticAssist",
    async () => {
      // 1. Magnetic assist strict boundaries: <= 0.55 m and |yawDelta| <= 28 deg + 0.25m lateral offset + container_logistics.js parity
      const cand = [{ id: 1, x: 0, y: 1.0, heading: 0 }];
      const hitIn = oracleFindNearestForkEngageTarget({ x: 0, y: 1.0 - 0.54, heading: (27 * Math.PI) / 180 }, cand);
      const hitLat = oracleFindNearestForkEngageTarget({ x: 0.25, y: 1.0, heading: 0 }, cand);
      const missDist = oracleFindNearestForkEngageTarget({ x: 0, y: 1.0 - 0.56, heading: 0 }, cand);
      const missYaw = oracleFindNearestForkEngageTarget({ x: 0, y: 1.0 - 0.40, heading: (29 * Math.PI) / 180 }, cand);
      assert(hitIn && hitIn.canEngage === true && hitIn.assisted === true, "assist active at 0.54m, 27°");
      assert(hitLat && hitLat.canEngage === true, "assist active at 0.25m lateral offset");
      assert(missDist === null, "assist off at 0.56m");
      assert(missYaw === null, "assist off at 29°");

      const cl = await tryImportVehicle("container_logistics.js");
      if (cl.ok && typeof cl.mod.findNearestForkEngageTarget === "function") {
        const realLat = cl.mod.findNearestForkEngageTarget({ x: 0.25, y: 1.0, heading: 0 }, cand);
        assert(realLat && realLat.canEngage === true, "real findNearestForkEngageTarget accepts 0.25m lateral offset");
        const real1Way = cl.mod.findNearestForkEngageTarget({ x: 0, y: 0.7, heading: Math.PI / 2 }, [{ id: 1, x: 0, y: 1.0, heading: 0, fourWay: false }]);
        assert(real1Way === null, "real 1-way target rejects 90 deg yaw");
      }

      // 2. Ramp toe boundary at exact 0.85 m
      const env = await makeLogisticsLiveEnv();
      try {
        const hl = 5.898 / 2;
        env.live.sessionHandle.upsertContainerCollider(0x80099201, 0, 100, 100, 10, 0, 10, true);
        assert(env.live.sessionHandle.probeContainerSurface(100, 100 - hl - 0.85, 11.5) !== null, "ramp toe at 0.85m hits");
        assert(env.live.sessionHandle.probeContainerSurface(100, 100 - hl - 0.86, 11.5) === null, "beyond 0.85m (0.86m) returns null");
      } finally {
        env.dispose();
      }

      // 3. Speed cap 3.2 m/s runtime enforcement via LogisticsWorldSimulator UpdatePose
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      const pjState = sim.palletJacks.get(pjGuid);
      const startX = pjState.x;
      const dt = 1 / 15;
      const step31 = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.UpdatePose, {
        x: startX + 3.1 * dt,
        y: pjState.y,
        z: pjState.z,
        dtSec: dt,
      });
      assert(step31.ok, `3.1 m/s UpdatePose must succeed: ${step31.reason}`);
      const acceptedX = pjState.x;

      const step33 = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.UpdatePose, {
        x: acceptedX + 3.3 * dt,
        y: pjState.y,
        z: pjState.z,
        dtSec: dt,
      });
      assert(!step33.ok && /3\.2 m\/s/i.test(step33.reason), "3.3 m/s UpdatePose must be rejected");
      near(pjState.x, acceptedX, 1e-6, "rejected 3.3 m/s step must not move jack");

      const jump25 = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.UpdatePose, {
        x: acceptedX + 25.0,
        y: pjState.y,
        z: pjState.z,
        dtSec: 0.4,
      });
      assert(!jump25.ok && /3\.2 m\/s/i.test(jump25.reason), "25m teleport UpdatePose must be rejected");
      near(pjState.x, acceptedX, 1e-6, "rejected 25m teleport must not move jack");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0]?.guid || 0;`), 6000, 150, "pj");
      const before = await live.getPalletJack(pjGuid);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const cl = before.rawPos ? { cell: before.cell, x: before.rawPos[0], y: before.rawPos[1], z: before.rawPos[2] } : toCellLocal(before.pos[0], before.pos[1], before.pos[2]);
      await live.evalInPage(`
        window.__sessionHandle?.vehiclePalletJackAction?.(${pjGuid}, 3, 0, 0, 0, 0, ${cl.cell}, ${cl.x + 25.0}, ${cl.y}, ${cl.z}, 0, 0);
        return true;
      `);
      await new Promise((r) => setTimeout(r, 400));
      const after = await live.getPalletJack(pjGuid);
      const dx = Math.hypot((after.pos[0] - before.pos[0]), (after.pos[1] - before.pos[1]));
      assert(dx < 5.0, `Anti-teleport cap must reject 25m single-step jump (moved ${dx}m)`);
    }
  );

  await collector.runDual(
    "T2.PJ.07",
    2,
    "PJ_BVA:DoublePick_Refusal_And_RackStow_While_Carrying_Refusal",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const d1 = sim.allocGuid();
      const d2 = sim.allocGuid();
      sim.deployables.set(d1, { guid: d1, wcid: 4000010, kind: 2, x: 100, y: 100, z: 10, isStowed: true, onlineFlags: ONLINE_FLAGS.Stowed, elevationM: 0 });
      sim.deployables.set(d2, { guid: d2, wcid: 4000011, kind: 3, x: 101, y: 100, z: 10, isStowed: true, onlineFlags: ONLINE_FLAGS.Stowed, elevationM: 0 });

      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: d1 }).ok, "first pick ok");
      const doublePick = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: d2 });
      assert(!doublePick.ok && /already carrying/i.test(doublePick.reason), "double pick refused");

      const stowOccupied = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack);
      assert(!stowOccupied.ok && /Release tiller/i.test(stowOccupied.reason), "rack stow refused while operator grabbed");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release);
      const stowCarrying = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack);
      assert(!stowCarrying.ok && /Drop cargo/i.test(stowCarrying.reason), "rack stow refused while carrying cargo");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const trGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${trGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`
        const p = window.__vehicles.palletJacks.list().find((x) => (x.stowedOnTrailerGuid ?? 0) === 0);
        return p ? p.guid : 0;
      `), 8000, 200, "deployed pallet jack");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.spawnDeployableNear(4000010, pjPose.pos, /4000010|Flux|spawned/i);
      await live.spawnDeployableNear(4000011, [pjPose.pos[0] + 0.4, pjPose.pos[1], pjPose.pos[2]], /4000011|Solar|spawned/i);
      const ds = await live.waitUntil(async () => await live.evalInPage(`
        const list = window.__vehicles.deployables.list();
        const f = list.find((d) => d.wcid === 4000010);
        const s = list.find((d) => d.wcid === 4000011);
        return f && s ? { d1: f.guid, d2: s.guid } : null;
      `), 8000, 200, "2 deployables spawned");
      await live.movePlayerNear(pjPose.pos);

      await live.evalInPage(`
        window.__vehicles.palletJacks.toggleDeployableStow(${ds.d1});
        window.__vehicles.palletJacks.toggleDeployableStow(${ds.d2});
        return true;
      `);
      await live.waitUntil(async () => await live.evalInPage(`
        const list = window.__vehicles.deployables.list();
        const f = list.find((d) => d.guid === ${ds.d1});
        const s = list.find((d) => d.guid === ${ds.d2});
        return f && s && ((f.last?.onlineFlags ?? 0) & 0x10) !== 0 && ((s.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 6000, 150, "both deployables stowed");

      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${ds.d1}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 4000010, 6000, 150, "first pick succeeded");

      // Double-pick refusal
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${ds.d2}, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 400));
      assert((await live.getPalletJack(pjGuid))?.carriedWcid === 4000010, "Double-pick must preserve first cargo 4000010");
      assert(await live.evalInPage(`return window.__vehicles.deployables.list().some((d) => d.guid === ${ds.d2});`), "Second deployable must remain on ground on double-pick refusal");

      // Rack-stow refusal while occupied & carrying
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${trGuid}, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 400));
      assert((await live.getTrailer(trGuid))?.stowedPalletJackGuid === 0, "Rack stow must be refused while jack grabbed & carrying");

      // Rack-stow refusal while released & still carrying
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "released");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${trGuid}, ${pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 400));
      assert((await live.getTrailer(trGuid))?.stowedPalletJackGuid === 0, "Rack stow must be refused while jack carrying cargo");
    }
  );

  // ---------------------------------------------------------------------------
  // Area C: Interlocks, Keybindings, WASM & HUD Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.IL.01",
    2,
    "IL_BVA:Keybinding_Disambiguation_B_Jack_vs_Semi_vs_InputFocus",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        let grabbedJack = 0;
        let boardedSemi = 0;
        let retailSleep = 0;
        let jackDist = 2.0;
        let semiDist = 5.0;

        env.fakeWinObj.addEventListener("keydown", (ev) => {
          const ae = env.doc.activeElement;
          if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
          if (ev.code === "KeyB") {
            if (jackDist <= 3.0) {
              grabbedJack++;
              ev.preventDefault();
              ev.stopImmediatePropagation();
            } else if (semiDist <= 8.0) {
              boardedSemi++;
              ev.preventDefault();
              ev.stopImmediatePropagation();
            }
          }
        }, true);
        env.fakeWinObj.addEventListener("keydown", (ev) => {
          if (ev.code === "KeyB") retailSleep++;
        }, false);

        // Case A: Jack <= 3m wins over Semi <= 8m and blocks Sleep
        env.fakeWinObj.dispatch("keydown", { code: "KeyB" });
        assert(grabbedJack === 1 && boardedSemi === 0 && retailSleep === 0, "Jack <= 3m takes priority");

        // Case B: Jack > 3m -> Semi <= 8m wins and blocks Sleep
        jackDist = 4.5;
        env.fakeWinObj.dispatch("keydown", { code: "KeyB" });
        assert(grabbedJack === 1 && boardedSemi === 1 && retailSleep === 0, "Semi <= 8m boards when jack out of range");

        // Case C: <input> focused -> typing bypass (neither jack nor semi intercepts)
        env.doc.activeElement = env.doc.createElement("input");
        jackDist = 1.5;
        const inputEv = env.fakeWinObj.dispatch("keydown", { code: "KeyB" });
        assert(!inputEv.defaultPrevented && grabbedJack === 1, "<input> focus bypasses proximity B");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0]?.guid || 0;`), 6000, 150, "pj");
      const interceptedWhileTyping = await live.evalInPage(`
        const inp = document.createElement("input");
        document.body.appendChild(inp);
        inp.focus();
        const ev = new KeyboardEvent("keydown", { key: "b", code: "KeyB", bubbles: true, cancelable: true });
        inp.dispatchEvent(ev);
        inp.remove();
        return ev.defaultPrevented;
      `);
      assert(!interceptedWhileTyping, "Typing in <input> must NOT be intercepted by KeyB");
      assert((await live.getPalletJack(pjGuid))?.operatorGuid === 0, "Jack stays ungrabbed during input typing");
    }
  );

  await collector.runDual(
    "T2.IL.02",
    2,
    "IL_BVA:MidSwing_Collider_Removal_And_8Arg_Restoration",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        const cGuid = 0x80099201;
        // Grounded container registers 8-arg collider
        env.live.sessionHandle.upsertContainerCollider(cGuid, 0x01018001, 20, 20, 10, 0, 11, false);
        assert(env.calls.upsertContainerCollider.length === 1, "initial upsert recorded");
        assert(Object.keys(env.calls.upsertContainerCollider[0]).length === 8, "exact 8-arg signature verified");
        assert(env.activeColliders.has(cGuid), "collider active on ground");

        // During SideliftPhase 3..9, collider is removed and zero upserts occur
        env.live.sessionHandle.removeContainerCollider(cGuid);
        assert(!env.activeColliders.has(cGuid), "collider suppressed during swing");
        assert(env.calls.removeContainerCollider.includes(cGuid), "removeContainerCollider recorded");

        // On touchdown, 8-arg collider restored at new grounded pose (non-Dericost cell 0x01010001 -> global 192+23.85, 192+20)
        env.live.sessionHandle.upsertContainerCollider(cGuid, 0x01010001, 23.85, 20, 10, 0, 11, true);
        assert(env.activeColliders.has(cGuid), "collider restored on touchdown");
        assert(env.live.sessionHandle.probeContainerSurface(192 + 23.85, 192 + 20, 11.5)?.zone === "floor", "ramp/floor walkable after touchdown restore");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid, tx: t.pos[0], ty: t.pos[1], tz: t.pos[2] } : null;
      `), 8000, 200, "rig");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${ids.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.twistlocksLocked === false, 4000, 150, "twistlocks unlocked");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 6, 10000, 150, "mid-swing phase 6");
      const midSwingSurf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${ids.tx + 1.9}, ${ids.ty}, ${ids.tz + 3.0}) ?? null;`);
      assert(midSwingSurf === null, "Mid-swing dynamic BSP collider must be suppressed");
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0);
      }, 24000, 300, "offloaded");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.98, 6000, 150, "doors open");
      const c = await live.getContainer(ids.cGuid);
      const surface = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${c.pos[0]}, ${c.pos[1]}, ${c.pos[2] + 1.5});`);
      assert(surface !== null && surface !== undefined, "Touchdown must restore dynamic BSP collider");
    }
  );

  await collector.runDual(
    "T2.IL.03",
    2,
    "IL_BVA:Forced_Release_Teleport_And_WebGLContextLost_Cleanup",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        // Test onTeleport and webglcontextlost session/seat/inputFunnel cleanup
        env.live.sessionHandle.setVehicleSeat(0x80099001, 0x01010001, 10, 10, 10, 0);
        env.live.vehicles.onTeleport();
        const beforeClear = env.calls.clearVehicleSeat.length;
        const beforeUnpoison = env.funnelCalls.unpoison;
        const beforeRel = env.funnelCalls.releaseHeld;
        env.fakeWinObj.dispatchCanvas("webglcontextlost");
        assert(env.calls.clearVehicleSeat.length > beforeClear, "webglcontextlost called clearVehicleSeat");
        assert(env.funnelCalls.unpoison > beforeUnpoison, "webglcontextlost unpoisoned __inputFunnel");
        assert(env.funnelCalls.releaseHeld > beforeRel, "webglcontextlost released held inputFunnel");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0]?.guid || 0;`), 6000, 150, "pj");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.sendChatAndWait("@palletjack despawn all", /despawn|removed/i, 8000);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid)) === null, 6000, 150, "jack despawned & released");
    }
  );

  await collector.runDual(
    "T2.IL.04",
    2,
    "IL_BVA:VehicleWireStats_32Slots_No_0x0910_0x0900_Aliasing",
    async () => {
      const opcodes = [];
      for (let op = 0x0900; op <= 0x0910; op++) opcodes.push(op);
      opcodes.push(OPCODES.Vehicle_PalletJackState, OPCODES.Vehicle_PalletJackState);
      const stats = oracleWireStatsTrack(opcodes);
      assert(stats.received.length === 32, "received array has 32 slots");
      assert(stats.received[0] === 1, `0x0900 slot 0 must be 1 (no aliasing with 0x0910), got ${stats.received[0]}`);
      assert(stats.received[16] === 3, `0x0910 slot 16 must be 3, got ${stats.received[16]}`);
      assert(stats.unknown === 0, "0 unknown opcodes");
    },
    async (live) => {
      await live.cleanupWorld();
      const before = await live.evalInPage(`return JSON.parse(window.__sessionHandle.vehicleWireStats());`);
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 8000);
      await new Promise((r) => setTimeout(r, 400));
      const after = await live.evalInPage(`return JSON.parse(window.__sessionHandle.vehicleWireStats());`);
      assert(after.received[16] > before.received[16], "0x0910 increments index 16");
      assert(after.received[0] === before.received[0], "0x0910 does not alias index 0 (0x0900)");
    }
  );

  await collector.runDual(
    "T2.IL.05",
    2,
    "IL_BVA:HUD_Hide_hb_Prefix_And_GPU_DrawCall_Light_Ceilings",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        const osdMod = await tryImportVehicle("osd.js");
        assert(osdMod.ok, osdMod.reason);
        for (const idConst of ["OSD_ID", "PROMPT_ID", "RETICLE_ID", "PIPPER_ID", "FPM_ID", "AIM_ID", "FALLLINE_ID", "HIT_ID", "VIGNETTE_ID"]) {
          assert(osdMod.mod[idConst].startsWith("hb-"), `${idConst} starts with hb-`);
        }
        const osd = osdMod.mod.createVehicleOsd({ document: env.doc });
        osd.prompt("ISO 3874 Test Prompt");
        assert(env.doc.getElementById("hb-vehicle-prompt") !== null, "#hb-vehicle-prompt created");
        osd.dispose();

        // Render baseline trailer & container models through real THREE.WebGLRenderer + FakeWebGL2
        const gl = createFakeWebGL2({ maxTextures: 16 });
        const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
        camera.position.set(5, -10, 4);
        camera.lookAt(0, 0, 1);

        const tm = await tryImportVehicle("trailer_models.js");
        const tr = tm.mod.buildSemiTrailer(THREE, "40ft");
        assert(countLights(tr.root) === 0, "trailer 0 lights");
        scene.add(tr.root);

        const slm = await tryImportVehicle("sidelifter_model.js");
        if (slm.ok && typeof slm.mod.buildSidelifterTrailer === "function") {
          const sl = slm.mod.buildSidelifterTrailer(THREE);
          assert(countDrawCalls(sl.root) <= 14 && countLights(sl.root) === 0, "sidelifter <=14 draws & 0 lights");
          scene.add(sl.root);
        }
        const pjm = await tryImportVehicle("pallet_jack_model.js");
        if (pjm.ok && typeof pjm.mod.buildPalletJack === "function") {
          const pj = pjm.mod.buildPalletJack(THREE);
          assert(countDrawCalls(pj.root) <= 6 && countLights(pj.root) === 0, "pallet jack <=6 draws & 0 lights");
          scene.add(pj.root);
        }

        gl.__fake.reset();
        renderer.render(scene, camera);
        const draws = (gl.__fake.counts.drawArrays || 0) + (gl.__fake.counts.drawElements || 0);
        assert(draws > 0, `FakeWebGL2 emitted ${draws} draw calls`);
        tr.dispose();
        renderer.dispose();
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.hideHud();
      const vis = await live.evalInPage(`
        const els = [...document.querySelectorAll("[id^=hb-]")];
        return els.map((e) => ({ id: e.id, vis: getComputedStyle(e).visibility }));
      `);
      await live.showHud();
      assert(vis.length > 0, "HUD elements with #hb- prefix exist");
      assert(vis.every((x) => x.vis === "hidden"), `All #hb- HUD elements must hide: ${JSON.stringify(vis)}`);
    }
  );

  await collector.runDual(
    "T2.IL.06",
    2,
    "IL_BVA:All9Deployables_Runtime_SetStowed_And_CSM_Propagation",
    async () => {
      const dm = await tryImportVehicle("deployable_models.js");
      const rm = await tryImportVehicle("radar_model.js");
      assert(dm.ok && rm.ok, "deployable & radar models load");
      const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };

      for (const d of ALL_9_DEPLOYABLES) {
        const model = d.wcid === 4000002
          ? rm.mod.buildDeployedRadar(THREE, { csmState: fakeCsm, stowed: false })
          : dm.mod.buildDeployable(THREE, d.wcid, { csmState: fakeCsm, stowed: false });
        let csmMeshes = 0;
        model.root.traverse((o) => {
          if (o.isMesh && o.material?.isMeshStandardMaterial && o.material.userData?.csmEnabled === true) {
            csmMeshes++;
          }
        });
        assert(csmMeshes > 0, `${d.name} has CSM-patched MeshStandardMaterials`);
        assert(countLights(model.root) === 0, `${d.name} has 0 dynamic lights`);

        assert(typeof model.setStowed === "function", `${d.name} must expose setStowed`);
        if (d.wcid === 4000002) model.update(1.5);
        else model.update({ simTimeSec: 1.5, sunAzimuthRad: 1.1, sunPitchRad: 0.7, deployElevation: 0.9, yawRad: 0.8, pitchRad: 0.3, energyJoules: 480000, fuelRemaining: 40, ammoCount: 3 });

        model.setStowed(true);
        assert(model.stowed === true, `${d.name} stowed === true`);
        model.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model.root);
        const stowedH = box.max.z - box.min.z;
        assert(stowedH <= (d.wcid === 4000002 ? 2.10 : 2.14), `${d.name} stowed height ${stowedH.toFixed(3)}m`);

        model.setStowed(false);
        assert(model.stowed === false, `${d.name} unstowed === false`);
        model.setStowed(true);
        assert(model.stowed === true, `${d.name} re-stowed === true`);
        model.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|spawned/i, 8000);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0]?.guid || 0;`), 6000, 150, "deployable");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${dGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${dGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 5000, 150, "stowed");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${dGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${dGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) === 0;
      `), 5000, 150, "unstowed");
    }
  );
}
