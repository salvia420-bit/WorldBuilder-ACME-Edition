// harness/e2e_logistics/tier4_scenarios.mjs — Tier 4 Real-World Application Scenarios (6 Scenarios).
// Runs genuine end-to-end workflows in BOTH `--mode offline` and `--mode live`.

import {
  LOGISTICS_SPEC,
  LogisticsWorldSimulator,
  ONLINE_FLAGS,
  PALLET_JACK_ACTION_KIND,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  assert,
  makeLogisticsLiveEnv,
  near,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleWireStatsTrack,
  tryImportVehicle,
} from "./common.mjs";

export const TIER4_METADATA = [
  { id: "T4.S01", tier: 4, feature: "Scenario:Full_40ft_FOB_Deployment_And_PackUp_Loop", mode: "dual" },
  { id: "T4.S02", tier: 4, feature: "Scenario:20ft_ForwardOutpost_LeftDrop_And_RackStow", mode: "dual" },
  { id: "T4.S03", tier: 4, feature: "Scenario:40HC_Mixed_Full_Half_Pinwheel_LIFO_Clearing", mode: "dual" },
  { id: "T4.S04", tier: 4, feature: "Scenario:ISO_3874_And_3691_5_Safety_Interlock_Recovery_Drill", mode: "dual" },
  { id: "T4.S05", tier: 4, feature: "Scenario:Reload_And_StatePreservation_Convoy_Ammo_Fuel_Energy", mode: "dual" },
  { id: "T4.S06", tier: 4, feature: "Scenario:SingleButton_AutoCycle_ShiftL_ForcedTeardown_ConsoleZero", mode: "dual" },
];

export async function runTier4(collector) {
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }
  // T4.S01: Full 40ft FOB deployment & pack-up loop (sidelifter40)
  await collector.runDual(
    "T4.S01",
    4,
    "Scenario:Full_40ft_FOB_Deployment_And_PackUp_Loop",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");

      // 1. Drive 20m & park
      assert(sim.canDriveTractor(tGuid).ok, "can drive coupled rig");
      sim.tractors.get(tGuid).y += 20;
      sim.trailers.get(trGuid).y += 20;

      // 2. Step-by-step sidelift offload right
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00).ok, "outriggers planted");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock).ok, "twistlocks unlocked");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload, 0x00).ok, "40ft container offloaded");
      near(sim.containers.get(cGuid).x - sim.trailers.get(trGuid).x, 3.85, 1e-4, "40ft landed at +3.85m");

      // 3. Open doors & unstow jack
      assert(sim.openContainerDoors(cGuid, true).ok, "270° doors & 0.85m ramp open");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack).ok, "jack deployed from rack");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 }).ok, "jack grabbed");

      // 4. Unload FOB units (rear-to-front LIFO: 20, 18, 16, 0) & activate on MicroGrid
      const deployedGuids = [];
      for (const slot of [20, 18, 16, 0]) {
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: slot, subSlot: 0 }).ok, `unload slot ${slot}`);
        const drop = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
        assert(drop.ok, `drop slot ${slot}`);
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: drop.deployableGuid });
        deployedGuids.push(drop.deployableGuid);
      }
      assert(sim.containers.get(cGuid).slots.length === 0, "container emptied");
      const turret = [...sim.deployables.values()].find((d) => d.wcid === 4000014);
      assert(turret && (turret.onlineFlags & ONLINE_FLAGS.Powered) !== 0, "MissileTurret powered on active MicroGrid");

      // 5. Pack up FOB: stow -> pick -> deepest-first reload (0, 16, 18, 20)
      const loadOrder = [0, 16, 18, 20];
      for (let i = 0; i < deployedGuids.length; i++) {
        const dg = deployedGuids[i];
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: dg });
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dg }).ok, "pick stowed unit");
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: loadOrder[i], subSlot: 0 }).ok, `reload slot ${loadOrder[i]}`);
      }
      assert(sim.containers.get(cGuid).slots.length === 4, "all 4 FOB units reloaded");

      // 6. Release & stow jack -> close doors -> sidelift reload -> retract -> drive
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release).ok, "jack released");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "jack re-stowed on rack");
      assert(sim.openContainerDoors(cGuid, false).ok, "doors closed");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftLoad, 0x00).ok, "container reloaded");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.RetractOutriggers).ok, "outriggers retracted");
      assert(sim.canDriveTractor(tGuid).ok, "convoy ready to depart");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.evalInPage(`window.__sessionHandle?.setSkyTimeOverride?.(0.5); return true;`);
      await live.sendChatAndWait("@tele 41.35N 33.33E", /Position:\s*\[Cell:/i, 10000);
      await new Promise((r) => setTimeout(r, 1000));

      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const rig = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return v && t && c ? { vGuid: v.guid, tGuid: t.guid, cGuid: c.guid, pos: [...t.pos] } : null;
      `), 10000, 250, "sidelifter40");

      await live.hideHud();
      await live.orbitCam(rig.pos[0], rig.pos[1], rig.pos[2] + 1.5, 18, 45, 20);
      await live.waitUntil(async () => await live.evalInPage(`
        const ps = window.__portalSpace;
        if (ps && ps.state !== 0) return false;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return true;
      `), 10000, 150, "portalSpace idle & 2 rAF");
      await live.captureAndVerifyShot("t4_s01a_coupled_road");
      await live.showHud();

      // Deploy outriggers -> unlock -> offload
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${rig.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(rig.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${rig.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(rig.tGuid))?.twistlocksLocked === false, 4000, 150, "twistlocks unlocked");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${rig.tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(rig.tGuid))?.sideliftPhase === 6, 10000, 150, "midswing");
      await live.hideHud();
      await live.captureAndVerifyShot("t4_s01b_sidelift_midswing");
      await live.showHud();

      await live.waitUntil(async () => {
        const t = await live.getTrailer(rig.tGuid);
        return t && t.mountedContainerGuid === 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0);
      }, 20000, 250, "offload landed");
      await live.evalInPage(`window.__vehicles.containers.action(${rig.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${rig.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => {
        const c = await live.getContainer(rig.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "doors open & jack ready");

      const pjInit = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjInit.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const cOff1 = await live.getContainer(rig.cGuid);
      const ch1 = cOff1?.heading ?? 0;
      const dropSpot1 = [
        cOff1.pos[0] + Math.cos(ch1) * 2.2 - Math.sin(ch1) * 9.0,
        cOff1.pos[1] - Math.sin(ch1) * 2.2 - Math.cos(ch1) * 9.0,
        cOff1.pos[2],
      ];
      // Peel outer slot 6 (4000002) aside to expose slot 4 (4000014 MissileTurret)
      const slot6Pos = await live.getSlotWorldPos(rig.cGuid, 6, 0);
      await live.movePalletJackTo(pjGuid, slot6Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${rig.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "peeled slot 6");
      await live.movePalletJackTo(pjGuid, dropSpot1);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "dropped slot 6 aside");

      const slot4Pos = await live.getSlotWorldPos(rig.cGuid, 4, 0);
      await live.movePalletJackTo(pjGuid, slot4Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${rig.cGuid}, 4, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 4000014, 6000, 150, "jack carrying");
      await live.hideHud();
      await live.captureAndVerifyShot("t4_s01c_jack_on_ramp");
      await live.showHud();

      await live.movePalletJackTo(pjGuid, [dropSpot1[0] + 1.8, dropSpot1[1], dropSpot1[2]]);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      const depInfo = await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.wcid === 4000014);
        if (!d) return null;
        const p = d.model?.root?.position ? [d.model.root.position.x, d.model.root.position.y, d.model.root.position.z] : (d.pos || d.rawPos);
        return p ? { guid: d.guid, pos: p } : null;
      `), 6000, 150, "deployed on ground");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${depInfo.guid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${depInfo.guid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) === 0;
      `), 5000, 150, "FOB unit activated");
      await live.hideHud();
      await live.captureAndVerifyShot("t4_s01d_fob_deployed");
      await live.showHud();

      // Pack-up & reload loop: stow -> pickGround -> loadContainer -> rack stow -> close doors -> sidelift load -> retract outriggers
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${depInfo.guid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const d = window.__vehicles.deployables.list().find((x) => x.guid === ${depInfo.guid});
        return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
      `), 5000, 150, "FOB unit re-stowed");
      await live.movePalletJackTo(pjGuid, depInfo.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${depInfo.guid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "re-picked FOB unit");
      await live.movePalletJackTo(pjGuid, slot4Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.loadContainer(${rig.cGuid}, 4, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "re-loaded into slot 4");
      const trPose = await live.getTrailer(rig.tGuid);
      await live.movePalletJackTo(pjGuid, trPose.pos, { stopDistM: 2.0 });
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "jack released");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${rig.tGuid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(rig.tGuid))?.stowedPalletJackGuid === pjGuid, 6000, 150, "jack stowed on rack");
      await live.evalInPage(`window.__vehicles.containers.action(${rig.cGuid}, 2); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(rig.cGuid))?.doorProgress ?? 1) <= 0.02, 6000, 150, "doors closed");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${rig.tGuid}, "load", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(rig.tGuid);
        return t && t.mountedContainerGuid !== 0 && (t.sideliftPhase === 2 || t.sideliftPhase === 0);
      }, 24000, 300, "container reloaded");
      await live.evalInPage(`window.__vehicles.trailers.retractOutriggers(${rig.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(rig.tGuid))?.sideliftPhase === 0, 6000, 150, "outriggers retracted");
    }
  );

  // T4.S02: 20ft forward-outpost rapid deployment on left-side drop (sidelifter20)
  await collector.runDual(
    "T4.S02",
    4,
    "Scenario:20ft_ForwardOutpost_LeftDrop_And_RackStow",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      near(sim.trailers.get(trGuid).craneSpanY, 2.9265, 1e-4, "20ft craneSpanY");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload, 0x01).ok, "left-side AutoOffload");
      near(sim.containers.get(cGuid).x - sim.trailers.get(trGuid).x, -3.85, 1e-4, "left drop at -3.85m");
      assert(sim.openContainerDoors(cGuid, true).ok, "doors open");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack).ok, "jack deployed");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 }).ok, "grab");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 9, subSlot: 0 }).ok, "unload RadarStation");
      const drop = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
      assert(drop.ok && sim.deployables.get(drop.deployableGuid).wcid === 4000002, "RadarStation dropped");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: drop.deployableGuid });
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release).ok, "release");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "jack re-stowed on rack");
      assert(sim.canDriveTractor(tGuid).ok, "empty chassis departs cleanly");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid, tx: t.pos[0], ty: t.pos[1], th: t.heading || 0 } : null;
      `), 10000, 200, "sidelifter20");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "left"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "left drop complete");
      const landed = (await live.getContainer(ids.cGuid)).pos;
      const dx = landed[0] - ids.tx;
      const dy = landed[1] - ids.ty;
      const lateralX = dx * Math.cos(ids.th) - dy * Math.sin(ids.th);
      assert(lateralX <= -3.4 && lateralX >= -4.3, `Left drop lateral offset ${lateralX}m`);
      await live.hideHud();
      await live.captureAndVerifyShot("t4_s02_left_drop_20ft");
      await live.showHud();
    }
  );

  // T4.S03: 40HC mixed full & half-pallet pinwheel LIFO clearing
  await collector.runDual(
    "T4.S03",
    4,
    "Scenario:40HC_Mixed_Full_Half_Pinwheel_LIFO_Clearing",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40hc");
      assert(sim.containers.get(cGuid).kind === 12, "40HC container");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "40HC offload");
      assert(sim.openContainerDoors(cGuid, true).ok, "40HC doors open");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack).ok, "jack deployed");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 }).ok, "grabbed");

      // Attempt blocked deep half-pallet (slot 2) before clearing rear blockers (slots 18 & 20)
      const blocked = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 2, subSlot: 0 });
      assert(!blocked.ok && /LIFO/i.test(blocked.reason), "inner slot 2 blocked before rear tier cleared");

      // Clear outer rear blockers (20, 18) -> inner slot 2 (BatteryUnit + GroundRadar) unlocks
      for (const [s, sub] of [[20, 0], [18, 0], [2, 1], [2, 0], [0, 0]]) {
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: s, subSlot: sub }).ok, `pick (${s},${sub})`);
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround).ok, `stage (${s},${sub})`);
      }
      assert(sim.containers.get(cGuid).slots.length === 0, "40HC fully cleared");

      // Verify deepest-first reload ordering (+Y -> -Y)
      const loadOrder = oracleComputeReachableLoadSlots(12, [], "half");
      assert(loadOrder[0].y >= loadOrder[loadOrder.length - 1].y, "40HC deepest-first sorts +Y -> -Y");
      assert(loadOrder[0].slotIndex === 0 || loadOrder[0].slotIndex === 1, "40HC deepest-first starts at front bulkhead");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40hc", /sidelifter40hc|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 10000, 200, "40hc");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offloaded");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.98, 6000, 150, "40hc open");
      await live.hideHud();
      await live.captureAndVerifyShot("t4_s03_40hc_pinwheel_lifo");
      await live.showHud();
    }
  );

  // T4.S04: ISO 3874 & 3691-5 safety interlock recovery drill
  await collector.runDual(
    "T4.S04",
    4,
    "Scenario:ISO_3874_And_3691_5_Safety_Interlock_Recovery_Drill",
    async () => {
      const env = await makeLogisticsLiveEnv();
      const osdMod = await tryImportVehicle("osd.js");
      const osd = osdMod.mod.createVehicleOsd({ document: env.doc });
      try {
        const sim = new LogisticsWorldSimulator();
        const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");

        // 1. Moving tractor blocks outriggers
        sim.tractors.get(tGuid).speed = 3.0;
        const rMove = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers);
        assert(!rMove.ok, "moving tractor refused");
        sim.tractors.get(tGuid).speed = 0;

        // 2. Plant outriggers -> driving blocked
        assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers).ok, "outriggers planted");
        assert(!sim.canDriveTractor(tGuid).ok, "driving blocked while outriggers planted");

        // 3. Locked twistlocks block manual offload -> unlock -> open doors block offload -> close -> slope > 6° blocks -> flatten -> offload
        const rTw = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload);
        assert(!rTw.ok, "locked twistlocks refused");
        osd.prompt(rTw.reason);
        assert(env.doc.getElementById("hb-vehicle-prompt")?.textContent.includes("ISO 3874"), "OSD shows ISO 3874 prompt");
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);

        sim.openContainerDoors(cGuid, true);
        assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload).ok, "open doors refused");
        sim.openContainerDoors(cGuid, false);

        sim.trailers.get(trGuid).slopeCos = 0.990; // ~8 deg > 6 deg
        assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload).ok, "steep slope refused");
        sim.trailers.get(trGuid).slopeCos = 0.999;

        // 4. Mounted container blocks jack entry -> offload -> open doors -> blocked LIFO refused
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
        assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 20, subSlot: 0 }).ok, "mounted entry refused");
        assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload).ok, "offload succeeded after clearing all ISO 3874 interlocks");

        sim.openContainerDoors(cGuid, true);
        assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 0, subSlot: 0 }).ok, "blocked LIFO slot 0 refused");

        // 5. Drop unit, activate, verify active stow refusal & raised forks refusal -> recover
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 20, subSlot: 0 }).ok, "outer slot 20 ok");
        const drop = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: drop.deployableGuid });
        assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: drop.deployableGuid }).ok, "active deployable refused");
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: drop.deployableGuid });
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.RaiseForks);
        assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: drop.deployableGuid }).ok, "raised forks refused");
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LowerForks);
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: drop.deployableGuid }).ok, "recovered & picked cleanly");
      } finally {
        osd.dispose();
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "t");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const el = document.getElementById("hb-vehicle-prompt");
        return el && el.style.display !== "none" && /ISO|twistlock/i.test(el.textContent || "");
      `), 6000, 150, "OSD interlock prompt");
      await live.captureAndVerifyShot("t4_s04_osd_interlock_prompt");
    }
  );

  // T4.S05: Reload & state-preservation convoy (Ammo / Fuel / Energy)
  await collector.runDual(
    "T4.S05",
    4,
    "Scenario:Reload_And_StatePreservation_Convoy_Ammo_Fuel_Energy",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "initial offload");
      sim.openContainerDoors(cGuid, true);
      sim.containers.get(cGuid).slots = [];
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      const baseline = [
        { wcid: 4000014, kind: 6, slot: 0, cargoState: { ammo: 1, fuel: 0, energy: 0 } },
        { wcid: 4000012, kind: 4, slot: 1, cargoState: { ammo: 0, fuel: 47.25, energy: 0 } },
        { wcid: 4000013, kind: 5, slot: 2, cargoState: { ammo: 0, fuel: 0, energy: 315000 } },
      ];
      for (const b of baseline) {
        const dg = sim.allocGuid();
        sim.deployables.set(dg, { guid: dg, wcid: b.wcid, kind: b.kind, x: 100, y: 100, z: 10, isStowed: true, onlineFlags: ONLINE_FLAGS.Stowed, elevationM: 0, cargoState: { ...b.cargoState } });
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dg });
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: b.slot, subSlot: 0 });
      }
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack);
      sim.openContainerDoors(cGuid, false);
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad).ok, "reload onto convoy");

      // Relocate convoy 75m
      sim.tractors.get(tGuid).y += 75;
      sim.trailers.get(trGuid).y += 75;
      sim.containers.get(cGuid).y += 75;

      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "offload at new FOB");
      sim.openContainerDoors(cGuid, true);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });
      for (const b of [...baseline].reverse()) {
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: b.slot, subSlot: 0 }).ok, `unload ${b.slot}`);
        const d = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
        const cs = sim.deployables.get(d.deployableGuid).cargoState;
        assert(cs.ammo === b.cargoState.ammo, "Ammo preserved after 75m convoy");
        near(cs.fuel, b.cargoState.fuel, 1e-4, "Fuel preserved after 75m convoy");
        near(cs.energy, b.cargoState.energy, 1e-1, "Energy preserved after 75m convoy");
      }
    },
    async (live) => {
      await live.cleanupWorld();
      const presetMsg = await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const gm = presetMsg.match(/tractor\s+0x([0-9a-f]+)\s*\+\s*trailer\s+0x([0-9a-f]+)\s*\+\s*container\s+0x([0-9a-f]+)/i);
      const wantV = gm ? (parseInt(gm[1], 16) >>> 0) : 0;
      const wantT = gm ? (parseInt(gm[2], 16) >>> 0) : 0;
      const wantC = gm ? (parseInt(gm[3], 16) >>> 0) : 0;
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = ${wantV}
          ? window.__vehicles.vehicles().find((x) => (x.guid >>> 0) === ${wantV})
          : window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = ${wantT}
          ? window.__vehicles.trailers.list().find((x) => (x.guid >>> 0) === ${wantT})
          : window.__vehicles.trailers.list()[0];
        const c = ${wantC}
          ? window.__vehicles.containers.list().find((x) => (x.guid >>> 0) === ${wantC})
          : window.__vehicles.containers.list()[0];
        return v && t && c ? { vGuid: v.guid, tGuid: t.guid, cGuid: c.guid } : null;
      `), 10000, 200, "convoy");
      const startPose = await live.getVehiclePose(ids.vGuid);
      assert(startPose && Array.isArray(startPose.pos), "convoy start pose available");

      // 1. Unload slot 20 -> record Ammo/Fuel/Energy -> stow -> reload -> stow jack -> close doors -> autoLoad onto convoy
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "initial offload");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "doors open & jack deployed");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      const cOff5 = await live.getContainer(ids.cGuid);
      const ch5 = cOff5?.heading ?? 0;
      const dropSpot5 = [
        cOff5.pos[0] + Math.cos(ch5) * 2.2 - Math.sin(ch5) * 9.0,
        cOff5.pos[1] - Math.sin(ch5) * 2.2 - Math.cos(ch5) * 9.0,
        cOff5.pos[2],
      ];
      // Peel outer slot 6 (4000002) aside to expose slot 4 (4000014 MissileTurret with Ammo=4)
      const slot6 = await live.getSlotWorldPos(ids.cGuid, 6, 0);
      await live.movePalletJackTo(pjGuid, slot6);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "peeled slot 6");
      await live.movePalletJackTo(pjGuid, dropSpot5);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "dropped slot 6 aside");

      const slot4 = await live.getSlotWorldPos(ids.cGuid, 4, 0);
      await live.movePalletJackTo(pjGuid, slot4);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 4, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 4000014, 6000, 150, "picked slot 4");
      await live.movePalletJackTo(pjGuid, [dropSpot5[0] + 1.8, dropSpot5[1], dropSpot5[2]]);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      const d1 = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((x) => x.wcid === 4000014) || null;`), 6000, 150, "dropped deployable");
      const before = {
        guid: d1.guid,
        wcid: d1.wcid,
        ammo: d1.last?.ammo ?? d1.last?.ammoRemaining ?? 0,
        fuelSec: d1.last?.fuelSec ?? d1.last?.fuelRemaining ?? 0,
        energyJoules: d1.last?.energyJoules ?? d1.last?.energyStoredJoules ?? 0,
      };
      if (((d1.last?.onlineFlags ?? 0) & 0x10) === 0) {
        await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${before.guid}); return true;`);
        await live.waitUntil(async () => await live.evalInPage(`
          const d = window.__vehicles.deployables.list().find((x) => x.guid === ${before.guid});
          return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
        `), 5000, 150, "stowed before convoy");
      }
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${before.guid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === before.wcid, 6000, 150, "picked stowed unit");
      const slot20 = await live.getSlotWorldPos(ids.cGuid, 20, 0);
      await live.movePalletJackTo(pjGuid, slot20);
      await live.evalInPage(`window.__vehicles.palletJacks.loadContainer(${ids.cGuid}, 20, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "loaded slot 20");
      const trPose = await live.getTrailer(ids.tGuid);
      await live.movePalletJackTo(pjGuid, trPose.pos, { stopDistM: 2.0 });
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "released");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${ids.tGuid}, ${pjGuid}); window.__vehicles.containers.action(${ids.cGuid}, 2); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 1) <= 0.02, 6000, 150, "doors closed");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoLoad", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0;
      }, 24000, 300, "autoLoad onto convoy");

      // 2. Drive convoy > 5 m
      await live.boardAndWait(ids.vGuid, 0);
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.9, yaw: 0 }, 4500); return true;`);
      await new Promise((r) => setTimeout(r, 4600));
      await live.evalInPage(`window.__vehicles.clearSticks(); window.__vehicles.setSticks({ land: 1 }, 1200); return true;`);
      await live.waitUntil(async () => {
        const p = await live.getVehiclePose(ids.vGuid);
        return p && Math.abs(p.speed ?? 0) < 0.08;
      }, 6000, 150, "convoy stopped");
      await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
      const afterPose = await live.getVehiclePose(ids.vGuid);
      await live.evalInPage(`window.__vehicles.exit(0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 5000, 150, "convoy exited");
      await new Promise((r) => setTimeout(r, 400));
      const moved = Math.hypot(afterPose.pos[0] - startPose.pos[0], afterPose.pos[1] - startPose.pos[1]);
      assert(moved > 5.0, `Convoy relocated (${moved}m)`);

      // 3. Offload at destination & verify Ammo/Fuel/Energy preserved
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offload after convoy");
      const cDest = await live.getContainer(ids.cGuid);
      if (cDest?.pos) await live.movePlayerNear(cDest.pos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pj2 = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "doors open at destination");
      const pj2Pose = await live.getPalletJack(pj2);
      await live.movePlayerNear(pj2Pose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pj2}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pj2))?.operatorGuid !== 0, 5000, 150, "grabbed at destination");
      await live.movePalletJackTo(pj2, await live.getSlotWorldPos(ids.cGuid, 20, 0));
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 20, 0, ${pj2}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pj2))?.carriedWcid !== 0, 6000, 150, "picked at destination");
      const chDest = cDest?.heading ?? 0;
      const dropSpotDest = [
        cDest.pos[0] + Math.cos(chDest) * 2.2 - Math.sin(chDest) * 9.0,
        cDest.pos[1] - Math.sin(chDest) * 2.2 - Math.cos(chDest) * 9.0,
        cDest.pos[2],
      ];
      await live.movePalletJackTo(pj2, dropSpotDest);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pj2}); return true;`);
      const d2 = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((x) => x.wcid === ${before.wcid}) || null;`), 6000, 150, "dropped at destination");
      assert(d2.wcid === before.wcid, `WCID preserved (${d2.wcid} === ${before.wcid})`);
      const afterAmmo = d2.last?.ammo ?? d2.last?.ammoRemaining ?? 0;
      const afterFuel = d2.last?.fuelSec ?? d2.last?.fuelRemaining ?? 0;
      const afterEnergy = d2.last?.energyJoules ?? d2.last?.energyStoredJoules ?? 0;
      assert(afterAmmo === before.ammo, `Ammo preserved across convoy (${afterAmmo} === ${before.ammo})`);
      near(afterFuel, before.fuelSec, 0.05, "Fuel preserved across convoy");
      near(afterEnergy, before.energyJoules, 1.0, "Energy preserved across convoy");
    }
  );

  // T4.S06: Single-button Auto-Cycle (Shift+L), forced teardown & clean console gate
  await collector.runDual(
    "T4.S06",
    4,
    "Scenario:SingleButton_AutoCycle_ShiftL_ForcedTeardown_ConsoleZero",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "AutoOffload completed");
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.Idle, "AutoOffload returned to Idle");

      // Open doors refuse AutoLoad -> close doors -> AutoLoad succeeds
      sim.openContainerDoors(cGuid, true);
      assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad).ok, "AutoLoad refuses open doors");
      sim.openContainerDoors(cGuid, false);
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad).ok, "AutoLoad completes cleanly");

      // Wire stats sanity across entire simulation
      const stats = oracleWireStatsTrack(sim.wireOpcodes);
      assert(stats.received[15] > 0 && stats.received[16] > 0 && stats.unknown === 0, "HBV1 v7 wire stats valid");

      // Forced teardown in makeLogisticsLiveEnv leaves 0 worldRoot children & 0 listeners
      const env = await makeLogisticsLiveEnv();
      env.live.sessionHandle.setVehicleSeat(pjGuid, 0, 0, 0, 0, 0);
      env.live.vehicles.onTeleport();
      env.dispose();
      assert(env.worldRoot.children.length === 0, "worldRoot cleaned up on dispose");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "trailer");
      await live.dispatchKey("KeyL", { shiftKey: true });
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "Shift+L AutoOffload");
      await live.dispatchKey("KeyL", { shiftKey: true });
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0;
      }, 24000, 300, "Shift+L AutoLoad");
      await live.cleanupWorld();
      const errs = await live.checkConsoleErrors();
      assert(errs.failing.length === 0, `Non-allowlisted console errors: ${errs.failing.join("; ")}`);
    }
  );
}
