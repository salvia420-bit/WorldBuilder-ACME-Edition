// harness/e2e_semi/tier3_pairwise.mjs — Tier 3 Cross-Feature Pairwise Combinations (12 tests >= 10).

import { readFileSync } from "node:fs";
import {
  DEPLOYABLE_KIND,
  OPCODES,
  SEMI_SPEC,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  VEHICLE_EVENT_KIND,
  assert,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleProfile,
  decodeVehicleState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleProfile,
  encodeVehicleState,
  getThree,
  makeFakeControlsWin,
  makeSemiLiveEnv,
  near,
  oracleComputeMountedContainerPose,
  oracleStepCoupledTrailer,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  unwrapC2SFrame,
  unwrapS2CFrame,
  wrapC2SFrame,
  wrapPi,
  wrapS2CFrame,
} from "./common.mjs";

export const TIER3_METADATA = [
  { id: "T3.01", tier: 3, feature: "Pairwise:Rig_Models_FifthWheel_Container_Fit", mode: "offline" },
  { id: "T3.02", tier: 3, feature: "Pairwise:TowMassMul_x_Surfaces_x_Brake_Reverse_Ford", mode: "offline" },
  { id: "T3.03", tier: 3, feature: "Pairwise:Coupled_30Hz_Ground_x_TrailerKinematics_STurn", mode: "offline" },
  { id: "T3.04", tier: 3, feature: "Pairwise:InstallVehicles_KeyG_Hitch_Track_Cam_Unhitch", mode: "offline" },
  { id: "T3.05", tier: 3, feature: "Pairwise:Jeep_KeyG_Windscreen_vs_Semi_KeyG_Hitch", mode: "offline" },
  { id: "T3.06", tier: 3, feature: "Pairwise:DualStack_FX_x_Diesel_Audio_x_2Seat_IK_x_OSD", mode: "offline" },
  { id: "T3.07", tier: 3, feature: "Pairwise:Container_Collider_Sync_x_Despawn_AutoUnhitch", mode: "offline" },
  { id: "T3.08", tier: 3, feature: "Pairwise:6_Liveries_x_2_Chassis_x_3_Container_Slots", mode: "offline" },
  { id: "T3.09", tier: 3, feature: "Pairwise:2Seat_Boarding_HotSwap_x_Semi_Camera_Modes", mode: "offline" },
  { id: "T3.10", tier: 3, feature: "Pairwise:HBV1_v6_Frames_x_Dericost_0x8000_Coord_RoundTrip", mode: "offline" },
  { id: "T3.11", tier: 3, feature: "Pairwise:Trailer_BrakeLights_x_Handbrake_x_GladHands", mode: "offline" },
  { id: "T3.12", tier: 3, feature: "Pairwise:Existing_Containers_Deployables_NonRegression", mode: "offline" },
];

export async function runTier3(collector) {
  const probeSemiAndUpgradedTrailer = async () => {
    const sm = await tryImportVehicle("semi_truck_model.js");
    const tm = await tryImportVehicle("trailer_models.js");
    if (!sm.ok || typeof sm.mod.buildSemiTruck !== "function") {
      return { ok: false, reason: "semi_truck_model.js not landed yet (M2)" };
    }
    if (!tm.ok || tm.mod.CHASSIS_KINGPIN_Z === undefined) {
      return { ok: false, reason: "trailer_models.js M2 upgrades (CHASSIS_KINGPIN_Z) not landed yet (M2)" };
    }
    return { ok: true, sm: sm.mod, tm: tm.mod };
  };

  // T3.01: Rig20 / Rig40 / Rig40HC full model + fifth-wheel + container fit
  await collector.checkFeature("T3.01", 3, "Pairwise:Rig_Models_FifthWheel_Container_Fit", probeSemiAndUpgradedTrailer, async ({ sm, tm }) => {
    const THREE = await getThree();
    const { mod: cm } = await tryImportVehicle("container_models.js");
    const semi = sm.buildSemiTruck(THREE, { profileKey: "semi-379", liveryId: 0 }, {});
    semi.root.position.set(10, 20, 0);
    semi.root.updateMatrixWorld(true);
    const anchor = semi.getFifthWheelWorldAnchor();
    const ax = Array.isArray(anchor) ? anchor[0] : anchor.x;
    const ay = Array.isArray(anchor) ? anchor[1] : anchor.y;
    const az = Array.isArray(anchor) ? anchor[2] : anchor.z;

    for (const [kind, cWcid] of [["20ft", 4000020], ["40ft", 4000021], ["40ft", 4000022]]) {
      const tr = tm.buildSemiTrailer(THREE, kind, { landingGearRetracted: true, twistlockState: 1 });
      const kpY = tm.TRAILER_SPECS[kind].kingpinY;
      // Place trailer so its kingpin (0, kpY, 0.96) sits on fifth wheel (ax, ay, az)
      tr.root.position.set(ax, ay - kpY, az - tm.CHASSIS_KINGPIN_Z);
      tr.root.updateMatrixWorld(true);
      near(tr.root.position.z, 0, 0.01, `${kind} trailer ground z alignment when coupled`);
      const c = cm.buildIsoContainer(THREE, cWcid);
      tr.attachContainer(c);
      const cb = new THREE.Box3().setFromObject(c.root);
      near(cb.min.z, SEMI_SPEC.chassisDeckZ, 0.05, `${kind}/${cWcid} container deck height`);
      tr.dispose();
    }
    semi.dispose();
  });

  // T3.02: towMassMul x Surface Families x Braking / Reverse / Ford Depth
  await collector.checkFeature(
    "T3.02",
    3,
    "Pairwise:TowMassMul_x_Surfaces_x_Brake_Reverse_Ford",
    async () => {
      const r = await tryImportVehicle("ground_model.js");
      if (!r.ok || typeof r.mod.paramsFromProfile !== "function") {
        return { ok: false, reason: "ground_model.js paramsFromProfile / towMassMul not landed yet (M2)" };
      }
      return r;
    },
    ({ mod: gm }) => {
      const semiBase = gm.paramsFromProfile({
        profileKey: "semi-379",
        wheelbase: SEMI_SPEC.wheelbase,
        vMax: SEMI_SPEC.vMax,
        reverseMax: SEMI_SPEC.reverseMax,
        accel: SEMI_SPEC.accel,
        decel: SEMI_SPEC.decel,
        climbLimitCos: SEMI_SPEC.climbLimitCos,
        fordDepthMax: SEMI_SPEC.fordDepthMax,
      });
      for (const surfIdx of [0, 1, 4]) { // Road, Dirt, SnowIce
        const surf = gm.SURFACE_FAMILIES[surfIdx];
        const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: surf, waterDepth: 0 });
        const speeds = {};
        for (const mul of [1.0, 0.72, 0.58]) {
          const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
          const p = { ...semiBase, towMassMul: mul };
          for (let i = 0; i < 120; i++) gm.step(st, { throttle: 1, steer: 0, towMassMul: mul }, p, oracle, gm.DT);
          speeds[mul] = st.speed;
        }
        assert(speeds[1.0] > speeds[0.72] && speeds[0.72] > speeds[0.58], `${surf.name} towMassMul ordering broken: ${JSON.stringify(speeds)}`);
      }
      // Reverse limit -7.0
      const stRev = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
      const road = () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[0], waterDepth: 0 });
      for (let i = 0; i < 180; i++) gm.step(stRev, { throttle: -1, steer: 0 }, semiBase, road, gm.DT);
      near(stRev.speed, -7.0, 0.25, "semi reverse terminal speed");

      // Active braking from 20 m/s vs coasting (normalBrake=9.5)
      const stBrake = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20, steerAngle: 0, mode: 6 };
      const stCoast = { ...stBrake };
      for (let i = 0; i < 60; i++) {
        gm.step(stBrake, { throttle: -1, steer: 0 }, semiBase, road, gm.DT);
        gm.step(stCoast, { throttle: 0, steer: 0 }, semiBase, road, gm.DT);
      }
      assert(stBrake.speed < 0.5 && stCoast.speed > 10.0, `brake must stop semi rapidly (${stBrake.speed} vs coast ${stCoast.speed})`);

      // Ford depth limit 1.05 m on ShallowFord (SURFACE_FAMILIES[7])
      const fordSurf = gm.SURFACE_FAMILIES[7];
      const stOkFord = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6, steerAngle: 0, mode: 6 };
      gm.step(stOkFord, { throttle: 1, steer: 0 }, semiBase, () => ({ z: 0, normal: [0, 0, 1], surface: fordSurf, waterDepth: 1.00 }), gm.DT);
      assert(stOkFord.speed > 0, `1.00 m ford permits forward speed, got ${stOkFord.speed}`);
      const stDeepFord = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6, steerAngle: 0, mode: 6 };
      gm.step(stDeepFord, { throttle: 1, steer: 0 }, semiBase, () => ({ z: 0, normal: [0, 0, 1], surface: fordSurf, waterDepth: 1.06 }), gm.DT);
      assert(stDeepFord.speed === 0, `1.06 m ford halts forward speed, got ${stDeepFord.speed}`);
    }
  );

  // T3.03: Coupled 30 Hz GroundModel + TrailerKinematics S-Turn & Reverse Jackknife
  await collector.checkFeature(
    "T3.03",
    3,
    "Pairwise:Coupled_30Hz_Ground_x_TrailerKinematics_STurn",
    async () => {
      const gm = await tryImportVehicle("ground_model.js");
      const tk = await tryImportVehicle("trailer_kinematics.js");
      if (!gm.ok || typeof gm.mod.paramsFromProfile !== "function") return { ok: false, reason: "ground_model.js paramsFromProfile missing (M2)" };
      if (!tk.ok || typeof tk.mod.stepCoupledTrailer !== "function") return { ok: false, reason: "trailer_kinematics.js missing (M2)" };
      return { ok: true, gm: gm.mod, tk: tk.mod };
    },
    ({ gm, tk }) => {
      const p = gm.paramsFromProfile({
        profileKey: "semi-379",
        wheelbase: SEMI_SPEC.wheelbase,
        maxSteerRad: SEMI_SPEC.maxSteerRad,
        vMax: SEMI_SPEC.vMax,
        reverseMax: SEMI_SPEC.reverseMax,
        accel: SEMI_SPEC.accel,
        decel: SEMI_SPEC.decel,
      });
      const spec = tk.TRAILER_PHYSICS_SPECS["40ft"];
      const oracle = () => 10;
      const st = { x: 0, y: 0, z: 10, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
      let tr = { heading: 0 };
      let trRef = { heading: 0 };
      // 300 forward S-turn steps + 150 hard reverse turn steps
      for (let i = 0; i < 450; i++) {
        const throttle = i < 240 ? 1.0 : (i < 270 ? -1.0 : -0.8);
        const steer = i < 120 ? 0.6 : (i < 240 ? -0.6 : 1.0);
        const prevH = st.heading;
        gm.step(st, { throttle, steer, towMassMul: 0.58 }, { ...p, towMassMul: 0.58 }, () => ({ z: 10, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[0] }), gm.DT);
        const yawRate = wrapPi(st.heading - prevH) / gm.DT;
        tr = tk.stepCoupledTrailer({ ...st, yawRate }, tr, SEMI_SPEC.fifthWheelOffsetY, spec, oracle, gm.DT);
        trRef = oracleStepCoupledTrailer({ ...st, yawRate }, trRef, SEMI_SPEC.fifthWheelOffsetY, SEMI_SPEC.trailers["40ft"], oracle, gm.DT);
        const art = Math.abs(wrapPi(st.heading - tr.heading));
        assert(art <= tk.MAX_JACKKNIFE_RAD + 1e-4, `jackknife angle exceeded at step ${i}: ${art}`);
      }
      near(tr.heading, trRef.heading, 0.02, "coupled S-turn+reverse heading matches oracle");
    }
  );

  // T3.04: Live installVehicles KeyG hitch -> coupled tracking -> towed camera -> unhitch
  await collector.checkFeature(
    "T3.04",
    3,
    "Pairwise:InstallVehicles_KeyG_Hitch_Track_Cam_Unhitch",
    async () => {
      const env = await makeSemiLiveEnv();
      const ok = Boolean(env.api?.trailers && env.api?.semi);
      env.dispose();
      return ok ? { ok: true } : { ok: false, reason: "index.js trailers / semi integration not landed yet (M3)" };
    },
    async () => {
      const env = await makeSemiLiveEnv();
      const cl = toCellLocal(2500, 3500, 10);
      env.inbox.push(
        { type: "ack", granted: 3 },
        {
          type: "profile",
          vehicle: 0x80099001,
          profileKey: "semi-379",
          displayName: "Ironhorse 379",
          locomotion: 2,
          vehicleClass: 3,
          liveryId: 0,
          vMax: 27,
          accel: 4.8,
          decel: 9.5,
          wheelbase: 4.66,
          trackWidth: 2.12,
          wheelRadius: 0.505,
          maxSteerRad: SEMI_SPEC.maxSteerRad,
          reverseMax: -7,
          climbLimitCos: 0.788,
          fordDepthMax: 1.05,
          fifthWheelOffsetY: -2.01,
          fifthWheelOffsetZ: 0.96,
          seats: SEMI_SPEC.seats.map((offset) => ({ offset })),
        },
        { type: "state", vehicle: 0x80099001, flags: 1, step: 1, mode: 0, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, heading: 0, speed: 0 },
        { type: "trailer_state", trailerGuid: 0x80099101, kind: DEPLOYABLE_KIND.TrailerChassis40, cell: cl.cell, position: [cl.x, cl.y - 7.36, cl.z], heading: 0, coupledTractorGuid: 0, trailerFlags: 0 },
        { type: "seat", vehicle: 0x80099001, seat: 0, occupant: 1001, state: 1, reason: 0 }
      );
      env.live.vehicles.afterTick(1.0, 0.016);
      const tInitY = env.api.trailers.get(0x80099101)?.model?.root?.position?.y ?? 0;
      await new Promise((r) => setTimeout(r, 40));
      env.fakeWinObj.dispatch("keydown", { code: "KeyG", repeat: false, target: env.doc.body });
      env.fakeWinObj.dispatch("keyup", { code: "KeyG", repeat: false, target: env.doc.body });
      env.live.vehicles.afterTick(1.033, 0.033);
      assert(env.calls.vehicleTrailerAction.some((c) => c.action === TRAILER_ACTION_KIND.Hitch), "KeyG must send Hitch action (1)");

      // Inject coupled server state + trailer_state (0x090F) beyond SNAP_DISTANCE_M (25m) with ack=1
      env.inbox.push(
        {
          type: "state",
          vehicle: 0x80099001,
          flags: 1,
          step: 2,
          ack: 1,
          mode: 6,
          cell: cl.cell,
          x: cl.x,
          y: cl.y + 30,
          z: cl.z,
          heading: 0.05,
          speed: 12,
          hitchedTrailerGuid: 0x80099101,
          trailerHeading: 0.02,
          trailerPitch: 0,
          trailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.GearRetracted | TRAILER_FLAGS.TwistlocksLocked,
        },
        {
          type: "trailer_state",
          trailerGuid: 0x80099101,
          kind: DEPLOYABLE_KIND.TrailerChassis40,
          cell: cl.cell,
          position: [cl.x, cl.y + 22.64, cl.z],
          heading: 0.02,
          pitch: 0,
          bank: 0,
          coupledTractorGuid: 0x80099001,
          mountedContainerGuid: 0,
          containerSlot: 0,
          trailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.GearRetracted | TRAILER_FLAGS.TwistlocksLocked,
          ownerGuid: 1001,
        }
      );
      env.live.vehicles.afterTick(1.05, 0.016);
      const tEntry = env.api.trailers.get(0x80099101);
      assert(tEntry && tEntry.coupledTractorGuid === 0x80099001, "trailer coupled in trailers Map");
      assert(tEntry.model.root.position.y > tInitY + 20.0, `coupled trailer must track tractor forward (${tInitY} -> ${tEntry.model.root.position.y})`);
      assert(tEntry.model?.landingGearRetracted === true, "coupled trailer landing gear retracted");
      assert(Number.isFinite(env.live.camera.position.x) && Number.isFinite(env.live.camera.position.y), "live camera position finite while towing");

      env.fakeWinObj.dispatch("keydown", { code: "KeyG", repeat: false, target: env.doc.body });
      env.fakeWinObj.dispatch("keyup", { code: "KeyG", repeat: false, target: env.doc.body });
      env.live.vehicles.afterTick(1.083, 0.033);
      assert(env.calls.vehicleTrailerAction.some((c) => c.action === TRAILER_ACTION_KIND.Unhitch), "second KeyG while coupled must send Unhitch action (2)");
      env.dispose();
    }
  );

  // T3.05: Jeep KeyG Windscreen Non-Regression Alongside Semi KeyG Hitch
  await collector.checkFeature(
    "T3.05",
    3,
    "Pairwise:Jeep_KeyG_Windscreen_vs_Semi_KeyG_Hitch",
    async () => {
      const r = await tryImportVehicle("controls.js");
      const src = readFileSync(r.path, "utf8");
      if (!/semi-379|vehicleClass\s*===\s*3|trailerHitch/.test(src)) {
        return { ok: false, reason: "controls.js semi-379 KeyG branch not landed yet (M3)" };
      }
      return r;
    },
    ({ mod }) => {
      const jeepEvents = [];
      const semiEvents = [];
      const w1 = makeFakeControlsWin();
      const cJeep = mod.createVehicleControls({ window: w1, locomotion: 2, vehicleClass: 2, profileKey: "jeep-mb", seatIndex: 0 });
      cJeep.onAction((a) => jeepEvents.push(a));
      cJeep.lock();
      try {
        w1.dispatchKey("KeyG", "keydown");
        w1.dispatchKey("KeyG", "keyup");
      } finally {
        cJeep.restore();
        cJeep.dispose();
      }
      assert(jeepEvents.some((e) => e.type === "windscreen"), `jeep-mb KeyG must still toggle windscreen, got ${JSON.stringify(jeepEvents)}`);
      assert(!jeepEvents.some((e) => e.type === "trailerHitch" || e.type === "hitch"), "jeep-mb KeyG must NOT emit trailerHitch");

      const w2 = makeFakeControlsWin();
      const cSemi = mod.createVehicleControls({ window: w2, locomotion: 2, vehicleClass: 3, profileKey: "semi-379", seatIndex: 0 });
      cSemi.onAction((a) => semiEvents.push(a));
      cSemi.lock();
      try {
        w2.dispatchKey("KeyG", "keydown");
        w2.dispatchKey("KeyG", "keyup");
      } finally {
        cSemi.restore();
        cSemi.dispose();
      }
      assert(semiEvents.some((e) => e.type === "trailerHitch" || e.type === "hitch"), `semi-379 KeyG must emit trailerHitch, got ${JSON.stringify(semiEvents)}`);
      assert(!semiEvents.some((e) => e.type === "windscreen"), "semi-379 KeyG must NOT emit windscreen");
    }
  );

  // T3.06: Dual-Stack FX + Diesel/Jake/Hadley Audio + 2-Seat IK + Semi OSD
  await collector.checkFeature(
    "T3.06",
    3,
    "Pairwise:DualStack_FX_x_Diesel_Audio_x_2Seat_IK_x_OSD",
    async () => {
      const a = await tryImportVehicle("audio.js");
      const gfx = await tryImportVehicle("ground_fx.js");
      const sp = await tryImportVehicle("seat_poses.js");
      const osd = await tryImportVehicle("osd.js");
      if (typeof a.mod?.computeDieselI6EngineParams !== "function") return { ok: false, reason: "audio.js semi diesel not landed yet (M3)" };
      const gfxSrc = readFileSync(gfx.path, "utf8");
      const spSrc = readFileSync(sp.path, "utf8");
      const osdSrc = readFileSync(osd.path, "utf8");
      if (!/3\.72|semi-379/.test(gfxSrc) || !/1\.98|0\.76|semi/.test(spSrc) || !/semi|TRAILER|HITCH/i.test(osdSrc)) {
        return { ok: false, reason: "ground_fx.js / seat_poses.js / osd.js semi support not landed yet (M3)" };
      }
      return { ok: true, a: a.mod, gfx: gfx.mod, sp: sp.mod, osd: osd.mod };
    },
    async ({ a, gfx, sp, osd }) => {
      const THREE = await getThree();
      const root = new THREE.Group();
      const fx = gfx.createGroundFx({ THREE, root });
      fx.update({ x: 0, y: 0, z: 0, heading: 0, speed: 15, surfaceFamily: 1, mode: 6, groundFlags: 0x21, profileKey: "semi-379", vehicleClass: 3 }, 0.05);
      assert(fx.getActiveCount() > 0, `semi ground_fx must have active emitted particles, got ${fx.getActiveCount()}`);
      fx.dispose();

      const pJake = a.computeDieselI6EngineParams({ speed: 15, throttle: 0, horn: true });
      const jakeRumble = pJake.rumbleHz ?? pJake.fundamentalHz;
      assert(Number.isFinite(jakeRumble) && jakeRumble > 20 && jakeRumble <= 90, `diesel I6 rumbleHz valid during Jake brake: ${jakeRumble}`);
      assert(Number.isFinite(pJake.firingHz) && pJake.firingHz > 20, `diesel I6 firingHz valid during Jake brake: ${pJake.firingHz}`);
      assert(Number.isFinite(pJake.jakeGain) && pJake.jakeGain > 0, `diesel I6 jakeGain active during Jake brake: ${pJake.jakeGain}`);

      const drvPose = sp.computeSeatPose(0, "0x02000001", { steerAngle: 0.3, profileKey: "semi-379", vehicleClass: 3 });
      const paxPose = sp.computeSeatPose(1, "0x02000001", { accelLong: -5.0, profileKey: "semi-379", vehicleClass: 3 });
      assert(drvPose.leftArmIK && drvPose.rightArmIK, "semi driver arm IK valid");
      assert(Array.isArray(paxPose.chestPos) && paxPose.chestPos.every(Number.isFinite), "semi passenger seat pose valid");

      const byId = new Map();
      const mk = (tag) => ({ tag, children: [], style: {}, id: "", textContent: "", setAttribute() {}, appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; }, remove() {} });
      const doc = { head: mk("head"), body: mk("body"), createElement: mk, getElementById: (id) => byId.get(id) ?? null };
      const hud = osd.createVehicleOsd({ document: doc });
      hud.update({ locomotion: 2, vehicleClass: 3, profileKey: "semi-379", name: "Ironhorse 379", speed: 15, hitchedTrailerGuid: 0x80099101, trailerFlags: 0x07 });
      const el = doc.getElementById(osd.OSD_ID);
      assert(el && el.style.display === "block" && el.textContent.length > 0 && !/NaN|undefined/.test(el.textContent), `semi OSD clean: ${el?.textContent}`);
      hud.dispose();
    }
  );

  // T3.07: Container Collider Sync Parked vs Moving Trailer & Tractor Despawn Auto-Unhitch
  await collector.checkFeature(
    "T3.07",
    3,
    "Pairwise:Container_Collider_Sync_x_Despawn_AutoUnhitch",
    async () => {
      const env = await makeSemiLiveEnv();
      const ok = Boolean(env.api?.trailers);
      env.dispose();
      return ok ? { ok: true } : { ok: false, reason: "index.js trailers integration not landed yet (M3)" };
    },
    async () => {
      const env = await makeSemiLiveEnv();
      const cl = toCellLocal(1500, 2500, 10);
      env.inbox.push(
        { type: "ack", granted: 3 },
        { type: "profile", vehicle: 0x80099001, profileKey: "semi-379", displayName: "Ironhorse 379", locomotion: 2, vehicleClass: 3, fifthWheelOffsetY: -2.01, fifthWheelOffsetZ: 0.96, seats: SEMI_SPEC.seats.map((offset) => ({ offset })) },
        { type: "state", vehicle: 0x80099001, flags: 1, step: 1, mode: 6, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, speed: 15, hitchedTrailerGuid: 0x80099101, trailerFlags: 0x07 },
        { type: "trailer_state", trailerGuid: 0x80099101, kind: DEPLOYABLE_KIND.TrailerChassis40, cell: cl.cell, position: [cl.x, cl.y - 7.36, cl.z], coupledTractorGuid: 0x80099001, mountedContainerGuid: 0x80099201, trailerFlags: 0x07 },
        { type: "container_state", containerGuid: 0x80099201, containerKind: DEPLOYABLE_KIND.IsoContainer40HC, doorState: 0, liveryId: 0, maxFullSlots: 21, flags: 0, ownerGuid: 1001, cell: cl.cell, position: [cl.x, cl.y - 7.36, cl.z + 1.32], heading: 0, doorProgress: 0, serialNumber: 1, slots: [] }
      );
      env.live.vehicles.afterTick(1.0, 0.016);
      const beforeColliders = env.calls.upsertContainerCollider.length;
      const cEntryMoving = env.api.containers.get(0x80099201);
      assert(
        beforeColliders === 0 && cEntryMoving && cEntryMoving.colliderActive === false,
        `container collider must be suppressed while moving (beforeColliders=${beforeColliders}, colliderActive=${cEntryMoving?.colliderActive})`
      );

      // Tractor despawns -> trailer unhitched and parked at updated pos + container collider re-synced
      env.inbox.push(
        { type: "event", vehicle: 0x80099001, kind: VEHICLE_EVENT_KIND.Despawn, step: 2 },
        { type: "trailer_state", trailerGuid: 0x80099101, kind: DEPLOYABLE_KIND.TrailerChassis40, cell: cl.cell, position: [cl.x, cl.y - 2.0, cl.z], coupledTractorGuid: 0, mountedContainerGuid: 0x80099201, trailerFlags: 0x02 },
        { type: "container_state", containerGuid: 0x80099201, containerKind: DEPLOYABLE_KIND.IsoContainer40HC, doorState: 0, liveryId: 0, maxFullSlots: 21, flags: 0, ownerGuid: 1001, cell: cl.cell, position: [cl.x, cl.y - 2.0, cl.z + 1.32], heading: 0, doorProgress: 0, serialNumber: 1, slots: [] }
      );
      env.live.vehicles.afterTick(1.016, 0.016);
      assert(env.api.trailers.get(0x80099101), "trailer persists after tractor despawn");
      const afterColliders = env.calls.upsertContainerCollider.length;
      const cEntryParked = env.api.containers.get(0x80099201);
      assert(
        afterColliders >= 1 && cEntryParked?.colliderActive === true,
        `container collider must activate on park/despawn (${beforeColliders} -> ${afterColliders}, colliderActive=${cEntryParked?.colliderActive})`
      );
      const lastCol = env.calls.upsertContainerCollider[afterColliders - 1];
      near(lastCol.y, cl.y - 2.0, 0.1, "re-synced container collider Y matches parked trailer");
      env.dispose();
    }
  );

  // T3.08: 6 Liveries x 2 Chassis x 3 Container Slots
  await collector.checkFeature("T3.08", 3, "Pairwise:6_Liveries_x_2_Chassis_x_3_Container_Slots", probeSemiAndUpgradedTrailer, async ({ sm, tm }) => {
    const THREE = await getThree();
    const { mod: cm } = await tryImportVehicle("container_models.js");
    for (let liv = 0; liv < 6; liv++) {
      const semi = sm.buildSemiTruck(THREE, { profileKey: "semi-379", liveryId: liv }, { liveryId: liv });
      const kind = liv % 2 === 0 ? "20ft" : "40ft";
      const tr = tm.buildSemiTrailer(THREE, kind);
      const slot = kind === "40ft" ? ["front", "rear", "center"][liv % 3] : "auto";
      const c20 = cm.buildIsoContainer(THREE, 4000020);
      tr.attachContainer(c20, { position: slot });
      const exp = oracleComputeMountedContainerPose({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0 }, kind, 6.058, slot);
      near(c20.root.position.y, exp.yOffsetLocal, 1e-4, `livery=${liv} kind=${kind} slot=${slot} Y`);
      tr.dispose();
      semi.dispose();
    }
  });

  // T3.09: 2-Seat Boarding Hot-Swap x Semi Camera Modes
  await collector.checkFeature(
    "T3.09",
    3,
    "Pairwise:2Seat_Boarding_HotSwap_x_Semi_Camera_Modes",
    async () => {
      const r = await tryImportVehicle("camera_rig.js");
      if (!r.ok || !r.mod.SEMI_CAB_EYES) return { ok: false, reason: "camera_rig.js SEMI_CAB_EYES not landed yet (M3)" };
      return r;
    },
    ({ mod }) => {
      const rig = mod.createPilotCameraRig({ locomotion: 2, vehicleClass: 3, profileKey: "semi-379", seatIndex: 0, ground: () => 0 });
      const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0 };
      const params = { locomotion: 2, vehicleClass: 3, profileKey: "semi-379" };
      rig.setView("chase");
      const chase = rig.step({ pose, params, dt: 1 / 60 });
      rig.setView("cockpit");
      const cab0 = rig.step({ pose, params, seatIndex: 0, dt: 1 / 60 });
      const cab1 = rig.step({ pose, params, seatIndex: 1, dt: 1 / 60 });
      rig.setView("hood");
      const hood = rig.step({ pose, params, dt: 1 / 60 });
      assert(chase.view === "chase" && cab0.view === "cockpit" && hood.view === "hood", "camera view mode transitions");
      assert(chase.cam.pos[1] < -9.0, `semi chase behind tractor, got y=${chase.cam.pos[1]}`);
      assert(cab0.cam.pos[0] < 0 && cab1.cam.pos[0] > 0, `seat 0 (${cab0.cam.pos[0]}) left vs seat 1 (${cab1.cam.pos[0]}) right`);
      assert(hood.cam.pos[1] > 1.0, `hood eye ahead of cab, got y=${hood.cam.pos[1]}`);
      assert(rig.cycleView() === "chase", "cycleView wraps hood -> chase");
    }
  );

  // T3.10: HBV1 v6 Frames x Dericost 0x8000 Coordinate Round-Trip (runs unconditionally)
  await collector.runCheck("T3.10", 3, "Pairwise:HBV1_v6_Frames_x_Dericost_0x8000_Coord_RoundTrip", () => {
    const dericostGlobal = [1234.5, 69999.25, 42.75];
    const local = toCellLocal(...dericostGlobal);
    const profWire = wrapS2CFrame(0x50000001, 1, OPCODES.Vehicle_Profile, encodeVehicleProfile({
      Vehicle: 0x80099001,
      ProfileKey: "semi-379",
      DisplayName: "Ironhorse 379",
      Locomotion: 2,
      StandInSetup: SEMI_SPEC.standInSetup,
      FifthWheelOffsetY: -2.01,
      FifthWheelOffsetZ: 0.96,
      LiveryId: 4,
      VehicleClass: 3,
    }, 6));
    const stateWire = wrapS2CFrame(0x50000001, 2, OPCODES.Vehicle_State, encodeVehicleState({
      Vehicle: 0x80099001,
      Cell: local.cell,
      Position: { X: local.x, Y: local.y, Z: local.z },
      HitchedTrailerGuid: 0x80099101,
      TrailerHeading: 0.5,
      TrailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.GearRetracted,
    }, 6));
    const trStateWire = wrapS2CFrame(0x50000001, 3, OPCODES.Vehicle_TrailerState, encodeTrailerState({
      TrailerGuid: 0x80099101,
      Kind: DEPLOYABLE_KIND.TrailerChassis40,
      Cell: local.cell,
      Position: { X: local.x, Y: local.y, Z: local.z },
      CoupledTractorGuid: 0x80099001,
      TrailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.GearRetracted,
    }, 6));
    const actWire = wrapC2SFrame(4, OPCODES.Vehicle_TrailerAction, encodeTrailerAction({
      TrailerGuid: 0x80099101,
      VehicleGuid: 0x80099001,
      Action: TRAILER_ACTION_KIND.Hitch,
    }, 6));

    const pDec = decodeVehicleProfile(unwrapS2CFrame(profWire).payload);
    const sDec = decodeVehicleState(unwrapS2CFrame(stateWire).payload);
    const tsDec = decodeTrailerState(unwrapS2CFrame(trStateWire).payload);
    const taDec = decodeTrailerAction(unwrapC2SFrame(actWire).payload);
    assert(pDec.VehicleClass === 3 && sDec.HitchedTrailerGuid === 0x80099101 && taDec.Action === 1, "pairwise v6 decode");
    const glob = toGlobal(tsDec.Cell, tsDec.Position.X, tsDec.Position.Y, tsDec.Position.Z);
    near(glob[0], dericostGlobal[0], 1e-3, "Dericost X");
    near(glob[1], dericostGlobal[1], 1e-3, "Dericost Y");
    near(glob[2], dericostGlobal[2], 1e-3, "Dericost Z");
  });

  // T3.11: Trailer Brake Lights x Handbrake x Glad-Hand Coupled Hoses
  await collector.checkFeature("T3.11", 3, "Pairwise:Trailer_BrakeLights_x_Handbrake_x_GladHands", probeSemiAndUpgradedTrailer, async ({ sm, tm }) => {
    const THREE = await getThree();
    const semi = sm.buildSemiTruck(THREE, { profileKey: "semi-379" }, {});
    const tr = tm.buildSemiTrailer(THREE, "40ft");
    semi.update({ speed: 0, handbrake: true, trailerCoupled: true }, 0.033);
    tr.setLandingGearRetracted(true);
    tr.setBrakeLights(true);
    const brakeMat = tr.materials?.brakeLampMat ?? tr.root.getObjectByName("trailer-brake-lamps")?.material ?? tr.root.getObjectByName("trailer-lamps")?.material;
    assert(brakeMat && brakeMat.emissiveIntensity > 0.8, "trailer brake lamps illuminated on handbrake");
    tr.setBrakeLights(false);
    tr.dispose();
    semi.dispose();
  });

  // T3.12: Existing Container & Deployable Non-Regression Under installVehicles (runs unconditionally)
  await collector.runCheck("T3.12", 3, "Pairwise:Existing_Containers_Deployables_NonRegression", async () => {
    const env = await makeSemiLiveEnv();
    const cl = toCellLocal(3000, 4000, 10);
    env.inbox.push(
      { type: "ack", granted: 3 },
      {
        type: "container_state",
        containerGuid: 0x80099201,
        containerKind: DEPLOYABLE_KIND.IsoContainer20,
        doorState: 2,
        liveryId: 0,
        maxFullSlots: 10,
        flags: 0,
        ownerGuid: 1001,
        cell: cl.cell,
        position: [cl.x, cl.y, cl.z],
        heading: 0,
        doorProgress: 1.0,
        serialNumber: 654321,
        slots: [],
      }
    );
    env.live.vehicles.afterTick(1.0, 0.016);
    const list = env.api.containers.list();
    assert(list.length === 1 && list[0].guid === 0x80099201, "existing containers.list() non-regression");
    env.api.containers.action(0x80099201, 2, 0, 0, 0);
    assert(env.calls.vehicleContainerAction.length === 1, "existing vehicleContainerAction non-regression");
    env.dispose();
  });
}
