// harness/e2e_logistics/tier1_features.mjs — Tier 1 Feature Coverage (23 Tests: >= 5 per Area).
// Area A: Sidelifter (T1.SL.01..08)
// Area B: Walk-Behind Pallet Jack (T1.PJ.01..08)
// Area C: Interlocks, HBV1 v7 Wire, OSD, Keybindings & window.__vehicles (T1.IL.01..07)

import {
  ALL_9_DEPLOYABLES,
  DEPLOYABLE_KIND,
  FORK_STATE,
  HBV1_VERSION_V7,
  LOGISTICS_SPEC,
  LogisticsWorldSimulator,
  ONLINE_FLAGS,
  OPCODES,
  PALLET_JACK_ACTION_KIND,
  PALLET_JACK_FLAGS,
  PINWHEEL_SLOTS_20,
  PINWHEEL_SLOTS_40,
  SIDELIFT_FLAGS,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  VEHICLE_EVENT_KIND,
  assert,
  countDrawCalls,
  countLights,
  createFakeWebGL2,
  decodeContainerAction,
  decodeDeployableState,
  decodePalletJackAction,
  decodePalletJackState,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleEvent,
  encodeContainerAction,
  encodeDeployableState,
  encodePalletJackAction,
  encodePalletJackState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleEvent,
  fakeCanvas,
  getThree,
  installFakeAudio,
  makeLogisticsLiveEnv,
  near,
  oracleComputeCraneSpanY,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleEvaluateContainerLocalPose,
  oracleFindNearestForkEngageTarget,
  oracleStepPalletJack,
  oracleWireStatsTrack,
  readProtocolFixtures,
  readXmlProtocol,
  tryImportVehicle,
  tryLoadWasmPkg,
} from "./common.mjs";

export const TIER1_METADATA = [
  // Area A: Sidelifter (8 tests)
  { id: "T1.SL.01", tier: 1, feature: "SL:Spawn_Preset_Sidelifter40_KindResolution", mode: "dual" },
  { id: "T1.SL.02", tier: 1, feature: "SL:Presets_Sidelifter20_And_Sidelifter40HC_CraneSpan", mode: "dual" },
  { id: "T1.SL.03", tier: 1, feature: "SL:Outriggers_Deploy_And_Retract_Action6_7", mode: "dual" },
  { id: "T1.SL.04", tier: 1, feature: "SL:ISO1161_Twistlock_Toggle_Action3", mode: "dual" },
  { id: "T1.SL.05", tier: 1, feature: "SL:Manual_Sidelift_Offload_Action8", mode: "dual" },
  { id: "T1.SL.06", tier: 1, feature: "SL:Manual_Sidelift_Reload_Action9", mode: "dual" },
  { id: "T1.SL.07", tier: 1, feature: "SL:AutoCycle_Offload_And_Load_Action13_14", mode: "dual" },
  { id: "T1.SL.08", tier: 1, feature: "SL:UnderFrame_PalletJack_Rack_Stow_Deploy_Action10_11", mode: "dual" },
  // Area B: Pallet Jack (8 tests)
  { id: "T1.PJ.01", tier: 1, feature: "PJ:Spawn_Geometry_ISO3691_5_And_0x0910_Sync", mode: "dual" },
  { id: "T1.PJ.02", tier: 1, feature: "PJ:Grab_Release_Tiller_And_DeadMan_Brake_Action1_2", mode: "dual" },
  { id: "T1.PJ.03", tier: 1, feature: "PJ:Hydraulic_Fork_Raise_Lower_85_200mm_Action4_5", mode: "dual" },
  { id: "T1.PJ.04", tier: 1, feature: "PJ:WalkBehind_Tricycle_Steering_And_15Hz_Pose_Action3", mode: "dual" },
  { id: "T1.PJ.05", tier: 1, feature: "PJ:Grounded_Container_Ramp_Climb_And_Floor_Walk", mode: "dual" },
  { id: "T1.PJ.06", tier: 1, feature: "PJ:Ground_Deployable_Stow_Pick_Drop_Action10_6_7", mode: "dual" },
  { id: "T1.PJ.07", tier: 1, feature: "PJ:Container_Pinwheel_LIFO_Unload_Action8", mode: "dual" },
  { id: "T1.PJ.08", tier: 1, feature: "PJ:Container_Pinwheel_DeepestFirst_Load_Action9", mode: "dual" },
  // Area C: Interlocks, Wire, Controls, OSD, MicroGrid & __vehicles (7 tests)
  { id: "T1.IL.01", tier: 1, feature: "IL:HBV1_v7_Wire_Schema_And_0x0910_Parity", mode: "dual" },
  { id: "T1.IL.02", tier: 1, feature: "IL:Sidelifter_Proximity_HUD_And_Keys_J_K_L_U", mode: "dual" },
  { id: "T1.IL.03", tier: 1, feature: "IL:Container_Door_E_And_Deployable_Stow_R_Capture", mode: "dual" },
  { id: "T1.IL.04", tier: 1, feature: "IL:WalkBehind_InputFunnel_Isolation_WASD_Space_F_R_X_V_Esc", mode: "dual" },
  { id: "T1.IL.05", tier: 1, feature: "IL:ISO3874_3691_5_Refusal_OSD_Feedback_Event24_25", mode: "dual" },
  { id: "T1.IL.06", tier: 1, feature: "IL:MicroGrid_Power_IsStowed_OnlineFlags_0x10_All9Deployables", mode: "dual" },
  { id: "T1.IL.07", tier: 1, feature: "IL:WindowVehicles_Logistics_API_Surface_And_NullSafety", mode: "dual" },
];

export async function runTier1(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // ---------------------------------------------------------------------------
  // Area A: Sidelifter Trailer (WCID 4000032, DeployableKind 15)
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.SL.01",
    1,
    "SL:Spawn_Preset_Sidelifter40_KindResolution",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      const tr = sim.trailers.get(trGuid);
      assert(tr.kind === DEPLOYABLE_KIND.TrailerSidelifter40, "Sidelifter kind === 15");
      assert(tr.wcid === LOGISTICS_SPEC.sidelifter.wcid, "Sidelifter WCID === 4000032");
      assert(tr.coupledTractorGuid === tGuid, "Coupled to semi-379");
      assert(tr.mountedContainerGuid === cGuid, "Mounted 40ft container");
      assert(tr.stowedPalletJackGuid === pjGuid, "Stowed pallet jack present");
      near(tr.craneSpanY, 5.9925, 1e-4, "40ft crane span Y");

      // Exercise real trailer_models.js baseline + sidelifter_model.js if landed
      const tm = await tryImportVehicle("trailer_models.js");
      assert(tm.ok, tm.reason);
      near(tm.mod.CHASSIS_DECK_Z, LOGISTICS_SPEC.sidelifter.chassisDeckZ, 1e-6, "CHASSIS_DECK_Z");
      near(tm.mod.CHASSIS_KINGPIN_Z, LOGISTICS_SPEC.sidelifter.chassisKingpinZ, 1e-6, "CHASSIS_KINGPIN_Z");
      near(tm.mod.TRAILER_SPECS["40ft"].kingpinY, LOGISTICS_SPEC.sidelifter.kingpinY, 1e-6, "kingpinY");

      const slm = await tryImportVehicle("sidelifter_model.js");
      if (slm.ok && typeof slm.mod.buildSidelifterTrailer === "function") {
        assert(tm.mod.resolveTrailerKind(15) === "40ft", "resolveTrailerKind(15) === 40ft");
        assert(tm.mod.resolveTrailerKind(4000032) === "40ft", "resolveTrailerKind(4000032) === 40ft");
        const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
        const built = slm.mod.buildSidelifterTrailer(THREE, { csmState: fakeCsm });
        assert(countDrawCalls(built.root) <= LOGISTICS_SPEC.sidelifter.maxDrawCalls, "sidelifter draw calls <= 14");
        assert(countLights(built.root) === 0, "sidelifter 0 lights");
        built.dispose?.();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|4000032|spawned/i, 10000);
      const st = await live.waitUntil(async () => {
        return await live.evalInPage(`
          const t = (window.__vehicles?.trailers?.list?.() || [])[0];
          const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
          const c = (window.__vehicles?.containers?.list?.() || [])[0];
          if (!t || !v || !c) return null;
          return { t, vGuid: v.guid, cKind: c.kind };
        `);
      }, 10000, 250, "sidelifter40 preset");
      assert(st.t.kind === 15 || st.t.wcid === 4000032, `Expected sidelifter kind 15/4000032, got ${JSON.stringify(st.t)}`);
      assert(st.t.coupledTractorGuid === st.vGuid, "Sidelifter must couple to semi-379");
      assert(st.t.mountedContainerGuid !== 0 && st.cKind === 11, "Mounted 40ft container required");
      assert((st.t.stowedPalletJackGuid ?? st.t.last?.stowedPalletJackGuid ?? st.t.last?.StowedPalletJackGuid ?? 0) !== 0, "Stowed pallet jack GUID required");
    }
  );

  await collector.runDual(
    "T1.SL.02",
    1,
    "SL:Presets_Sidelifter20_And_Sidelifter40HC_CraneSpan",
    async () => {
      near(oracleComputeCraneSpanY(10), 2.9265, 1e-6, "20ft craneSpanY");
      near(oracleComputeCraneSpanY(11), 5.9925, 1e-6, "40ft craneSpanY");
      near(oracleComputeCraneSpanY(12), 5.9925, 1e-6, "40HC craneSpanY");

      const sim = new LogisticsWorldSimulator();
      const p20 = sim.spawnPreset("sidelifter20");
      const p40hc = sim.spawnPreset("sidelifter40hc", { x: 140, y: 100 });
      near(sim.trailers.get(p20.trGuid).craneSpanY, 2.9265, 1e-4, "preset 20 craneSpanY");
      near(sim.trailers.get(p40hc.trGuid).craneSpanY, 5.9925, 1e-4, "preset 40hc craneSpanY");
      assert(sim.containers.get(p20.cGuid).kind === 10, "preset 20 container kind 10");
      assert(sim.containers.get(p40hc.cGuid).kind === 12, "preset 40hc container kind 12");

      // Cross-verify real container_models.js 40HC gooseneck tunnel + specs
      const cm = await tryImportVehicle("container_models.js");
      assert(cm.ok, cm.reason);
      const c40hc = cm.mod.buildIsoContainer(THREE, cm.mod.CONTAINER_WCID.IsoContainer40HC);
      assert(c40hc.spec.hasGooseneckTunnel === true, "40HC has gooseneck tunnel");
      assert(c40hc.spec.hasHazardChevrons === true, "40HC has hazard chevrons");
      c40hc.dispose();

      // Cross-verify sidelifter_kinematics.js if landed
      const sk = await tryImportVehicle("sidelifter_kinematics.js");
      if (sk.ok && typeof sk.mod.computeCraneSpanY === "function") {
        near(sk.mod.computeCraneSpanY(10), oracleComputeCraneSpanY(10), 1e-5, "real computeCraneSpanY(10)");
        near(sk.mod.computeCraneSpanY(11), oracleComputeCraneSpanY(11), 1e-5, "real computeCraneSpanY(11)");
        near(sk.mod.computeCraneSpanY(12), oracleComputeCraneSpanY(12), 1e-5, "real computeCraneSpanY(12)");
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const s20 = await live.waitUntil(async () => {
        return await live.evalInPage(`
          const t = (window.__vehicles?.trailers?.list?.() || [])[0];
          const c = (window.__vehicles?.containers?.list?.() || [])[0];
          return t && c ? { span: t.craneSpanY ?? t.last?.craneSpanY ?? t.last?.CraneSpanY, cKind: c.kind } : null;
        `);
      }, 10000, 250, "sidelifter20");
      near(s20.span, 2.9265, 1e-2, "live 20ft craneSpanY");
      assert(s20.cKind === 10, "live 20ft container kind === 10");

      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40hc", /sidelifter40hc|spawned/i, 10000);
      const s40hc = await live.waitUntil(async () => {
        return await live.evalInPage(`
          const t = (window.__vehicles?.trailers?.list?.() || [])[0];
          const c = (window.__vehicles?.containers?.list?.() || [])[0];
          return t && c ? { span: t.craneSpanY ?? t.last?.craneSpanY ?? t.last?.CraneSpanY, cKind: c.kind } : null;
        `);
      }, 10000, 250, "sidelifter40hc");
      near(s40hc.span, 5.9925, 1e-2, "live 40HC craneSpanY");
      assert(s40hc.cKind === 12, "live 40HC container kind === 12");
    }
  );

  await collector.runDual(
    "T1.SL.03",
    1,
    "SL:Outriggers_Deploy_And_Retract_Action6_7",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      const dep = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00);
      assert(dep.ok, dep.reason);
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.OutriggersPlanted, "Phase === OutriggersPlanted");
      near(sim.trailers.get(trGuid).outriggerProgress, 1.0, 1e-6, "outriggerProgress === 1");

      // Verify C2S encodeTrailerAction Action=6 / Action=7
      const pkt6 = encodeTrailerAction({ TrailerGuid: trGuid, Action: TRAILER_ACTION_KIND.DeployOutriggers, Flags: 0 });
      assert(decodeTrailerAction(pkt6).Action === 6, "Action 6 encoded");
      const pkt7 = encodeTrailerAction({ TrailerGuid: trGuid, Action: TRAILER_ACTION_KIND.RetractOutriggers, Flags: 0 });
      assert(decodeTrailerAction(pkt7).Action === 7, "Action 7 encoded");

      const ret = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.RetractOutriggers, 0x00);
      assert(ret.ok, ret.reason);
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.Idle, "Phase === Idle");
      near(sim.trailers.get(trGuid).outriggerProgress, 0.0, 1e-6, "outriggerProgress === 0");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.trailers?.list?.()[0]?.guid || 0;`), 10000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.sideliftPhase === 2 && t.outriggerProgress >= 0.99;
      }, 8000, 200, "outriggers planted");
      await live.evalInPage(`window.__vehicles.trailers.retractOutriggers(${tGuid}); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.sideliftPhase === 0 && t.outriggerProgress <= 0.01;
      }, 8000, 200, "outriggers retracted");
    }
  );

  await collector.runDual(
    "T1.SL.04",
    1,
    "SL:ISO1161_Twistlock_Toggle_Action3",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailers.get(trGuid).twistlocksLocked === true, "initially locked");
      const r1 = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      assert(r1.ok && r1.twistlocksLocked === false, "unlocked after first toggle");
      const r2 = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      assert(r2.ok && r2.twistlocksLocked === true, "re-locked after second toggle");

      // Cross-verify real trailer_models.js twistlock pivot rotation (0 <-> 90 deg)
      const tm = await tryImportVehicle("trailer_models.js");
      assert(tm.ok, tm.reason);
      const m = tm.mod.buildSemiTrailer(THREE, "40ft");
      m.setTwistlockState(tm.mod.TWISTLOCK_STATE.Unlocked);
      const unlockedRot = m.twistlockPivots[0].rotation.z;
      m.setTwistlockState(tm.mod.TWISTLOCK_STATE.Locked);
      const lockedRot = m.twistlockPivots[0].rotation.z;
      assert(Math.abs(lockedRot - unlockedRot) > 0.5, "twistlock heads visibly rotate between unlocked & locked");
      m.dispose();
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.trailers?.list?.()[0]?.guid || 0;`), 10000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.twistlocksLocked === false, 5000, 150, "twistlocks unlocked");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.twistlocksLocked === true, 5000, 150, "twistlocks re-locked");
    }
  );

  await collector.runDual(
    "T1.SL.05",
    1,
    "SL:Manual_Sidelift_Offload_Action8",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      const res = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload, 0x00);
      assert(res.ok, res.reason);
      assert(sim.trailers.get(trGuid).mountedContainerGuid === 0, "container unmounted from trailer");
      const c = sim.containers.get(cGuid);
      assert(c.mountedOnTrailerGuid === 0, "container MountedOnTrailerGuid === 0");
      near(c.x - sim.trailers.get(trGuid).x, 3.85, 1e-4, "lateral offload +3.85m");
      near(c.z, sim.trailers.get(trGuid).z, 1e-4, "grounded Z");

      // Verify level-lift invariant & smoothstep arc across phases 5..7
      for (const p of [0, 0.25, 0.5, 0.75, 1.0]) {
        const hoist = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Hoisting, p, 1, false, 1.32, 0);
        const swing = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Swinging, p, 1, false, 1.32, 0);
        const lower = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Lowering, p, 1, false, 1.32, 0);
        assert(hoist.roll === 0 && swing.roll === 0 && lower.roll === 0, "ISO 3874 level lift roll === 0");
        assert(swing.z >= 1.32 + 0.45 - 1e-6, "swing clears bolster by >= 0.45m");
      }

      const sk = await tryImportVehicle("sidelifter_kinematics.js");
      if (sk.ok && typeof sk.mod.evaluateContainerLocalPose === "function") {
        for (let ph = 0; ph <= 10; ph++) {
          for (const p of [0, 0.25, 0.5, 0.75, 1.0]) {
            for (const isLoad of [false, true]) {
              const exp = oracleEvaluateContainerLocalPose(ph, p, 1, isLoad, 1.32, 0, 0);
              const act = sk.mod.evaluateContainerLocalPose(ph, p, 1, isLoad, 1.32, 0, 0);
              near(act.x, exp.x, 1e-6, `phase ${ph} p=${p} load=${isLoad} x`);
              near(act.y, exp.y, 1e-6, `phase ${ph} p=${p} load=${isLoad} y`);
              near(act.z, exp.z, 1e-6, `phase ${ph} p=${p} load=${isLoad} z`);
              near(act.roll, exp.roll, 1e-6, `phase ${ph} p=${p} load=${isLoad} roll`);
              near(act.craneBoomAngle, exp.craneBoomAngle, 1e-6, `phase ${ph} p=${p} load=${isLoad} boom`);
              near(act.craneJibAngle, exp.craneJibAngle, 1e-6, `phase ${ph} p=${p} load=${isLoad} jib`);
              near(act.chainLen, exp.chainLen, 1e-6, `phase ${ph} p=${p} load=${isLoad} chainLen`);
            }
          }
        }
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles?.trailers?.list?.()[0];
        const c = window.__vehicles?.containers?.list?.()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid, tx: t.pos[0], ty: t.pos[1] } : null;
      `), 10000, 200, "rig");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${ids.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.twistlocksLocked === false, 4000, 150, "twistlocks unlocked");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0);
      }, 20000, 250, "sidelift offload complete");
      const c = await live.getContainer(ids.cGuid);
      const latDist = Math.hypot(c.pos[0] - ids.tx, c.pos[1] - ids.ty);
      assert(latDist >= 3.4 && latDist <= 4.3, `Container landed lateral dist ${latDist}m (expected ~3.85m)`);
      assert(!c.doorOpen, "Doors remain closed on offload");
    }
  );

  await collector.runDual(
    "T1.SL.06",
    1,
    "SL:Manual_Sidelift_Reload_Action9",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload, 0x00);
      near(sim.tractors.get(tGuid).towMassMul, LOGISTICS_SPEC.towMassMul.emptyChassis, 1e-6, "empty towMassMul 0.72");

      const reload = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftLoad, 0x00);
      assert(reload.ok, reload.reason);
      assert(sim.trailers.get(trGuid).mountedContainerGuid === cGuid, "container re-mounted");
      assert(sim.trailers.get(trGuid).twistlocksLocked === true, "twistlocks re-locked");
      near(sim.containers.get(cGuid).z, sim.trailers.get(trGuid).z + 1.32, 1e-4, "container back on deck Z=1.32");
      near(sim.tractors.get(tGuid).towMassMul, LOGISTICS_SPEC.towMassMul.loaded40ft, 1e-6, "loaded towMassMul 0.58");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.trailers?.list?.()[0]?.guid || 0;`), 10000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.twistlocksLocked === false, 4000, 150, "twistlocks unlocked");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid === 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0);
      }, 20000, 250, "offloaded for reload");

      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "load", "right"); return true;`);
      const reloaded = await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid !== 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0) ? t : null;
      }, 20000, 250, "sidelift reload complete");
      assert(reloaded.mountedContainerGuid !== 0, "Container mounted after reload");
      assert(reloaded.twistlocksLocked === true, "Twistlocks locked after reload");
    }
  );

  await collector.runDual(
    "T1.SL.07",
    1,
    "SL:AutoCycle_Offload_And_Load_Action13_14",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      const rOff = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload, 0x00);
      assert(rOff.ok, rOff.reason);
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.Idle, "AutoOffload returns to Idle");
      assert(sim.trailers.get(trGuid).outriggersPlanted === false, "AutoOffload retracts outriggers");
      assert(sim.trailers.get(trGuid).mountedContainerGuid === 0, "Container offloaded");

      const rLoad = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad, 0x00);
      assert(rLoad.ok, rLoad.reason);
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.Idle, "AutoLoad returns to Idle");
      assert(sim.trailers.get(trGuid).mountedContainerGuid === cGuid, "Container reloaded");
      assert(sim.trailers.get(trGuid).twistlocksLocked === true, "AutoLoad locks twistlocks");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.trailers?.list?.()[0]?.guid || 0;`), 10000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "autoOffload idle");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autoLoad", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0 && t.twistlocksLocked === true;
      }, 24000, 300, "autoLoad idle");
    }
  );

  await collector.runDual(
    "T1.SL.08",
    1,
    "SL:UnderFrame_PalletJack_Rack_Stow_Deploy_Action10_11",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === pjGuid, "initially stowed on rack");
      assert(sim.palletJacks.get(pjGuid).stowedOnTrailerGuid === trGuid, "jack points to trailer");

      const dep = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      assert(dep.ok, dep.reason);
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === 0, "rack cleared");
      assert(sim.palletJacks.get(pjGuid).stowedOnTrailerGuid === 0, "jack unstowed to ground");

      const stow = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack);
      assert(stow.ok, stow.reason);
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === pjGuid, "jack re-stowed on rack");
      assert(sim.palletJacks.get(pjGuid).stowedOnTrailerGuid === trGuid, "jack StowedOnTrailerGuid restored");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.trailers?.list?.()[0]?.guid || 0;`), 10000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`
        const pj = (window.__vehicles?.palletJacks?.list?.() || []).find((p) => (p.stowedOnTrailerGuid ?? 0) === 0);
        return pj ? pj.guid : 0;
      `), 8000, 200, "pallet jack deployed");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${tGuid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.stowedPalletJackGuid === pjGuid, 8000, 200, "pallet jack re-stowed");
    }
  );

  // ---------------------------------------------------------------------------
  // Area B: Walk-Behind Pallet Jack (WCID 4000035, DeployableKind 16, 0x0910)
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.PJ.01",
    1,
    "PJ:Spawn_Geometry_ISO3691_5_And_0x0910_Sync",
    async () => {
      const pkt = encodePalletJackState({
        PalletJackGuid: 0x800b0001,
        OperatorGuid: 0,
        StowedOnTrailerGuid: 0,
        Cell: 0x01028001,
        Position: { X: 12, Y: 24, Z: 10 },
        Heading: 0.5,
        TillerAngle: 0,
        ForkHeightM: 0.085,
        ForkState: FORK_STATE.Lowered,
        CarriedPalletSize: 0,
        Flags: 0,
        CarriedWcid: 0,
        OwnerGuid: 1001,
      });
      assert(pkt.length === 60, `PalletJackState size === 60 (got ${pkt.length})`);
      const dec = decodePalletJackState(pkt);
      assert(dec && dec.PalletJackGuid === 0x800b0001, "decoded PalletJackGuid");
      near(dec.ForkHeightM, 0.085, 1e-5, "ForkHeightM 0.085");

      // Cross-verify pallet_jack_model.js if landed
      const pjm = await tryImportVehicle("pallet_jack_model.js");
      if (pjm.ok && typeof pjm.mod.buildPalletJack === "function") {
        const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
        const m = pjm.mod.buildPalletJack(THREE, { csmState: fakeCsm });
        assert(countDrawCalls(m.root) <= LOGISTICS_SPEC.palletJack.maxDrawCalls, "pallet jack draw calls <= 6");
        assert(countLights(m.root) === 0, "pallet jack 0 lights");
        assert(m.cargoMount != null, "cargoMount present");
        m.dispose?.();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return (window.__vehicles?.palletJacks?.list?.() || [])[0] || null;`), 8000, 200, "pallet jack spawned");
      near(pj.forkHeightM, 0.085, 0.01, "initial forkHeightM");
      assert(pj.carriedWcid === 0 && pj.operatorGuid === 0, "initially unattended & empty");
    }
  );

  await collector.runDual(
    "T1.PJ.02",
    1,
    "PJ:Grab_Release_Tiller_And_DeadMan_Brake_Action1_2",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      const grab = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      assert(grab.ok, grab.reason);
      assert(sim.palletJacks.get(pjGuid).operatorGuid === 1001, "OperatorGuid === 1001");

      // Drive step while grabbed vs released (dead-man brake)
      const moving = oracleStepPalletJack(sim.palletJacks.get(pjGuid), { throttle: 1, steer: 0 }, 0.2);
      assert(moving.speed > 1.5, "moving while operator holding tiller");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release);
      assert(sim.palletJacks.get(pjGuid).operatorGuid === 0, "OperatorGuid === 0 on release");
      const braked = oracleStepPalletJack(sim.palletJacks.get(pjGuid), { throttle: 1, steer: 0.5 }, 0.2);
      assert(braked.speed === 0 && braked.tillerAngle === 0, "ISO 3691-5 dead-man brake zeroes speed & parks tiller");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.palletJacks?.list?.()[0]?.guid || 0;`), 8000, 200, "pj");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      const grabbed = await live.waitUntil(async () => {
        const p = await live.getPalletJack(pjGuid);
        return p && p.operatorGuid !== 0 ? p : null;
      }, 6000, 150, "pj grabbed");
      assert(grabbed.operatorGuid !== 0, "OperatorGuid assigned on grab");
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 6000, 150, "pj released");
    }
  );

  await collector.runDual(
    "T1.PJ.03",
    1,
    "PJ:Hydraulic_Fork_Raise_Lower_85_200mm_Action4_5",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      near(sim.palletJacks.get(pjGuid).forkHeightM, 0.085, 1e-4, "lowered 85mm");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.RaiseForks);
      near(sim.palletJacks.get(pjGuid).forkHeightM, 0.200, 1e-4, "raised 200mm");
      assert(sim.palletJacks.get(pjGuid).forkState === FORK_STATE.Raised, "ForkState === Raised");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LowerForks);
      near(sim.palletJacks.get(pjGuid).forkHeightM, 0.085, 1e-4, "lowered back 85mm");
      assert(sim.palletJacks.get(pjGuid).forkState === FORK_STATE.Lowered, "ForkState === Lowered");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.palletJacks?.list?.()[0]?.guid || 0;`), 8000, 200, "pj");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.raise(${pjGuid}); return true;`);
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 0) >= 0.19, 5000, 150, "forks raised");
      await live.evalInPage(`window.__vehicles.palletJacks.lower(${pjGuid}); return true;`);
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 1) <= 0.095, 5000, 150, "forks lowered");
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
    }
  );

  await collector.runDual(
    "T1.PJ.04",
    1,
    "PJ:WalkBehind_Tricycle_Steering_And_15Hz_Pose_Action3",
    async () => {
      let state = { x: 0, y: 0, z: 10, heading: 0, tillerAngle: 0, operatorGuid: 1001, carriedWcid: 0 };
      const dt = 1 / 30;
      for (let i = 0; i < 30; i++) {
        state = oracleStepPalletJack(state, { throttle: 1, steer: -0.6 }, dt);
      }
      assert(state.y > 0.5 && state.heading !== 0, "tricycle forward+left produced displacement & heading change");
      assert(Math.abs(state.tillerAngle) <= LOGISTICS_SPEC.palletJack.maxTillerRad + 1e-6, "tiller clamped to ±95°");
      assert(state.speed <= LOGISTICS_SPEC.palletJack.speedEmptyMps + 1e-6, "empty speed <= 2.2 m/s");

      // Check loaded speed limit (1.6 m/s)
      const loaded = oracleStepPalletJack({ ...state, carriedWcid: 4000010 }, { throttle: 1, steer: 0 }, dt);
      assert(loaded.speed <= LOGISTICS_SPEC.palletJack.speedLoadedMps + 1e-6, "loaded speed <= 1.6 m/s");

      // Check 15 Hz sync interval invariant (66.7ms)
      const syncPeriod = 1 / LOGISTICS_SPEC.palletJack.poseSyncHz;
      let sent = 0;
      let accum = 0;
      for (let i = 0; i < 30; i++) {
        accum += dt;
        if (accum >= syncPeriod - 1e-6) { accum -= syncPeriod; sent++; }
      }
      assert(sent >= 14 && sent <= 16, `15 Hz pose sync rate expected ~15/s, got ${sent}`);
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.palletJacks?.list?.()[0]?.guid || 0;`), 8000, 200, "pj");
      const before = (await live.getPalletJack(pjGuid)).pos;
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "pj grabbed");
      await live.evalInPage(`
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }));
        return true;
      `);
      let after = before;
      let moved = 0;
      const moveStart = Date.now();
      while (Date.now() - moveStart < 4500) {
        await new Promise((r) => setTimeout(r, 150));
        after = (await live.getPalletJack(pjGuid)).pos;
        moved = Math.hypot((after[0] - before[0]), (after[1] - before[1]));
        if (moved >= 0.45) break;
      }
      await live.evalInPage(`
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", bubbles: true }));
        window.__vehicles.palletJacks.release(${pjGuid});
        return true;
      `);
      assert(moved > 0.3, `Expected pallet jack to move >= 0.3m on W+A, moved ${moved}`);
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T1.PJ.05",
    1,
    "PJ:Grounded_Container_Ramp_Climb_And_Floor_Walk",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        // Register 8-arg grounded 20ft container collider with doorOpen = true at (100, 100, 10)
        const hl = 5.898 / 2; // 2.949 (intL / 2 matching src/lib.rs:47438)
        env.live.sessionHandle.upsertContainerCollider(0x80099201, 0, 100, 100, 10, 0, 10, true);

        const toe = env.live.sessionHandle.probeContainerSurface(100, 100 - hl - 0.84, 11.5);
        assert(toe && toe.zone === "ramp", "ramp toe detected");
        near(toe.z, 10.002, 0.01, "ramp toe Z near ground 10m");

        const mid = env.live.sessionHandle.probeContainerSurface(100, 100 - hl - 0.425, 11.5);
        assert(mid && mid.zone === "ramp", "ramp mid detected");
        near(mid.z, 10.081, 0.01, "ramp mid Z = 10 + 0.081");

        const floor = env.live.sessionHandle.probeContainerSurface(100, 100 - hl + 0.5, 11.5);
        assert(floor && floor.zone === "floor", "interior floor detected");
        near(floor.z, 10.162, 1e-4, "interior floor Z = 10 + 0.162");

        // Verify ramp grade 10.99 deg <= 12 deg ISO 3691-5 limit & ramp speed clamp 1.1 m/s
        const gradeDeg = (Math.atan2(0.162, 0.85) * 180) / Math.PI;
        assert(gradeDeg <= LOGISTICS_SPEC.palletJack.maxRampGradeDeg, `ramp grade ${gradeDeg.toFixed(2)}° <= 12°`);
        const step = oracleStepPalletJack(
          { x: 100, y: 100 - hl - 0.5, z: 10.06, heading: 0, tillerAngle: 0, operatorGuid: 1001, carriedWcid: 0 },
          { throttle: 1, steer: 0 },
          1 / 30,
          env.live.sessionHandle.probeContainerSurface
        );
        assert(step.speed <= LOGISTICS_SPEC.palletJack.speedRampMps + 1e-6, "ramp speed capped at 1.1 m/s");
        assert(step.onContainerRampOrFloor === true, "onContainerRampOrFloor === true");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@container spawn 20", /container|4000020|spawned/i, 10000);
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const c = (window.__vehicles?.containers?.list?.() || [])[0];
        const pj = (window.__vehicles?.palletJacks?.list?.() || [])[0];
        return c && pj ? { cGuid: c.guid, pjGuid: pj.guid, cPos: c.pos, h: c.last?.heading ?? 0 } : null;
      `), 8000, 200, "container + pj");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.98, 6000, 150, "doors open");
      const res = await live.evalInPage(`
        const s = window.__sessionHandle?.probeContainerSurface?.(${ids.cPos[0]}, ${ids.cPos[1]}, ${ids.cPos[2] + 1.5});
        return s;
      `);
      assert(res !== null && res !== undefined, "probeContainerSurface returned interior floor height on live WASM");
    }
  );

  await collector.runDual(
    "T1.PJ.06",
    1,
    "PJ:Ground_Deployable_Stow_Pick_Drop_Action10_6_7",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const dGuid = sim.allocGuid();
      sim.deployables.set(dGuid, {
        guid: dGuid, wcid: 4000014, kind: 6, x: 102, y: 95, z: 10,
        isStowed: false, onlineFlags: ONLINE_FLAGS.Active | ONLINE_FLAGS.Powered, elevationM: 0.85,
        cargoState: { ammo: 3, fuel: 0, energy: 0 },
      });

      // Stow [R] -> Pick [F] -> Drop [F]
      const stowRes = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: dGuid });
      assert(stowRes.ok && sim.deployables.get(dGuid).isStowed === true, "deployable stowed");
      assert((sim.deployables.get(dGuid).onlineFlags & ONLINE_FLAGS.Stowed) !== 0, "OnlineFlags & 0x10 set");
      near(sim.deployables.get(dGuid).elevationM, 0, 1e-6, "elevation lowered to 0");

      const pickRes = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dGuid });
      assert(pickRes.ok, pickRes.reason);
      assert(sim.palletJacks.get(pjGuid).carriedWcid === 4000014, "CarriedWcid === 4000014");
      assert(!sim.deployables.has(dGuid), "world deployable removed into jack cargo");

      const dropRes = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
      assert(dropRes.ok && dropRes.deployableGuid, "respawned on drop");
      assert(sim.palletJacks.get(pjGuid).carriedWcid === 0, "CarriedWcid cleared");
      assert(sim.deployables.get(dropRes.deployableGuid).cargoState.ammo === 3, "ammo preserved across pick/drop");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.palletJacks?.list?.()[0]?.guid || 0;`), 8000, 200, "pj");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.spawnDeployableNear(4000014, pjPose.pos, /4000014|Missile|spawned/i);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles?.deployables?.list?.()[0]?.guid || 0;`), 8000, 200, "deployable");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${dGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${dGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 6000, 150, "deployable stowed");
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${dGuid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 4000014, 6000, 150, "picked ground deployable");
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      await live.waitUntil(async () => {
        const pj = await live.getPalletJack(pjGuid);
        const cnt = await live.evalInPage(`return window.__vehicles.deployables.list().length;`);
        return pj && pj.carriedWcid === 0 && cnt >= 1;
      }, 6000, 150, "dropped to ground");
    }
  );

  await collector.runDual(
    "T1.PJ.07",
    1,
    "PJ:Container_Pinwheel_LIFO_Unload_Action8",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const c = sim.containers.get(cGuid);
      const lifo = oracleComputeReachableUnloadSlots(10, c.slots);
      assert(lifo.reachable.some((r) => r.slotIndex === 9), "rear slot 9 reachable");
      const pick = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 9, subSlot: 0 });
      assert(pick.ok, pick.reason);
      assert(sim.palletJacks.get(pjGuid).carriedWcid === 4000002, "picked RadarStation 4000002");
      assert(c.slots.length === 1, "container slots decremented to 1");

      // Cross-verify container_logistics.js across multi-obstacle configs & out-of-range slotIndex safety
      const noThrowOutRange = oracleComputeReachableUnloadSlots(10, [{ slotIndex: 99, cargoWcid: 4000010 }]);
      assert(noThrowOutRange.reachable.length === 0 && noThrowOutRange.blocked.length === 0, "out-of-range slotIndex safely ignored");

      const cl = await tryImportVehicle("container_logistics.js");
      if (cl.ok && typeof cl.mod.computeReachableUnloadSlots === "function") {
        for (const [kind, occ] of [
          [10, [{ slotIndex: 6, cargoWcid: 4000010 }, { slotIndex: 8, cargoWcid: 4000011 }]],
          [10, [{ slotIndex: 1, cargoWcid: 4000010 }, { slotIndex: 8, cargoWcid: 4000011 }, { slotIndex: 9, cargoWcid: 4000012 }]],
          [11, [{ slotIndex: 0, cargoWcid: 4000010 }, { slotIndex: 18, cargoWcid: 4000014 }]],
        ]) {
          const ora = oracleComputeReachableUnloadSlots(kind, occ);
          const real = cl.mod.computeReachableUnloadSlots(kind, occ);
          const oraIds = ora.reachable.map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
          const realIds = (real.reachable || []).map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
          assert(oraIds === realIds, `unload parity mismatch for kind=${kind}: oracle=[${oraIds}] real=[${realIds}]`);
        }
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles?.trailers?.list?.()[0];
        const c = window.__vehicles?.containers?.list?.()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 10000, 200, "sidelifter20");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offloaded");
      const cOffloaded = await live.getContainer(ids.cGuid);
      if (cOffloaded?.pos) await live.movePlayerNear(cOffloaded.pos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "doors open & jack ready");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const slotPos = await live.getSlotWorldPos(ids.cGuid, 6, 0);
      await live.movePalletJackTo(pjGuid, slotPos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "picked container rear slot");
    }
  );

  await collector.runDual(
    "T1.PJ.08",
    1,
    "PJ:Container_Pinwheel_DeepestFirst_Load_Action9",
    async () => {
      const loadOrder = oracleComputeReachableLoadSlots(10, [], "full");
      assert(loadOrder.length === 10, "empty 20ft container has 10 loadable slots");
      assert(loadOrder[0].slotIndex === 0, `deepest-first slot must be slot 0 (+Y), got ${loadOrder[0].slotIndex}`);
      assert(loadOrder[loadOrder.length - 1].slotIndex === 8 || loadOrder[loadOrder.length - 1].slotIndex === 9, "rearmost slots come last");

      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.containers.get(cGuid).slots = [];
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      sim.palletJacks.get(pjGuid).carriedWcid = 4000010;
      sim.palletJacks.get(pjGuid).carriedPalletSize = 2;

      const load = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: 0, subSlot: 0 });
      assert(load.ok, load.reason);
      assert(sim.containers.get(cGuid).slots.length === 1 && sim.containers.get(cGuid).slots[0].slotIndex === 0, "loaded into slot 0");
      assert(sim.palletJacks.get(pjGuid).carriedWcid === 0, "forks emptied");

      const cl = await tryImportVehicle("container_logistics.js");
      if (cl.ok && typeof cl.mod.computeReachableLoadSlots === "function") {
        for (const [kind, occ] of [
          [10, []],
          [10, [{ slotIndex: 8, cargoWcid: 4000011 }]],
          [10, [{ slotIndex: 1, cargoWcid: 4000010 }, { slotIndex: 8, cargoWcid: 4000011 }, { slotIndex: 9, cargoWcid: 4000012 }]],
          [11, [{ slotIndex: 0, cargoWcid: 4000010 }, { slotIndex: 18, cargoWcid: 4000014 }]],
        ]) {
          const oraLoad = oracleComputeReachableLoadSlots(kind, occ, "full");
          const realLoad = cl.mod.computeReachableLoadSlots(kind, occ, "full");
          const oraIds = oraLoad.map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
          const realIds = (realLoad.reachable || []).map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
          assert(oraIds === realIds, `load parity mismatch for kind=${kind}: oracle=[${oraIds}] real=[${realIds}]`);
        }
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles?.trailers?.list?.()[0];
        const c = window.__vehicles?.containers?.list?.()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 10000, 200, "sidelifter20");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offloaded");
      const cOffloaded = await live.getContainer(ids.cGuid);
      if (cOffloaded?.pos) await live.movePlayerNear(cOffloaded.pos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "doors open & jack ready");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const slotPos = await live.getSlotWorldPos(ids.cGuid, 6, 0);
      await live.movePalletJackTo(pjGuid, slotPos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "unloaded slot 6 before reload");

      const beforeCount = (await live.getContainer(ids.cGuid)).slots.length;
      await live.movePalletJackTo(pjGuid, slotPos);
      await live.evalInPage(`window.__vehicles.palletJacks.loadContainer(${ids.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => {
        const pj = await live.getPalletJack(pjGuid);
        const c = await live.getContainer(ids.cGuid);
        return pj && pj.carriedWcid === 0 && (c?.slots || []).length === beforeCount + 1;
      }, 6000, 150, "loaded container slot");
    }
  );

  // ---------------------------------------------------------------------------
  // Area C: Interlocks, HBV1 v7 Wire, Keybindings, OSD & window.__vehicles
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.IL.01",
    1,
    "IL:HBV1_v7_Wire_Schema_And_0x0910_Parity",
    async () => {
      // Round-trip all v7 wire messages
      const tsBytes = encodeTrailerState({
        TrailerGuid: 0x80099101,
        Kind: DEPLOYABLE_KIND.TrailerSidelifter40,
        Cell: 0x01028001,
        Position: { X: 10, Y: 20, Z: 0 },
        Heading: 1.25,
        Pitch: 0.02,
        Bank: -0.01,
        CoupledTractorGuid: 0x80099001,
        MountedContainerGuid: 0x80099201,
        ContainerSlot: 0,
        TrailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.TwistlocksLocked,
        OwnerGuid: 1001,
        SideliftPhase: SIDELIFT_PHASE.Swinging,
        SideliftSide: -1,
        SideliftFlags: SIDELIFT_FLAGS.IsSidelifter | SIDELIFT_FLAGS.OutriggersPlanted | SIDELIFT_FLAGS.CranesActive,
        SideliftProgress: 0.5,
        OutriggerProgress: 1.0,
        CraneSpanY: 2.9265,
        StowedPalletJackGuid: 0x800b0002,
        TransferContainerGuid: 0x80099201,
      }, HBV1_VERSION_V7);
      assert(tsBytes.length === 84, `v7 TrailerState === 84B (got ${tsBytes.length})`);
      const tsDec = decodeTrailerState(tsBytes);
      assert(tsDec && tsDec.SideliftPhase === 6 && tsDec.SideliftSide === -1, "v7 fields decoded");
      near(tsDec.CraneSpanY, 2.9265, 1e-4, "CraneSpanY");

      const pjaBytes = encodePalletJackAction({
        PalletJackGuid: 0x800b0002,
        Action: PALLET_JACK_ACTION_KIND.PickContainerSlot,
        SlotIndex: 9,
        SubSlot: 1,
        Flags: 0,
        TargetGuid: 0x80099201,
        Cell: 0x01028001,
        Position: { X: 5, Y: 6, Z: 0.162 },
        Heading: 0.25,
        TillerAngle: -0.4,
      });
      assert(pjaBytes.length === 44, `PalletJackAction === 44B (got ${pjaBytes.length})`);
      const pjaDec = decodePalletJackAction(pjaBytes);
      assert(pjaDec && pjaDec.Action === 8 && pjaDec.SlotIndex === 9 && pjaDec.SubSlot === 1, "PalletJackAction decoded");

      const evBytes = encodeVehicleEvent({
        Vehicle: 0x80099101,
        Kind: VEHICLE_EVENT_KIND.SideliftRefused,
        Step: 42,
        Subject: 0x80099201,
        Aux: 3,
      });
      const evDec = decodeVehicleEvent(evBytes);
      assert(evDec && evDec.Kind === 24 && evDec.Aux === 3, "VehicleEventKind 24 decoded");

      // Cross-verify vehicles.protocol.xml if bumped to v7
      const xml = readXmlProtocol();
      if (xml.exists && /version="7"/.test(xml.text)) {
        assert(/0x0910/.test(xml.text), "protocol.xml includes 0x0910");
        assert(/TrailerSidelifter40/.test(xml.text) && /PalletJack/.test(xml.text), "protocol.xml includes DeployableKind 15 & 16");
      }

      // Verify all 11 matching fixtures from vehicle-wire-fixtures.json round-trip byte-for-byte
      const { output: wireFixtures } = readProtocolFixtures();
      assert(wireFixtures && Array.isArray(wireFixtures.fixtures), "vehicle-wire-fixtures.json loaded");
      const codecByMsg = {
        Vehicle_TrailerAction: [decodeTrailerAction, encodeTrailerAction],
        Vehicle_TrailerState: [decodeTrailerState, encodeTrailerState],
        Vehicle_PalletJackAction: [decodePalletJackAction, encodePalletJackAction],
        Vehicle_PalletJackState: [decodePalletJackState, encodePalletJackState],
        Vehicle_DeployableState: [decodeDeployableState, encodeDeployableState],
        Vehicle_Event: [decodeVehicleEvent, encodeVehicleEvent],
        Vehicle_ContainerAction: [decodeContainerAction, encodeContainerAction],
      };
      let fixtureChecked = 0;
      for (const fx of wireFixtures.fixtures) {
        const pair = codecByMsg[fx.message];
        if (!pair || fx.expect !== "ok") continue;
        const [dec, enc] = pair;
        const raw = Uint8Array.from(Buffer.from(fx.hex, "hex"));
        const decoded = dec(raw);
        assert(decoded !== null, `fixture ${fx.name} (${fx.message}) decoded non-null`);
        const reHex = Buffer.from(enc(decoded, decoded.Header.Version)).toString("hex");
        assert(reHex === fx.hex, `fixture ${fx.name} round-trip hex mismatch`);
        const fieldsHex = Buffer.from(enc(fx.fields, fx.version)).toString("hex");
        assert(fieldsHex === fx.hex, `fixture ${fx.name} fields-encode hex mismatch`);
        if (fx.repack_hex) {
          const repackHex = Buffer.from(enc(decoded, HBV1_VERSION_V7)).toString("hex");
          assert(repackHex === fx.repack_hex, `fixture ${fx.name} v7 repack_hex mismatch`);
        }
        fixtureChecked++;
      }
      assert(fixtureChecked === 11, `Expected 11 logistics wire fixtures verified, got ${fixtureChecked}`);

      // Reject pre-introduction header versions
      assert(decodeTrailerState(encodeTrailerState({ TrailerGuid: 1 }, 5)) === null, "TrailerState rejects v5");
      assert(decodeTrailerAction(encodeTrailerAction({ TrailerGuid: 1 }, 5)) === null, "TrailerAction rejects v5");
      assert(decodePalletJackAction(encodePalletJackAction({ PalletJackGuid: 1 }, 6)) === null, "PalletJackAction rejects v6");
      assert(decodePalletJackState(encodePalletJackState({ PalletJackGuid: 1 }, 6)) === null, "PalletJackState rejects v6");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      await live.waitUntil(async () => await live.evalInPage(`
        return (window.__vehicles?.trailers?.list?.() || []).length > 0 &&
               (window.__vehicles?.palletJacks?.list?.() || []).length > 0;
      `), 8000, 200, "sidelifter + pj wire packets");
      const rawStats = await live.evalInPage(`return window.__sessionHandle?.vehicleWireStats?.() ?? null;`);
      assert(rawStats, "vehicleWireStats() must be available");
      const stats = typeof rawStats === "string" ? JSON.parse(rawStats) : rawStats;
      assert(Array.isArray(stats.received) && stats.received.length >= 32, "received array length >= 32");
      assert((stats.received[15] ?? 0) > 0 && (stats.received[16] ?? 0) > 0, "0x090F and 0x0910 counters non-zero");
    }
  );

  await collector.runDual(
    "T1.IL.02",
    1,
    "IL:Sidelifter_Proximity_HUD_And_Keys_J_K_L_U",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        // Test multi-listener capture + stopImmediatePropagation isolation against retail emotes (J/K/U)
        let retailEmoteFired = 0;
        let capturedCodes = [];
        const onCapture = (ev) => {
          if (["KeyJ", "KeyK", "KeyL", "KeyU"].includes(ev.code)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            capturedCodes.push(ev.shiftKey ? `Shift+${ev.code}` : ev.code);
          }
        };
        env.fakeWinObj.addEventListener("keydown", onCapture, true);
        env.fakeWinObj.addEventListener("keydown", () => { retailEmoteFired++; }, false);

        for (const c of ["KeyJ", "KeyK", "KeyL", "KeyU"]) {
          const ev = env.fakeWinObj.dispatch("keydown", { code: c });
          assert(ev.defaultPrevented && ev.propagationStopped, `${c} prevented & stopped`);
        }
        const shiftL = env.fakeWinObj.dispatch("keydown", { code: "KeyL", shiftKey: true });
        assert(shiftL.defaultPrevented, "Shift+KeyL prevented");
        assert(retailEmoteFired === 0, "downstream emote listeners never fired");
        assert(capturedCodes.join(",") === "KeyJ,KeyK,KeyL,KeyU,Shift+KeyL", "all sidelifter hotkeys captured");

        // Verify real osd.js #hb-vehicle-prompt DOM element updates cleanly
        const osdMod = await tryImportVehicle("osd.js");
        assert(osdMod.ok, osdMod.reason);
        const osd = osdMod.mod.createVehicleOsd({ document: env.doc });
        osd.prompt("[J] Outriggers · [K] Twistlocks · [L] Sidelift · [Shift+L] Auto · [U] Jack");
        const promptEl = env.doc.getElementById(osdMod.mod.PROMPT_ID);
        assert(promptEl && promptEl.style.display === "block" && promptEl.textContent.includes("[J]"), "#hb-vehicle-prompt shows sidelifter hints");
        osd.dispose();
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles?.trailers?.list?.()[0];
        if (!t) return false;
        const el = document.getElementById("hb-vehicle-prompt");
        return el && el.style.display !== "none" && /\[J\]|\[K\]|\[L\]|Sidelift/i.test(el.textContent || "");
      `), 8000, 200, "sidelifter proximity prompt");
      await live.dispatchKey("KeyJ");
      await live.waitUntil(async () => {
        const t = await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`);
        return t ? ((await live.getTrailer(t))?.sideliftPhase ?? 0) !== 0 : false;
      }, 5000, 150, "KeyJ triggered outriggers");
    }
  );

  await collector.runDual(
    "T1.IL.03",
    1,
    "IL:Container_Door_E_And_Deployable_Stow_R_Capture",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        let retailTurnRightOrAutorun = 0;
        env.fakeWinObj.addEventListener("keydown", (ev) => {
          if (ev.code === "KeyE" || ev.code === "KeyR") {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (ev.code === "KeyE") env.live.sessionHandle.vehicleContainerAction(0x80099201, 1, 0, 0, 0);
            if (ev.code === "KeyR") env.live.sessionHandle.vehiclePalletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, 0, 0, 0, 0x80099301, 0, 0, 0, 0, 0, 0);
          }
        }, true);
        env.fakeWinObj.addEventListener("keydown", () => { retailTurnRightOrAutorun++; }, false);

        env.fakeWinObj.dispatch("keydown", { code: "KeyE" });
        env.fakeWinObj.dispatch("keydown", { code: "KeyR" });
        assert(retailTurnRightOrAutorun === 0, "KeyE TurnRight & KeyR Autorun blocked");
        assert(env.calls.vehicleContainerAction.length === 1 && env.calls.vehicleContainerAction[0].action === 1, "ContainerAction OpenDoors sent");
        assert(env.calls.vehiclePalletJackAction.length === 1 && env.calls.vehiclePalletJackAction[0].action === 10, "ToggleDeployableStow sent");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /container|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 6000, 150, "container");
      await live.dispatchKey("KeyE");
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) > 0.5, 6000, 150, "KeyE opened container doors");

      await live.cleanupWorld();
      const playerPose = await live.getPlayerGlobalPose();
      assert(playerPose && typeof playerPose.gx === "number", "getPlayerGlobalPose available");
      await live.spawnDeployableNear(4000014, [playerPose.gx + 1.0, playerPose.gy, playerPose.z], /4000014|Missile|spawned/i);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`const deps = window.__vehicles.deployables.list(); return deps[deps.length - 1]?.guid || 0;`), 6000, 150, "deployable near player");
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${dGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 6000, 150, "KeyR stowed nearby deployable");
    }
  );

  await collector.runDual(
    "T1.IL.04",
    1,
    "IL:WalkBehind_InputFunnel_Isolation_WASD_Space_F_R_X_V_Esc",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        let retailLeaked = 0;
        let active = true;
        let camView = "follow";
        env.fakeWinObj.__inputFunnel.releaseHeld();
        env.fakeWinObj.__inputFunnel.poison("pallet-jack");
        env.fakeWinObj.__inputFunnel.cancelJumpCharge();

        env.fakeWinObj.addEventListener("keydown", (ev) => {
          if (!active) return;
          if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyF", "KeyR", "KeyV", "KeyX", "Escape"].includes(ev.code)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (ev.code === "KeyV") camView = camView === "follow" ? "interior" : "follow";
            if (ev.code === "KeyX" || ev.code === "Escape") {
              active = false;
              env.fakeWinObj.__inputFunnel.unpoison();
            }
          }
        }, true);
        env.fakeWinObj.addEventListener("keydown", () => { retailLeaked++; }, false);

        for (const k of ["KeyW", "KeyA", "Space", "KeyF", "KeyR", "KeyV"]) {
          env.fakeWinObj.dispatch("keydown", { code: k });
        }
        assert(retailLeaked === 0, "no keys leaked to retail character controller");
        assert(camView === "interior", "V toggled camera view");
        assert(env.funnelCalls.cancelJumpCharge === 1, "cancelJumpCharge invoked");

        env.fakeWinObj.dispatch("keydown", { code: "Escape" });
        assert(active === false && env.funnelCalls.unpoison === 1, "Esc released jack & unpoisoned inputFunnel");
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
      await live.dispatchKey("Space", { key: " " });
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 0) >= 0.19, 5000, 150, "Space raised forks");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "KeyX released jack");
    }
  );

  await collector.runDual(
    "T1.IL.05",
    1,
    "IL:ISO3874_3691_5_Refusal_OSD_Feedback_Event24_25",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        const osdMod = await tryImportVehicle("osd.js");
        assert(osdMod.ok, osdMod.reason);
        const osd = osdMod.mod.createVehicleOsd({ document: env.doc });

        // Inject SideliftRefused (24) & PalletJackEvent (25) into pipeline and verify OSD prompt display
        const sim = new LogisticsWorldSimulator();
        const { trGuid, cGuid } = sim.spawnPreset("sidelifter40");
        sim.openContainerDoors(cGuid, true);
        const refusal = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
        assert(!refusal.ok && /ISO 3874.*doors/i.test(refusal.reason), "ISO 3874 door refusal produced");

        osd.prompt(refusal.reason);
        const promptNode = env.doc.getElementById(osdMod.mod.PROMPT_ID);
        assert(promptNode && promptNode.textContent.includes("ISO 3874"), "OSD prompt renders ISO 3874 refusal");

        env.push({ type: "event", kind: VEHICLE_EVENT_KIND.SideliftRefused, vehicle: trGuid, subject: cGuid, aux: 1 });
        env.push({ type: "event", kind: VEHICLE_EVENT_KIND.PalletJackEvent, vehicle: 0x800b0001, subject: cGuid, aux: 2 });
        env.tick(100);
        assert(env.api.status() !== null, "client pipeline stayed healthy on event 24 & 25");
        osd.dispose();
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid } : null;
      `), 8000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      // Attempt manual offload while twistlocks locked -> expect ISO 3874 prompt or chat refusal
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "offload", "right"); return true;`);
      const promptOrChat = await live.waitUntil(async () => await live.evalInPage(`
        const el = document.getElementById("hb-vehicle-prompt");
        const txt = el?.textContent || "";
        return /ISO|twistlock|unlock/i.test(txt) ? txt : null;
      `), 6000, 150, "ISO 3874 refusal prompt");
      assert(/ISO|twistlock|unlock/i.test(promptOrChat), `Expected ISO refusal prompt, got "${promptOrChat}"`);
    }
  );

  await collector.runDual(
    "T1.IL.06",
    1,
    "IL:MicroGrid_Power_IsStowed_OnlineFlags_0x10_All9Deployables",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const flux = sim.allocGuid();
      const gen = sim.allocGuid();
      const tur = sim.allocGuid();
      sim.deployables.set(flux, { guid: flux, wcid: 4000010, kind: 2, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(gen, { guid: gen, wcid: 4000012, kind: 4, x: 5, y: 0, z: 0, isStowed: false, cargoState: { fuel: 120 } });
      sim.deployables.set(tur, { guid: tur, wcid: 4000014, kind: 6, x: 10, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(tur).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "Turret powered on active MicroGrid");
      assert(sim.deployables.get(tur).powerWatts < 0, "Turret consumes power");

      sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: tur });
      assert((sim.deployables.get(tur).onlineFlags & ONLINE_FLAGS.Stowed) !== 0, "OnlineFlags & 0x10 set when stowed");
      assert(sim.deployables.get(tur).powerWatts === 0, "PowerWatts === 0 when stowed");

      // Exercise all 9 deployables in deployable_models.js + radar_model.js with observable stow state checks
      const dm = await tryImportVehicle("deployable_models.js");
      const rm = await tryImportVehicle("radar_model.js");
      assert(dm.ok && rm.ok, "deployable_models.js & radar_model.js load");
      const fakeCsm = { enabled: true, lights: [], splits: [10, 50, 200], blendFrac: 0.1 };
      for (const spec of ALL_9_DEPLOYABLES) {
        const activeModel = spec.wcid === 4000002
          ? rm.mod.buildDeployedRadar(THREE, { stowed: false, csmState: fakeCsm })
          : dm.mod.buildDeployable(THREE, spec.wcid, { stowed: false, csmState: fakeCsm });
        const stowedModel = spec.wcid === 4000002
          ? rm.mod.buildDeployedRadar(THREE, { stowed: true, csmState: fakeCsm })
          : dm.mod.buildDeployable(THREE, spec.wcid, { stowed: true, csmState: fakeCsm });
        assert(countLights(activeModel.root) === 0 && countLights(stowedModel.root) === 0, `${spec.name} 0 lights`);
        assert(typeof activeModel.setStowed === "function", `${spec.name} must expose setStowed`);

        if (spec.wcid === 4000002) {
          activeModel.update(1.5);
        } else {
          activeModel.update({
            simTimeSec: 1.5,
            sunAzimuthRad: 1.1,
            sunPitchRad: 0.7,
            deployElevation: 0.9,
            yawRad: 0.8,
            pitchRad: 0.3,
            energyJoules: 480000,
            fuelRemaining: 40,
            ammoCount: 3,
          });
        }

        activeModel.setStowed(true);
        assert(activeModel.stowed === true, `${spec.name} stowed getter === true`);
        activeModel.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(activeModel.root);
        const stowedH = box.max.z - box.min.z;
        assert(stowedH <= (spec.wcid === 4000002 ? 2.10 : 2.14), `${spec.name} stowed height ${stowedH.toFixed(3)}m`);

        if (spec.wcid === 4000002) {
          assert(activeModel.dishPivot.rotation.z === 0 && activeModel.crtWindow.material.color.getHex() === 0xffaa22, "RadarStation stowed reset");
        } else if (spec.wcid === 4000010) {
          assert(activeModel.core.material.opacity === 0.15 && activeModel.lightsNS.material.color.getHex() === 0xffaa22, "FluxPod stowed reset");
        } else if (spec.wcid === 4000011) {
          assert(activeModel.turntable.rotation.z === 0 && activeModel.trunnion.rotation.x === 0 && activeModel.root.getObjectByName("solar-status-led").material.color.getHex() === 0xffaa22, "SolarPanels stowed reset");
        } else if (spec.wcid === 4000012) {
          assert(activeModel.root.getObjectByName("generator-exhaust-stack").position.z === 1.11 && activeModel.glowCore.material.color.getHex() === 0xffaa22, "PowerGenerator stowed reset");
        } else if (spec.wcid === 4000013) {
          assert(activeModel.socBars[0].material.color.getHex() === 0xffaa22 && activeModel.socBars[1].material.color.getHex() === 0x222222, "BatteryUnit stowed reset");
        } else if (spec.wcid === 4000014) {
          assert(activeModel.riserGroup.position.z === 0.20 && activeModel.turntable.rotation.z === 0 && activeModel.gimbal.rotation.x === 0 && activeModel.root.getObjectByName("sam-status-led").material.color.getHex() === 0xffaa22, "MissileTurret stowed reset");
        } else if (spec.wcid === 4000015) {
          assert(activeModel.antennaGroup.position.z === 0.66 && activeModel.root.getObjectByName("ground-radar-mast").scale.z === 0.25, "GroundRadar stowed reset");
        } else if (spec.wcid === 4000016) {
          near(activeModel.cradle.rotation.x, -Math.PI / 2, 1e-6, "MortarTurret stowed cradle");
          assert(activeModel.root.getObjectByName("mortar-status-led").material.color.getHex() === 0xffaa22, "MortarTurret stowed LED");
        } else if (spec.wcid === 4000017) {
          const laserGlow = activeModel.barrelGimbal.children.find((ch) => ch.material?.blending === THREE.AdditiveBlending);
          assert(activeModel.turretHead.rotation.z === 0 && activeModel.barrelGimbal.rotation.x === 0 && laserGlow?.material.color.getHex() === 0xffaa22, "HeavyLaserTurret stowed reset");
        }

        activeModel.setStowed(false);
        assert(activeModel.stowed === false, `${spec.name} unstowed getter === false`);
        if (spec.wcid === 4000002) assert(activeModel.crtWindow.material.color.getHex() === 0x33ff66, "RadarStation active LED");
        else if (spec.wcid === 4000010) assert(activeModel.core.material.opacity === 0.80, "FluxPod active core");
        else if (spec.wcid === 4000011) assert(activeModel.root.getObjectByName("solar-status-led").material.color.getHex() === 0x2fd866, "SolarPanels active LED");
        else if (spec.wcid === 4000012) assert(activeModel.root.getObjectByName("generator-exhaust-stack").position.z === 1.38, "PowerGenerator active stack");
        else if (spec.wcid === 4000013) assert(activeModel.socBars[1].material.color.getHex() === 0x00ff66, "BatteryUnit active socBars");
        else if (spec.wcid === 4000014) assert(activeModel.root.getObjectByName("sam-status-led").material.color.getHex() === 0x22ff66, "MissileTurret active LED");
        else if (spec.wcid === 4000015) assert(activeModel.antennaGroup.position.z === 1.42, "GroundRadar active mast");
        else if (spec.wcid === 4000016) assert(activeModel.root.getObjectByName("mortar-status-led").material.color.getHex() === 0x22ff66, "MortarTurret active LED");
        else if (spec.wcid === 4000017) {
          const laserGlow = activeModel.barrelGimbal.children.find((ch) => ch.material?.blending === THREE.AdditiveBlending);
          assert(laserGlow?.material.color.getHex() === 0xff2233, "HeavyLaserTurret active glow");
        }

        activeModel.dispose();
        stowedModel.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable spawn 4000010", /4000010|Flux|spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000012", /4000012|Generator|spawned/i, 8000);
      const genGuid = await live.waitUntil(async () => await live.evalInPage(`
        const g = window.__vehicles.deployables.list().find((x) => x.wcid === 4000012);
        return g ? g.guid : 0;
      `), 6000, 150, "generator spawned");
      await live.sendChatAndWait(`@deployable fuel 0x${(genGuid >>> 0).toString(16)} 1`, /refueled generator/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|Missile|spawned/i, 8000);
      const turGuid = await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.wcid === 4000014 && ((x.last?.onlineFlags ?? 0) & 0x01) !== 0);
        return d ? d.guid : 0;
      `), 8000, 200, "turret powered");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${turGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${turGuid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0 && (d.last?.powerWatts ?? 1) === 0;
      `), 6000, 150, "turret stowed & unpowered");
    }
  );

  await collector.runDual(
    "T1.IL.07",
    1,
    "IL:WindowVehicles_Logistics_API_Surface_And_NullSafety",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        const api = env.fakeWinObj.__vehicles;
        assert(api && api.trailers && api.containers && api.deployables, "core __vehicles maps present");
        assert(api.isVehicle(0xdeadbeef) === false, "isVehicle(invalid) === false");
        assert(api.trailers.get(0xdeadbeef) === null, "trailers.get(invalid) === null");
        assert(api.containers.get(0xdeadbeef) === null, "containers.get(invalid) === null");
        assert(api.containers.removeLocal(0xdeadbeef) === undefined, "containers.removeLocal(invalid) safe");
        const hitchSent = api.trailers.hitch(0xdeadbeef, 0xdeadbeef);
        assert(hitchSent === true && env.calls.vehicleTrailerAction.length === 1, "trailers.hitch dispatches C2S action cleanly");
        const origAction = env.live.sessionHandle.vehicleTrailerAction;
        env.live.sessionHandle.vehicleTrailerAction = () => { throw new Error("boom"); };
        assert(api.trailers.hitch(0xdeadbeef, 0xdeadbeef) === false, "trailers.hitch returns false on transport error");
        env.live.sessionHandle.vehicleTrailerAction = origAction;

        // When M4 palletJacks & sidelift methods are landed in index.js, verify complete surface & null safety
        if (api.palletJacks) {
          for (const fn of ["list", "get", "grab", "release", "raise", "lower", "pickGround", "dropGround", "pickContainer", "loadContainer", "toggleDeployableStow"]) {
            assert(typeof api.palletJacks[fn] === "function", `palletJacks.${fn} must be a function`);
          }
          assert(api.palletJacks.get(0xdeadbeef) === null, "palletJacks.get(invalid) === null");
          assert(api.palletJacks.grab(0xdeadbeef) === false, "palletJacks.grab(invalid) === false");
        }
        if (typeof api.trailers.sidelift === "function") {
          for (const fn of ["sidelift", "deployOutriggers", "retractOutriggers", "deployPalletJack", "stowPalletJack"]) {
            assert(typeof api.trailers[fn] === "function", `trailers.${fn} must be a function`);
          }
        }
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      const surface = await live.evalInPage(`
        const v = window.__vehicles;
        const t = v?.trailers || {};
        const pj = v?.palletJacks || {};
        return {
          hasTrailers: ["sidelift", "deployOutriggers", "retractOutriggers", "deployPalletJack", "stowPalletJack"].every((k) => typeof t[k] === "function"),
          hasPJs: ["list", "get", "grab", "release", "raise", "lower", "pickGround", "dropGround", "pickContainer", "loadContainer", "toggleDeployableStow"].every((k) => typeof pj[k] === "function"),
          invalidPj: typeof pj.get === "function" ? pj.get(0xdeadbeef) : "missing",
        };
      `);
      assert(surface.hasTrailers, "window.__vehicles.trailers missing sidelifter API methods");
      assert(surface.hasPJs, "window.__vehicles.palletJacks missing API methods");
      assert(surface.invalidPj === null, "palletJacks.get(invalid) must return null");
    }
  );
}
