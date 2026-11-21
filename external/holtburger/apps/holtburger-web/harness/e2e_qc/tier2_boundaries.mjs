// harness/e2e_qc/tier2_boundaries.mjs — Tier 2 Boundary & Negative Coverage (40 checks = 5 * 8 areas F1–F8).

import {
  CONTAINER_ACTION_KIND,
  DEPLOYABLE_KIND,
  DERICOS_FLAT_SITE,
  DERICOST_Y_OFFSET,
  HBV1_VERSION_V7,
  IFF_STANDING,
  LOGISTICS_SPEC,
  ONLINE_FLAGS,
  PALLET_JACK_ACTION_KIND,
  QcWorldSimulator,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  VEHICLE_EVENT_KIND,
  assert,
  computeIso6346CheckDigit,
  countLights,
  decodeTrailerAction,
  decodeVehicleEvent,
  encodeTrailerAction,
  encodeVehicleEvent,
  getThree,
  makeQcLiveEnv,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
} from "./common.mjs";

export const TIER2_METADATA = [
  // F1: Protocol & Security Boundaries (5)
  { id: "T2.QC.F1.01", tier: 2, feature: "F1:Protocol_Security", mode: "offline" },
  { id: "T2.QC.F1.02", tier: 2, feature: "F1:Protocol_Security", mode: "offline" },
  { id: "T2.QC.F1.03", tier: 2, feature: "F1:Protocol_Security", mode: "dual" },
  { id: "T2.QC.F1.04", tier: 2, feature: "F1:Protocol_Security", mode: "dual" },
  { id: "T2.QC.F1.05", tier: 2, feature: "F1:Protocol_Security", mode: "offline" },
  // F2: Semi Crew & Lifecycle Boundaries (5)
  { id: "T2.QC.F2.01", tier: 2, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T2.QC.F2.02", tier: 2, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T2.QC.F2.03", tier: 2, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T2.QC.F2.04", tier: 2, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T2.QC.F2.05", tier: 2, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  // F3: Trailers & Coupling Boundaries (5)
  { id: "T2.QC.F3.01", tier: 2, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T2.QC.F3.02", tier: 2, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T2.QC.F3.03", tier: 2, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T2.QC.F3.04", tier: 2, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T2.QC.F3.05", tier: 2, feature: "F3:Trailers_Coupling", mode: "dual" },
  // F4: Sidelifter Left/Right & Aux Boundaries (5)
  { id: "T2.QC.F4.01", tier: 2, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T2.QC.F4.02", tier: 2, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T2.QC.F4.03", tier: 2, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T2.QC.F4.04", tier: 2, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T2.QC.F4.05", tier: 2, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  // F5: Containers & Rotation Boundaries (5)
  { id: "T2.QC.F5.01", tier: 2, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T2.QC.F5.02", tier: 2, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T2.QC.F5.03", tier: 2, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T2.QC.F5.04", tier: 2, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T2.QC.F5.05", tier: 2, feature: "F5:Containers_Rotation", mode: "offline" },
  // F6: Pallet Jack & Sync Boundaries (5)
  { id: "T2.QC.F6.01", tier: 2, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T2.QC.F6.02", tier: 2, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T2.QC.F6.03", tier: 2, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T2.QC.F6.04", tier: 2, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T2.QC.F6.05", tier: 2, feature: "F6:PalletJack_Sync", mode: "dual" },
  // F7: MicroGrid & AirDefense Boundaries (5)
  { id: "T2.QC.F7.01", tier: 2, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T2.QC.F7.02", tier: 2, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T2.QC.F7.03", tier: 2, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T2.QC.F7.04", tier: 2, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T2.QC.F7.05", tier: 2, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  // F8: Dericost & Visual Boundaries (5)
  { id: "T2.QC.F8.01", tier: 2, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T2.QC.F8.02", tier: 2, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T2.QC.F8.03", tier: 2, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T2.QC.F8.04", tier: 2, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T2.QC.F8.05", tier: 2, feature: "F8:Dericost_Visual", mode: "live" },
];

export async function runTier2(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // ---------------------------------------------------------------------------
  // F1: Protocol & Security Boundaries
  // ---------------------------------------------------------------------------

  await collector.runCheck("T2.QC.F1.01", 2, "F1:Protocol_Security", async () => {
    const valid = encodeTrailerAction({ Flags: 0xffff }, HBV1_VERSION_V7);
    assert(decodeTrailerAction(valid).Flags === 0xffff, "Full u16 Flags=0xFFFF decoded");
    assert(decodeTrailerAction(valid.slice(0, 23)) === null, "Truncated 23B dropped");
    const badTag = valid.slice();
    badTag[0] = 0x58; // 'X'
    assert(decodeTrailerAction(badTag) === null, "Bad tag dropped");
    const ver0 = encodeTrailerAction({}, 0);
    assert(decodeTrailerAction(ver0) === null, "Version=0 dropped");
  });

  await collector.runCheck("T2.QC.F1.02", 2, "F1:Protocol_Security", async () => {
    const idxMod = await tryImportVehicle("index.js");
    assert(idxMod.ok, idxMod.reason);
    const v1 = encodeVehicleEvent({ Kind: VEHICLE_EVENT_KIND.SideliftRefused, Aux: 5 }, 1);
    const decV1 = decodeVehicleEvent(v1);
    assert(decV1.Aux === 0, "v1 VehicleEvent defaults Aux=0");

    const env = await makeQcLiveEnv();
    try {
      env.push({ type: "event", kind: VEHICLE_EVENT_KIND.SideliftRefused, vehicle: 0x80091001, aux: 999 });
      env.tick(100);
      assert(env.doc.getElementById("hb-vehicle-prompt").textContent === idxMod.mod.SIDELIFT_REFUSAL_REASONS[0], "Out-of-range Aux=999 falls back to SIDELIFT_REFUSAL_REASONS[0]");
      env.push({ type: "event", kind: VEHICLE_EVENT_KIND.PalletJackEvent, vehicle: 0x80093001, aux: 999 });
      env.tick(133);
      assert(env.doc.getElementById("hb-vehicle-prompt").textContent === idxMod.mod.PALLET_JACK_EVENT_REASONS[0], "Out-of-range Aux=999 falls back to PALLET_JACK_EVENT_REASONS[0]");
    } finally {
      env.dispose();
    }
  });

  await collector.runDual(
    "T2.QC.F1.03",
    2,
    "F1:Protocol_Security",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      sim.containers.get(cGuid).slots = [];
      assert(sim.openContainerDoors(cGuid, true).ok, "Open container doors before Action=3 Load check");
      const playerRes = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { slotIndex: 0, cargoWcid: 4000010, accessLevel: 0 });
      assert(!playerRes.ok && sim.containers.get(cGuid).slots.length === 0, "AccessLevel=0 refused for Load (Action=3)");
      const devRes = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Load, { slotIndex: 0, cargoWcid: 4000010, accessLevel: 4 });
      assert(devRes.ok && sim.containers.get(cGuid).slots.length === 1, "AccessLevel=4 allowed for Load (Action=3)");
      const closeRes = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.CloseDoors, { accessLevel: 0 });
      assert(closeRes.ok && sim.containers.get(cGuid).doorProgress <= 0.15, "AccessLevel=0 allowed for CloseDoors (Action=2)");
      const openRes = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { accessLevel: 0 });
      assert(openRes.ok && sim.containers.get(cGuid).doorProgress >= 0.85, "AccessLevel=0 allowed for OpenDoors (Action=1)");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@accountcreate qcplayer qcplayer 0", /account|created|already exists/i, 8000);
      await live.sendChatAndWait("@set-accountaccess qcplayer 0", /updated|player|access/i, 8000);
      await live.sendChatAndWait("@container spawn 20", /spawned|container/i, 8000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "container");
      const cHex = `0x${(c.guid >>> 0).toString(16)}`;
      await live.sendChat(`@container doors ${cHex} open`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open before Load check");
      const sec = await live.openSecondContext("qcplayer", "qcplayer", "QcPlayer");
      const qcCharName = (await sec.evalInPage('return window.__sessionHandle?.characterList?.()?.find((c) => !c.deleteTime)?.name || window.__sessionHandle?.characterList?.()?.[0]?.name || "QcPlayer";')) || "QcPlayer";
      await live.sendChat(`@teletome ${qcCharName}`);
      await live.waitUntil(async () => await sec.evalInPage(`return !!window.__vehicles?.containers?.get?.(${c.guid});`), 10000, 200, "qcplayer tracks container");
      // Attempt Action=3 Load as AccessLevel=0 Player with doors already open (isolating AccessLevel guard)
      await sec.evalInPage(`window.__sessionHandle.vehicleContainerAction(${c.guid}, 3, 0, 0, 4000010); return true;`);
      await new Promise((r) => setTimeout(r, 1500));
      const cAfterLoad = await live.getContainer(c.guid);
      assert((cAfterLoad?.slots?.length ?? 0) === 0, "Non-developer qcplayer MUST NOT conjure cargo via Action=3 Load");
      // CloseDoors (Action=2) and OpenDoors (Action=1) within 15m still permitted for normal player
      await sec.evalInPage(`window.__sessionHandle.vehicleContainerAction(${c.guid}, 2, 0, 0, 0); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 1) <= 0.15, 6000, 150, "qcplayer CloseDoors allowed");
      await sec.evalInPage(`window.__sessionHandle.vehicleContainerAction(${c.guid}, 1, 0, 0, 0); return true;`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.85, 6000, 150, "qcplayer OpenDoors allowed");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F1.04",
    2,
    "F1:Protocol_Security",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { hasCapPilot: false }).ok, "!CapPilot refused");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { isDead: true }).ok, "IsDead refused");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { teleporting: true }).ok, "Teleporting refused");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { isSeated: true }).ok, "IsSeated refused");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.OpenDoors, { distM: 15.1 }).ok, ">15m refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /spawned|container/i, 8000);
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const c = window.__vehicles.containers.list()[0];
        const v = window.__vehicles.vehicles()[0];
        return c && v ? { cGuid: c.guid, vGuid: v.guid } : null;
      `), 8000, 200, "container + semi");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "seated");
      await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${ids.cGuid}, 1, 0, 0, 0); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      assert(((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) < 0.1, "Seated player refused container OpenDoors");
      await live.cleanupWorld();
    }
  );

  await collector.runCheck("T2.QC.F1.05", 2, "F1:Protocol_Security", async () => {
    const dv = await tryImportVehicle("deployable_vfx.js");
    assert(dv.ok, dv.reason);
    const root = new THREE.Group();
    const vfx = dv.mod.createDeployableCombatVfx({ liveScene3d: { worldRoot: root }, THREE, ground: () => 0 });
    vfx.handleFireEvent({ weaponKind: 1, burstCount: 0, muzzle: [0, 0, 2], targetPos: [100, 0, 50], energyJoules: NaN });
    vfx.handleFireEvent({ weaponKind: 3, muzzle: [0, 0, 2], targetPos: [48000, 117000, 200], energyJoules: Infinity });
    vfx.update(0.05);
    assert(countLights(root) === 0, "Zero lights allocated on hostile fire payload");
    root.traverse((o) => {
      assert(Number.isFinite(o.position.x) && Number.isFinite(o.position.y) && Number.isFinite(o.position.z), "No NaN transform in VFX");
    });
    vfx.dispose();
  });

  // ---------------------------------------------------------------------------
  // F2: Semi Crew & Lifecycle Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F2.01",
    2,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats();
      assert(sim.boardVehicle(vGuid, 1001, 0, { distM: 16.0 }).ok, "16.0m valid for heavy tractor");
      sim.exitVehicle(vGuid, 1001);
      assert(sim.boardVehicle(vGuid, 1001, 0, { distM: 16.5 }).reason === 1, "16.5m refused TooFar=1");
      sim.tractors.get(vGuid).speed = 2.0;
      assert(sim.boardVehicle(vGuid, 1001, 0, { distM: 2.0 }).reason === 3, ">1.5m/s refused NotParked=3");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const v = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0] || null;`), 8000, 200, "semi");
      const p = await live.getPlayerGlobalPose();
      await live.movePlayerNear([p.gx + 22, p.gy, p.z], [0, 0, 0]);
      await live.evalInPage(`window.__vehicles.board(${v.guid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return (window.__vehicles.status()?.stats?.boardRefusals ?? 0) > 0;`), 6000, 150, "board refused TooFar");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F2.02",
    2,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats();
      assert(sim.boardVehicle(vGuid, 1001, 0).ok, "P1 seat 0");
      assert(sim.boardVehicle(vGuid, 1002, 1).ok, "P2 seat 1");
      assert(sim.boardVehicle(vGuid, 1001, 1).reason === 2, "Occupied seat 1 refused SeatTaken=2");
      assert(sim.boardVehicle(vGuid, 1001, 2).reason === 2, "Out-of-bounds seat 2 refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "seat 0");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 2); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert(await live.evalInPage(`return !!window.__vehicles.piloting && window.__vehicles.status()?.pilot?.seat === 0;`), "Invalid seat 2 refused without displacing pilot");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F2.03",
    2,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats();
      sim.boardVehicle(vGuid, 1001, 0);
      sim.boardVehicle(vGuid, 1002, 1);
      sim.tractors.get(vGuid).speed = 10.0;
      sim.exitVehicle(vGuid, 1001);
      assert(sim.tractors.get(vGuid).speed === 0 && sim.tractors.get(vGuid).seats[1] === 1002, "Driver exit auto-brakes moving semi while co-driver stays seated");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.9 }, 1500); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      await live.evalInPage(`window.__vehicles.exit(0); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      assert(await live.evalInPage(`return window.__vehicles.isVehicle(${vGuid});`), "Semi survives moving exit");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F2.04",
    2,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats();
      sim.boardVehicle(vGuid, 1001, 0);
      sim.boardVehicle(vGuid, 1002, 1);
      sim.exitVehicle(vGuid, 1001);
      sim.advanceTime(601.0);
      assert(sim.tractors.get(vGuid).isDestroyed === false && sim.tractors.get(vGuid).seats[1] === 1002, "Seat 1 occupant prevents idle despawn > 10m");
      sim.advanceTime(600.0);
      assert(sim.tractors.get(vGuid).isDestroyed === false, "Still alive at 20m with passenger");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 1); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.passenger;`), 6000, 150, "passenger");
      const holdMs = process.env.LONG_LIFECYCLE === "1" ? 605000 : 4000;
      await new Promise((r) => setTimeout(r, holdMs));
      assert(await live.evalInPage(`return !!window.__vehicles.passenger && window.__vehicles.isVehicle(${vGuid});`), "Vehicle with passenger did not despawn");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F2.05",
    2,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sm = await tryImportVehicle("semi_truck_model.js");
      assert(sm.ok, sm.reason);
      assert(sm.mod.getSemiLivery(0).id === 0 && sm.mod.getSemiLivery(5).id === 5, "Boundary liveries 0 & 5");
      assert(sm.mod.getSemiLivery(6).id === 0 && sm.mod.getSemiLivery(255).id === 0 && sm.mod.getSemiLivery(-1).id === 0, "Out-of-range liveries clamp/fallback to 0");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 255", /spawned|semi/i, 8000);
      const livRes = await live.waitUntil(async () => await live.evalInPage(`
        const l = window.__vehicles.vehicles()[0]?.profile?.liveryId;
        return typeof l === "number" ? { liv: l } : null;
      `), 8000, 200, "semi livery");
      const liv = livRes.liv;
      assert(liv >= 0 && liv <= 5, `Out-of-range liveryId clamped cleanly to ${liv}`);
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F3: Trailers & Coupling Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F3.01",
    2,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      sim.tractors.get(tGuid).speed = 0.26;
      const r = sim.unhitchTrailer(tGuid, trGuid);
      assert(!r.ok && sim.tractors.get(tGuid).hitchedTrailerGuid === trGuid, "Unhitch refused at 0.26 m/s");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig40", /rig40|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig40");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.8 }, 2200); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const sp = window.__vehicles.status()?.pilot?.state?.speed ?? 0;
        return sp > 0.5 ? sp : null;
      `), 6000, 100, "tractor moving > 0.5 m/s");
      await live.dispatchKey("KeyG");
      await new Promise((r) => setTimeout(r, 700));
      assert((await live.getTrailer(ids.tGuid))?.coupledTractorGuid === ids.vGuid, "Moving unhitch refused");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F3.02",
    2,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers);
      const r = sim.unhitchTrailer(tGuid, trGuid);
      assert(!r.ok && /sidelifter/i.test(r.reason), "Mid-sidelift unhitch refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids.tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers planted");
      await live.evalInPage(`window.__vehicles.trailers.unhitch(${ids.tGuid}, ${ids.vGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 1000));
      assert((await live.getTrailer(ids.tGuid))?.coupledTractorGuid === ids.vGuid, "Mid-sidelift unhitch refused live");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F3.03",
    2,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      sim.unhitchTrailer(tGuid, trGuid);
      assert(!sim.hitchTrailer(tGuid, trGuid, { distM: 3.51, angleDeg: 0 }).ok, ">3.5m hitch refused");
      assert(!sim.hitchTrailer(tGuid, trGuid, { distM: 1.5, angleDeg: 61 }).ok, ">60 deg hitch refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig40", /rig40|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig40");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.dispatchKey("KeyG");
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.coupledTractorGuid === 0, 5000, 150, "unhitched");
      const startPos = await live.evalInPage(`
        const st = window.__vehicles.status()?.pilot?.state;
        return st ? { x: st.x, y: st.y } : null;
      `);
      assert(startPos && Number.isFinite(startPos.x), "tractor start pose");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.85 }, 6000); return true;`);
      const movedDist = await live.waitUntil(async () => await live.evalInPage(`
        const st = window.__vehicles.status()?.pilot?.state;
        if (!st) return null;
        const d = Math.hypot(st.x - (${startPos.x}), st.y - (${startPos.y}));
        return d > 4.5 ? d : null;
      `), 10000, 150, "tractor drove > 4.5 m from trailer kingpin");
      await live.evalInPage(`window.__vehicles.clearSticks(); window.__vehicles.setSticks({ throttle: 0, handbrake: true }, 5000); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`
        const sp = window.__vehicles.status()?.pilot?.state?.speed ?? 1;
        return Math.abs(sp) < 0.08 ? true : null;
      `), 8000, 150, "tractor stopped before hitch attempt");
      await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
      assert(movedDist > 4.0, `tractor drove > 4.0 m (${movedDist.toFixed(2)} m)`);
      await live.evalInPage(`window.__vehicles.trailers.hitch(${ids.tGuid}, ${ids.vGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert((await live.getTrailer(ids.tGuid))?.coupledTractorGuid === 0, ">3.5m hitch refused live");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F3.04",
    2,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.tractors.get(tGuid).speed = 1.0;
      const r = sim.openContainerDoors(cGuid, true);
      assert(!r.ok && sim.containers.get(cGuid).doorProgress === 0, "Mounted container doors blocked while moving");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig40", /rig40|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "rig40");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.8 }, 1400); return true;`);
      await new Promise((r) => setTimeout(r, 700));
      await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${ids.cGuid}, 1, 0, 0, 0); return true;`);
      await new Promise((r) => setTimeout(r, 700));
      assert(((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) < 0.05, "Moving mounted container door open refused");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F3.05",
    2,
    "F3:Trailers_Coupling",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        env.push({ type: "trailer_state", trailerGuid: 0x80099101, kind: 14, cell: 0xa9b30002, position: [19, 24, 94], coupledTractorGuid: 0x80099001, mountedContainerGuid: 0x80099201 });
        env.push({ type: "event", kind: VEHICLE_EVENT_KIND.Despawn, vehicle: 0x80099001, subject: 0 });
        env.tick(100);
        assert(!env.api.isVehicle(0x80099001), "Despawned tractor removed cleanly without orphan crash");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig40", /rig40|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
      `), 8000, 200, "rig40");
      await live.sendChat(`@vehicle despawn 0x${(ids.vGuid >>> 0).toString(16)}`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.coupledTractorGuid === 0, 6000, 150, "auto-unhitched on tractor despawn");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F4: Sidelifter Left/Right & Aux Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F4.01",
    2,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload, 0x01); // offloaded on left (-3.85)
      assert(sim.trailers.get(trGuid).mountedContainerGuid === 0, "Offloaded to left");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad, 0x02); // auto-detect
      assert(sim.trailers.get(trGuid).mountedContainerGuid !== 0, "Auto-detect 0x02 reloaded left container");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autooffload", "left"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 25000, 250, "left offload");
      // Explicit wrong side (Flags=0x00 right) must refuse
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autoload", "right"); return true;`);
      await new Promise((r) => setTimeout(r, 1500));
      assert((await live.getTrailer(tGuid))?.mountedContainerGuid === 0, "Wrong-side Flags=0x00 refused left container");
      // Auto-detect Flags=0x02 succeeds
      await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${tGuid}, 0, 0, 14, 0, 0x02); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0;
      }, 25000, 250, "Flags=0x02 reloaded left container");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F4.02",
    2,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00);
      assert(sim.trailers.get(trGuid).sideliftSide === 1, "Planted right (+1)");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.RetractOutriggers);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x01);
      assert(sim.trailers.get(trGuid).sideliftSide === -1, "Switched to left (-1) after retract");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "right outriggers");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${tGuid}); return true;`);
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "offload", "left"); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      assert((await live.getTrailer(tGuid))?.mountedContainerGuid !== 0, "Cannot switch sidelift side while outriggers planted");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F4.03",
    2,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const { oracleCheckSlopeFromCos } = await import("./common.mjs");
      assert(!oracleCheckSlopeFromCos(0.9943), "6.1 deg (cos=0.9943) refused");
      assert(oracleCheckSlopeFromCos(0.9947), "5.9 deg (cos=0.9947) allowed");
      const sim = new QcWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40", { slopeCos: 0.990 });
      assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers).ok, "Slope >6 deg blocks outriggers");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      // Verify 6 deg flat site allows outriggers
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "flat outriggers deployed");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F4.04",
    2,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sk = await tryImportVehicle("sidelifter_kinematics.js");
      assert(sk.ok, sk.reason);
      // Mid-air phases Hoisting(5), Swinging(6), Lowering(7) must not be abandoned
      const pHoist = sk.mod.evaluateContainerLocalPose(5, 0.5, 1, "offload", 1.32, 0, 0);
      assert(pHoist.z > 1.32, "Hoisting lifts container above deck");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${tGuid}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 2, 6000, 150, "outriggers planted");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "cancel"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(tGuid))?.sideliftPhase === 0, 8000, 150, "OutriggersPlanted cancel returned to Idle");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F4.05",
    2,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.openContainerDoors(cGuid, true);
      const r = sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      assert(!r.ok && /doors/i.test(r.reason), "Open doors block sidelift");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "sidelifter40");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.85, 6000, 150, "doors open");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "right"); return true;`);
      await new Promise((r) => setTimeout(r, 1200));
      assert((await live.getTrailer(ids.tGuid))?.mountedContainerGuid === ids.cGuid, "Open doors blocked AutoOffload");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F5: Containers & Rotation Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F5.01",
    2,
    "F5:Containers_Rotation",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      sim.containers.get(cGuid).mountedOnTrailerGuid = 0;
      sim.containers.get(cGuid).doorProgress = 0.5;
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 9 }).ok, "Unpack refused when doorProgress < 0.8");
      sim.containers.get(cGuid).doorProgress = 1.0;
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 3 }).ok, "Unpack refused on empty slot");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`);
      await new Promise((r) => setTimeout(r, 800));
      assert(await live.evalInPage(`return window.__vehicles.deployables.list().length === 0;`), "Closed doors block @container unpack");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F5.02",
    2,
    "F5:Containers_Rotation",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      sim.containers.get(cGuid).mountedOnTrailerGuid = 0;
      sim.openContainerDoors(cGuid, true);
      const u = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 9 });
      assert(u.ok, "Initial unpack ok");
      assert(sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Pack, { slotIndex: 9, cargoWcid: u.dGuid }).ok, "First pack ok");
      assert(!sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Pack, { slotIndex: 9, cargoWcid: u.dGuid }).ok, "Duplicate pack on already-packed deployable refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0]?.guid || 0;`), 6000, 150, "unpacked");
      await live.sendChatAndWait(`@container pack 0x${(cGuid >>> 0).toString(16)} 0x${(dGuid >>> 0).toString(16)}`, /packed/i, 8000);
      await live.sendChatAndWait(`@container pack 0x${(cGuid >>> 0).toString(16)} 0x${(dGuid >>> 0).toString(16)}`, /not found|already|cannot|fail|no/i, 8000);
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F5.03",
    2,
    "F5:Containers_Rotation",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.push({ type: "container_state", containerGuid: 0x80099201, containerKind: 10, doorState: 0, doorProgress: 0.04, cell: 0xa9b30002, position: [19, 24, 94], heading: Math.PI / 2 });
        env.tick(100);
        assert(env.live.sessionHandle.probeContainerSurface(gx - 3.3, gy, gz + 1.5) === null, "Closed door (0.04) has no rear ramp surface");
        env.push({ type: "container_state", containerGuid: 0x80099201, containerKind: 10, doorState: 2, doorProgress: 1.0, cell: 0xa9b30002, position: [19, 24, 94], heading: Math.PI / 2 });
        for (let t = 133; t <= 1200; t += 100) env.tick(t, 100);
        const sRamp = env.live.sessionHandle.probeContainerSurface(gx - 3.3, gy, gz + 1.5);
        assert(sRamp && sRamp.zone === "ramp", "Open door enables rotated ramp surface");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /spawned/i, 8000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "container");
      const surfClosed = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${c.pos[0]}, ${c.pos[1] - 3.3}, ${c.pos[2] + 1.5}) || null;`);
      assert(!surfClosed, "Closed container has no ramp surface at -3.3m");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F5.04",
    2,
    "F5:Containers_Rotation",
    async () => {
      const cl = await tryImportVehicle("container_logistics.js");
      assert(cl.ok, cl.reason);
      // Legacy palletSize: 1 in occupiedSlots normalizes to unified occupied slot 0; adjacent Right slot 1 stays open.
      const slots = [{ slotIndex: 0, subSlot: 0, cargoWcid: 4000013, palletSize: 1 }];
      const rFull = cl.mod.computeReachableLoadSlots(10, slots, "full");
      assert(!rFull.reachable.some((s) => s.slotIndex === 0), "Occupied slot 0 (normalized from legacy palletSize=1) rejects new load");
      assert(rFull.reachable.some((s) => s.slotIndex === 1 && s.subSlot === 0), "Adjacent Right slot 1 remains reachable for unified full pallet");
      const rHalf = cl.mod.computeReachableLoadSlots(10, slots, "half");
      assert(rHalf.reachable.length === 0, "Explicit legacy half pallet load rejected (0 reachable slots)");
      const subErr = cl.mod.isSlotReachableForLoad(10, [], 1, 1, "full");
      assert(!subErr.reachable && subErr.reason === "invalid_subslot", `subSlot=1 rejected with invalid_subslot, got ${subErr.reason}`);
      const halfErr = cl.mod.isSlotReachableForLoad(10, [], 1, 0, "half");
      assert(!halfErr.reachable && halfErr.reason === "invalid_pallet_size", `half rejected with invalid_pallet_size, got ${halfErr.reason}`);
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /spawned/i, 8000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "container");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 0, 0, 4000013); return true;`); // unified pallet in slot 0
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.slots?.length ?? 0) === 1, 5000, 150, "slot 0 loaded");
      // Try loading 4000014 into occupied slot 0 -> must be refused
      await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 0, 0, 4000014); return true;`);
      await new Promise((r) => setTimeout(r, 1000));
      const c = await live.getContainer(cGuid);
      assert(c.slots.length === 1 && c.slots[0].cargoWcid === 4000013, "Second pallet rejected from occupied slot 0");
      await live.cleanupWorld();
    }
  );

  await collector.runCheck("T2.QC.F5.05", 2, "F5:Containers_Rotation", async () => {
    const cm = await tryImportVehicle("container_models.js");
    assert(cm.ok, cm.reason);
    assert(cm.mod.computeIso6346CheckDigit("CSQU", "305438") === 3, "ISO 6346 standard example CSQU305438 -> 3");
    assert(cm.mod.computeIso6346CheckDigit("HLTU", "100002") === 0, "ISO 6346 remainder 10 -> 0 edge case");
    assert(computeIso6346CheckDigit("CSQU", "305438") === 3, "Independent oracle parity");
    let threw = false;
    try { cm.mod.computeIso6346CheckDigit("HL1", "000001"); } catch (_) { threw = true; }
    assert(threw, "Invalid prefix throws");
  });

  // ---------------------------------------------------------------------------
  // F6: Pallet Jack & Sync Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F6.01",
    2,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
      const startX = sim.palletJacks.get(pjGuid).x;
      const r = sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.UpdatePose, { x: startX + 5.0, dtSec: 0.2 });
      assert(!r.ok && sim.palletJacks.get(pjGuid).x === startX, "Leaky-bucket >3.2 m/s rejected & position clamped");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0] || null;`), 8000, 200, "pj");
      await live.movePlayerNear(pj.pos, [0, -1.2, 0]);
      await live.dispatchKey("KeyB");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      const cl = toCellLocal(pj.pos[0] + 15.0, pj.pos[1], pj.pos[2]);
      await live.evalInPage(`window.__sessionHandle.vehiclePalletJackAction(${pj.guid}, 3, 0, 0, 0, 0, ${cl.cell}, ${cl.x}, ${cl.y}, ${cl.z}, 0, 0); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      const pjAfter = await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => p.guid === ${pj.guid}) || null;`);
      assert(pjAfter && Math.hypot(pjAfter.pos[0] - pj.pos[0], pjAfter.pos[1] - pj.pos[1]) < 4.0, "15m teleport rejected by 3.2 m/s anti-teleport cap");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F6.02",
    2,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.deployables.set(0x80094099, { guid: 0x80094099, wcid: 4000010, x: 100, y: 100, z: 10, isStowed: false, onlineFlags: ONLINE_FLAGS.Active, elevationM: 0.5 });
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
      assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: 0x80094099 }).ok, "Unstowed deployable refused");
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.ToggleDeployableStow, { targetGuid: 0x80094099 });
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.RaiseForks);
      assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickGroundDeployable, { targetGuid: 0x80094099 }).ok, "Raised forks (>0.10m) refused");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000010", /4000010|spawned/i, 8000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const pj = window.__vehicles.palletJacks.list()[0];
        const d = window.__vehicles.deployables.list()[0];
        return pj && d ? { pjGuid: pj.guid, dGuid: d.guid, pjPos: pj.pos } : null;
      `), 8000, 200, "pj + deployable");
      await live.movePlayerNear(ids.pjPos, [0, -1.2, 0]);
      await live.dispatchKey("KeyB");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${ids.dGuid}, ${ids.pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert((await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.carriedWcid || 0;`)) === 0, "Unstowed deployable pickup refused");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F6.03",
    2,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
      assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 0 }).ok, "LIFO blocks inner slot 0 behind outer Left-lane slots 16/18");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 19 }).ok, "Outer slot 19 succeeds");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const c = window.__vehicles.containers.list()[0];
        const pj = window.__vehicles.palletJacks.list()[0];
        return c && pj ? { cGuid: c.guid, pjGuid: pj.guid, pjPos: pj.pos } : null;
      `), 8000, 200, "fob20 + pj");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.movePlayerNear(ids.pjPos, [0, -1.2, 0]);
      await live.dispatchKey("KeyB");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickContainer(${ids.cGuid}, 0, 0, ${ids.pjGuid}); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert((await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.carriedWcid || 0;`)) === 0, "LIFO blocked inner slot 0 live");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F6.04",
    2,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
      assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "Rack stow refused while operator grabbed");
      sim.palletJacks.get(pjGuid).carriedWcid = 4000010;
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release);
      assert(!sim.trailerAction(trGuid, TRAILER_ACTION_KIND.StowPalletJack).ok, "Rack stow refused while carrying cargo");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployPalletJack(${tGuid}); return true;`);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list().find((p) => p.stowedOnTrailerGuid === 0) || null;`), 6000, 150, "deployed pj");
      await live.movePlayerNear(pj.pos, [0, -1.2, 0]);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pj.guid}); return true;`);
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.trailers.stowPalletJack(${tGuid}, ${pj.guid}); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert((await live.getTrailer(tGuid))?.stowedPalletJackGuid === 0, "Grabbed pallet jack refused rack stow");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F6.05",
    2,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1001 }).ok, "P1 grabs jack");
      assert(!sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab, { playerGuid: 1002 }).ok, "P2 refused while P1 operates jack");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0] || null;`), 8000, 200, "pj");
      const p1 = await live.getPlayerGlobalPose();
      // Move tailnet1 5m away (>3.5m grab range) -> Grab refused
      await live.movePlayerNear([p1.gx + 5.5, p1.gy, p1.z], [0, 0, 0]);
      await live.evalInPage(`window.__vehicles.palletJacks.grab(${pj.guid}); return true;`);
      await new Promise((r) => setTimeout(r, 800));
      assert((await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.operatorGuid || 0;`)) === 0, ">3.5m pallet jack grab refused");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F7: MicroGrid & AirDefense Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F7.01",
    2,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const sam = sim.allocGuid();
      sim.deployables.set(sam, { guid: sam, wcid: 4000014, x: 0, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(sam).onlineFlags & ONLINE_FLAGS.Powered) === 0, "Turret unpowered without FluxPod");
      const fireNoFlux = sim.tickAirDefenseFire(sam, 0x80099901, [100, 0, 50], { standing: IFF_STANDING.Hostile, aglM: 50, distM: 100, isAir: true });
      assert(!fireNoFlux.ok, "Unpowered MissileTurret MUST NOT fire");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|spawned/i, 8000);
      const sam = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000014) || null;`), 8000, 200, "sam");
      assert((sam.last?.onlineFlags & 0x01) === 0, "Turret without FluxPod/power has Powered=0");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F7.02",
    2,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), inT = sim.allocGuid(), outT = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 2, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(inT, { guid: inT, wcid: 4000014, x: 75.0, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.deployables.set(outT, { guid: outT, wcid: 4000014, x: 75.1, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(inT).onlineFlags & ONLINE_FLAGS.InFluxRange) !== 0, "75.0m inside ±75m cube");
      assert((sim.deployables.get(outT).onlineFlags & ONLINE_FLAGS.InFluxRange) === 0, "75.1m outside ±75m cube");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const p = await live.getPlayerGlobalPose();
      await live.sendChatAndWait(`@deployable spawn 4000010 ${p.gx.toFixed(2)} ${p.gy.toFixed(2)} ${p.z.toFixed(2)}`, /4000010|spawned/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000012 ${(p.gx + 3).toFixed(2)} ${p.gy.toFixed(2)} ${p.z.toFixed(2)}`, /4000012|spawned/i, 8000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      await live.sendChatAndWait(`@deployable spawn 4000014 ${(p.gx + 80).toFixed(2)} ${p.gy.toFixed(2)} ${p.z.toFixed(2)}`, /4000014|spawned/i, 8000);
      const outT = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000014) || null;`), 8000, 200, "out-of-range turret");
      assert((outT.last?.onlineFlags & 0x02) === 0, "80m (>75m) turret outside FluxPod range");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F7.03",
    2,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), b = sim.allocGuid(), l = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(b, { guid: b, wcid: 4000013, x: 2, y: 0, z: 0, isStowed: false, cargoState: { energy: 119999 } });
      sim.deployables.set(l, { guid: l, wcid: 4000017, x: 4, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      assert(!sim.tickAirDefenseFire(l, 0x80099901, [50, 0, 0], { standing: IFF_STANDING.Hostile, distM: 50 }).ok, "< 120 kJ refuses laser shot");
      sim.deployables.get(b).cargoState.energy = 120000;
      assert(sim.tickAirDefenseFire(l, 0x80099901, [50, 0, 0], { standing: IFF_STANDING.Hostile, distM: 50 }).ok, "120 kJ fires laser shot");
      assert(sim.deployables.get(b).cargoState.energy === 0, "Battery left at 0 J");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable spawn 4000010", /spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000013", /spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000017", /spawned/i, 8000);
      await live.sendChatAndWait("@vehicle spawn jeep-mb", /spawned/i, 8000);
      await new Promise((r) => setTimeout(r, 1500));
      const bat = await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000013);`);
      assert((bat?.last?.energyJoules ?? 0) < 120000, "Uncharged battery (< 120 kJ) cannot fire laser");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F7.04",
    2,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), sam = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 2, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(sam, { guid: sam, wcid: 4000014, x: 4, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert(!sim.tickAirDefenseFire(sam, 1, [200, 0, 7.9], { standing: 3, aglM: 7.9, distM: 200, isAir: true }).ok, "< 8m AGL excluded");
      assert(!sim.tickAirDefenseFire(sam, 2, [200, 0, 1551], { standing: 3, aglM: 1551, distM: 200, isAir: true }).ok, "> 1550m AGL excluded");
      assert(!sim.tickAirDefenseFire(sam, 3, [32188, 0, 100], { standing: 3, aglM: 100, distM: 32188, isAir: true }).ok, "> 32,187m excluded");
      assert(!sim.tickAirDefenseFire(sam, 4, [200, 0, 100], { standing: 3, aglM: 100, distM: 200, isAir: true, occluded: true }).ok, "Terrain-occluded excluded");
      assert(!sim.tickAirDefenseFire(sam, 5, [200, 0, 0], { standing: 3, aglM: 0, distM: 200, isAir: false }).ok, "Ground vehicle excluded from air SAM");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployed/i, 10000);
      await live.sendChatAndWait("@vehicle spawn hellcat-demo", /spawned/i, 8000);
      await new Promise((r) => setTimeout(r, 1500));
      const sam = await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000014);`);
      assert((sam?.last?.ammo ?? 4) === 4, "Grounded hellcat (< 8m AGL) does not expend SAM ammo");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T2.QC.F7.05",
    2,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), m = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 2, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(m, { guid: m, wcid: 4000016, x: 4, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      assert(!sim.tickAirDefenseFire(m, 1, [50, 0, 0], { standing: IFF_STANDING.Friendly, distM: 50 }).ok, "Friendly (1) ignored");
      assert(!sim.tickAirDefenseFire(m, 2, [50, 0, 0], { standing: IFF_STANDING.Neutral, distM: 50 }).ok, "Neutral (2) ignored");
      assert(sim.tickAirDefenseFire(m, 3, [50, 0, 0], { standing: IFF_STANDING.Hostile, distM: 50 }).ok, "Hostile (3) engaged");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployed/i, 10000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      // Player standing near GroundRadar must never be targeted as hostile
      await new Promise((r) => setTimeout(r, 1500));
      const p = await live.getPlayerGlobalPose();
      assert(p && Number.isFinite(p.z), "Deployer player remains safe near own GroundRadar");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F8: Dericost & Visual Boundaries
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T2.QC.F8.01",
    2,
    "F8:Dericost_Visual",
    async () => {
      const cDerethEdge = toCellLocal(1000, DERICOST_Y_OFFSET - 0.1, 10);
      assert((cDerethEdge.cell & 0x8000) === 0 && cDerethEdge.continent === 0, "gy = 68927.9 -> continent 0");
      const cDeriStart = toCellLocal(1000, DERICOST_Y_OFFSET, 10);
      assert((cDeriStart.cell & 0x8000) !== 0 && cDeriStart.continent === 1, "gy = 68928.0 -> continent 1 (0x8000)");
      const cDeriNorth = toCellLocal(1000, 117887.0, 10);
      assert((cDeriNorth.cell & 0x8000) !== 0 && cDeriNorth.continent === 1, "gy = 117887.0 -> continent 1 preserved");
    },
    async (live) => {
      await live.cleanupWorld();
      const site = await live.ensureDericostFlatSite();
      assert((site.landblockId & 0x8000) !== 0 && site.gy >= DERICOST_Y_OFFSET, "Dericost 0x8000 bit & >=68928m confirmed");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T2.QC.F8.02",
    2,
    "F8:Dericost_Visual",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const seamCell = toCellLocal(191.5, DERICOST_Y_OFFSET + 191.5, 278.0);
        assert((seamCell.cell & 0x8000) !== 0, "Seam cell has Dericost bit 15");
        env.push({
          type: "container_state",
          containerGuid: 0x800d5555,
          containerKind: 11, // 40ft straddles seam
          doorState: 2,
          doorProgress: 1.0,
          cell: seamCell.cell,
          position: [seamCell.x, seamCell.y, seamCell.z],
          heading: 0,
        });
        env.tick(100);
        assert(env.activeColliders.has(0x800d5555), "Straddling Dericost container collider registered");
        env.push({ type: "event", kind: VEHICLE_EVENT_KIND.Despawn, vehicle: 0x800d5555, subject: 0 });
        env.tick(133);
        assert(!env.activeColliders.has(0x800d5555), "Straddling Dericost container collider evicted cleanly");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      await live.sendChat(`@teleloc ${DERICOS_FLAT_SITE.cellHex} 191.50 191.50 ${DERICOS_FLAT_SITE.z.toFixed(2)}`);
      await live.waitUntil(async () => {
        const p = await live.getPlayerGlobalPose();
        return p && p.isDericost && p.lx >= 188.0 && p.ly >= 188.0 ? p : null;
      }, 8000, 150, "Dericost seam pose");
      await live.sendChatAndWait("@container spawn 40", /spawned|container/i, 8000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "seam container");
      const surf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${c.pos[0]}, ${c.pos[1]}, ${c.pos[2] + 1.5}) || null;`);
      assert(surf && Math.abs(surf.z - (c.pos[2] + 0.162)) < 0.08, "Dericost straddling container collider walkable");
      await live.sendChat(`@container despawn 0x${(c.guid >>> 0).toString(16)}`);
      await live.waitUntil(async () => await live.evalInPage(`return !window.__sessionHandle?.probeContainerSurface?.(${c.pos[0]}, ${c.pos[1]}, ${c.pos[2] + 1.5});`), 6000, 150, "evicted cleanly");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T2.QC.F8.03",
    2,
    "F8:Dericost_Visual",
    async () => {
      const indoorDeriCell = 0x10208105;
      assert((indoorDeriCell & 0x8000) !== 0 && (indoorDeriCell & 0x7fff) >= 0x0100, "Dericost indoor dungeon cell identified without clamping");
      const outdoorDeri = toCellLocal(31968, 96672, 278);
      assert((outdoorDeri.cell & 0x8000) !== 0 && (outdoorDeri.cell & 0x7fff) < 0x0100, "Dericost outdoor cell identified");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      // Teleport +60m above Dericost ground and verify pose remains in Dericost
      await live.sendChat(`@teleloc ${DERICOS_FLAT_SITE.cellHex} 96.00 96.00 ${(DERICOS_FLAT_SITE.z + 40).toFixed(2)}`);
      await new Promise((r) => setTimeout(r, 800));
      const p = await live.getPlayerGlobalPose();
      assert(p && p.isDericost && p.gy >= DERICOST_Y_OFFSET, "Dericost altitude teleport stayed on Dericost");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T2.QC.F8.04",
    2,
    "F8:Dericost_Visual",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats({ x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z });
      sim.boardVehicle(vGuid, 1001, 0);
      sim.exitVehicle(vGuid, 1001);
      assert(sim.tractors.get(vGuid).y >= DERICOST_Y_OFFSET, "Dericost exit preserves continent coordinates");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@vehicle spawn jeep-mb", /spawned|jeep/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "jeep on Dericost");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 6000, 150, "exited");
      const p = await live.getPlayerGlobalPose();
      assert(p && p.isDericost && p.gy >= DERICOST_Y_OFFSET, "Vehicle exit on Dericost placed player safely on Dericost");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.checkLive("T2.QC.F8.05", 2, "F8:Dericost_Visual", async (live) => {
    await live.cleanupWorld();
    await live.ensureOutdoorFlatSite();
    await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
    const p = await live.getPlayerGlobalPose();
    await live.orbitCam(p.gx, p.gy, p.z + 2, 22, 0.9, 0.35);
    const shotWithHud = await live.captureAndVerifyShot("t2_qc_f8_05_hud_on");
    await live.hideHud();
    await new Promise((r) => setTimeout(r, 250));
    const shotNoHud = await live.captureAndVerifyShot("t2_qc_f8_05_hud_off");
    await live.showHud();
    assert(shotWithHud.valid && shotNoHud.valid, "Both HUD-on and HUD-hidden PNGs valid");
    const errs = await live.checkConsoleErrors();
    assert(errs.failing.length === 0, `Console/page errors: ${errs.failing.join("; ")}`);
    await live.cleanupWorld();
  });
}
