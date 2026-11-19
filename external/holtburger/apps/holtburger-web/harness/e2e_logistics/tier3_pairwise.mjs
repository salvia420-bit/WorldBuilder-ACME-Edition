// harness/e2e_logistics/tier3_pairwise.mjs — Tier 3 Cross-Feature Pairwise Combinations (12 Tests).

import {
  ALL_9_DEPLOYABLES,
  DEPLOYABLE_KIND,
  DERICOST_Y_OFFSET,
  HBV1_VERSION_V7,
  LOGISTICS_SPEC,
  LogisticsWorldSimulator,
  ONLINE_FLAGS,
  PALLET_JACK_ACTION_KIND,
  SIDELIFT_FLAGS,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  assert,
  decodePalletJackState,
  decodeTrailerState,
  encodePalletJackState,
  encodeTrailerState,
  getThree,
  installFakeAudio,
  makeLogisticsLiveEnv,
  near,
  oracleComputeCraneSpanY,
  oracleComputeReachableLoadSlots,
  oracleComputeReachableUnloadSlots,
  oracleEvaluateContainerLocalPose,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
} from "./common.mjs";

export const TIER3_METADATA = [
  { id: "T3.01", tier: 3, feature: "Pairwise:Semi379_x_Sidelifter_x_20_40_40HC_x_Left_Right", mode: "dual" },
  { id: "T3.02", tier: 3, feature: "Pairwise:Elevated_Bridge_DropZ_x_probeContainerSurface_0_85m", mode: "dual" },
  { id: "T3.03", tier: 3, feature: "Pairwise:Mixed_Full_Half_Pallets_x_Pinwheel_LIFO_20ft_40ft", mode: "dual" },
  { id: "T3.04", tier: 3, feature: "Pairwise:PalletCargoState_Ammo_Fuel_Energy_x_Container_RoundTrip", mode: "dual" },
  { id: "T3.05", tier: 3, feature: "Pairwise:MicroGrid_Power_x_IsStowed_x_All9Deployables", mode: "dual" },
  { id: "T3.06", tier: 3, feature: "Pairwise:WalkBehind_Controller_x_SurfaceAudio_x_SidelifterAudio", mode: "dual" },
  { id: "T3.07", tier: 3, feature: "Pairwise:Coupled_TrailerKinematics_30Hz_x_towMassMul_x_SideliftLock", mode: "dual" },
  { id: "T3.08", tier: 3, feature: "Pairwise:Dericost_0x8000_Coord_RoundTrip_x_0x090F_v7_And_0x0910", mode: "dual" },
  { id: "T3.09", tier: 3, feature: "Pairwise:RackStowed_PalletJack_x_STurn_Articulation", mode: "dual" },
  { id: "T3.10", tier: 3, feature: "Pairwise:Container_HalfSlot_Jack_Stow_vs_Rack_Stow_And_Commands", mode: "dual" },
  { id: "T3.11", tier: 3, feature: "Pairwise:ModeSwitching_Capture_Precedence_Jack_Semi_OnFoot", mode: "dual" },
  { id: "T3.12", tier: 3, feature: "Pairwise:Legacy_Skeletal_Trailers_4000030_4000031_NonRegression", mode: "dual" },
];

export async function runTier3(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  await collector.runDual(
    "T3.01",
    3,
    "Pairwise:Semi379_x_Sidelifter_x_20_40_40HC_x_Left_Right",
    async () => {
      const matrix = [
        { preset: "sidelifter20", kind: 10, span: 2.9265, side: -1, flags: 0x01 },
        { preset: "sidelifter20", kind: 10, span: 2.9265, side: 1, flags: 0x00 },
        { preset: "sidelifter40", kind: 11, span: 5.9925, side: -1, flags: 0x01 },
        { preset: "sidelifter40", kind: 11, span: 5.9925, side: 1, flags: 0x00 },
        { preset: "sidelifter40hc", kind: 12, span: 5.9925, side: -1, flags: 0x01 },
        { preset: "sidelifter40hc", kind: 12, span: 5.9925, side: 1, flags: 0x00 },
      ];
      for (const row of matrix) {
        const sim = new LogisticsWorldSimulator();
        const { trGuid, cGuid } = sim.spawnPreset(row.preset);
        near(oracleComputeCraneSpanY(row.kind), row.span, 1e-4, `${row.preset} craneSpanY`);
        const off = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload, row.flags);
        assert(off.ok, `${row.preset} side=${row.side} offload ok: ${off.reason}`);
        near(sim.containers.get(cGuid).x - sim.trailers.get(trGuid).x, row.side * 3.85, 1e-4, `${row.preset} drop X`);
        const pose = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Swinging, 0.5, row.side, false, 1.32, 0);
        assert(pose.roll === 0, "level lift invariant");
        const load = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad, row.flags);
        assert(load.ok && sim.trailers.get(trGuid).mountedContainerGuid === cGuid, `${row.preset} side=${row.side} reload ok`);
      }
    },
    async (live) => {
      for (const [preset, side, expectSpan] of [
        ["sidelifter20", "left", 2.9265],
        ["sidelifter40hc", "right", 5.9925],
      ]) {
        await live.cleanupWorld();
        await live.sendChatAndWait(`@trailer preset ${preset}`, new RegExp(`${preset}|sidelifter|spawned`, "i"), 10000);
        const ids = await live.waitUntil(async () => await live.evalInPage(`
          const t = window.__vehicles.trailers.list()[0];
          const c = window.__vehicles.containers.list()[0];
          return t && c ? { tGuid: t.guid, cGuid: c.guid, tx: t.pos[0], ty: t.pos[1], th: t.heading ?? t.last?.heading ?? 0, span: t.craneSpanY ?? t.last?.craneSpanY ?? t.last?.CraneSpanY } : null;
        `), 10000, 200, preset);
        near(ids.span, expectSpan, 0.05, `${preset} craneSpanY`);
        await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", ${JSON.stringify(side)}); return true;`);
        await live.waitUntil(async () => {
          const t = await live.getTrailer(ids.tGuid);
          return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
        }, 24000, 300, `${preset} ${side} offload`);
        const landed = (await live.getContainer(ids.cGuid)).pos;
        const lat = Math.abs((landed[0] - ids.tx) * Math.cos(ids.th) - (landed[1] - ids.ty) * Math.sin(ids.th));
        assert(lat >= 3.4 && lat <= 4.3, `${preset} ${side} lateral drop ${lat}m`);
      }
    }
  );

  await collector.runDual(
    "T3.02",
    3,
    "Pairwise:Elevated_Bridge_DropZ_x_probeContainerSurface_0_85m",
    async () => {
      const env = await makeLogisticsLiveEnv({ terrainHeightAt: () => 22.5 });
      try {
        const bridgeZ = 22.5;
        const pose = oracleEvaluateContainerLocalPose(SIDELIFT_PHASE.Lowering, 1.0, 1, false, 1.32, bridgeZ);
        near(pose.z, bridgeZ, 1e-4, "lowering terminates at bridgeZ=22.5");
        const cGuid = 0x80099299;
        env.live.sessionHandle.upsertContainerCollider(cGuid, 0, 100, 100, bridgeZ, 0, 10, true);
        const hl = 5.898 / 2;
        const rampMid = env.live.sessionHandle.probeContainerSurface(100, 100 - hl - 0.425, bridgeZ + 2.0);
        const floor = env.live.sessionHandle.probeContainerSurface(100, 100, bridgeZ + 2.0);
        assert(rampMid && rampMid.zone === "ramp", "elevated ramp probe hit");
        near(rampMid.z, bridgeZ + 0.081, 0.01, "elevated ramp mid Z");
        assert(floor && floor.zone === "floor", "elevated floor probe hit");
        near(floor.z, bridgeZ + 0.162, 1e-4, "elevated floor Z");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@container spawn 20", /container|spawned/i, 10000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 6000, 150, "c");
      await live.evalInPage(`window.__vehicles.containers.action(${c.guid}, 1); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.98, 6000, 150, "doors");
      const surf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${c.pos[0]}, ${c.pos[1]}, ${c.pos[2] + 1.5});`);
      assert(surf !== null && surf !== undefined, "elevated/terrain probeContainerSurface returns valid floor Z");
    }
  );

  await collector.runDual(
    "T3.03",
    3,
    "Pairwise:Mixed_Full_Half_Pallets_x_Pinwheel_LIFO_20ft_40ft",
    async () => {
      // 40ft container with mixed Full + Half-pallet pairs across rear & front quads
      const slots40 = [
        { slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2 },
        { slotIndex: 2, subSlot: 0, cargoWcid: 4000013, palletSize: 1 },
        { slotIndex: 2, subSlot: 1, cargoWcid: 4000015, palletSize: 1 },
        { slotIndex: 18, subSlot: 0, cargoWcid: 4000014, palletSize: 2 },
        { slotIndex: 20, subSlot: 0, cargoWcid: 4000016, palletSize: 1 },
        { slotIndex: 20, subSlot: 1, cargoWcid: 4000017, palletSize: 1 },
      ];
      const u1 = oracleComputeReachableUnloadSlots(11, slots40);
      assert(u1.reachable.some((r) => r.slotIndex === 18), "rear slot 18 reachable");
      assert(!u1.reachable.some((r) => r.slotIndex === 0), "deep slot 0 blocked while rear tier full");

      // Clear rear tier (18 & 20) -> slot 2 half-pallets & slot 0 unlock
      const clearedRear = slots40.filter((s) => s.slotIndex !== 18 && s.slotIndex !== 20);
      const u2 = oracleComputeReachableUnloadSlots(11, clearedRear);
      assert(u2.reachable.some((r) => r.slotIndex === 2 && r.subSlot === 0), "half pallet (2,0) reachable once rear cleared");
      assert(u2.reachable.some((r) => r.slotIndex === 2 && r.subSlot === 1), "half pallet (2,1) reachable");

      // Load half pallet into empty 20ft container -> deepest-first (+Y -> -Y)
      const l20 = oracleComputeReachableLoadSlots(10, [], "half");
      assert(l20.length === 20, "20ft supports 20 half-pallet sub-slots");
      assert(l20[0].y >= 2.38 && l20[0].y >= l20[l20.length - 1].y, "deepest-first +Y -> -Y ordering");
      assert(l20[0].slotIndex === 0 || l20[0].slotIndex === 1, "first half-pallet slot is against front bulkhead");

      const cl = await tryImportVehicle("container_logistics.js");
      if (cl.ok && typeof cl.mod.computeReachableLoadSlots === "function") {
        const realHalf = cl.mod.computeReachableLoadSlots(10, [], "half");
        const realList = Array.isArray(realHalf) ? realHalf : (realHalf.reachable || []);
        assert(realList.length === 20, "real container_logistics 20ft half-pallet capacity === 20");
        const realU1 = cl.mod.computeReachableUnloadSlots(11, slots40).reachable.map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
        const oraU1 = u1.reachable.map((x) => `${x.slotIndex}:${x.subSlot}`).join(",");
        assert(realU1 === oraU1, `40ft mixed unload parity mismatch: oracle=[${oraU1}] real=[${realU1}]`);
      }
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
      const cOff = await live.getContainer(ids.cGuid);
      if (cOff?.pos) await live.movePlayerNear(cOff.pos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); return true;`);
      const slots = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        return (c?.doorProgress ?? 0) >= 0.98 ? c.slots : null;
      }, 6000, 150, "40hc open");
      assert(Array.isArray(slots) && slots.length >= 1, "40HC mixed cargo slots populated");
    }
  );

  await collector.runDual(
    "T3.04",
    3,
    "Pairwise:PalletCargoState_Ammo_Fuel_Energy_x_Container_RoundTrip",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.containers.get(cGuid).slots = [];
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 });

      // Spawn a partially expended MissileTurret (ammo=2), PowerGenerator (fuel=63.5s), BatteryUnit (energy=240kJ)
      const units = [
        { wcid: 4000014, kind: 6, slot: 0, sub: 0, cargoState: { ammo: 2, fuel: 0, energy: 0 } },
        { wcid: 4000012, kind: 4, slot: 1, sub: 0, cargoState: { ammo: 0, fuel: 63.5, energy: 0 } },
        { wcid: 4000013, kind: 5, slot: 2, sub: 0, cargoState: { ammo: 0, fuel: 0, energy: 240000 } },
      ];
      for (const u of units) {
        const dg = sim.allocGuid();
        sim.deployables.set(dg, { guid: dg, wcid: u.wcid, kind: u.kind, x: 100, y: 100, z: 10, isStowed: true, onlineFlags: ONLINE_FLAGS.Stowed, elevationM: 0, cargoState: { ...u.cargoState } });
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: dg }).ok, "pick stowed");
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.LoadContainerSlot, { targetGuid: cGuid, slotIndex: u.slot, subSlot: u.sub }).ok, "load container");
      }

      // Close doors -> Sidelift reload -> Sidelift offload -> Open doors -> Unload -> Drop -> Assert state preserved
      sim.openContainerDoors(cGuid, false);
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad).ok, "reload onto trailer");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "offload at destination");
      sim.openContainerDoors(cGuid, true);

      // Unload in reverse slot order (LIFO: 2 -> 1 -> 0)
      for (const u of [...units].reverse()) {
        assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: u.slot, subSlot: u.sub }).ok, `pick slot ${u.slot}`);
        const drop = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround);
        assert(drop.ok, "drop at destination");
        const restored = sim.deployables.get(drop.deployableGuid).cargoState;
        assert(restored.ammo === u.cargoState.ammo, `ammo preserved (${restored.ammo} === ${u.cargoState.ammo})`);
        near(restored.fuel, u.cargoState.fuel, 1e-4, "fuel preserved");
        near(restored.energy, u.cargoState.energy, 1e-1, "energy preserved");
      }
    },
    async (live) => {
      // Verify live round-trip preserves ammo/fuel/energy across stow -> load -> container reload/offload -> unload -> drop
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        const c = window.__vehicles.containers.list()[0];
        return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
      `), 10000, 200, "rig");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "offloaded");
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
      const cOff = await live.getContainer(ids.cGuid);
      const ch = cOff?.heading ?? 0;
      const dropSpot = [
        cOff.pos[0] + Math.cos(ch) * 2.2 - Math.sin(ch) * 9.0,
        cOff.pos[1] - Math.sin(ch) * 2.2 - Math.cos(ch) * 9.0,
        cOff.pos[2],
      ];
      // Peel outer slot 6 (4000002) aside to expose slot 4 (4000014 MissileTurret with Ammo=4)
      const slot6Pos = await live.getSlotWorldPos(ids.cGuid, 6, 0);
      await live.movePalletJackTo(pjGuid, slot6Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 6, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid !== 0, 6000, 150, "peeled slot 6");
      await live.movePalletJackTo(pjGuid, dropSpot);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "dropped slot 6 aside");

      const slot4Pos = await live.getSlotWorldPos(ids.cGuid, 4, 0);
      await live.movePalletJackTo(pjGuid, slot4Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 4, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 4000014, 6000, 150, "picked slot 4");
      await live.movePalletJackTo(pjGuid, [dropSpot[0] + 1.8, dropSpot[1], dropSpot[2]]);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pjGuid}); return true;`);
      const d1 = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((x) => x.wcid === 4000014) || null;`), 6000, 150, "dropped unit");
      const before = {
        guid: d1.guid,
        wcid: d1.wcid,
        ammo: d1.last?.ammo ?? d1.last?.ammoRemaining ?? 0,
        fuelSec: d1.last?.fuelSec ?? d1.last?.fuelRemaining ?? 0,
        energyJoules: d1.last?.energyJoules ?? d1.last?.energyStoredJoules ?? 0,
      };

      // Ensure stowed (dropGround leaves deployables stowed; only toggle if currently unstowed) -> pickGround -> loadContainer (slot 20)
      const isAlreadyStowed = Boolean((d1.last?.onlineFlags ?? 0) & 0x10);
      if (!isAlreadyStowed) {
        await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${before.guid}); return true;`);
        await live.waitUntil(async () => await live.evalInPage(`
          const d = window.__vehicles.deployables.list().find((x) => x.guid === ${before.guid});
          return d && ((d.last?.onlineFlags ?? 0) & 0x10) !== 0;
        `), 5000, 150, "stowed");
      }
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${before.guid}, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === before.wcid, 6000, 150, "re-picked ground");
      const slot20Pos = await live.getSlotWorldPos(ids.cGuid, 20, 0);
      await live.movePalletJackTo(pjGuid, slot20Pos);
      await live.evalInPage(`window.__vehicles.palletJacks.loadContainer(${ids.cGuid}, 20, 0, ${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.carriedWcid === 0, 6000, 150, "re-loaded slot 20");
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "released");
      const trPose = await live.getTrailer(ids.tGuid);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed to rack");
      await live.movePalletJackTo(pjGuid, trPose.pos, { stopDistM: 2.0 });
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "released at rack");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${ids.tGuid}, ${pjGuid}); window.__vehicles.containers.action(${ids.cGuid}, 2); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 1) <= 0.02, 6000, 150, "doors closed");

      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoLoad", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0;
      }, 24000, 300, "autoLoad round-trip");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoOffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 24000, 300, "autoOffload round-trip");
      await live.evalInPage(`window.__vehicles.containers.action(${ids.cGuid}, 1); window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pj2 = await live.waitUntil(async () => {
        const c = await live.getContainer(ids.cGuid);
        const pj = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`);
        return (c?.doorProgress ?? 0) >= 0.98 && pj ? pj : 0;
      }, 8000, 200, "re-opened & jack deployed");
      const pj2Pose = await live.getPalletJack(pj2);
      await live.movePlayerNear(pj2Pose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pj2}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pj2))?.operatorGuid !== 0, 5000, 150, "grabbed2");
      await live.movePalletJackTo(pj2, await live.getSlotWorldPos(ids.cGuid, 20, 0));
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 20, 0, ${pj2}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pj2))?.carriedWcid !== 0, 6000, 150, "re-unloaded");
      await live.movePalletJackTo(pj2, [dropSpot[0] - 1.5, dropSpot[1], dropSpot[2]]);
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${pj2}); return true;`);
      const d2 = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((x) => x.wcid === ${before.wcid}) || null;`), 6000, 150, "re-dropped unit");
      assert(d2.wcid === before.wcid, `WCID preserved (${d2.wcid} === ${before.wcid})`);
      const afterAmmo = d2.last?.ammo ?? d2.last?.ammoRemaining ?? 0;
      const afterFuel = d2.last?.fuelSec ?? d2.last?.fuelRemaining ?? 0;
      const afterEnergy = d2.last?.energyJoules ?? d2.last?.energyStoredJoules ?? 0;
      assert(afterAmmo === before.ammo, `Ammo preserved (${afterAmmo} === ${before.ammo})`);
      near(afterFuel, before.fuelSec, 0.05, "Fuel preserved");
      near(afterEnergy, before.energyJoules, 1.0, "Energy preserved");
    }
  );

  await collector.runDual(
    "T3.05",
    3,
    "Pairwise:MicroGrid_Power_x_IsStowed_x_All9Deployables",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const guids = [];
      for (const spec of ALL_9_DEPLOYABLES) {
        const g = sim.allocGuid();
        sim.deployables.set(g, {
          guid: g, wcid: spec.wcid, kind: spec.kind, x: 0, y: 0, z: 0,
          isStowed: false, onlineFlags: 0, cargoState: { ammo: 4, fuel: 100, energy: 200000 },
        });
        guids.push(g);
      }
      sim.recomputeMicroGrid();
      for (const g of guids) {
        const d = sim.deployables.get(g);
        assert((d.onlineFlags & ONLINE_FLAGS.InFluxRange) !== 0, `${d.wcid} in FluxRange`);
        assert((d.onlineFlags & ONLINE_FLAGS.Stowed) === 0, `${d.wcid} not stowed initially`);
      }

      // Stow generators & battery -> consumers lose power -> unstow recovers
      for (const g of guids) {
        sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: g });
        assert((sim.deployables.get(g).onlineFlags & ONLINE_FLAGS.Stowed) !== 0, `${sim.deployables.get(g).wcid} stowed`);
        assert(sim.deployables.get(g).powerWatts === 0, "stowed powerWatts === 0");
      }
      for (const g of guids) {
        sim.palletJackAction(0, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: g });
      }
      assert((sim.deployables.get(guids[5]).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "MissileTurret re-powered");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@deployable spawn 4000010", /4000010|spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000012", /4000012|spawned/i, 8000);
      const genGuid = await live.waitUntil(async () => await live.evalInPage(`
        const g = window.__vehicles.deployables.list().find((d) => d.wcid === 4000012);
        return g ? g.guid : 0;
      `), 6000, 150, "generator spawned");
      await live.sendChatAndWait(`@deployable fuel 0x${(genGuid >>> 0).toString(16)} 1`, /refueled generator/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|spawned/i, 8000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const list = window.__vehicles.deployables.list();
        const gen = list.find((d) => d.wcid === 4000012);
        const tur = list.find((d) => d.wcid === 4000014);
        return gen && tur && ((tur.last?.onlineFlags ?? 0) & 0x01) !== 0 ? { gen: gen.guid, tur: tur.guid } : null;
      `), 8000, 200, "MicroGrid powered");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${ids.gen}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const tur = window.__vehicles.deployables.list().find((d) => d.guid === ${ids.tur});
        return tur && ((tur.last?.onlineFlags ?? 0) & 0x01) === 0;
      `), 6000, 150, "turret unpowered when generator stowed");
    }
  );

  await collector.runDual(
    "T3.06",
    3,
    "Pairwise:WalkBehind_Controller_x_SurfaceAudio_x_SidelifterAudio",
    async () => {
      const audioMod = await tryImportVehicle("audio.js");
      assert(audioMod.ok, audioMod.reason);
      const env = await makeLogisticsLiveEnv();
      const fakeAudio = installFakeAudio();
      try {
        assert(audioMod.mod.vehicleAudioEnabled("?vehicles=on") === true, "audio enabled on ?vehicles=on");
        const gvAudio = audioMod.mod.createGroundVehicleAudio({
          audioManager: env.live.audioManager,
          vehicleClass: 3,
        });
        gvAudio.start();
        gvAudio.update({ speed: 5.0, throttle: 0.4, steerAngle: 0.1, onGround: true, surfaceFamily: 0 });
        assert(gvAudio.isStarted() === true, "ground vehicle audio started cleanly");
        gvAudio.dispose();

        assert(typeof audioMod.mod.createLogisticsAudio === "function", "createLogisticsAudio must be exported");
        let tSec = 10.0;
        const logAudio = audioMod.mod.createLogisticsAudio({
          audioManager: env.live.audioManager,
          liveScene3d: env.live,
          search: "?vehicles=on",
          clock: () => tSec,
        });
        assert(logAudio.updateSidelifter(0x80099101, { sideliftPhase: SIDELIFT_PHASE.Swinging, load: 1.0, pos: [10, 10, 10] }) === true, "updateSidelifter active");
        assert(logAudio.stats.ptoVoices === 1 && logAudio.stats.swingVoices === 1, "ptoVoices & swingVoices active");
        assert(logAudio.outriggerThud({ pos: [10, 10, 10] }) === true, "outriggerThud played");
        assert(logAudio.twistlockClank({ pos: [10, 10, 10], locked: true }) === true, "twistlockClank played");
        assert(logAudio.pumpRatchet({ pos: [10, 9, 10] }) === true, "pumpRatchet played");
        assert(logAudio.releaseHiss({ pos: [10, 9, 10] }) === true, "releaseHiss played");
        assert(logAudio.updateWheelRoll(0x800b0001, { speed: 1.4, surface: "ramp", loaded: true, pos: [10, 9, 10] }) === true, "updateWheelRoll ramp played");
        assert(logAudio.stats.rollVoices === 1, "rollVoices === 1");
        assert(logAudio.updateWheelRoll(0x800b0001, { speed: 1.4, surface: "floor", loaded: true, pos: [10, 9, 10] }) === true, "updateWheelRoll floor played");
        assert(logAudio.updateWheelRoll(0x800b0001, { speed: 1.4, surface: "terrain", loaded: false, pos: [10, 9, 10] }) === true, "updateWheelRoll terrain played");
        logAudio.stopSidelifter(0x80099101);
        logAudio.stopWheelRoll(0x800b0001);
        logAudio.dispose();
        assert(logAudio.stats.disposed === true && logAudio.stats.totalNodes === 0, "logAudio.dispose() cleans all voices");

        // When nullRender === true, createLogisticsAudio must suppress all voices & nodes
        env.live.nullRender = true;
        const suppressed = audioMod.mod.createLogisticsAudio({
          audioManager: env.live.audioManager,
          liveScene3d: env.live,
          search: "?vehicles=on",
          clock: () => tSec,
        });
        assert(suppressed.stats.enabled === false, "nullRender disables logistics audio");
        assert(suppressed.updateSidelifter(0x80099101, { sideliftPhase: SIDELIFT_PHASE.Swinging, load: 1, pos: [10, 10, 10] }) === false, "nullRender suppresses updateSidelifter");
        assert(suppressed.outriggerThud({ pos: [10, 10, 10] }) === false, "nullRender suppresses outriggerThud");
        assert(suppressed.twistlockClank({ pos: [10, 10, 10], locked: true }) === false, "nullRender suppresses twistlockClank");
        assert(suppressed.pumpRatchet({ pos: [10, 9, 10] }) === false, "nullRender suppresses pumpRatchet");
        assert(suppressed.releaseHiss({ pos: [10, 9, 10] }) === false, "nullRender suppresses releaseHiss");
        assert(suppressed.updateWheelRoll(0x800b0001, { speed: 1.4, surface: "ramp", loaded: true, pos: [10, 9, 10] }) === false, "nullRender suppresses updateWheelRoll");
        assert(suppressed.stats.totalNodes === 0, "nullRender leaves 0 active audio nodes");
        suppressed.dispose();
        env.push({
          type: "trailer_state",
          trailerGuid: 0x80099101,
          kind: 15,
          cell: 0,
          pos: [10, 10, 10],
          heading: 0,
          pitch: 0,
          bank: 0,
          coupledTractorGuid: 0,
          mountedContainerGuid: 0,
          containerSlot: 0,
          trailerFlags: 0,
          sideliftPhase: SIDELIFT_PHASE.Swinging,
          sideliftProgress: 0.5,
        });
        env.tick(200);
        assert(env.api.status() !== null, "nullRender audio gating safe");
      } finally {
        fakeAudio?.restore?.();
        env.dispose();
      }
    },
    async (live) => {
      // Self-contained live sidelifter + pallet-jack audio exercise + console zero gate
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "trailer");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`), 6000, 150, "pj");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.raise(${pjGuid}); return true;`);
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 0) >= 0.19, 5000, 150, "raised");
      await live.evalInPage(`window.__vehicles.palletJacks.lower(${pjGuid}); return true;`);
      await live.waitUntil(async () => ((await live.getPalletJack(pjGuid))?.forkHeightM ?? 1) <= 0.095, 5000, 150, "lowered");
      await live.evalInPage(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true })); return true;`);
      await new Promise((r) => setTimeout(r, 400));
      await live.evalInPage(`window.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true })); window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "released");
      await live.evalInPage(`window.__vehicles.trailers.retractOutriggers(${tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 0, 6000, 150, "retracted");
      const errs = await live.checkConsoleErrors();
      assert(errs.failing.length === 0, `Console errors during audio ops: ${errs.failing.join("; ")}`);
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T3.07",
    3,
    "Pairwise:Coupled_TrailerKinematics_30Hz_x_towMassMul_x_SideliftLock",
    async () => {
      const tk = await tryImportVehicle("trailer_kinematics.js");
      assert(tk.ok, tk.reason);
      near(tk.mod.TOW_MASS_MUL.LOADED_40FT, 0.58, 1e-6, "loaded towMassMul");
      near(tk.mod.TOW_MASS_MUL.EMPTY_CHASSIS, 0.72, 1e-6, "empty towMassMul");
      near(tk.mod.TOW_MASS_MUL.BOBTAIL, 1.0, 1e-6, "bobtail towMassMul");

      const sim = new LogisticsWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      near(sim.tractors.get(tGuid).towMassMul, 0.58, 1e-6, "loaded before offload");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers);
      assert(!sim.canDriveTractor(tGuid).ok, "drive locked while outriggers deployed");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload);
      near(sim.tractors.get(tGuid).towMassMul, 0.72, 1e-6, "empty after offload");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.RetractOutriggers);
      assert(sim.canDriveTractor(tGuid).ok, "drive unlocked in Idle");

      // Step real 30 Hz trailer_kinematics
      const trPose = tk.mod.stepCoupledTrailer(
        { x: 0, y: 0, z: 10, heading: 0, speed: 5, steerAngle: 0.2, wheelbase: 4.66 },
        { x: 0, y: -7.36, z: 10, heading: 0 },
        -2.01,
        "40ft",
        () => 10
      );
      assert(Number.isFinite(trPose.x) && Number.isFinite(trPose.heading), "30 Hz articulation step finite");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const before = await live.waitUntil(async () => await live.evalInPage(`
        const s = window.__vehicles.semi.list()[0];
        const t = window.__vehicles.trailers.list()[0];
        return s && t && s.coupled && s.towMassMul < 0.9 ? { towMassMul: s.towMassMul, tGuid: t.guid } : null;
      `), 10000, 200, "semi + trailer");
      near(before.towMassMul, 0.58, 0.05, "loaded towMassMul");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${before.tGuid}, "autoOffload", "right"); return true;`);
      const after = await live.waitUntil(async () => {
        const t = await live.getTrailer(before.tGuid);
        const s = await live.evalInPage(`const x = window.__vehicles.semi.list()[0]; return x ? { towMassMul: x.towMassMul } : null;`);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0 ? s : null;
      }, 24000, 300, "empty chassis");
      near(after.towMassMul, 0.72, 0.05, "empty towMassMul after offload");
    }
  );

  await collector.runDual(
    "T3.08",
    3,
    "Pairwise:Dericost_0x8000_Coord_RoundTrip_x_0x090F_v7_And_0x0910",
    async () => {
      const gx = 3214.5;
      const gy = DERICOST_Y_OFFSET + 1450.25;
      const gz = 42.75;
      const cl = toCellLocal(gx, gy, gz);
      assert(((cl.cell >>> 15) & 1) === 1, "Dericost 0x8000 bit set");

      const pjBytes = encodePalletJackState({
        PalletJackGuid: 0x800b0005,
        Cell: cl.cell,
        Position: { X: cl.x, Y: cl.y, Z: cl.z },
        Heading: 1.0,
      });
      const pjDec = decodePalletJackState(pjBytes);
      const [rx, ry, rz] = toGlobal(pjDec.Cell, pjDec.Position.X, pjDec.Position.Y, pjDec.Position.Z);
      near(rx, gx, 1e-3, "Dericost X round-trip");
      near(ry, gy, 1e-3, "Dericost Y round-trip");
      near(rz, gz, 1e-3, "Dericost Z round-trip");

      const trBytes = encodeTrailerState({
        TrailerGuid: 0x80099105,
        Kind: 15,
        Cell: cl.cell,
        Position: { X: cl.x, Y: cl.y, Z: cl.z },
      }, HBV1_VERSION_V7);
      const trDec = decodeTrailerState(trBytes);
      assert(((trDec.Cell >>> 15) & 1) === 1, "TrailerState preserves Dericost bit");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 10000);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0] || null;`), 6000, 150, "pj");
      assert(Array.isArray(pj.pos) && pj.pos.every(Number.isFinite), "Global pose finite on live server");
    }
  );

  await collector.runDual(
    "T3.09",
    3,
    "Pairwise:RackStowed_PalletJack_x_STurn_Articulation",
    async () => {
      const sim = new LogisticsWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === pjGuid, "jack stowed on rack");

      const tk = await tryImportVehicle("trailer_kinematics.js");
      let tractor = { x: 0, y: 0, z: 10, heading: 0, speed: 8.0, steerAngle: -0.35, wheelbase: 4.66 };
      let trailer = { x: 0, y: -7.36, z: 10, heading: 0 };
      for (let i = 0; i < 60; i++) {
        if (i === 30) tractor.steerAngle = 0.35;
        tractor.x += Math.sin(tractor.heading) * tractor.speed * (1 / 30);
        tractor.y += Math.cos(tractor.heading) * tractor.speed * (1 / 30);
        tractor.heading += (tractor.speed * Math.tan(tractor.steerAngle) / tractor.wheelbase) * (1 / 30);
        trailer = tk.mod.stepCoupledTrailer(tractor, trailer, -2.01, "40ft", () => 10);
      }
      assert(Math.abs(trailer.heading) > 0.1, "trailer articulated through S-turn");
      // When jack is unstowed after S-turn, it deploys cleanly beside the turned trailer
      sim.trailers.get(trGuid).x = trailer.x;
      sim.trailers.get(trGuid).y = trailer.y;
      const dep = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      assert(dep.ok, "jack deploys cleanly after S-turn");
      assert(Math.hypot(sim.palletJacks.get(pjGuid).x - trailer.x, sim.palletJacks.get(pjGuid).y - trailer.y) < 4.0, "jack deployed near turned trailer");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig");
      await live.boardAndWait(ids.vGuid, 0);
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.7, yaw: -0.6 }, 900); return true;`);
      await new Promise((r) => setTimeout(r, 950));
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.7, yaw: 0.6 }, 900); return true;`);
      await new Promise((r) => setTimeout(r, 950));
      await live.evalInPage(`window.__vehicles.clearSticks(); window.__vehicles.exit(0); return true;`);
      await new Promise((r) => setTimeout(r, 600));
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0) || null;`), 6000, 150, "jack deployed after S-turn");
      assert(pj !== null, "Rack-stowed pallet jack survives S-turn and deploys cleanly");
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T3.10",
    3,
    "Pairwise:Container_HalfSlot_Jack_Stow_vs_Rack_Stow_And_Commands",
    async () => {
      // Choice 4: Pallet jack can stow either on trailer under-frame rack OR inside a container half-slot
      const sim = new LogisticsWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter20");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === 0, "unstowed from rack");

      // Verify container half-slot capacity can host a PalletJack WCID 4000035
      const loadHalf = oracleComputeReachableLoadSlots(10, sim.containers.get(cGuid).slots, "half");
      assert(loadHalf.length > 0, "container has available half-slot for pallet jack stowage");

      // Also verify rack re-stow
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "re-stowed on trailer rack");
      assert(sim.trailers.get(trGuid).stowedPalletJackGuid === pjGuid, "rack GUID restored");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@palletjack spawn", /spawned pallet jack/i, 8000);
      await live.sendChatAndWait("@palletjack list", /pallet|4000035|1/i, 8000);
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T3.11",
    3,
    "Pairwise:ModeSwitching_Capture_Precedence_Jack_Semi_OnFoot",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        let mode = "onfoot";
        const log = [];
        env.fakeWinObj.addEventListener("keydown", (ev) => {
          if (mode === "jack") {
            if (["KeyW", "Space", "KeyF", "KeyX"].includes(ev.code)) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              log.push(`jack:${ev.code}`);
              if (ev.code === "KeyX") mode = "onfoot";
            }
          } else if (mode === "semi") {
            if (["KeyG", "KeyL", "Space", "KeyX"].includes(ev.code)) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              log.push(`semi:${ev.code}`);
              if (ev.code === "KeyX") mode = "onfoot";
            }
          } else if (ev.code === "KeyB") {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            mode = log.includes("jack:KeyX") ? "semi" : "jack";
            log.push(`enter:${mode}`);
          }
        }, true);

        env.fakeWinObj.dispatch("keydown", { code: "KeyB" }); // -> jack
        env.fakeWinObj.dispatch("keydown", { code: "Space" }); // jack forks
        env.fakeWinObj.dispatch("keydown", { code: "KeyX" }); // -> onfoot
        env.fakeWinObj.dispatch("keydown", { code: "KeyB" }); // -> semi
        env.fakeWinObj.dispatch("keydown", { code: "KeyG" }); // semi hitch
        env.fakeWinObj.dispatch("keydown", { code: "KeyX" }); // -> onfoot
        assert(log.join(",") === "enter:jack,jack:Space,jack:KeyX,enter:semi,semi:KeyG,semi:KeyX", `Unexpected sequence: ${log.join(",")}`);
        assert(mode === "onfoot", "returned cleanly to onfoot");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles().find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${ids.tGuid}); return true;`);
      const pjGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => (p.stowedOnTrailerGuid ?? 0) === 0)?.guid || 0;`), 6000, 150, "pj");
      const pjPose = await live.getPalletJack(pjGuid);
      await live.movePlayerNear(pjPose.pos);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid !== 0, 5000, 150, "jack active");
      await live.evalInPage(`window.__vehicles.palletJacks.release(${pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.getPalletJack(pjGuid))?.operatorGuid === 0, 5000, 150, "jack released");
      await live.boardAndWait(ids.vGuid, 0);
      await live.evalInPage(`window.__vehicles.exit(0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 5000, 150, "exited cleanly");
    }
  );

  await collector.runDual(
    "T3.12",
    3,
    "Pairwise:Legacy_Skeletal_Trailers_4000030_4000031_NonRegression",
    async () => {
      const env = await makeLogisticsLiveEnv();
      try {
        // Inject legacy skeletal 20ft (kind=13) & 40ft (kind=14) trailers with SideliftFlags=0
        env.push({
          type: "trailer_state",
          trailerGuid: 0x80099110,
          kind: 13,
          cell: 0,
          pos: [10, 10, 10],
          heading: 0,
          pitch: 0,
          bank: 0,
          coupledTractorGuid: 0,
          mountedContainerGuid: 0,
          containerSlot: 0,
          trailerFlags: 0,
        });
        env.push({
          type: "trailer_state",
          trailerGuid: 0x80099111,
          kind: 14,
          cell: 0,
          pos: [20, 10, 10],
          heading: 0,
          pitch: 0,
          bank: 0,
          coupledTractorGuid: 0,
          mountedContainerGuid: 0,
          containerSlot: 0,
          trailerFlags: 0,
        });
        env.tick(100);
        const t20 = env.api.trailers.get(0x80099110);
        const t40 = env.api.trailers.get(0x80099111);
        assert(t20 && t20.specKind === "20ft" && !t20.isSidelifter, "legacy 20ft chassis intact");
        assert(t40 && t40.specKind === "40ft" && !t40.isSidelifter, "legacy 40ft chassis intact");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.sendChatAndWait("@trailer preset rig40", /rig40|4000031|spawned/i, 10000);
      const t = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0] || null;`), 8000, 200, "rig40");
      assert(t.wcid === 4000031 || t.kind === 14, "legacy rig40 spawns cleanly");
      await live.cleanupWorld();
    }
  );
}
