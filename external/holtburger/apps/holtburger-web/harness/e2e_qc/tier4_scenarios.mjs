// harness/e2e_qc/tier4_scenarios.mjs — Tier 4 Real-World Operational Scenarios (6 scenarios).

import {
  CONTAINER_ACTION_KIND,
  DERICOS_FLAT_SITE,
  DERICOST_Y_OFFSET,
  IFF_STANDING,
  ONLINE_FLAGS,
  PALLET_JACK_ACTION_KIND,
  QcWorldSimulator,
  TRAILER_ACTION_KIND,
  VEHICLE_EVENT_KIND,
  acHeadingTransform,
  assert,
  countLights,
  getThree,
  makeQcLiveEnv,
  near,
  toCellLocal,
  tryImportVehicle,
} from "./common.mjs";

export const TIER4_METADATA = [
  { id: "T4.QC.S01", tier: 4, feature: "Scenario:Dericost_Full_Convoy_Logistics_RoundTrip", mode: "dual" },
  { id: "T4.QC.S02", tier: 4, feature: "Scenario:LeftRight_Rotated_Unpack_And_Aux_Prompt_Drill", mode: "dual" },
  { id: "T4.QC.S03", tier: 4, feature: "Scenario:MicroGrid_9Unit_PowerGate_And_AirDefense_LiveCombat", mode: "dual" },
  { id: "T4.QC.S04", tier: 4, feature: "Scenario:CrossLandblock_MicroGrid_And_Convoy_Relocation", mode: "dual" },
  { id: "T4.QC.S05", tier: 4, feature: "Scenario:CoDriver_Passenger_Lifecycle_And_LateObserver_Sync", mode: "dual" },
  { id: "T4.QC.S06", tier: 4, feature: "Scenario:Security_Access_Boundary_And_UltraClouds_VisualAudit", mode: "dual" },
];

export async function runTier4(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // S01: Dericost Full Convoy Logistics Round-Trip
  await collector.runDual(
    "T4.QC.S01",
    4,
    "Scenario:Dericost_Full_Convoy_Logistics_RoundTrip",
    async () => {
      const env = await makeQcLiveEnv({ terrainHeightAt: () => DERICOS_FLAT_SITE.z });
      try {
        const sim = new QcWorldSimulator();
        const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40", { x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z });
        sim.boardVehicle(tGuid, 1001, 0);
        sim.tractors.get(tGuid).x += 192.0; // cross Dericost landblock
        sim.exitVehicle(tGuid, 1001);
        assert(sim.tractors.get(tGuid).y >= DERICOST_Y_OFFSET, "Exited on Dericost");
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
        assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload, 0x01).ok, "Left offload on Dericost");
        sim.openContainerDoors(cGuid, true);
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
        const c = sim.containers.get(cGuid);
        const cl = toCellLocal(c.x, c.y, c.z);
        env.push({ type: "container_state", containerGuid: cGuid, containerKind: 11, doorState: 2, doorProgress: 1.0, cell: cl.cell, position: [cl.x, cl.y, cl.z], heading: 0 });
        env.tick(100);
        const surf = env.live.sessionHandle.probeContainerSurface(c.x, c.y, c.z + 1.5);
        assert(surf && Math.abs(surf.z - (c.z + 0.162)) < 1e-4, "Walkable container floor on Dericost");
        sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 20 }).ok, "Unloaded generator on Dericost");
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround).ok, "Dropped generator on Dericost");
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release).ok, "Released jack");
        assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "Re-stowed jack on rack");
        sim.openContainerDoors(cGuid, false);
        assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad, 0x02).ok, "0x02 auto-detect left reload on Dericost");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      const site = await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid, cGuid: t.mountedContainerGuid, pos: t.pos } : null;
      `), 8000, 200, "Dericost sidelifter40");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.8 }, 5000); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return Math.abs(window.__vehicles.status()?.pilot?.state?.speed ?? 0) > 0.5;`), 8000, 100, "moving on Dericost");
      await live.evalInPage(`window.__vehicles.setSticks({ handbrake: true }, 3000); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return (window.__vehicles.status()?.pilot?.state?.mode ?? -1) === 0;`), 8000, 100, "parked on Dericost");
      await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 6000, 150, "exited on Dericost");
      const trPose = await live.getTrailer(ids.tGuid);
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "left"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0 && t.sideliftSide === -1;
      }, 25000, 250, "Dericost left offload");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      const cDet = await live.getContainer(ids.cGuid);
      const surf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${cDet.pos[0]}, ${cDet.pos[1]}, ${cDet.pos[2] + 1.5}) || null;`);
      assert(surf && Math.abs(surf.z - (cDet.pos[2] + 0.162)) < 0.08, "Dericost container floor +0.162m");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} close`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 1) <= 0.05, 6000, 150, "doors closed");
      await live.movePlayerNear(trPose.pos, [-2.5, 0, 0]);
      await live.dispatchKey("KeyL", { key: "L", shiftKey: true });
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === ids.cGuid && t.sideliftPhase === 0;
      }, 25000, 250, "Dericost on-foot Shift+KeyL 0x02 left reload");
      await live.orbitCam(trPose.pos[0], trPose.pos[1], trPose.pos[2] + 2, 24, 0.8, 0.35);
      await live.hideHud();
      await new Promise((r) => setTimeout(r, 300));
      const shot = await live.captureAndVerifyShot("t4_qc_s01_dericost_convoy");
      await live.showHud();
      assert(shot.valid, "Dericost convoy shot valid");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  // S02: Left/Right + Rotated Unpack + Aux Prompt Drill
  await collector.runDual(
    "T4.QC.S02",
    4,
    "Scenario:LeftRight_Rotated_Unpack_And_Aux_Prompt_Drill",
    async () => {
      const idxMod = await tryImportVehicle("index.js");
      assert(idxMod.ok, idxMod.reason);
      const env = await makeQcLiveEnv();
      try {
        for (let aux = 1; aux <= 7; aux++) {
          env.push({ type: "event", kind: VEHICLE_EVENT_KIND.SideliftRefused, vehicle: 0x80091001, aux });
          env.tick(400 + aux * 10);
          assert(env.doc.getElementById("hb-vehicle-prompt").textContent === idxMod.mod.SIDELIFT_REFUSAL_REASONS[aux]);
          env.push({ type: "event", kind: VEHICLE_EVENT_KIND.PalletJackEvent, vehicle: 0x80093001, aux });
          env.tick(500 + aux * 10);
          assert(env.doc.getElementById("hb-vehicle-prompt").textContent === idxMod.mod.PALLET_JACK_EVENT_REASONS[aux]);
        }
      } finally {
        env.dispose();
      }
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      sim.containers.get(cGuid).mountedOnTrailerGuid = 0;
      sim.containers.get(cGuid).heading = Math.PI;
      sim.openContainerDoors(cGuid, true);
      const u = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 9 });
      const [ex, ey] = acHeadingTransform(100, 100 - 7.36, 0, -(6.058 / 2 + 0.85 + 1.5), Math.PI);
      near(u.pos[0], ex, 1e-4, "South-facing rotated unpack X");
      near(u.pos[1], ey, 1e-4, "South-facing rotated unpack Y");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid, pos: t.pos } : null;
      `), 8000, 200, "sidelifter40");
      // Trigger Aux refusal (locked twistlock offload)
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "offload", "right"); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return [...(window.__vehicles.events() || [])].some((e) => e.kind === 24 && e.aux >= 1);`), 6000, 150, "Aux kind=24 prompt");
      await live.evalInPage(`window.__vehicles.trailers.cancel ? window.__vehicles.trailers.sidelift(${ids.tGuid}, "cancel") : window.__vehicles.trailers.retractOutriggers(${ids.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 8000, 150, "retracted");
      // Left offload + 0x02 auto-detect reload
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "left"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === 0 && (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 25000, 250, "left offload");
      await live.movePlayerNear(ids.pos, [-2.5, 0, 0]);
      await live.dispatchKey("KeyL", { key: "L", shiftKey: true });
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === ids.cGuid && (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 25000, 250, "0x02 left reload");
      await live.cleanupWorld();
    }
  );

  // S03: MicroGrid 9-Unit Power Gate & AirDefense Live Combat
  await collector.runDual(
    "T4.QC.S03",
    4,
    "Scenario:MicroGrid_9Unit_PowerGate_And_AirDefense_LiveCombat",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), s = sim.allocGuid(), g = sim.allocGuid(), b = sim.allocGuid();
      const rad = sim.allocGuid(), gr = sim.allocGuid(), sam = sim.allocGuid(), mor = sim.allocGuid(), las = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: true, cargoState: {} });
      sim.deployables.set(s, { guid: s, wcid: 4000011, x: 3, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 6, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(b, { guid: b, wcid: 4000013, x: 9, y: 0, z: 0, isStowed: false, cargoState: { energy: 600000 } });
      sim.deployables.set(rad, { guid: rad, wcid: 4000002, x: 12, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(gr, { guid: gr, wcid: 4000015, x: 15, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(sam, { guid: sam, wcid: 4000014, x: 18, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.deployables.set(mor, { guid: mor, wcid: 4000016, x: 21, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(las, { guid: las, wcid: 4000017, x: 24, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      assert(!sim.tickAirDefenseFire(sam, 1, [300, 0, 120], { standing: 3, aglM: 120, distM: 300, isAir: true }).ok, "Unpowered SAM silent while FluxPod stowed");
      sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: f });
      assert(sim.tickAirDefenseFire(sam, 1, [300, 0, 120], { standing: 3, aglM: 120, distM: 300, isAir: true }).ok, "Powered SAM fires 4-round salvo");
      assert(sim.tickAirDefenseFire(mor, 2, [90, 0, 0], { standing: 3, distM: 90 }).ok, "Powered Mortar fires");
      assert(sim.tickAirDefenseFire(las, 2, [90, 0, 0], { standing: 3, distM: 90 }).ok, "Powered Laser fires (-120 kJ)");
      const dv = await tryImportVehicle("deployable_vfx.js");
      assert(dv.ok, dv.reason);
      const vfx = dv.mod.createDeployableCombatVfx({ liveScene3d: { worldRoot: new THREE.Group() }, THREE, ground: () => 0 });
      for (const evt of sim.fireEvents) vfx.handleFireEvent({ weaponKind: evt.weaponKind, muzzle: [0, 0, 2], targetPos: evt.targetPos, burstCount: evt.burstCount });
      vfx.update(0.05);
      assert(countLights(vfx.root) === 0, "Zero lights during full combat VFX");
      vfx.dispose();
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployed/i, 10000);
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 5`, /refueled/i, 8000);
      await live.evalInPage(`
        window.__qcFireEvents = [];
        const vfx = window.__vehicles?.deployables?.vfx;
        if (vfx && !vfx.__qcWrapped) {
          vfx.__qcWrapped = true;
          const orig = vfx.handleFireEvent.bind(vfx);
          vfx.handleFireEvent = (msg) => {
            try { window.__qcFireEvents.push({ weaponKind: msg?.weaponKind, energyJoules: msg?.energyJoules, target: msg?.target ?? msg?.targetGuid ?? 0, at: Date.now() }); } catch (_) {}
            return orig(msg);
          };
        }
        return true;
      `);
      const chargedEnergy = await live.waitUntil(async () => await live.evalInPage(`
        const bat = window.__vehicles.deployables.list().find((d) => d.wcid === 4000013);
        const e = bat?.last?.energyJoules ?? 0;
        return e >= 120000 ? e : null;
      `), 15000, 200, "Battery charged >= 120 kJ");
      await live.evalInPage(`window.__qcPeakEnergy = ${chargedEnergy}; return true;`);
      const p = await live.getPlayerGlobalPose();
      await live.orbitCam(p.gx, p.gy, p.z + 3, 28, 0.6, 0.38);
      await live.hideHud();
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      await sec.sendChat(`@teleloc 0x${p.landblockId.toString(16)} ${(p.lx + 30).toFixed(2)} ${p.ly.toFixed(2)} ${p.z.toFixed(2)}`);
      await sec.sendChat("@vehicle spawn jeep-mb");
      const engagement = await live.waitUntil(async () => await live.evalInPage(`
        const bat = window.__vehicles.deployables.list().find((d) => d.wcid === 4000013);
        const cur = bat?.last?.energyJoules ?? 0;
        if (cur > (window.__qcPeakEnergy ?? 0)) window.__qcPeakEnergy = cur;
        const peak = window.__qcPeakEnergy ?? 0;
        const fires = window.__qcFireEvents || [];
        const hasLaserFire = fires.some((f) => f.weaponKind === 3);
        const discharged = peak >= 120000 && cur <= peak - 100000;
        return (discharged || hasLaserFire) ? { peak, cur, hasLaserFire, firesCount: fires.length } : null;
      `), 18000, 150, "live GroundRadar -> Laser/Mortar combat");
      assert(
        engagement.hasLaserFire || engagement.cur <= engagement.peak - 100000,
        `Expected live AirDefense fire/discharge, got ${JSON.stringify(engagement)}`
      );
      await new Promise((r) => setTimeout(r, 150));
      const shot = await live.captureAndVerifyShot("t4_qc_s03_combat_vfx");
      await live.showHud();
      assert(shot.valid, "Combat VFX shot valid");
      await live.cleanupWorld();
    }
  );

  // S04: Cross-Landblock MicroGrid & Convoy Relocation
  await collector.runDual(
    "T4.QC.S04",
    4,
    "Scenario:CrossLandblock_MicroGrid_And_Convoy_Relocation",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), t = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 188, y: 100, z: 10, isStowed: true, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 196, y: 100, z: 10, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(t, { guid: t, wcid: 4000017, x: 198, y: 100, z: 10, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(t).onlineFlags & ONLINE_FLAGS.Powered) === 0, "Unpowered before FluxPod unstow");
      sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: f });
      assert((sim.deployables.get(t).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "Cross-landblock powered after SetStowed(false)");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const p = await live.getPlayerGlobalPose();
      const gxFlux = 32448 - 4.0;
      const gxTurret = 32448 + 4.0;
      const gy = 34392.0;
      await live.sendChatAndWait(`@deployable spawn 4000010 ${gxFlux.toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000012 ${(gxFlux - 2).toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000014 ${gxTurret.toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      const flux = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000010)?.guid || 0;`), 8000, 200, "FluxPod");
      await live.movePlayerNear([gxFlux, gy, p.z], [0, -1.5, 0]);
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${flux}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return ((window.__vehicles.deployables.list().find((d) => d.wcid === 4000014)?.last?.onlineFlags ?? 1) & 0x01) === 0;`), 6000, 150, "unpowered when FluxPod stowed");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${flux}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return ((window.__vehicles.deployables.list().find((d) => d.wcid === 4000014)?.last?.onlineFlags ?? 0) & 0x01) !== 0;`), 8000, 200, "cross-landblock repowered");
      await live.cleanupWorld();
    }
  );

  // S05: Co-Driver Passenger Lifecycle & Late-Observer Sync
  await collector.runDual(
    "T4.QC.S05",
    4,
    "Scenario:CoDriver_Passenger_Lifecycle_And_LateObserver_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.boardVehicle(tGuid, 1001, 0);
      sim.boardVehicle(tGuid, 1002, 1);
      sim.tractors.get(tGuid).speed = 12.0;
      assert(!sim.unhitchTrailer(tGuid, trGuid).ok, "Moving unhitch blocked");
      sim.exitVehicle(tGuid, 1001);
      sim.advanceTime(650);
      assert(!sim.tractors.get(tGuid).isDestroyed && sim.tractors.get(tGuid).seats[1] === 1002 && sim.palletJacks.get(pjGuid).stowedOnTrailerGuid === trGuid, "Co-driver & stowed jack survived > 10m");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t && t.stowedPalletJackGuid ? { vGuid: v.guid, tGuid: t.guid, pjGuid: t.stowedPalletJackGuid } : null;
      `), 8000, 200, "sidelifter40");
      const p1 = await live.getPlayerGlobalPose();
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      const targetGx = p1.gx + 3;
      const targetGy = p1.gy;
      await sec.sendChat(`@teleloc 0x${p1.landblockId.toString(16)} ${(p1.lx + 3).toFixed(2)} ${p1.ly.toFixed(2)} ${p1.z.toFixed(2)}`);
      await live.waitUntil(async () => {
        const sp = await sec.getPlayerGlobalPose();
        if (!sp || Math.hypot(sp.gx - targetGx, sp.gy - targetGy) > 5.0) return false;
        return await sec.evalInPage(`
          const pj = window.__vehicles?.palletJacks?.get?.(${ids.pjGuid});
          const vehReady = (window.__vehicles?.vehicles?.() || []).some((v) => (v.guid >>> 0) === ${ids.vGuid} && !!v.profile && !!v.params);
          return Boolean(pj && (pj.stowedOnTrailerGuid >>> 0) === ${ids.tGuid} && vehReady);
        `);
      }, 12000, 200, "late observer sees semi + stowed jack");
      const b0 = await live.evalInPage(`return window.__vehicles.board(${ids.vGuid}, 0);`);
      assert(b0?.ok, `driver board() failed: ${JSON.stringify(b0)}`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "driver seated");
      const b1 = await sec.evalInPage(`return window.__vehicles.board(${ids.vGuid}, 1);`);
      assert(b1?.ok, `co-driver board() failed: ${JSON.stringify(b1)}`);
      await live.waitUntil(async () => await sec.evalInPage(`return !!window.__vehicles.passenger;`), 10000, 150, "co-driver seated");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 6000, 150, "driver exited");
      await new Promise((r) => setTimeout(r, 2000));
      assert(await sec.evalInPage(`return !!window.__vehicles.passenger;`), "Co-driver remained seated after driver exit");
      await live.cleanupWorld();
    }
  );

  // S06: Security Access Boundary & Ultra+Clouds Visual Audit
  await collector.runDual(
    "T4.QC.S06",
    4,
    "Scenario:Security_Access_Boundary_And_UltraClouds_VisualAudit",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      assert(sim.openContainerDoors(cGuid, true).ok, "Open container doors before Action=3 Load check");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 0 }).ok, "AccessLevel=0 Load refused");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5, isDead: true }).ok, "IsDead refused");
      assert(sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5 }).ok, "Developer Load allowed");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@accountcreate qcplayer qcplayer 0", /account|created|already exists/i, 8000);
      await live.sendChatAndWait("@set-accountaccess qcplayer 0", /updated|player|access/i, 8000);
      await live.sendChatAndWait("@container spawn 20", /spawned/i, 8000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "container");
      const cHex = `0x${(c.guid >>> 0).toString(16)}`;
      await live.sendChat(`@container doors ${cHex} open`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open before Load check");
      const sec = await live.openSecondContext("qcplayer", "qcplayer", "QcPlayer");
      const qcCharName = (await sec.evalInPage('return window.__sessionHandle?.characterList?.()?.find((c) => !c.deleteTime)?.name || window.__sessionHandle?.characterList?.()?.[0]?.name || "QcPlayer";')) || "QcPlayer";
      await live.sendChat(`@teletome ${qcCharName}`);
      await live.waitUntil(async () => await sec.evalInPage(`return !!window.__vehicles?.containers?.get?.(${c.guid});`), 10000, 200, "qcplayer tracks container");
      await sec.evalInPage(`window.__sessionHandle.vehicleContainerAction(${c.guid}, 3, 0, 0, 4000010); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      assert(((await live.getContainer(c.guid))?.slots?.length ?? 0) === 0, "qcplayer AccessLevel=0 Load refused");
      await live.closeSecondContexts();

      await live.orbitCam(c.pos[0], c.pos[1], c.pos[2] + 1.5, 16, 0.7, 0.35);
      await live.hideHud();
      await new Promise((r) => setTimeout(r, 300));
      const shot = await live.captureAndVerifyShot("t4_qc_s06_ultra_clouds");
      await live.showHud();
      assert(shot.valid, "Ultra+clouds visual audit PNG valid");
      const errs = await live.checkConsoleErrors();
      assert(errs.failing.length === 0, `Non-allowlisted console/page errors: ${errs.failing.join("; ")}`);
      await live.cleanupWorld();
    }
  );
}
