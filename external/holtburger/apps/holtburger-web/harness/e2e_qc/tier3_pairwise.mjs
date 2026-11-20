// harness/e2e_qc/tier3_pairwise.mjs — Tier 3 Cross-Feature Pairwise Combinatorial (12 checks >= 8).

import {
  CONTAINER_ACTION_KIND,
  DEPLOYABLE_KIND,
  DERICOS_FLAT_SITE,
  DERICOST_Y_OFFSET,
  IFF_STANDING,
  LOGISTICS_SPEC,
  ONLINE_FLAGS,
  PALLET_JACK_ACTION_KIND,
  PALLET_JACK_FLAGS,
  QcWorldSimulator,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  VEHICLE_EVENT_KIND,
  acHeadingTransform,
  angleDiff,
  assert,
  countLights,
  decodePalletJackState,
  decodeVehicleEvent,
  encodePalletJackState,
  encodeVehicleEvent,
  getThree,
  makeQcLiveEnv,
  near,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  wrapPi,
} from "./common.mjs";

export const TIER3_METADATA = [
  { id: "T3.QC.01", tier: 3, feature: "Pairwise:Dericost_x_Semi_Sidelifter_Container_Jack", mode: "dual" },
  { id: "T3.QC.02", tier: 3, feature: "Pairwise:LeftRight_x_RotatedRig_x_SlotY", mode: "dual" },
  { id: "T3.QC.03", tier: 3, feature: "Pairwise:RotatedContainer_x_Unpack_x_MicroGrid", mode: "dual" },
  { id: "T3.QC.04", tier: 3, feature: "Pairwise:Generator_Solar_Battery_x_Laser_Mortar", mode: "dual" },
  { id: "T3.QC.05", tier: 3, feature: "Pairwise:Dericost_x_RadarStationStow_x_MissileTurret", mode: "dual" },
  { id: "T3.QC.06", tier: 3, feature: "Pairwise:MovingTractor_x_Trailer_x_Sidelift_x_Doors", mode: "dual" },
  { id: "T3.QC.07", tier: 3, feature: "Pairwise:CrossLandblock_x_CoDriver_x_StowedJack", mode: "dual" },
  { id: "T3.QC.08", tier: 3, feature: "Pairwise:StowedJack_x_LateObserver_x_Dericost", mode: "dual" },
  { id: "T3.QC.09", tier: 3, feature: "Pairwise:CrossLandblock_FluxPod_x_SetStowed_x_Turret", mode: "dual" },
  { id: "T3.QC.10", tier: 3, feature: "Pairwise:AuxEvents_x_PromptHUD_x_WireFallback", mode: "offline" },
  { id: "T3.QC.11", tier: 3, feature: "Pairwise:LoadAccess_x_CapPilot_Dead_Seated", mode: "dual" },
  { id: "T3.QC.12", tier: 3, feature: "Pairwise:GroundFx_Headlights_x_RotatedHeadings_x_Dericost", mode: "offline" },
];

export async function runTier3(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // T3.QC.01
  await collector.runDual(
    "T3.QC.01",
    3,
    "Pairwise:Dericost_x_Semi_Sidelifter_Container_Jack",
    async () => {
      const env = await makeQcLiveEnv({ terrainHeightAt: () => DERICOS_FLAT_SITE.z });
      try {
        const sim = new QcWorldSimulator();
        const { tGuid, trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40", { x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z });
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
        sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
        sim.openContainerDoors(cGuid, true);
        const c = sim.containers.get(cGuid);
        const cl = toCellLocal(c.x, c.y, c.z);
        assert((cl.cell & 0x8000) !== 0, "Offloaded container on Dericost cell");
        env.push({ type: "container_state", containerGuid: cGuid, containerKind: 11, doorState: 2, doorProgress: 1.0, cell: cl.cell, position: [cl.x, cl.y, cl.z], heading: 0 });
        env.tick(100);
        const surf = env.live.sessionHandle.probeContainerSurface(c.x, c.y, c.z + 1.5);
        assert(surf && surf.zone === "floor" && Math.abs(surf.z - (c.z + 0.162)) < 1e-4, "Dericost floor +0.162m walkable");
        sim.tractors.get(tGuid).seats = [1001, 0];
        sim.exitVehicle(tGuid, 1001);
        assert(sim.tractors.get(tGuid).y >= DERICOST_Y_OFFSET && sim.palletJacks.get(pjGuid).y >= DERICOST_Y_OFFSET, "Tractor & jack stay on Dericost");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "sidelifter40 on Dericost");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === 0 && (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 25000, 250, "Dericost offload");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => p.stowedOnTrailerGuid === 0) || null;`), 6000, 150, "pj deployed");
      assert(pj.pos[1] >= DERICOST_Y_OFFSET, "Pallet jack deployed on Dericost");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  // T3.QC.02
  await collector.runDual(
    "T3.QC.02",
    3,
    "Pairwise:LeftRight_x_RotatedRig_x_SlotY",
    async () => {
      for (const h of [Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        for (const side of [-1, 1]) {
          const [wx, wy] = acHeadingTransform(100, 200, side * 3.85, 2.9295, h);
          assert(Number.isFinite(wx) && Number.isFinite(wy) && Math.hypot(wx - 100, wy - 200) > 4.5, "Rotated outreach + slotY world probe valid");
        }
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid, pos: t.pos } : null;
      `), 8000, 200, "sidelifter20");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "left"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === 0 && (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 25000, 250, "left offload");
      await live.movePlayerNear(ids.pos, [-2.5, 0, 0]);
      await live.dispatchKey("KeyL", { key: "L", shiftKey: true });
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === ids.cGuid && (await live.getTrailer(ids.tGuid))?.sideliftPhase === 0, 25000, 250, "0x02 left reload");
      await live.cleanupWorld();
    }
  );

  // T3.QC.03
  await collector.runDual(
    "T3.QC.03",
    3,
    "Pairwise:RotatedContainer_x_Unpack_x_MicroGrid",
    async () => {
      const sim = new QcWorldSimulator();
      const cGuid = sim.allocGuid();
      sim.containers.set(cGuid, {
        guid: cGuid, kind: 10, wcid: 4000020, x: 200, y: 300, z: 10, heading: Math.PI / 2,
        mountedOnTrailerGuid: 0, doorState: 2, doorProgress: 1.0,
        slots: [
          { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2, cargoState: {} },
          { slotIndex: 2, subSlot: 0, cargoWcid: 4000011, palletSize: 2, cargoState: {} },
          { slotIndex: 4, subSlot: 0, cargoWcid: 4000014, palletSize: 2, cargoState: { ammo: 4 } },
        ],
      });
      const uF = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 0 });
      const uS = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 2 });
      const uT = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 4 });
      assert(uF.ok && uS.ok && uT.ok, "All 3 unpacked from rotated container");
      assert((sim.deployables.get(uT.dGuid).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "Turret powered by unpacked FluxPod + Solar");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const h = Math.PI / 2;
      const p0 = await live.getPlayerGlobalPose();
      const qw = Math.cos(-h / 2);
      const qz = Math.sin(-h / 2);
      await live.sendChat(`@teleloc 0x${p0.landblockId.toString(16)} ${p0.lx.toFixed(2)} ${p0.ly.toFixed(2)} ${p0.z.toFixed(2)} ${qw.toFixed(6)} 0 0 ${qz.toFixed(6)}`);
      const p = await live.waitUntil(async () => {
        const cur = await live.getPlayerGlobalPose();
        return cur && Math.abs(angleDiff(cur.heading, h)) < 0.2 ? cur : null;
      }, 8000, 150, "player rotated to +pi/2");
      await live.sendChatAndWait(`@container spawn 20 ${p.gx.toFixed(2)} ${(p.gy + 6).toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "rotated container");
      const cDet = await live.getContainer(cGuid);
      assert(
        Math.abs(angleDiff(cDet.heading, h)) < 0.25 && Math.abs(wrapPi(cDet.heading)) > 0.5,
        `Expected rotated container heading ~${h.toFixed(2)}, got ${cDet.heading}`
      );
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.evalInPage(`
        window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 0, 0, 4000010);
        window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 2, 0, 4000011);
        window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 4, 0, 4000012);
        window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 6, 0, 4000014);
        return true;
      `);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.slots?.length ?? 0) >= 4, 6000, 150, "4 slots loaded");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} all`, /unpacked/i, 10000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 6000, 150, "unpacked generator");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      const powered = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.deployables.list().find((d) => d.wcid === 4000014);
        return t && (t.last?.onlineFlags & 0x03) === 0x03 ? true : false;
      `), 8000, 200, "unpacked MicroGrid powered");
      assert(powered, "Rotated unpacked MicroGrid powered");
      await live.sendChat("@teleloc 0xA9B30002 19.20 24.00 94.00");
      await live.cleanupWorld();
    }
  );

  // T3.QC.04
  await collector.runDual(
    "T3.QC.04",
    3,
    "Pairwise:Generator_Solar_Battery_x_Laser_Mortar",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), s = sim.allocGuid(), b = sim.allocGuid(), m = sim.allocGuid(), l = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 4, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(s, { guid: s, wcid: 4000011, x: 8, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(b, { guid: b, wcid: 4000013, x: 12, y: 0, z: 0, isStowed: false, cargoState: { energy: 240000 } });
      sim.deployables.set(m, { guid: m, wcid: 4000016, x: 16, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(l, { guid: l, wcid: 4000017, x: 20, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      assert(sim.tickAirDefenseFire(m, 99, [90, 0, 0], { standing: IFF_STANDING.Hostile, distM: 90 }).ok, "Mortar fired");
      assert(sim.tickAirDefenseFire(l, 99, [90, 0, 0], { standing: IFF_STANDING.Hostile, distM: 90 }).ok, "Laser fired");
      assert(sim.deployables.get(b).cargoState.energy === 120000, "Battery reduced 240 kJ -> 120 kJ");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployed/i, 10000);
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
        return (discharged || hasLaserFire) ? { peak, cur, hasLaserFire } : null;
      `), 18000, 150, "laser discharge");
      assert(
        engagement.hasLaserFire || engagement.cur <= engagement.peak - 100000,
        `Battery did not discharge during live Laser engagement: ${JSON.stringify(engagement)}`
      );
      await live.cleanupWorld();
    }
  );

  // T3.QC.05
  await collector.runDual(
    "T3.QC.05",
    3,
    "Pairwise:Dericost_x_RadarStationStow_x_MissileTurret",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), rad = sim.allocGuid(), sam = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: DERICOS_FLAT_SITE.gx + 4, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(rad, { guid: rad, wcid: 4000002, x: DERICOS_FLAT_SITE.gx + 8, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: {} });
      sim.deployables.set(sam, { guid: sam, wcid: 4000014, x: DERICOS_FLAT_SITE.gx + 12, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert(sim.tickAirDefenseFire(sam, 77, [DERICOS_FLAT_SITE.gx + 300, DERICOS_FLAT_SITE.gy, DERICOS_FLAT_SITE.z + 100], { standing: 3, aglM: 100, distM: 300, isAir: true }).ok, "Dericost SAM fired");
      sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: rad });
      assert((sim.deployables.get(rad).onlineFlags & ONLINE_FLAGS.Stowed) !== 0, "RadarStation stowed on Dericost");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployed/i, 10000);
      await live.sendChat("@teleloc 0xA6908025 114.00 96.00 278.00");
      await live.waitUntil(async () => {
        const p = await live.getPlayerGlobalPose();
        return p && Math.abs(p.lx - 114.0) <= 2.0 ? p : null;
      }, 6000, 150, "clear of base deployables");
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const rad = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000002) || null;`), 8000, 200, "RadarStation");
      await live.movePlayerNear(rad.pos, [0, -1.5, 0]);
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`return Boolean((window.__vehicles.deployables.list().find((d) => d.guid === ${rad.guid})?.last?.onlineFlags ?? 0) & 0x10);`), 6000, 150, "Dericost RadarStation stowed");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  // T3.QC.06
  await collector.runDual(
    "T3.QC.06",
    3,
    "Pairwise:MovingTractor_x_Trailer_x_Sidelift_x_Doors",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.tractors.get(tGuid).speed = 5.0;
      assert(!sim.unhitchTrailer(tGuid, trGuid).ok, "Unhitch blocked while moving");
      assert(!sim.openContainerDoors(cGuid, true).ok, "Doors blocked while moving");
      sim.tractors.get(tGuid).speed = 0;
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers);
      assert(!sim.canDriveTractor(tGuid).ok, "Drive locked while sidelift active");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers planted");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 1.0 }, 800); return true;`);
      await new Promise((r) => setTimeout(r, 900));
      const spd = await live.evalInPage(`return window.__vehicles.status()?.pilot?.server?.speed ?? 0;`);
      assert(Math.abs(spd) <= 0.25, `Drive locked during active outriggers (speed=${spd})`);
      await live.cleanupWorld();
    }
  );

  // T3.QC.07
  await collector.runDual(
    "T3.QC.07",
    3,
    "Pairwise:CrossLandblock_x_CoDriver_x_StowedJack",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid, pjGuid } = sim.spawnPreset("sidelifter40", { x: 190, y: 100, z: 10 });
      sim.boardVehicle(tGuid, 1001, 0);
      sim.boardVehicle(tGuid, 1002, 1);
      sim.tractors.get(tGuid).x = 196; // crossed lbX 0 -> 1
      sim.exitVehicle(tGuid, 1001);
      sim.advanceTime(650);
      assert(!sim.tractors.get(tGuid).isDestroyed && sim.palletJacks.get(pjGuid).stowedOnTrailerGuid === trGuid, "Cross-LB rig + co-driver + stowed jack intact");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const eastH = Math.PI / 2;
      const qw = Math.cos(-eastH / 2);
      const qz = Math.sin(-eastH / 2);
      await live.sendChat(`@teleloc 0xA9B30039 172.00 96.00 94.00 ${qw.toFixed(6)} 0 0 ${qz.toFixed(6)}`);
      await live.waitUntil(async () => {
        const p = await live.getPlayerGlobalPose();
        return p && p.lx >= 168 && Math.abs(angleDiff(p.heading, eastH)) < 0.2 ? p : null;
      }, 8000, 150, "near eastern seam facing East");
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const st = window.__vehicles.status()?.vehicles?.[0];
        const t = window.__vehicles.trailers.list()[0];
        return st?.pos && t ? { vGuid: st.guid, vPos: [st.pos.x, st.pos.y, st.pos.z], tGuid: t.guid, pjGuid: t.stowedPalletJackGuid } : null;
      `), 8000, 200, "sidelifter40");
      await live.movePlayerNear(ids.vPos, [0, -2.5, 0]);
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      const secCl = toCellLocal(ids.vPos[0] - 2, ids.vPos[1] - 2, ids.vPos[2]);
      await sec.sendChat(`@teleloc 0x${secCl.cell.toString(16)} ${secCl.x.toFixed(2)} ${secCl.y.toFixed(2)} ${secCl.z.toFixed(2)}`);
      await live.waitUntil(async () => {
        const sp = await sec.getPlayerGlobalPose();
        if (!sp || Math.hypot(sp.gx - ids.vPos[0], sp.gy - ids.vPos[1]) > 5.0) return false;
        return await sec.evalInPage(`return (window.__vehicles?.vehicles?.() || []).some((v) => v.guid === ${ids.vGuid});`);
      }, 10000, 200, "tailnet2 near & sees semi");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "driver seat 0");
      await sec.evalInPage(`window.__vehicles.board(${ids.vGuid}, 1); return true;`);
      await live.waitUntil(async () => await sec.evalInPage(`return !!window.__vehicles.passenger;`), 6000, 150, "co-driver seat 1");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.9 }, 4500); return true;`);
      const seamPos = await live.waitUntil(async () => {
        const pos = await live.evalInPage(`return window.__vehicles.status()?.vehicles?.find((v) => v.guid === ${ids.vGuid})?.pos || null;`);
        if (!pos) return null;
        return pos.x >= 0xaa * 192 + 1.0 ? pos : null;
      }, 6000, 150, "rig crosses 0xA9 -> 0xAA seam");
      await live.evalInPage(`window.__vehicles.clearSticks?.(); return true;`);
      const clAfter = toCellLocal(seamPos.x, seamPos.y, seamPos.z);
      assert(((clAfter.cell >>> 24) & 0xff) >= 0xaa, `Expected rig to cross 0xA9 -> 0xAA seam, seamPos=${JSON.stringify(seamPos)}`);
      const tr = await live.getTrailer(ids.tGuid);
      assert(tr && tr.coupledTractorGuid === ids.vGuid && tr.stowedPalletJackGuid === ids.pjGuid, "Coupled trailer & stowed jack intact across seam drive");
      assert(await sec.evalInPage(`return !!window.__vehicles.passenger && window.__vehicles.isVehicle(${ids.vGuid});`), "Co-driver remained seated across seam drive");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  // T3.QC.08
  await collector.runDual(
    "T3.QC.08",
    3,
    "Pairwise:StowedJack_x_LateObserver_x_Dericost",
    async () => {
      const cl = DERICOS_FLAT_SITE;
      const bytes = encodePalletJackState({
        PalletJackGuid: 0x80093001,
        StowedOnTrailerGuid: 0x80091001,
        Cell: cl.cell,
        Position: { X: cl.lx, Y: cl.ly, Z: cl.z },
        Flags: PALLET_JACK_FLAGS.Stowed,
      });
      const dec = decodePalletJackState(bytes);
      assert((dec.Cell & 0x8000) !== 0 && dec.StowedOnTrailerGuid === 0x80091001 && (dec.Flags & PALLET_JACK_FLAGS.Stowed), "Late-observer 0x0910 packet preserves Dericost cell & StowedOnTrailerGuid");
    },
    async (live) => {
      await live.cleanupWorld();
      const site = await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t && t.stowedPalletJackGuid ? { tGuid: t.guid, pjGuid: t.stowedPalletJackGuid } : null;
      `), 8000, 200, "Dericost sidelifter40");
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      await sec.sendChat(`@teleloc ${DERICOS_FLAT_SITE.cellHex} ${(DERICOS_FLAT_SITE.lx + 4).toFixed(2)} ${DERICOS_FLAT_SITE.ly.toFixed(2)} ${site.tz.toFixed(2)}`);
      const obs = await live.waitUntil(async () => await sec.evalInPage(`
        const pj = window.__vehicles?.palletJacks?.get?.(${ids.pjGuid});
        return pj && (pj.stowedOnTrailerGuid >>> 0) === ${ids.tGuid} ? pj : null;
      `), 12000, 200, "Dericost late-observer stowed jack sync");
      assert((obs.stowedOnTrailerGuid >>> 0) === ids.tGuid, "Late observer synced stowed pallet jack on Dericost");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  // T3.QC.09
  await collector.runDual(
    "T3.QC.09",
    3,
    "Pairwise:CrossLandblock_FluxPod_x_SetStowed_x_Turret",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), t = sim.allocGuid();
      // FluxPod at x=188 (lbX=0), Turret at x=196 (lbX=1), delta = 8m <= 75m
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 188, y: 100, z: 10, isStowed: true, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 189, y: 100, z: 10, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(t, { guid: t, wcid: 4000014, x: 196, y: 100, z: 10, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(t).onlineFlags & ONLINE_FLAGS.Powered) === 0, "Unpowered while FluxPod stowed");
      sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: f });
      assert((sim.deployables.get(t).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "Cross-landblock SetStowed(false) powers turret via GlobalPosition");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const gxFlux = 32448 - 4.0; // lb 0xA8B3 near eastern edge (32448 = 169*192)
      const gxTurret = 32448 + 4.0; // lb 0xA9B3 across seam (8m apart)
      const gy = 34392.0;
      const p = await live.getPlayerGlobalPose();
      await live.sendChatAndWait(`@deployable spawn 4000010 ${gxFlux.toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000012 ${(gxFlux - 2).toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000014 ${gxTurret.toFixed(2)} ${gy.toFixed(2)} ${p.z.toFixed(2)}`, /spawned/i, 8000);
      const fluxGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000010)?.guid || 0;`), 8000, 200, "FluxPod");
      await live.movePlayerNear([gxFlux, gy, p.z], [0, -1.5, 0]);
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${fluxGuid}); return true;`); // stow
      await live.waitUntil(async () => await live.evalInPage(`return ((window.__vehicles.deployables.list().find((d) => d.wcid === 4000014)?.last?.onlineFlags ?? 1) & 0x01) === 0;`), 6000, 150, "unpowered when FluxPod stowed");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${fluxGuid}); return true;`); // unstow -> SetStowed(false) GlobalPosition
      await live.waitUntil(async () => await live.evalInPage(`return ((window.__vehicles.deployables.list().find((d) => d.wcid === 4000014)?.last?.onlineFlags ?? 0) & 0x01) !== 0;`), 6000, 150, "cross-landblock turret repowered");
      await live.cleanupWorld();
    }
  );

  // T3.QC.10
  await collector.runCheck("T3.QC.10", 3, "Pairwise:AuxEvents_x_PromptHUD_x_WireFallback", async () => {
    const idxMod = await tryImportVehicle("index.js");
    assert(idxMod.ok, idxMod.reason);
    const env = await makeQcLiveEnv();
    try {
      for (const [kind, table] of [
        [VEHICLE_EVENT_KIND.SideliftRefused, idxMod.mod.SIDELIFT_REFUSAL_REASONS],
        [VEHICLE_EVENT_KIND.PalletJackEvent, idxMod.mod.PALLET_JACK_EVENT_REASONS],
      ]) {
        for (let aux = 0; aux <= 7; aux++) {
          const bytes = encodeVehicleEvent({ Vehicle: 0x80091001, Kind: kind, Aux: aux }, 7);
          const dec = decodeVehicleEvent(bytes);
          env.push({ type: "event", kind: dec.Kind, vehicle: dec.Vehicle, aux: dec.Aux });
          env.tick(300 + aux * 10);
          assert(env.doc.getElementById("hb-vehicle-prompt").textContent === table[aux], `kind=${kind} aux=${aux} prompt parity`);
        }
      }
    } finally {
      env.dispose();
    }
  });

  // T3.QC.11
  await collector.runDual(
    "T3.QC.11",
    3,
    "Pairwise:LoadAccess_x_CapPilot_Dead_Seated",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5 }).ok, "Closed doors block Load");
      assert(sim.openContainerDoors(cGuid, true).ok, "Open container doors before Load");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 0 }).ok, "AccessLevel=0 blocked");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5, hasCapPilot: false }).ok, "!CapPilot blocked");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5, isDead: true }).ok, "IsDead blocked");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5, isSeated: true }).ok, "IsSeated blocked");
      assert(sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { cargoWcid: 4000010, accessLevel: 5 }).ok, "Developer on-foot alive allowed");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /spawned/i, 8000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "container");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 0, 0, 4000010); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.slots?.length ?? 0) === 1, 6000, 150, "Developer Load allowed");
      await live.cleanupWorld();
    }
  );

  // T3.QC.12
  await collector.runCheck("T3.QC.12", 3, "Pairwise:GroundFx_Headlights_x_RotatedHeadings_x_Dericost", async () => {
    const gfx = await tryImportVehicle("ground_fx.js");
    const sm = await tryImportVehicle("semi_truck_model.js");
    const jm = await tryImportVehicle("jeep_model.js");
    assert(gfx.ok && sm.ok && jm.ok, "ground_fx.js, semi_truck_model.js & jeep_model.js load");
    const root = new THREE.Group();
    const mgr = gfx.mod.createGroundFx(THREE, root, { profileKey: "semi-379", vehicleClass: 3 });
    const semi = sm.mod.buildSemiTruck(THREE, { livery: 0 }, { liveScene3d: { activeLights: [] } });
    const jeep = jm.mod.buildProceduralJeep(THREE, {}, { liveScene3d: { activeLights: [] } });
    const dims = gfx.mod.SEMI_FX_DIMENSIONS;
    for (const h of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      semi.root.position.set(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, DERICOS_FLAT_SITE.z);
      semi.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -h);
      semi.update({ headlights: true, speed: 12 }, 0.033);
      jeep.root.position.set(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, DERICOS_FLAT_SITE.z);
      jeep.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -h);
      jeep.update({ headlights: true, speed: 12 }, 0.033);
      mgr.update({ x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, heading: h, speed: 12, surfaceFamily: 4, vehicleClass: 3 }, 0.1);
      const [expHx, expHy] = acHeadingTransform(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, 0, 3.60, h);
      near(semi.pooledLight.position.x, expHx, 0.05, `Semi headlight X at h=${h.toFixed(2)}`);
      near(semi.pooledLight.position.y, expHy, 0.05, `Semi headlight Y at h=${h.toFixed(2)}`);
      const [expJx, expJy] = acHeadingTransform(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, 0, 1.60, h);
      near(jeep.pooledLight.position.x, expJx, 0.05, `Jeep headlight X at h=${h.toFixed(2)}`);
      near(jeep.pooledLight.position.y, expJy, 0.05, `Jeep headlight Y at h=${h.toFixed(2)}`);
      const fresh = mgr.pool.filter((s) => s.active && s.t === 0);
      assert(fresh.length >= dims.wheelOffsets.length + dims.exhaustOffsets.length, `Expected wheel+exhaust particles on Dericost at h=${h.toFixed(2)}`);
      for (const [lx, ly] of dims.wheelOffsets) {
        const [ex, ey] = acHeadingTransform(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, lx, ly, h);
        const hit = fresh.some((s) => Math.abs(s.z - (DERICOS_FLAT_SITE.z + 0.05)) < 0.05 && Math.hypot(s.x - ex, s.y - ey) < 1e-4);
        assert(hit, `Missing Dericost wheel particle at (${ex.toFixed(2)}, ${ey.toFixed(2)}) h=${h.toFixed(2)}`);
      }
      for (const [exOff, eyOff, ezOff] of dims.exhaustOffsets) {
        const [ex, ey] = acHeadingTransform(DERICOS_FLAT_SITE.gx, DERICOS_FLAT_SITE.gy, exOff, eyOff, h);
        const hit = fresh.some((s) => Math.abs(s.z - (DERICOS_FLAT_SITE.z + ezOff)) < 0.05 && Math.hypot(s.x - ex, s.y - ey) < 1e-4);
        assert(hit, `Missing Dericost exhaust particle at (${ex.toFixed(2)}, ${ey.toFixed(2)}) h=${h.toFixed(2)}`);
      }
    }
    assert(countLights(root) === 0 && countLights(semi.root) === 0 && countLights(jeep.root) === 0, "Zero THREE.Light instances");
    semi.dispose();
    jeep.dispose();
    mgr.dispose();
  });
}
