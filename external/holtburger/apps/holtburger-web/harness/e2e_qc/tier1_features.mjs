// harness/e2e_qc/tier1_features.mjs — Tier 1 Feature Coverage (40 checks = 5 * 8 areas F1–F8).

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  ALL_9_DEPLOYABLES,
  ALL_RESERVED_WCIDS,
  APP_ROOT,
  CONTAINER_ACTION_KIND,
  DEPLOYABLE_KIND,
  DEPLOYABLE_WEAPON_KIND,
  DERICOS_FLAT_SITE,
  DERICOST_Y_OFFSET,
  FORK_STATE,
  HBV1_VERSION_V7,
  IFF_STANDING,
  LOGISTICS_SPEC,
  ONLINE_FLAGS,
  OPCODES,
  PALLET_JACK_ACTION_KIND,
  PALLET_JACK_FLAGS,
  QcWorldSimulator,
  SIDELIFT_PHASE,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  VEHICLE_EVENT_KIND,
  acHeadingTransform,
  angleDiff,
  assert,
  countDrawCalls,
  countLights,
  decodeCapabilitiesAck,
  decodeContainerAction,
  decodeContainerState,
  decodeDeployableFire,
  decodeDeployableState,
  decodeGroundContacts,
  decodePalletJackAction,
  decodePalletJackState,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleEvent,
  decodeVehicleSeat,
  encodeClientCapabilities,
  encodeContainerAction,
  encodeContainerState,
  encodeDeployableFire,
  encodeDeployableState,
  encodeGroundContacts,
  encodePalletJackAction,
  encodePalletJackState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleEvent,
  encodeVehicleSeat,
  getThree,
  makeQcLiveEnv,
  near,
  oracleComputeCraneSpanY,
  oracleComputeReachableUnloadSlots,
  readProtocolFixtures,
  readXmlProtocol,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  tryLoadWasmPkg,
  wrapPi,
} from "./common.mjs";

export const TIER1_METADATA = [
  // F1: Protocol & Security (5)
  { id: "T1.QC.F1.01", tier: 1, feature: "F1:Protocol_Security", mode: "offline" },
  { id: "T1.QC.F1.02", tier: 1, feature: "F1:Protocol_Security", mode: "dual" },
  { id: "T1.QC.F1.03", tier: 1, feature: "F1:Protocol_Security", mode: "offline" },
  { id: "T1.QC.F1.04", tier: 1, feature: "F1:Protocol_Security", mode: "dual" },
  { id: "T1.QC.F1.05", tier: 1, feature: "F1:Protocol_Security", mode: "live" },
  // F2: Semi Crew & Lifecycle (5)
  { id: "T1.QC.F2.01", tier: 1, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T1.QC.F2.02", tier: 1, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T1.QC.F2.03", tier: 1, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T1.QC.F2.04", tier: 1, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  { id: "T1.QC.F2.05", tier: 1, feature: "F2:Semi_Crew_Lifecycle", mode: "dual" },
  // F3: Trailers & Coupling (5)
  { id: "T1.QC.F3.01", tier: 1, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T1.QC.F3.02", tier: 1, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T1.QC.F3.03", tier: 1, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T1.QC.F3.04", tier: 1, feature: "F3:Trailers_Coupling", mode: "dual" },
  { id: "T1.QC.F3.05", tier: 1, feature: "F3:Trailers_Coupling", mode: "offline" },
  // F4: Sidelifter Left/Right & Aux (5)
  { id: "T1.QC.F4.01", tier: 1, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T1.QC.F4.02", tier: 1, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T1.QC.F4.03", tier: 1, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T1.QC.F4.04", tier: 1, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  { id: "T1.QC.F4.05", tier: 1, feature: "F4:Sidelifter_LeftRight_Aux", mode: "dual" },
  // F5: Containers & Rotation (5)
  { id: "T1.QC.F5.01", tier: 1, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T1.QC.F5.02", tier: 1, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T1.QC.F5.03", tier: 1, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T1.QC.F5.04", tier: 1, feature: "F5:Containers_Rotation", mode: "dual" },
  { id: "T1.QC.F5.05", tier: 1, feature: "F5:Containers_Rotation", mode: "dual" },
  // F6: Pallet Jack & Late-Observer Sync (5)
  { id: "T1.QC.F6.01", tier: 1, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T1.QC.F6.02", tier: 1, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T1.QC.F6.03", tier: 1, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T1.QC.F6.04", tier: 1, feature: "F6:PalletJack_Sync", mode: "dual" },
  { id: "T1.QC.F6.05", tier: 1, feature: "F6:PalletJack_Sync", mode: "live" },
  // F7: MicroGrid & AirDefense Combat (5)
  { id: "T1.QC.F7.01", tier: 1, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T1.QC.F7.02", tier: 1, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T1.QC.F7.03", tier: 1, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T1.QC.F7.04", tier: 1, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  { id: "T1.QC.F7.05", tier: 1, feature: "F7:MicroGrid_AirDefense", mode: "dual" },
  // F8: Dericost Continent & Visual Sanity (5)
  { id: "T1.QC.F8.01", tier: 1, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T1.QC.F8.02", tier: 1, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T1.QC.F8.03", tier: 1, feature: "F8:Dericost_Visual", mode: "dual" },
  { id: "T1.QC.F8.04", tier: 1, feature: "F8:Dericost_Visual", mode: "offline" },
  { id: "T1.QC.F8.05", tier: 1, feature: "F8:Dericost_Visual", mode: "live" },
];

function collectNodes(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  if (Array.isArray(node.children)) {
    for (const c of node.children) collectNodes(c, pred, out);
  }
  return out;
}

export async function runTier1(collector) {
  const THREE = await getThree();
  if (collector.mode === "live" && collector.liveSession) {
    await collector.liveSession.ensureOutdoorFlatSite();
  }

  // ---------------------------------------------------------------------------
  // F1: Protocol & Security
  // ---------------------------------------------------------------------------

  await collector.runCheck("T1.QC.F1.01", 1, "F1:Protocol_Security", async () => {
    const xml = readXmlProtocol();
    assert(xml.exists, "vehicles.protocol.xml missing");
    assert(/<schema[^>]*version="7"/.test(xml.text), "vehicles.protocol.xml must declare <schema version=\"7\">");
    assert(/protocol version 7\b/i.test(xml.text), "vehicles.protocol.xml header comment must reflect v7 (PROJECT.md #1)");
    const taBlock = xml.text.match(/<type[^>]+name="Vehicle_TrailerAction"[\s\S]*?<\/type>/)?.[0] || "";
    assert(/type="ushort"\s+name="Flags"/.test(taBlock), "Vehicle_TrailerAction.Flags must be ushort");
    assert(/0x02/.test(taBlock), "Vehicle_TrailerAction.Flags must document 0x02 auto-detect");
    const dfBlock = xml.text.match(/<type[^>]+name="Vehicle_DeployableFire"[\s\S]*?<\/type>/)?.[0] || "";
    assert(/name="TargetPos"/.test(dfBlock), "Vehicle_DeployableFire.TargetPos present");
    assert(!/name="TargetPos"[^>]*text="landblock-local"/.test(dfBlock), "Vehicle_DeployableFire.TargetPos doc must align with server global coordinates (PROJECT.md #1)");

    const fx = readProtocolFixtures();
    assert(fx.output && fx.output.version === 7, `vehicle-wire-fixtures.json must be version 7, got ${fx.output?.version}`);
    const wasm = await tryLoadWasmPkg();
    assert(wasm.ok, wasm.reason);
    const proto = wasm.ns?.SessionHandle?.prototype;
    for (const m of ["vehicleTrailerAction", "vehicleContainerAction", "vehiclePalletJackAction", "upsertContainerCollider", "removeContainerCollider", "probeContainerSurface"]) {
      assert(typeof proto?.[m] === "function", `WASM SessionHandle.prototype.${m} missing`);
    }
    const wasmBytes = statSync(path.join(APP_ROOT, "pkg", "holtburger_web_bg.wasm")).size;
    assert(wasmBytes > 512 * 1024, `pkg/holtburger_web_bg.wasm suspiciously small (${wasmBytes}B)`);
  });

  await collector.runDual(
    "T1.QC.F1.02",
    1,
    "F1:Protocol_Security",
    async () => {
      const capBytes = encodeClientCapabilities(0x03, HBV1_VERSION_V7);
      assert(capBytes.length === 12, `ClientCapabilities must be 12B, got ${capBytes.length}`);
      const env = await makeQcLiveEnv();
      try {
        env.push({ type: "ack", granted: 0x03, simHz: 30 });
        env.tick(100);
        const st = env.api.status();
        assert(st?.caps?.granted === 3, `Expected caps.granted === 3, got ${st?.caps?.granted}`);
        const ackBuf = new Uint8Array([0x48, 0x42, 0x56, 0x31, 7, 0, 0, 0, 3, 0, 0, 0, 30, 0, 0, 0]);
        const dec = decodeCapabilitiesAck(ackBuf);
        assert(dec && dec.Granted === 3 && dec.SimHz === 30, "CapabilitiesAck decode parity");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      const st = await live.waitUntil(
        async () => await live.evalInPage(`
          const s = window.__vehicles?.status?.();
          return s && s.caps && (s.caps.granted & 0x03) === 0x03 ? s : null;
        `),
        12000,
        150,
        "window.__vehicles.status().caps (0x03)"
      );
      assert(st && st.caps, "window.__vehicles.status().caps unavailable");
      assert((st.caps.granted & 0x03) === 0x03, `Expected Observe|Pilot (0x03), got ${st.caps.granted}`);
      const pose = await live.getPlayerGlobalPose();
      assert(pose && Number.isFinite(pose.gx) && Number.isFinite(pose.gy), "Local player pose valid");
    }
  );

  await collector.runCheck("T1.QC.F1.03", 1, "F1:Protocol_Security", async () => {
    const ta = encodeTrailerAction({ TrailerGuid: 0x80091001, VehicleGuid: 0x80090001, ContainerGuid: 0x80092001, Action: TRAILER_ACTION_KIND.AutoLoad, Slot: 1, Flags: 0x02 });
    const taDec = decodeTrailerAction(ta);
    assert(ta.length === 24 && taDec.Flags === 0x02 && taDec.Action === TRAILER_ACTION_KIND.AutoLoad, "0x090F C2S round-trip with Flags=0x02");

    const ts = encodeTrailerState({ TrailerGuid: 0x80091001, Kind: 15, SideliftPhase: 5, SideliftSide: -1, SideliftFlags: 0x0f, StowedPalletJackGuid: 0x80093001 });
    const tsDec = decodeTrailerState(ts);
    assert(ts.length === 84 && tsDec.SideliftSide === -1 && tsDec.StowedPalletJackGuid === 0x80093001, "0x090F S2C round-trip");

    const pj = encodePalletJackState({ PalletJackGuid: 0x80093001, StowedOnTrailerGuid: 0x80091001, Flags: PALLET_JACK_FLAGS.Stowed, ForkHeightM: 0.2 });
    const pjDec = decodePalletJackState(pj);
    assert(pj.length === 60 && pjDec.StowedOnTrailerGuid === 0x80091001 && (pjDec.Flags & PALLET_JACK_FLAGS.Stowed), "0x0910 S2C round-trip");

    const df = encodeDeployableFire({ DeployableGuid: 0x80094001, WeaponKind: DEPLOYABLE_WEAPON_KIND.Laser, TargetGuid: 0x80095001, TargetPos: { X: 32000, Y: 96680, Z: 279 }, EnergyJoules: 120000, BurstCount: 1 });
    const dfDec = decodeDeployableFire(df);
    assert(df.length === 72 && dfDec.WeaponKind === 3 && dfDec.EnergyJoules === 120000, "0x090C round-trip");

    for (let aux = 1; aux <= 7; aux++) {
      const ev = encodeVehicleEvent({ Vehicle: 0x80091001, Kind: VEHICLE_EVENT_KIND.SideliftRefused, Aux: aux });
      const evDec = decodeVehicleEvent(ev);
      assert(ev.length === 60 && evDec.Aux === aux, `0x0908 Aux=${aux} preserved as u32`);
    }
  });

  await collector.runDual(
    "T1.QC.F1.04",
    1,
    "F1:Protocol_Security",
    async () => {
      assert(new Set(ALL_RESERVED_WCIDS).size === ALL_RESERVED_WCIDS.length, "All 17 reserved WCIDs unique");
      assert(ALL_9_DEPLOYABLES.length === 9, "All 9 deployable specs present");
      for (const spec of ALL_9_DEPLOYABLES) {
        assert(ALL_RESERVED_WCIDS.includes(spec.wcid), `WCID ${spec.wcid} missing from reserved list`);
      }
      assert(LOGISTICS_SPEC.trailers["20ft"].wcid === 4000030, "Trailer 20ft WCID 4000030");
      assert(LOGISTICS_SPEC.trailers["40ft"].wcid === 4000031, "Trailer 40ft WCID 4000031");
      assert(LOGISTICS_SPEC.sidelifter.wcid === 4000032, "Sidelifter WCID 4000032");
      assert(LOGISTICS_SPEC.palletJack.wcid === 4000035, "PalletJack WCID 4000035");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base|deployable/i, 10000);
      await live.sendChatAndWait("@container preset fob20", /fob|container|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20 container");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.85, 6000, 150, "fob20 doors open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked|4000002|radar/i, 8000);
      const wcids = await live.waitUntil(async () => await live.evalInPage(`
        const set = new Set(window.__vehicles.deployables.list().map((d) => d.wcid));
        return set.size >= 9 ? [...set] : null;
      `), 10000, 200, "all 9 deployable WCIDs live");
      for (const d of ALL_9_DEPLOYABLES) {
        assert(wcids.includes(d.wcid), `Missing live deployable WCID ${d.wcid} (${d.name})`);
      }
      await live.cleanupWorld();
    }
  );

  await collector.checkLive("T1.QC.F1.05", 1, "F1:Protocol_Security", async (live) => {
    await live.cleanupWorld();
    await live.ensureOutdoorFlatSite();
    await live.sendChatAndWait("@container spawn 20", /container|spawned/i, 8000);
    const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "container");
    await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
    await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
    await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${cGuid}, 3, 0, 0, 4000010); return true;`);
    const loaded = await live.waitUntil(async () => {
      const c = await live.getContainer(cGuid);
      return c?.slots?.find((s) => s.slotIndex === 0 && s.cargoWcid === 4000010) || null;
    }, 8000, 200, "Developer Action=3 Load slot 0");
    assert(loaded.cargoWcid === 4000010, "Developer tailnet1 allowed to Load WCID 4000010");
    await live.cleanupWorld();
  });

  // ---------------------------------------------------------------------------
  // F2: Semi Crew & Lifecycle
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F2.01",
    1,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sm = await tryImportVehicle("semi_truck_model.js");
      assert(sm.ok, sm.reason);
      assert(sm.mod.SEMI_LIVERY_INDEX.length === 6, "6 semi liveries defined");
      for (let liv = 0; liv < 6; liv++) {
        const fakeScene = { activeLights: [] };
        const m = sm.mod.buildSemiTruck(THREE, { livery: liv }, { liveScene3d: fakeScene });
        assert(m.livery.id === liv, `Livery ${liv} resolved`);
        assert(countLights(m.root) === 0, `Livery ${liv} 0 THREE.Lights`);
        assert(countDrawCalls(m.root) <= 16, `Livery ${liv} draw calls <= 16`);
        m.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      for (const liv of [0, 3, 5]) {
        await live.sendChatAndWait(`@vehicle spawn semi-379 ${liv}`, /spawned|semi/i, 8000);
      }
      const semis = await live.waitUntil(async () => await live.evalInPage(`
        const list = window.__vehicles.vehicles().filter((v) => v.profile?.profileKey === "semi-379");
        return list.length >= 3 ? list.map((v) => ({ g: v.guid, liv: v.profile.liveryId, seats: v.profile.seats?.length })) : null;
      `), 10000, 200, "3 liveried semis");
      assert(semis.every((s) => s.seats === 2), "Each semi-379 has 2 cab seats");
      assert(new Set(semis.map((s) => s.liv)).size === 3, "Distinct liveryIds on wire");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F2.02",
    1,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sm = await tryImportVehicle("semi_truck_model.js");
      const jm = await tryImportVehicle("jeep_model.js");
      assert(sm.ok && jm.ok, "semi_truck_model.js & jeep_model.js load");
      const fakeScene = { activeLights: [] };
      const semi = sm.mod.buildSemiTruck(THREE, { livery: 0 }, { liveScene3d: fakeScene });
      const jeep = jm.mod.buildProceduralJeep(THREE, {}, { liveScene3d: fakeScene });

      // Heading +pi/2 (East): local forward (+Y) -> world (+X)
      const qEast = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
      semi.root.position.set(100, 200, 10);
      semi.root.quaternion.copy(qEast);
      semi.update({ headlights: true, braking: true, speed: 5 }, 0.033);
      assert(semi.pooledLight.intensity > 0 && semi.pooledLight.position.x > 103.0, `Semi East headlight rotated to +X (${semi.pooledLight.position.x})`);
      near(semi.pooledLight.position.y, 200, 0.2, "Semi East headlight world Y");

      jeep.root.position.set(100, 200, 10);
      for (const h of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        jeep.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -h);
        jeep.update({ headlights: true, speed: 5 }, 0.033);
        const [expJx, expJy] = acHeadingTransform(100, 200, 0, 1.6, h);
        assert(jeep.pooledLight.intensity > 0, `Jeep headlight active at h=${h.toFixed(2)}`);
        near(jeep.pooledLight.position.x, expJx, 0.2, `Jeep headlight world X at h=${h.toFixed(2)}`);
        near(jeep.pooledLight.position.y, expJy, 0.2, `Jeep headlight world Y at h=${h.toFixed(2)}`);
      }
      semi.dispose();
      jeep.dispose();
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 1", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi spawned");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting semi");
      await live.dispatchKey("KeyL");
      await live.dispatchKey("KeyV");
      await live.waitUntil(async () => await live.evalInPage(`
        const evs = window.__vehicles.events();
        return evs.some((e) => e.kind === 13) && evs.some((e) => e.kind === 12);
      `), 6000, 150, "Headlights(13) & Horn(12) events");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F2.03",
    1,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const vGuid = 0x80099001;
        env.push({
          type: "profile",
          vehicle: vGuid,
          profileKey: "semi-379",
          displayName: "Ironhorse 379",
          locomotion: 2,
          standInSetup: 0x0200026b,
          simHz: 30,
          vMax: 27,
          vehicleClass: 3,
          seats: [{ role: 0, motion: 0x41000013, offset: [-0.52, 0.28, 1.72] }, { role: 1, motion: 0x41000013, offset: [0.52, 0.28, 1.72] }],
          weapons: [],
          parts: [],
        });
        env.push({ type: "seat", vehicle: vGuid, seat: 0, occupant: 1001, state: 1, reason: 0 });
        env.push({ type: "state", vehicle: vGuid, step: 1, ack: 0, cell: 0xa9b30002, x: 19, y: 24, z: 94, heading: 0, pitch: 0, bank: 0, speed: 0, vCap: 27, ammo: 0, mode: 0, flags: 1 });
        env.tick(100);
        assert(env.api.piloting === true, "Player seated in Seat 0");
        const cards = collectNodes(env.doc.body, (n) => typeof n.className === "string" && n.className.includes("hb-ground-seat-card"));
        assert(cards.length >= 2, `Expected seat cards in OSD, got ${cards.length}`);
        cards[1].dispatchEvent({ type: "click" });
        assert(env.calls.vehicleBoard.some((b) => b.guid === vGuid && b.seat === 1), "OSD onSeatClick(1) must trigger vehicleBoard(vGuid, 1)");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "seat 0");
      await live.waitUntil(async () => await live.evalInPage(`return document.querySelectorAll(".hb-ground-seat-card").length >= 2;`), 6000, 150, "2 OSD ground seat cards");
      await live.evalInPage(`document.querySelectorAll(".hb-ground-seat-card")[1]?.click?.(); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.status()?.passenger?.seat === 1;`), 6000, 150, "hot-swapped to seat 1");
      await live.evalInPage(`document.querySelectorAll(".hb-ground-seat-card")[0]?.click?.(); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.status()?.pilot?.seat === 0;`), 6000, 150, "hot-swapped back to seat 0");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F2.04",
    1,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vGuid = sim.spawnSemiWithSeats();
      assert(sim.boardVehicle(vGuid, 1001, 0).ok, "Driver boards seat 0");
      assert(sim.boardVehicle(vGuid, 1002, 1).ok, "Passenger boards seat 1");
      const ex = sim.exitVehicle(vGuid, 1001);
      assert(ex.ok && ex.anyOccupied === true, "Seat 1 remains occupied after driver exits");
      const v = sim.tractors.get(vGuid);
      assert(v.seats[0] === 0 && v.seats[1] === 1002 && v.emptySinceSec === null, "EmptySinceUtc stays null while passenger seated");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      const p1 = await live.getPlayerGlobalPose();
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      const targetGx = p1.gx + 2;
      const targetGy = p1.gy;
      await sec.sendChat(`@teleloc 0x${p1.landblockId.toString(16)} ${(p1.lx + 2).toFixed(2)} ${p1.ly.toFixed(2)} ${p1.z.toFixed(2)}`);
      await live.waitUntil(async () => {
        const sp = await sec.getPlayerGlobalPose();
        if (!sp || Math.hypot(sp.gx - targetGx, sp.gy - targetGy) > 5.0) return false;
        return await sec.evalInPage(`return (window.__vehicles?.vehicles?.() || []).some((v) => (v.guid >>> 0) === ${vGuid} && !!v.profile && !!v.params);`);
      }, 10000, 200, "tailnet2 sees semi");
      const b0 = await live.evalInPage(`return window.__vehicles.board(${vGuid}, 0);`);
      assert(b0?.ok, `tailnet1 board() failed: ${JSON.stringify(b0)}`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "tailnet1 seated");
      const b1 = await sec.evalInPage(`return window.__vehicles.board(${vGuid}, 1);`);
      assert(b1?.ok, `tailnet2 board() failed: ${JSON.stringify(b1)}`);
      await live.waitUntil(async () => await sec.evalInPage(`return !!window.__vehicles.passenger;`), 6000, 150, "tailnet2 seated in seat 1");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 6000, 150, "tailnet1 exited");
      await new Promise((r) => setTimeout(r, 1500));
      const stillSeated = await sec.evalInPage(`return !!window.__vehicles.passenger && window.__vehicles.isVehicle(${vGuid});`);
      assert(stillSeated, "Co-driver remained seated after driver exited");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F2.05",
    1,
    "F2:Semi_Crew_Lifecycle",
    async () => {
      const sim = new QcWorldSimulator();
      const vKeep = sim.spawnSemiWithSeats();
      sim.boardVehicle(vKeep, 1001, 0);
      sim.boardVehicle(vKeep, 1002, 1);
      sim.exitVehicle(vKeep, 1001);
      sim.advanceTime(650.0); // > 10 min with Seat 1 occupied
      assert(sim.tractors.get(vKeep).isDestroyed === false, "Vehicle with Seat 1 occupied MUST NOT despawn after 10 min");

      const vEmpty = sim.spawnSemiWithSeats();
      sim.boardVehicle(vEmpty, 1003, 0);
      sim.exitVehicle(vEmpty, 1003);
      sim.advanceTime(605.0);
      assert(sim.tractors.get(vEmpty).isDestroyed === true, "Completely empty vehicle despawns after 10 min");
    },
    async (live) => {
      // Live check verifies EmptySinceUtc does not immediately prune an empty or passenger-occupied vehicle and passenger stays active across ticks
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 0", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 1); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.passenger;`), 6000, 150, "passenger seat 1");
      await new Promise((r) => setTimeout(r, 3000));
      assert(await live.evalInPage(`return !!window.__vehicles.passenger && window.__vehicles.isVehicle(${vGuid});`), "Passenger seat 1 stayed alive");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F3: Trailers & Coupling
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F3.01",
    1,
    "F3:Trailers_Coupling",
    async () => {
      const tk = await tryImportVehicle("trailer_kinematics.js");
      assert(tk.ok, tk.reason);
      let tr = { x: 0, y: -7.36, z: 0, heading: 0, pitch: 0, bank: 0, articulationRad: 0 };
      const tractor = { x: 0, y: 0, z: 0, heading: 0, speed: 8.0, yawRate: 0.12 };
      for (let i = 0; i < 30; i++) {
        tractor.heading = tk.mod.wrapPi(tractor.heading + tractor.yawRate * (1 / 30));
        tractor.x += Math.sin(tractor.heading) * tractor.speed * (1 / 30);
        tractor.y += Math.cos(tractor.heading) * tractor.speed * (1 / 30);
        tr = tk.mod.stepCoupledTrailer(tractor, tr, -2.01, "40ft", () => 0, 1 / 30);
      }
      assert(Number.isFinite(tr.articulationRad) && Math.abs(tr.articulationRad) <= tk.mod.MAX_JACKKNIFE_RAD + 1e-4, "30Hz trailer tracks within jackknife limit");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig40hc", /rig40hc|coupled|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && t ? { vGuid: v.guid, tGuid: t.guid, fl: t.trailerFlags } : null;
      `), 8000, 200, "rig40hc");
      assert((ids.fl & TRAILER_FLAGS.Coupled) !== 0 && (ids.fl & TRAILER_FLAGS.GearRetracted) !== 0, "Coupled + GearRetracted flags");
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting rig40hc");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.6, yaw: 0.3 }, 900); return true;`);
      await new Promise((r) => setTimeout(r, 1050));
      const trAfter = await live.getTrailer(ids.tGuid);
      assert(trAfter && trAfter.coupledTractorGuid === ids.vGuid, "Trailer stayed coupled during turn");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F3.02",
    1,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.unhitchTrailer(tGuid, trGuid).ok, "Unhitch when parked & sidelift Idle");
      assert(sim.tractors.get(tGuid).hitchedTrailerGuid === 0, "Tractor hitchedTrailerGuid cleared");
      assert(sim.hitchTrailer(tGuid, trGuid, { distM: 2.0, angleDeg: 10 }).ok, "Re-hitch within 3.5m / 60 deg");
      assert(sim.tractors.get(tGuid).hitchedTrailerGuid === trGuid, "Tractor hitchedTrailerGuid restored");
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
      await live.waitUntil(async () => ((await live.getTrailer(ids.tGuid))?.coupledTractorGuid ?? 1) === 0, 6000, 150, "unhitched");
      await live.dispatchKey("KeyG");
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.coupledTractorGuid === ids.vGuid, 6000, 150, "rehitched");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F3.03",
    1,
    "F3:Trailers_Coupling",
    async () => {
      const cA = toCellLocal(190.0, 24.0, 10.0);
      const cB = toCellLocal(196.0, 24.0, 10.0);
      assert(((cA.cell >>> 24) & 0xff) === 0 && ((cB.cell >>> 24) & 0xff) === 1, "Crossed lbX 0 -> 1");
      const [gx, gy] = toGlobal(cB.cell, cB.x, cB.y, cB.z);
      near(gx, 196.0, 1e-3, "Global X preserved across landblock");
      near(gy, 24.0, 1e-3, "Global Y preserved across landblock");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      // Place player near eastern seam of 0xA9B3 (x = 175m) facing East (+pi/2) so preset tractor spawns at x ~ 189m on flat 94m ground within 16m boarding range
      await live.sendChat("@teleloc 0xA9B30039 175.00 96.00 94.00 0.707107 0 0 -0.707107");
      await live.waitUntil(async () => {
        const p = await live.getPlayerGlobalPose();
        return p && p.lx >= 172 ? p : null;
      }, 8000, 200, "near seam");
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const v = window.__vehicles.vehicles()[0];
        const st = window.__vehicles.status()?.vehicles?.[0];
        const t = window.__vehicles.trailers.list()[0];
        return v && st?.pos && t ? { vGuid: v.guid, vPos: [st.pos.x, st.pos.y, st.pos.z], tGuid: t.guid, cGuid: t.mountedContainerGuid, pjGuid: t.stowedPalletJackGuid } : null;
      `), 8000, 200, "sidelifter40");
      await live.movePlayerNear(ids.vPos, [0, -2.5, 0]);
      await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.75, yaw: 0.5 }, 1600); return true;`);
      await new Promise((r) => setTimeout(r, 1750));
      const tr = await live.getTrailer(ids.tGuid);
      assert(tr && tr.coupledTractorGuid === ids.vGuid && tr.mountedContainerGuid === ids.cGuid && tr.stowedPalletJackGuid === ids.pjGuid, "Coupled trailer, container & stowed jack survived seam drive");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F3.04",
    1,
    "F3:Trailers_Coupling",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.tractors.get(tGuid).towMassMul === LOGISTICS_SPEC.towMassMul.loaded40ft, "Loaded towMassMul = 0.58");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      assert(sim.tractors.get(tGuid).towMassMul === LOGISTICS_SPEC.towMassMul.emptyChassis, "Empty chassis towMassMul = 0.72");
      assert(sim.containers.get(cGuid).mountedOnTrailerGuid === 0, "Container unmounted");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset rig20", /rig20|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t && t.mountedContainerGuid ? { tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "rig20");
      await live.evalInPage(`window.__vehicles.trailers.toggleTwistlock(${ids.tGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.twistlockLocked === false, 5000, 150, "unlocked");
      await live.evalInPage(`window.__vehicles.trailers.unmountContainer(${ids.tGuid}, ${ids.cGuid}); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === 0, 5000, 150, "unmounted");
      await live.evalInPage(`window.__vehicles.trailers.mountContainer(${ids.tGuid}, ${ids.cGuid}, 0); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids.tGuid))?.mountedContainerGuid === ids.cGuid, 5000, 150, "remounted");
      await live.cleanupWorld();
    }
  );

  await collector.runCheck("T1.QC.F3.05", 1, "F3:Trailers_Coupling", async () => {
    const tm = await tryImportVehicle("trailer_models.js");
    assert(tm.ok, tm.reason);
    assert(tm.mod.TRAILER_WCID.Chassis20ft === 4000030 && tm.mod.TRAILER_WCID.Chassis40ft === 4000031 && tm.mod.TRAILER_WCID.Sidelifter40 === 4000032, "WCIDs 4000030/31/32");
    const tr = tm.mod.buildSemiTrailer(THREE, "40ft");
    tr.update(0.033, { brakeLights: true, twistlockState: 1, landingGearRetracted: true });
    assert(tr.brakeLights === true && tr.twistlockState === 1 && tr.landingGearRetracted === true, "BrakeLights, twistlocks & landing gear updated");
    tr.dispose();
  });

  // ---------------------------------------------------------------------------
  // F4: Sidelifter Left/Right & Aux
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F4.01",
    1,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, cGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployOutriggers, 0x00);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftOffload, 0x00).ok, "Right offload ok");
      near(sim.containers.get(cGuid).x, sim.trailers.get(trGuid).x + 3.85, 1e-4, "Right offload +3.85m");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.SideliftLoad, 0x00).ok, "Right reload ok");
      assert(sim.trailers.get(trGuid).mountedContainerGuid === cGuid, "Container remounted");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 25000, 250, "right auto offload complete");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autoload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === ids.cGuid && t.sideliftPhase === 0;
      }, 25000, 250, "right auto reload complete");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F4.02",
    1,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        env.push({
          type: "trailer_state",
          trailerGuid: 0x80099101,
          kind: DEPLOYABLE_KIND.TrailerSidelifter40,
          cell: 0xa9b30002,
          position: [19, 24, 94],
          heading: 0,
          mountedContainerGuid: 0,
          sideliftPhase: 0,
          sideliftSide: -1,
          sideliftFlags: 0x01,
        });
        env.push({ type: "state", vehicle: 0x80099001, step: 1, cell: 0xa9b30002, x: 19, y: 24, z: 94, heading: 0, speed: 0, mode: 0, flags: 0 });
        env.tick(100);
        // Move local player within 12m on foot
        env.entityMap.get(1001).root.position.set(32467.2, 34392.0, 94.0);
        // Adjust trailer to be near player global pose
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.entityMap.get(1001).root.position.set(gx - 2.0, gy, gz);
        env.fakeWinObj.dispatch("keydown", { code: "KeyJ", key: "j" });
        env.fakeWinObj.dispatch("keydown", { code: "KeyL", key: "l", shiftKey: true });
        assert(env.calls.vehicleTrailerAction.length >= 2, "On-foot KeyJ & Shift+KeyL dispatched");
        for (const c of env.calls.vehicleTrailerAction) {
          assert((c.flags & 0x02) !== 0, `Expected on-foot sideFlags to include 0x02 auto-detect, got 0x${(c.flags || 0).toString(16)} (Contract #2)`);
        }
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
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid, pos: t.pos } : null;
      `), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "left"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0 && t.sideliftSide === -1;
      }, 25000, 250, "left auto offload complete");
      // Walk player near trailer on foot and press Shift+KeyL (Flags=0x02 auto-detect!)
      await live.movePlayerNear(ids.pos, [-2.5, 0, 0]);
      await live.dispatchKey("KeyL", { key: "L", shiftKey: true });
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === ids.cGuid && t.sideliftPhase === 0;
      }, 25000, 250, "on-foot Shift+KeyL (0x02) auto-detected left container and reloaded");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F4.03",
    1,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      assert(oracleComputeCraneSpanY(10) === 2.9265, "20ft crane span Y = 2.9265");
      assert(oracleComputeCraneSpanY(11) === 5.9925, "40ft crane span Y = 5.9925");
      // Verify index.js ground probe samples rotated side outreach
      const probeCoords = [];
      const env = await makeQcLiveEnv({
        terrainHeightAt: (x, y) => { probeCoords.push([x, y]); return 94.0 + 0.01 * (x - 32467.2); },
      });
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.push({ type: "container_state", containerGuid: 0x80099201, containerKind: DEPLOYABLE_KIND.IsoContainer20, cell: 0xa9b30002, position: [19, 24, 94], heading: Math.PI / 2 });
        env.push({
          type: "trailer_state",
          trailerGuid: 0x80099101,
          kind: DEPLOYABLE_KIND.TrailerSidelifter40,
          cell: 0xa9b30002,
          position: [19, 24, 94],
          heading: Math.PI / 2,
          mountedContainerGuid: 0x80099201,
          containerSlot: 1,
          sideliftPhase: SIDELIFT_PHASE.Lowering,
          sideliftSide: 1,
          sideliftProgress: 0.5,
          craneSpanY: 2.9265,
        });
        env.tick(100);
        // At heading +pi/2 (East), local (side*3.85, slotY=+2.9295) transforms via acHeadingTransform -> (gx + 2.9295, gy - 3.85)
        const [expProbeX, expProbeY] = acHeadingTransform(gx, gy, 3.85, 2.9295, Math.PI / 2);
        const hit = probeCoords.some(([px, py]) => Math.hypot(px - expProbeX, py - expProbeY) < 0.25);
        assert(hit, `Expected rotated slotY ground probe at (${expProbeX.toFixed(2)}, ${expProbeY.toFixed(2)}), got ${JSON.stringify(probeCoords)}`);
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter20", /sidelifter20|spawned/i, 10000);
      const tr = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list().find((t) => t.craneSpanY < 4.0) || null;`), 8000, 200, "sidelifter20");
      near(tr.craneSpanY, 2.9265, 1e-3, "Live sidelifter20 craneSpanY");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F4.04",
    1,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const idxMod = await tryImportVehicle("index.js");
      assert(idxMod.ok, idxMod.reason);
      const table = idxMod.mod.SIDELIFT_REFUSAL_REASONS;
      assert(table && typeof table[0] === "string" && table[0].length > 0, "SIDELIFT_REFUSAL_REASONS[0] present");
      const env = await makeQcLiveEnv();
      try {
        for (let aux = 1; aux <= 7; aux++) {
          assert(typeof table[aux] === "string" && table[aux] !== table[0], `SIDELIFT_REFUSAL_REASONS[${aux}] must be distinct non-fallback`);
          env.push({ type: "event", kind: VEHICLE_EVENT_KIND.SideliftRefused, vehicle: 0x80099101, subject: 0, aux });
          env.tick(100 + aux * 20);
          const promptNode = env.doc.getElementById("hb-vehicle-prompt");
          assert(promptNode && promptNode.textContent === table[aux], `Aux=${aux} rendered "${promptNode?.textContent}" expected "${table[aux]}"`);
        }
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.deployOutriggers(${ids}, "right"); return true;`);
      await live.waitUntil(async () => (await live.getTrailer(ids))?.sideliftPhase === 2, 6000, 150, "outriggers planted");
      // Trigger locked twistlocks refusal -> verify non-zero Aux event & non-fallback prompt
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids}, "offload", "right"); return true;`);
      const res = await live.waitUntil(async () => await live.evalInPage(`
        const ev = [...(window.__vehicles.events() || [])].reverse().find((e) => e.kind === 24);
        const txt = document.getElementById("hb-vehicle-prompt")?.textContent || "";
        return ev && ev.aux >= 1 && ev.aux <= 7 && txt.length > 0 ? { aux: ev.aux, txt } : null;
      `), 6000, 150, "SideliftRefused Aux 1..7");
      assert(res.aux >= 1 && res.aux <= 7, `Expected non-zero Aux 1..7, got ${res.aux}`);
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F4.05",
    1,
    "F4:Sidelifter_LeftRight_Aux",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid } = sim.spawnPreset("sidelifter40");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload).ok, "AutoOffload ok");
      assert(sim.events.some((e) => e.kind === VEHICLE_EVENT_KIND.SideliftStarted) && sim.events.some((e) => e.kind === VEHICLE_EVENT_KIND.SideliftComplete), "Started & Complete emitted");
      assert(sim.trailers.get(trGuid).sideliftPhase === SIDELIFT_PHASE.Idle, "Returned to Idle");
      assert(sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoLoad).ok, "AutoLoad ok");
      assert(sim.trailers.get(trGuid).mountedContainerGuid !== 0, "Container mounted again");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const tGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.trailers.list()[0]?.guid || 0;`), 8000, 200, "sidelifter40");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autooffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 25000, 250, "AutoOffload complete");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${tGuid}, "autoload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(tGuid);
        return t && t.mountedContainerGuid !== 0 && t.sideliftPhase === 0;
      }, 25000, 250, "AutoLoad complete");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F5: Containers & Rotation
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F5.01",
    1,
    "F5:Containers_Rotation",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.push({ type: "container_state", containerGuid: 0x80099201, containerKind: 10, doorState: 2, doorProgress: 1.0, cell: 0xa9b30002, position: [19, 24, 94], heading: 0 });
        env.tick(100);
        const surf = env.live.sessionHandle.probeContainerSurface(gx, gy - 3.3, gz + 2);
        assert(surf && surf.zone === "ramp" && surf.z > gz && surf.z < gz + 0.162, "Open door enables rear ramp surface");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container spawn 20", /spawned|container/i, 8000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "container");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F5.02",
    1,
    "F5:Containers_Rotation",
    async () => {
      const sim = new QcWorldSimulator();
      const halfL = LOGISTICS_SPEC.containers[10].extL / 2;
      const rearDist = -(halfL + 0.85 + 1.5);
      for (const h of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const cGuid = sim.allocGuid();
        sim.containers.set(cGuid, {
          guid: cGuid, kind: 10, wcid: 4000020, x: 100, y: 200, z: 10, heading: h,
          mountedOnTrailerGuid: 0, doorState: 2, doorProgress: 1.0,
          slots: [{ slotIndex: 0, subSlot: 0, cargoWcid: 4000010, palletSize: 2, cargoState: {} }],
        });
        const res = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 0 });
        assert(res.ok, `Unpack failed at heading=${h}`);
        const [expX, expY] = acHeadingTransform(100, 200, 0, rearDist, h);
        near(res.pos[0], expX, 1e-4, `Unpack X at heading=${h.toFixed(2)}`);
        near(res.pos[1], expY, 1e-4, `Unpack Y at heading=${h.toFixed(2)}`);
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      const halfL = LOGISTICS_SPEC.containers[10].extL / 2;
      const rearDist = -(halfL + 0.85 + 1.5);
      for (const h of [Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        await live.cleanupWorld();
        const p0 = await live.getPlayerGlobalPose();
        const qw = Math.cos(-h / 2);
        const qz = Math.sin(-h / 2);
        await live.sendChat(`@teleloc 0x${p0.landblockId.toString(16)} ${p0.lx.toFixed(2)} ${p0.ly.toFixed(2)} ${p0.z.toFixed(2)} ${qw.toFixed(6)} 0 0 ${qz.toFixed(6)}`);
        const p = await live.waitUntil(async () => {
          const cur = await live.getPlayerGlobalPose();
          return cur && Math.abs(angleDiff(cur.heading, h)) < 0.2 ? cur : null;
        }, 8000, 150, `player rotated to heading ${h.toFixed(2)}`);
        await live.sendChatAndWait(`@container spawn 20 ${p.gx.toFixed(2)} ${(p.gy + 6).toFixed(2)} ${p.z.toFixed(2)}`, /spawned|container/i, 8000);
        const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "rotated container");
        const cDet = await live.getContainer(c.guid);
        assert(
          Math.abs(angleDiff(cDet.heading, h)) < 0.25 && Math.abs(wrapPi(cDet.heading)) > 0.5,
          `Expected rotated container heading ~${h.toFixed(2)}, got ${cDet.heading}`
        );
        await live.sendChat(`@container doors 0x${(c.guid >>> 0).toString(16)} open`);
        await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
        await live.evalInPage(`window.__sessionHandle.vehicleContainerAction(${c.guid}, 3, 0, 0, 4000010); return true;`);
        await live.waitUntil(async () => ((await live.getContainer(c.guid))?.slots?.length ?? 0) >= 1, 6000, 150, "slot 0 loaded");
        await live.sendChatAndWait(`@container unpack 0x${(c.guid >>> 0).toString(16)} 0`, /unpacked/i, 8000);
        const dep = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0] || null;`), 6000, 150, "unpacked deployable");
        const [expX, expY] = acHeadingTransform(cDet.pos[0], cDet.pos[1], 0, rearDist, cDet.heading);
        assert(Math.hypot(dep.pos[0] - expX, dep.pos[1] - expY) <= 1.2, `Unpacked pos [${dep.pos[0].toFixed(2)}, ${dep.pos[1].toFixed(2)}] vs expected AC compass [${expX.toFixed(2)}, ${expY.toFixed(2)}] at h=${h.toFixed(2)}`);
      }
      await live.sendChat("@teleloc 0xA9B30002 19.20 24.00 94.00");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F5.03",
    1,
    "F5:Containers_Rotation",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        for (const h of [Math.PI / 2, Math.PI]) {
          env.push({ type: "container_state", containerGuid: 0x80099201, containerKind: 10, doorState: 2, doorProgress: 1.0, cell: 0xa9b30002, position: [19, 24, 94], heading: h });
          env.tick(100);
          const [rx, ry] = acHeadingTransform(gx, gy, 0, -3.3, h);
          const [fx, fy] = acHeadingTransform(gx, gy, 0, 0.0, h);
          const sRamp = env.live.sessionHandle.probeContainerSurface(rx, ry, gz + 1.5);
          const sFloor = env.live.sessionHandle.probeContainerSurface(fx, fy, gz + 1.5);
          assert(sRamp && sRamp.zone === "ramp", `Ramp probe at h=${h.toFixed(2)}`);
          assert(sFloor && sFloor.zone === "floor" && Math.abs(sFloor.z - (gz + 0.162)) < 1e-4, `Floor +0.162m at h=${h.toFixed(2)}`);
        }
      } finally {
        env.dispose();
      }
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
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "rotated container");
      const cDet = await live.getContainer(c.guid);
      assert(
        Math.abs(angleDiff(cDet.heading, h)) < 0.25 && Math.abs(wrapPi(cDet.heading)) > 0.5,
        `Expected rotated container heading ~${h.toFixed(2)}, got ${cDet.heading}`
      );
      await live.sendChat(`@container doors 0x${(c.guid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(c.guid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      const [fx, fy] = acHeadingTransform(cDet.pos[0], cDet.pos[1], 0, 0, cDet.heading);
      const surf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${fx}, ${fy}, ${cDet.pos[2] + 1.5}) || null;`);
      assert(surf && Math.abs(surf.z - (cDet.pos[2] + 0.162)) < 0.05, `Rotated floor probe expected +0.162m, got ${JSON.stringify(surf)}`);
      await live.sendChat("@teleloc 0xA9B30002 19.20 24.00 94.00");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F5.04",
    1,
    "F5:Containers_Rotation",
    async () => {
      const sim = new QcWorldSimulator();
      const { cGuid } = sim.spawnPreset("sidelifter20");
      sim.containers.get(cGuid).mountedOnTrailerGuid = 0;
      sim.openContainerDoors(cGuid, true);
      const u = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Unpack, { slotIndex: 9 });
      assert(u.ok && u.dGuid, "Unpacked slot 9");
      const pk = sim.containerAction(cGuid, CONTAINER_ACTION_KIND.Pack, { slotIndex: 9, cargoWcid: u.dGuid });
      assert(pk.ok, "Packed back into slot 9");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} all`, /unpacked/i, 10000);
      const dGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0]?.guid || 0;`), 8000, 200, "unpacked");
      await live.sendChatAndWait(`@container pack 0x${(cGuid >>> 0).toString(16)} 0x${(dGuid >>> 0).toString(16)}`, /packed/i, 8000);
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F5.05",
    1,
    "F5:Containers_Rotation",
    async () => {
      const reach20 = oracleComputeReachableUnloadSlots(10, [{ slotIndex: 0, subSlot: 0, palletSize: 2 }, { slotIndex: 8, subSlot: 0, palletSize: 2 }]);
      assert(reach20.reachable.some((r) => r.slotIndex === 8) && !reach20.reachable.some((r) => r.slotIndex === 0), "20ft LIFO blocks slot 0 behind slot 8");
      const reach40 = oracleComputeReachableUnloadSlots(11, [{ slotIndex: 0, subSlot: 0, palletSize: 2 }, { slotIndex: 18, subSlot: 0, palletSize: 2 }, { slotIndex: 20, subSlot: 0, palletSize: 2 }]);
      assert(reach40.reachable.some((r) => r.slotIndex === 18) && !reach40.reachable.some((r) => r.slotIndex === 0), "40ft LIFO blocks slot 0 behind outer bays 18/20");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const c = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0] || null;`), 8000, 200, "fob20");
      const cl = await tryImportVehicle("container_logistics.js");
      assert(cl.ok, cl.reason);
      const reach = cl.mod.computeReachableUnloadSlots(c.kind, c.last?.slots || []);
      assert(reach && Array.isArray(reach.reachable) && reach.reachable.length >= 1, "At least outer bay reachable in fob20");
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F6: Pallet Jack & Late-Observer Sync
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F6.01",
    1,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab).ok, "Grab ok");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.RaiseForks).ok, "RaiseForks ok");
      near(sim.palletJacks.get(pjGuid).forkHeightM, 0.2, 1e-4, "Fork height 0.200m");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Release).ok, "Release ok");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      const pj = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.palletJacks.list()[0] || null;`), 8000, 200, "pallet jack");
      await live.movePlayerNear(pj.pos, [0, -1.2, 0]);
      await live.dispatchKey("KeyB");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      await live.dispatchKey("Space", { key: " " });
      await live.waitUntil(async () => ((await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.forkHeightM || 0;`)) >= 0.19), 5000, 150, "raised forks");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${pj.guid})?.operatorGuid || 0;`)) === 0, 5000, 150, "released");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F6.02",
    1,
    "F6:PalletJack_Sync",
    async () => {
      const sim = new QcWorldSimulator();
      const { trGuid, cGuid, pjGuid } = sim.spawnPreset("sidelifter40");
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.DeployPalletJack);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.ToggleTwistlock);
      sim.trailerAction(trGuid, TRAILER_ACTION_KIND.AutoOffload);
      sim.openContainerDoors(cGuid, true);
      sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.Grab);
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.PickContainerSlot, { targetGuid: cGuid, slotIndex: 20 }).ok, "Pick generator slot 20");
      assert(sim.palletJacks.get(pjGuid).carriedCargoState.fuel === 120, "Fuel preserved on jack");
      assert(sim.palletJackAction(pjGuid, PALLET_JACK_ACTION_KIND.DropToGround).ok, "Drop to ground");
      const dropped = [...sim.deployables.values()][0];
      assert(dropped.cargoState.fuel === 120, "Fuel preserved on ground");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@palletjack spawn", /pallet|spawned/i, 8000);
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|spawned/i, 8000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const pj = window.__vehicles.palletJacks.list()[0];
        const d = window.__vehicles.deployables.list()[0];
        return pj && d ? { pjGuid: pj.guid, dGuid: d.guid, pjPos: pj.pos, dPos: d.pos } : null;
      `), 8000, 200, "pj + turret");
      await live.evalInPage(`window.__vehicles.palletJacks.toggleDeployableStow(${ids.dGuid}); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return Boolean((window.__vehicles.deployables.list().find((x) => x.guid === ${ids.dGuid})?.last?.onlineFlags ?? 0) & 0x10);`), 5000, 150, "stowed");
      await live.movePlayerNear(ids.pjPos, [0, -1.2, 0]);
      await live.dispatchKey("KeyB");
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.operatorGuid || 0;`)) !== 0, 5000, 150, "grabbed");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${ids.dGuid}, ${ids.pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.carriedWcid || 0;`)) === 4000014, 6000, 150, "carrying 4000014");
      await live.evalInPage(`window.__vehicles.palletJacks.dropGround(${ids.pjGuid}); return true;`);
      await live.waitUntil(async () => (await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.carriedWcid || 0;`)) === 0, 6000, 150, "dropped");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F6.03",
    1,
    "F6:PalletJack_Sync",
    async () => {
      const idxMod = await tryImportVehicle("index.js");
      assert(idxMod.ok, idxMod.reason);
      const table = idxMod.mod.PALLET_JACK_EVENT_REASONS;
      assert(table && typeof table[0] === "string" && table[0].length > 0, "PALLET_JACK_EVENT_REASONS[0] present");
      const env = await makeQcLiveEnv();
      try {
        for (let aux = 1; aux <= 7; aux++) {
          assert(typeof table[aux] === "string" && table[aux] !== table[0], `PALLET_JACK_EVENT_REASONS[${aux}] distinct`);
          env.push({ type: "event", kind: VEHICLE_EVENT_KIND.PalletJackEvent, vehicle: 0x800b0001, subject: 0, aux });
          env.tick(200 + aux * 20);
          const promptNode = env.doc.getElementById("hb-vehicle-prompt");
          assert(promptNode && promptNode.textContent === table[aux], `Aux=${aux} rendered "${promptNode?.textContent}" expected "${table[aux]}"`);
        }
      } finally {
        env.dispose();
      }
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
      // Raise forks and attempt pickup -> expect Aux in 1..7 & prompt
      await live.dispatchKey("Space", { key: " " });
      await live.waitUntil(async () => ((await live.evalInPage(`return window.__vehicles.palletJacks.get(${ids.pjGuid})?.forkHeightM || 0;`)) >= 0.19), 5000, 150, "forks raised");
      await live.evalInPage(`window.__vehicles.palletJacks.pickGround(${ids.dGuid}, ${ids.pjGuid}); return true;`);
      const res = await live.waitUntil(async () => await live.evalInPage(`
        const ev = [...(window.__vehicles.events() || [])].reverse().find((e) => e.kind === 25 && e.aux >= 3);
        const txt = document.getElementById("hb-vehicle-prompt")?.textContent || "";
        return ev && txt.length > 0 ? { aux: ev.aux, txt } : null;
      `), 6000, 150, "PalletJackEvent Aux 3..7");
      assert(res.aux >= 1 && res.aux <= 7, `Expected non-zero PalletJackEvent Aux, got ${res.aux}`);
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F6.04",
    1,
    "F6:PalletJack_Sync",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.push({ type: "deployable_state", deployable: 0x80094010, kind: DEPLOYABLE_KIND.MissileTurret, cell: 0xa9b30002, x: 19, y: 24, z: 94, onlineFlags: ONLINE_FLAGS.Active });
        env.tick(100);
        env.entityMap.get(1001).root.position.set(gx, gy - 1.5, gz);
        env.fakeWinObj.dispatch("keydown", { code: "KeyR", key: "r" });
        assert(env.calls.vehiclePalletJackAction.some((a) => a.action === PALLET_JACK_ACTION_KIND.ToggleDeployableStow && a.targetGuid === 0x80094010), "On-foot KeyR dispatches ToggleDeployableStow (10)");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable spawn 4000014", /4000014|spawned/i, 8000);
      const dep = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list()[0] || null;`), 8000, 200, "turret");
      await live.movePlayerNear(dep.pos, [0, -1.5, 0]);
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`return Boolean((window.__vehicles.deployables.list().find((d) => d.guid === ${dep.guid})?.last?.onlineFlags ?? 0) & 0x10);`), 6000, 150, "KeyR stowed");
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`return !((window.__vehicles.deployables.list().find((d) => d.guid === ${dep.guid})?.last?.onlineFlags ?? 0) & 0x10);`), 6000, 150, "KeyR unstowed");
      await live.cleanupWorld();
    }
  );

  await collector.checkLive("T1.QC.F6.05", 1, "F6:PalletJack_Sync", async (live) => {
    await live.cleanupWorld();
    await live.ensureOutdoorFlatSite();
    await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
    const ids = await live.waitUntil(async () => await live.evalInPage(`
      const t = window.__vehicles.trailers.list()[0];
      return t && t.stowedPalletJackGuid ? { tGuid: t.guid, pjGuid: t.stowedPalletJackGuid } : null;
    `), 8000, 200, "sidelifter40 stowed jack");
    const p1 = await live.getPlayerGlobalPose();
    const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
    await sec.sendChat(`@teleloc 0x${p1.landblockId.toString(16)} ${(p1.lx + 4).toFixed(2)} ${p1.ly.toFixed(2)} ${p1.z.toFixed(2)}`);
    const synced = await live.waitUntil(async () => await sec.evalInPage(`
      const pj = window.__vehicles?.palletJacks?.get?.(${ids.pjGuid});
      return pj && (pj.stowedOnTrailerGuid >>> 0) === ${ids.tGuid} ? pj : null;
    `), 12000, 200, "late-observer stowed pallet jack sync");
    assert((synced.stowedOnTrailerGuid >>> 0) === ids.tGuid, "Late observer sees StowedOnTrailerGuid");
    await live.cleanupWorld();
  });

  // ---------------------------------------------------------------------------
  // F7: MicroGrid & AirDefense Combat
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F7.01",
    1,
    "F7:MicroGrid_AirDefense",
    async () => {
      const dm = await tryImportVehicle("deployable_models.js");
      const rm = await tryImportVehicle("radar_model.js");
      assert(dm.ok && rm.ok, "deployable_models.js & radar_model.js load");
      for (const d of ALL_9_DEPLOYABLES) {
        const m = d.wcid === 4000002 ? rm.mod.buildDeployedRadar(THREE) : dm.mod.buildDeployable(THREE, d.wcid);
        assert(countLights(m.root) === 0, `${d.name} 0 THREE.Lights`);
        assert(countDrawCalls(m.root) <= 10, `${d.name} draw calls <= 10`);
        m.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "doors open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const count = await live.waitUntil(async () => await live.evalInPage(`
        const set = new Set(window.__vehicles.deployables.list().map((d) => d.wcid));
        return set.size >= 9 ? set.size : null;
      `), 10000, 200, "9 unit types");
      assert(count >= 9, "All 9 deployable WCIDs live");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F7.02",
    1,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), s = sim.allocGuid(), g = sim.allocGuid(), b = sim.allocGuid(), t = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(s, { guid: s, wcid: 4000011, x: 5, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 10, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(b, { guid: b, wcid: 4000013, x: 15, y: 0, z: 0, isStowed: false, cargoState: { energy: 600000 } });
      sim.deployables.set(t, { guid: t, wcid: 4000014, x: 20, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(t).onlineFlags & (ONLINE_FLAGS.Powered | ONLINE_FLAGS.InFluxRange)) === 3, "Powered + InFluxRange");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "generator");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 5`, /refueled generator/i, 8000);
      const powered = await live.waitUntil(async () => await live.evalInPage(`
        const tur = window.__vehicles.deployables.list().find((d) => d.wcid === 4000014);
        const genD = window.__vehicles.deployables.list().find((d) => d.wcid === 4000012);
        return tur && genD && (tur.last?.onlineFlags & 0x03) === 0x03 && (genD.last?.fuelSec ?? 0) > 100 ? true : false;
      `), 10000, 200, "MicroGrid powered + generator fueled");
      assert(powered, "MicroGrid consumers powered and fueled");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F7.03",
    1,
    "F7:MicroGrid_AirDefense",
    async () => {
      const rm = await tryImportVehicle("radar_model.js");
      assert(rm.ok, rm.reason);
      const env = await makeQcLiveEnv();
      try {
        const [gx, gy, gz] = toGlobal(0xa9b30002, 19, 24, 94);
        env.push({ type: "deployable_state", deployable: 0x80094002, kind: DEPLOYABLE_KIND.RadarStation, cell: 0xa9b30002, x: 19, y: 24, z: 94, onlineFlags: ONLINE_FLAGS.Active });
        env.tick(100);
        const list1 = env.api.deployables.list();
        const rEntry = env.live.worldRoot.getObjectByName("deployed-radar-station");
        assert(list1.some((d) => d.wcid === 4000002) && rEntry, "RadarStation spawned in client scene");
        env.push({ type: "deployable_state", deployable: 0x80094002, kind: DEPLOYABLE_KIND.RadarStation, cell: 0xa9b30002, x: 19, y: 24, z: 94, onlineFlags: ONLINE_FLAGS.Stowed });
        env.tick(133);
        const dAfter = env.api.deployables.list().find((d) => d.guid === 0x80094002);
        assert((dAfter.last.onlineFlags & ONLINE_FLAGS.Stowed) !== 0, "OnlineFlags.Stowed (0x10) received for RadarStation");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const rad = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000002) || null;`), 8000, 200, "RadarStation 4000002");
      await live.movePlayerNear(rad.pos, [0, -1.5, 0]);
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`return Boolean((window.__vehicles.deployables.list().find((d) => d.guid === ${rad.guid})?.last?.onlineFlags ?? 0) & 0x10);`), 6000, 150, "RadarStation stowed broadcast 0x10");
      await live.dispatchKey("KeyR");
      await live.waitUntil(async () => await live.evalInPage(`return !((window.__vehicles.deployables.list().find((d) => d.guid === ${rad.guid})?.last?.onlineFlags ?? 0) & 0x10);`), 6000, 150, "RadarStation unstowed broadcast");
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F7.04",
    1,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), b = sim.allocGuid(), m = sim.allocGuid(), l = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 5, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(b, { guid: b, wcid: 4000013, x: 10, y: 0, z: 0, isStowed: false, cargoState: { energy: 600000 } });
      sim.deployables.set(m, { guid: m, wcid: 4000016, x: 15, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(l, { guid: l, wcid: 4000017, x: 20, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.recomputeMicroGrid();
      const rm = sim.tickAirDefenseFire(m, 0x80099901, [120, 0, 0], { standing: IFF_STANDING.Hostile, distM: 120 });
      const rl = sim.tickAirDefenseFire(l, 0x80099901, [120, 0, 0], { standing: IFF_STANDING.Hostile, distM: 120 });
      assert(rm.ok && rl.ok && rl.evt.energyJoules === 120000, "Mortar & Laser fired");
      assert(sim.deployables.get(b).cargoState.energy === 480000, "Battery discharged by 120 kJ");

      const dv = await tryImportVehicle("deployable_vfx.js");
      assert(dv.ok, dv.reason);
      const vfx = dv.mod.createDeployableCombatVfx({ liveScene3d: { worldRoot: new THREE.Group() }, THREE, ground: () => 0 });
      vfx.handleFireEvent({ weaponKind: 2, muzzle: [15, 0, 2], targetPos: [120, 0, 0] });
      vfx.handleFireEvent({ weaponKind: 3, muzzle: [20, 0, 2], targetPos: [120, 0, 0] });
      vfx.update(0.05);
      assert(countLights(vfx.root) === 0, "0 THREE.Lights during combat VFX");
      vfx.dispose();
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
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
      // Spawn a genuinely Hostile (3) target via tailnet2 (SpawnedBy != DeployerPlayerGuid)
      const sec = await live.openSecondContext("tailnet2", "tailnet2", "TailnetTwo");
      await sec.sendChat(`@teleloc 0x${p.landblockId.toString(16)} ${(p.lx + 30).toFixed(2)} ${p.ly.toFixed(2)} ${p.z.toFixed(2)}`);
      await sec.sendChat("@vehicle spawn jeep-mb");
      const engagement = await live.waitUntil(async () => await live.evalInPage(`
        const bat = window.__vehicles.deployables.list().find((d) => d.wcid === 4000013);
        const las = window.__vehicles.deployables.list().find((d) => d.wcid === 4000017);
        const cur = bat?.last?.energyJoules ?? 0;
        if (cur > (window.__qcPeakEnergy ?? 0)) window.__qcPeakEnergy = cur;
        const peak = window.__qcPeakEnergy ?? 0;
        const fires = window.__qcFireEvents || [];
        const hasLaserFire = fires.some((f) => f.weaponKind === 3);
        const discharged = peak >= 120000 && cur <= peak - 100000;
        return (discharged || hasLaserFire) ? { peak, cur, hasLaserFire, firesCount: fires.length, lasFlags: las?.last?.onlineFlags ?? 0 } : null;
      `), 18000, 150, "Hostile target Laser fire / battery discharge");
      assert(
        engagement.hasLaserFire || engagement.cur <= engagement.peak - 100000,
        `Expected Laser fire or >=100kJ discharge from peak ${engagement.peak}, got ${JSON.stringify(engagement)}`
      );
      await live.cleanupWorld();
    }
  );

  await collector.runDual(
    "T1.QC.F7.05",
    1,
    "F7:MicroGrid_AirDefense",
    async () => {
      const sim = new QcWorldSimulator();
      const f = sim.allocGuid(), g = sim.allocGuid(), sam = sim.allocGuid();
      sim.deployables.set(f, { guid: f, wcid: 4000010, x: 0, y: 0, z: 0, isStowed: false, cargoState: {} });
      sim.deployables.set(g, { guid: g, wcid: 4000012, x: 5, y: 0, z: 0, isStowed: false, cargoState: { fuel: 600 } });
      sim.deployables.set(sam, { guid: sam, wcid: 4000014, x: 10, y: 0, z: 0, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      const res = sim.tickAirDefenseFire(sam, 0x80099902, [500, 0, 120], { standing: IFF_STANDING.Hostile, aglM: 120, distM: 500, isAir: true });
      assert(res.ok && res.evt.burstCount === 4 && sim.deployables.get(sam).cargoState.ammo === 0, "4-SAM salvo expended ammo 4 -> 0");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
      await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
      await live.sendChatAndWait("@container preset fob20", /fob|spawned/i, 10000);
      const cGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.containers.list()[0]?.guid || 0;`), 8000, 200, "fob20");
      await live.sendChat(`@container doors 0x${(cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "open");
      await live.sendChatAndWait(`@container unpack 0x${(cGuid >>> 0).toString(16)} 6`, /unpacked/i, 8000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 5`, /refueled/i, 8000);
      // Spawn hellcat, takeoff & bail so derelict aircraft > 10m AGL triggers RadarStation -> MissileTurret
      await live.sendChatAndWait("@vehicle spawn hellcat-demo", /spawned|hellcat/i, 8000);
      const hGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles().find((v) => v.profile?.profileKey === "hellcat-demo")?.guid || 0;`), 8000, 200, "hellcat");
      await live.evalInPage(`window.__vehicles.board(${hGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting hellcat");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 1.0, pitch: 0.5 }, 3800); return true;`);
      await new Promise((r) => setTimeout(r, 4000));
      await live.evalInPage(`window.__vehicles.exit(1); return true;`); // bail out -> derelict airborne target
      const samRes = await live.waitUntil(async () => await live.evalInPage(`
        const sam = window.__vehicles.deployables.list().find((d) => d.wcid === 4000014);
        return sam && (sam.last?.ammo ?? 4) < 4 ? { ammo: sam.last.ammo } : null;
      `), 18000, 250, "MissileTurret SAM salvo fired");
      assert(samRes.ammo < 4, `Expected MissileTurret ammo < 4 after salvo, got ${samRes.ammo}`);
      await live.cleanupWorld();
    }
  );

  // ---------------------------------------------------------------------------
  // F8: Dericost Continent & Visual Sanity
  // ---------------------------------------------------------------------------

  await collector.runDual(
    "T1.QC.F8.01",
    1,
    "F8:Dericost_Visual",
    async () => {
      const fm = await tryImportVehicle("flight_model.js");
      assert(fm.ok, fm.reason);
      near(fm.mod.DERICOST_Y_OFFSET, 68928.0, 1e-6, "flight_model DERICOST_Y_OFFSET");
      assert(fm.mod.WORLD_Y_MAX >= 117887.0, "WORLD_Y_MAX covers Dericost");
      const [gx, gy, gz] = toGlobal(DERICOS_FLAT_SITE.cell, DERICOS_FLAT_SITE.lx, DERICOS_FLAT_SITE.ly, DERICOS_FLAT_SITE.z);
      near(gx, DERICOS_FLAT_SITE.gx, 1e-4, "Dericost gx");
      near(gy, DERICOS_FLAT_SITE.gy, 1e-4, "Dericost gy");
      const cl = toCellLocal(gx, gy, gz);
      assert((cl.cell & 0x8000) !== 0 && cl.continent === 1, "toCellLocal sets bit 15 on Dericost");
    },
    async (live) => {
      await live.cleanupWorld();
      const site = await live.ensureDericostFlatSite();
      assert((site.landblockId & 0x8000) !== 0 && Number.isFinite(site.tz), `Dericost terrain finite (${site.tz})`);
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi on Dericost");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting on Dericost");
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.7 }, 1400); return true;`);
      await new Promise((r) => setTimeout(r, 1550));
      const pAfter = await live.getPlayerGlobalPose();
      assert(pAfter && pAfter.isDericost && pAfter.gy >= DERICOST_Y_OFFSET, "Rig stayed on Dericost after driving");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T1.QC.F8.02",
    1,
    "F8:Dericost_Visual",
    async () => {
      const env = await makeQcLiveEnv();
      try {
        const cl = DERICOS_FLAT_SITE;
        env.push({ type: "container_state", containerGuid: 0x800d0001, containerKind: 10, doorState: 2, doorProgress: 1.0, cell: cl.cell, position: [cl.lx, cl.ly, cl.z], heading: 0 });
        env.tick(100);
        const sFloor = env.live.sessionHandle.probeContainerSurface(cl.gx, cl.gy, cl.z + 1.5);
        const sRamp = env.live.sessionHandle.probeContainerSurface(cl.gx, cl.gy - 3.3, cl.z + 1.5);
        assert(sFloor && sFloor.zone === "floor" && Math.abs(sFloor.z - (cl.z + 0.162)) < 1e-4, "Dericost floor +0.162m");
        assert(sRamp && sRamp.zone === "ramp", "Dericost ramp walkable");
      } finally {
        env.dispose();
      }
    },
    async (live) => {
      await live.cleanupWorld();
      const site = await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
      const ids = await live.waitUntil(async () => await live.evalInPage(`
        const t = window.__vehicles.trailers.list()[0];
        return t ? { tGuid: t.guid, cGuid: t.mountedContainerGuid } : null;
      `), 8000, 200, "sidelifter40 on Dericost");
      await live.evalInPage(`window.__vehicles.trailers.sidelift(${ids.tGuid}, "autooffload", "right"); return true;`);
      await live.waitUntil(async () => {
        const t = await live.getTrailer(ids.tGuid);
        return t && t.mountedContainerGuid === 0 && t.sideliftPhase === 0;
      }, 25000, 250, "Dericost sidelift offload");
      await live.sendChat(`@container doors 0x${(ids.cGuid >>> 0).toString(16)} open`);
      await live.waitUntil(async () => ((await live.getContainer(ids.cGuid))?.doorProgress ?? 0) >= 0.9, 6000, 150, "Dericost container doors open");
      const cDet = await live.getContainer(ids.cGuid);
      const surf = await live.evalInPage(`return window.__sessionHandle?.probeContainerSurface?.(${cDet.pos[0]}, ${cDet.pos[1]}, ${cDet.pos[2] + 1.5}) || null;`);
      assert(surf && Math.abs(surf.z - (cDet.pos[2] + 0.162)) < 0.08, `Dericost WASM probeContainerSurface expected +0.162m, got ${JSON.stringify(surf)}`);
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runDual(
    "T1.QC.F8.03",
    1,
    "F8:Dericost_Visual",
    async () => {
      const sim = new QcWorldSimulator();
      const { tGuid, trGuid } = sim.spawnPreset("sidelifter40", { x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z });
      const v = sim.tractors.get(tGuid);
      v.seats = [1001, 0];
      sim.exitVehicle(tGuid, 1001);
      assert(v.y >= DERICOST_Y_OFFSET, "Vehicle/exit stays in Dericost coordinates (>= 68928m)");
      sim.deployables.set(0x800d1001, { guid: 0x800d1001, wcid: 4000010, x: DERICOS_FLAT_SITE.gx, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: {} });
      sim.deployables.set(0x800d1002, { guid: 0x800d1002, wcid: 4000012, x: DERICOS_FLAT_SITE.gx + 4, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: { fuel: 200 } });
      sim.deployables.set(0x800d1003, { guid: 0x800d1003, wcid: 4000014, x: DERICOS_FLAT_SITE.gx + 8, y: DERICOS_FLAT_SITE.gy, z: DERICOS_FLAT_SITE.z, isStowed: false, cargoState: { ammo: 4 } });
      sim.recomputeMicroGrid();
      assert((sim.deployables.get(0x800d1003).onlineFlags & ONLINE_FLAGS.Powered) !== 0, "MicroGrid operates on Dericost");
    },
    async (live) => {
      await live.cleanupWorld();
      await live.ensureDericostFlatSite();
      await live.sendChatAndWait("@vehicle spawn semi-379 2", /spawned|semi/i, 8000);
      const vGuid = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.vehicles()[0]?.guid || 0;`), 8000, 200, "semi");
      await live.evalInPage(`window.__vehicles.board(${vGuid}, 0); return true;`);
      await live.waitUntil(async () => await live.evalInPage(`return !!window.__vehicles.piloting;`), 6000, 150, "piloting");
      await live.dispatchKey("KeyX");
      await live.waitUntil(async () => await live.evalInPage(`return !window.__vehicles.piloting;`), 6000, 150, "exited semi");
      const pExit = await live.getPlayerGlobalPose();
      assert(pExit && pExit.isDericost && pExit.gy >= DERICOST_Y_OFFSET, `ProbeExitPosition kept player on Dericost: ${JSON.stringify(pExit)}`);
      await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
      const gen = await live.waitUntil(async () => await live.evalInPage(`return window.__vehicles.deployables.list().find((d) => d.wcid === 4000012)?.guid || 0;`), 8000, 200, "gen");
      await live.sendChatAndWait(`@deployable fuel 0x${(gen >>> 0).toString(16)} 2`, /refueled/i, 8000);
      await live.waitUntil(async () => await live.evalInPage(`return Boolean((window.__vehicles.deployables.list().find((d) => d.wcid === 4000014)?.last?.onlineFlags ?? 0) & 0x01);`), 8000, 200, "Dericost turret powered");
      await live.cleanupWorld();
      await live.ensureOutdoorFlatSite();
    }
  );

  await collector.runCheck("T1.QC.F8.04", 1, "F8:Dericost_Visual", async () => {
    const gfx = await tryImportVehicle("ground_fx.js");
    assert(gfx.ok, gfx.reason);
    const root = new THREE.Group();
    const mgr = gfx.mod.createGroundFx(THREE, root, { profileKey: "semi-379", vehicleClass: 3 });
    assert(mgr.lightCountDelta === 0 && countLights(root) === 0, "ground_fx 0 THREE.Lights");
    const dims = gfx.mod.SEMI_FX_DIMENSIONS;
    for (const h of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      mgr.update({ x: 100, y: 200, z: 10, heading: h, speed: 12, surfaceFamily: 1, vehicleClass: 3 }, 0.1);
      const fresh = mgr.pool.filter((s) => s.active && s.t === 0);
      assert(fresh.length >= dims.wheelOffsets.length + dims.exhaustOffsets.length, `Expected wheel+exhaust spawns at h=${h.toFixed(2)}, got ${fresh.length}`);
      for (const [lx, ly] of dims.wheelOffsets) {
        const [ex, ey] = acHeadingTransform(100, 200, lx, ly, h);
        const hit = fresh.some((s) => Math.abs(s.z - 10.05) < 0.05 && Math.hypot(s.x - ex, s.y - ey) < 1e-4);
        assert(hit, `Missing rotated wheel particle at (${ex.toFixed(3)}, ${ey.toFixed(3)}) for local (${lx}, ${ly}) h=${h.toFixed(2)}`);
      }
      for (const [exOff, eyOff, ezOff] of dims.exhaustOffsets) {
        const [ex, ey] = acHeadingTransform(100, 200, exOff, eyOff, h);
        const hit = fresh.some((s) => Math.abs(s.z - (10 + ezOff)) < 0.05 && Math.hypot(s.x - ex, s.y - ey) < 1e-4);
        assert(hit, `Missing rotated exhaust particle at (${ex.toFixed(3)}, ${ey.toFixed(3)}) for local (${exOff}, ${eyOff}) h=${h.toFixed(2)}`);
      }
    }
    assert(mgr.getActiveCount() > 0, "ground_fx emitted particles across rotated headings");
    mgr.dispose();
  });

  await collector.checkLive("T1.QC.F8.05", 1, "F8:Dericost_Visual", async (live) => {
    await live.cleanupWorld();
    const site = await live.ensureDericostFlatSite();
    await live.sendChatAndWait("@trailer preset sidelifter40", /sidelifter|spawned/i, 10000);
    await live.sendChatAndWait("@deployable preset base", /spawned|base/i, 10000);
    await live.orbitCam(site.gx, site.gy, site.z + 2, 26, 0.7, 0.35);
    await live.hideHud();
    await new Promise((r) => setTimeout(r, 350));
    const shot = await live.captureAndVerifyShot("t1_qc_f8_05_dericost_ultra");
    await live.showHud();
    assert(shot.width >= 1280 && shot.height >= 720 && shot.distinctPixels >= 16, `Valid EGL shot: ${JSON.stringify(shot)}`);
    const errs = await live.checkConsoleErrors();
    assert(errs.failing.length === 0, `Non-allowlisted console errors: ${errs.failing.join("; ")}`);
    await live.cleanupWorld();
    await live.ensureOutdoorFlatSite();
  });
}
