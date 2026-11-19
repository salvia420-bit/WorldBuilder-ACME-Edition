// harness/e2e_semi/tier2_boundaries.mjs — Tier 2 Boundary & Corner Cases (>= 5 tests per feature area F1–F7 = 35 tests).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPLOYABLE_KIND,
  GROUND_DOCS_DIR,
  HBV1_TAG,
  SEMI_SPEC,
  TRAILER_ACTION_KIND,
  aceFilePath,
  angleDiff,
  assert,
  decodeHeader,
  decodeTrailerAction,
  decodeTrailerState,
  decodeVehicleProfile,
  decodeVehicleState,
  encodeTrailerAction,
  encodeTrailerState,
  encodeVehicleProfile,
  encodeVehicleState,
  extractCSharpMethodScope,
  getThree,
  makeFakeControlsWin,
  makeSemiLiveEnv,
  near,
  stripCSharpComments,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  wrapPi,
} from "./common.mjs";

async function liveWaitUntil(fn, timeoutMs = 10000, intervalMs = 200, label = "condition") {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

function getSemiTestsSrc() {
  const stPath = aceFilePath("Source/ACE.Server.Tests/Vehicles/SemiTrailerTests.cs");
  return existsSync(stPath) ? readFileSync(stPath, "utf8") : null;
}

export const TIER2_METADATA = [
  // F1: Protocol Boundaries (5)
  { id: "T2.F1.01", tier: 2, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T2.F1.02", tier: 2, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T2.F1.03", tier: 2, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T2.F1.04", tier: 2, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T2.F1.05", tier: 2, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  // F2: semi-379 Model & Steer Boundaries (5)
  { id: "T2.F2.01", tier: 2, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T2.F2.02", tier: 2, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T2.F2.03", tier: 2, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T2.F2.04", tier: 2, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T2.F2.05", tier: 2, feature: "F2:Semi379_Model", mode: "offline" },
  // F3: Trailer Chassis Boundaries (5)
  { id: "T2.F3.01", tier: 2, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T2.F3.02", tier: 2, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T2.F3.03", tier: 2, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T2.F3.04", tier: 2, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T2.F3.05", tier: 2, feature: "F3:Trailer_Models", mode: "offline" },
  // F4: Kinematics & GroundModel Boundaries (5)
  { id: "T2.F4.01", tier: 2, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T2.F4.02", tier: 2, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T2.F4.03", tier: 2, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T2.F4.04", tier: 2, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T2.F4.05", tier: 2, feature: "F4:Kinematics_Ground", mode: "offline" },
  // F5: Container Mounting & Door Lock Boundaries (5)
  { id: "T2.F5.01", tier: 2, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T2.F5.02", tier: 2, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T2.F5.03", tier: 2, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T2.F5.04", tier: 2, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T2.F5.05", tier: 2, feature: "F5:Containers_Twistlocks", mode: "offline" },
  // F6: Server Hitching & Despawn Boundaries (5)
  { id: "T2.F6.01", tier: 2, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T2.F6.02", tier: 2, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T2.F6.03", tier: 2, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T2.F6.04", tier: 2, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T2.F6.05", tier: 2, feature: "F6:Server_Commands", mode: "offline" },
  // F7: Client UX Boundaries (5)
  { id: "T2.F7.01", tier: 2, feature: "F7:Client_UX", mode: "offline" },
  { id: "T2.F7.02", tier: 2, feature: "F7:Client_UX", mode: "offline" },
  { id: "T2.F7.03", tier: 2, feature: "F7:Client_UX", mode: "offline" },
  { id: "T2.F7.04", tier: 2, feature: "F7:Client_UX", mode: "offline" },
  { id: "T2.F7.05", tier: 2, feature: "F7:Client_UX", mode: "offline" },
];

export async function runTier2(collector) {
  // ---------------------------------------------------------------------------
  // F1: Protocol Boundaries
  // ---------------------------------------------------------------------------

  await collector.runCheck("T2.F1.01", 2, "F1:HBV1_v6_Protocol", () => {
    const v5Prof = encodeVehicleProfile({
      Vehicle: 0x80099001,
      ProfileKey: "jeep-mb",
      DisplayName: "Willys MB",
      Locomotion: 2,
      FifthWheelOffsetY: -99,
      LiveryId: 5,
    }, 5);
    const dec = decodeVehicleProfile(v5Prof);
    assert(dec && dec.Header.Version === 5, "decoded v5 version");
    assert(dec.FifthWheelOffsetY === 0, "v5 profile omits FifthWheelOffsetY -> 0");
    assert(dec.FifthWheelOffsetZ === 0, "v5 profile omits FifthWheelOffsetZ -> 0");
    assert(dec.LiveryId === 0, "v5 profile omits LiveryId -> 0");
    assert(dec.VehicleClass === 0, "v5 profile omits VehicleClass -> 0");
    assert(dec.Reserved4 === 0, "v5 profile omits Reserved4 -> 0");
  });

  await collector.runCheck("T2.F1.02", 2, "F1:HBV1_v6_Protocol", () => {
    const v5State = encodeVehicleState({
      Vehicle: 0x80099001,
      Step: 77,
      HitchedTrailerGuid: 0x80099101,
      TrailerFlags: 0x07,
    }, 5);
    assert(v5State.length === 84, `v5 state exact length 84B, got ${v5State.length}`);
    const dec = decodeVehicleState(v5State);
    assert(dec.HitchedTrailerGuid === 0, "v5 state defaults HitchedTrailerGuid=0");
    assert(dec.TrailerHeading === 0, "v5 state defaults TrailerHeading=0");
    assert(dec.TrailerPitch === 0, "v5 state defaults TrailerPitch=0");
    assert(dec.TrailerFlags === 0, "v5 state defaults TrailerFlags=0");
  });

  await collector.runCheck("T2.F1.03", 2, "F1:HBV1_v6_Protocol", () => {
    const v6 = encodeVehicleState({
      Vehicle: 0x80099001,
      Step: 12,
      HitchedTrailerGuid: 0x80099101,
      TrailerHeading: 1.5,
      TrailerPitch: -0.04,
      TrailerFlags: 0x05,
    }, 7);
    const withTrailing = new Uint8Array(v6.length + 4);
    withTrailing.set(v6);
    withTrailing.set([0xde, 0xad, 0xbe, 0xef], v6.length);
    const dec = decodeVehicleState(withTrailing);
    assert(dec && dec.Header.Version === 7, "v7 header parsed");
    assert(dec.HitchedTrailerGuid === 0x80099101, "v7 forward compat preserves v6 HitchedTrailerGuid");
    near(dec.TrailerHeading, 1.5, 1e-5, "v7 preserves TrailerHeading");
    assert(dec._bytesConsumed === 100 && dec._bytesTotal === 104, "trailing extra bytes safely ignored");
  });

  await collector.runCheck("T2.F1.04", 2, "F1:HBV1_v6_Protocol", () => {
    const badTag = encodeTrailerAction({ Header: { Tag: 0x31564249, Version: 6 }, Action: 1 });
    assert(decodeTrailerAction(badTag) === null, "bad tag 0x31564249 must return null");
    const zeroVer = encodeTrailerAction({ Header: { Tag: HBV1_TAG, Version: 0 }, Action: 1 });
    assert(decodeTrailerAction(zeroVer) === null, "Version=0 must return null");
    const shortAction = encodeTrailerAction({ Action: 1 }).slice(0, 23);
    assert(decodeTrailerAction(shortAction) === null, "23B truncated TrailerAction must return null");
    const shortState = encodeTrailerState({}).slice(0, 59);
    assert(decodeTrailerState(shortState) === null, "59B truncated TrailerState must return null");
  });

  await collector.runCheck("T2.F1.05", 2, "F1:HBV1_v6_Protocol", () => {
    // Dericost continent bit 0x8000 (gy >= 68928.0) and landblock bounds [0..254]
    const dericostLoc = toCellLocal(2450.25, 69500.75, 14.5);
    assert(((dericostLoc.cell >>> 15) & 1) === 1, "Dericost 0x8000 bit must be set");
    assert(dericostLoc.x >= 0 && dericostLoc.x < 192, "local x in [0, 192)");
    assert(dericostLoc.y >= 0 && dericostLoc.y < 192, "local y in [0, 192)");
    const wire = encodeTrailerState({
      TrailerGuid: 0x80099101,
      Kind: DEPLOYABLE_KIND.TrailerChassis40,
      Cell: dericostLoc.cell,
      Position: { X: dericostLoc.x, Y: dericostLoc.y, Z: dericostLoc.z },
    });
    const dec = decodeTrailerState(wire);
    const glob = toGlobal(dec.Cell, dec.Position.X, dec.Position.Y, dec.Position.Z);
    near(glob[0], 2450.25, 1e-3, "Dericost global X");
    near(glob[1], 69500.75, 1e-3, "Dericost global Y");

    // Extreme clamping check: lbX never reaches 0xFF
    const edgeLoc = toCellLocal(99999, 68928 + 99999, 0);
    assert(((edgeLoc.cell >>> 24) & 0xff) <= 254, "lbX <= 254");
    assert(((edgeLoc.cell >>> 16) & 0xff) <= 254, "lbY <= 254");
  });

  // ---------------------------------------------------------------------------
  // F2: semi-379 Model & Steer Boundaries
  // ---------------------------------------------------------------------------

  const probeSemi = async () => {
    const r = await tryImportVehicle("semi_truck_model.js");
    if (!r.ok) return r;
    if (typeof r.mod.buildSemiTruck !== "function") return { ok: false, reason: "semi_truck_model.js missing buildSemiTruck" };
    return r;
  };

  await collector.checkFeature(
    "T2.F2.01",
    2,
    "F2:Semi379_Model",
    async () => {
      const gm = await tryImportVehicle("ground_model.js");
      if (!gm.ok || typeof gm.mod.paramsFromProfile !== "function") {
        return { ok: false, reason: "ground_model.js paramsFromProfile not landed yet (M2)" };
      }
      return gm;
    },
    ({ mod: gm }) => {
      const p = gm.paramsFromProfile({
        profileKey: "semi-379",
        wheelbase: SEMI_SPEC.wheelbase,
        maxSteerRad: SEMI_SPEC.maxSteerRad,
        vMax: SEMI_SPEC.vMax,
        reverseMax: SEMI_SPEC.reverseMax,
        accel: SEMI_SPEC.accel,
        decel: SEMI_SPEC.decel,
      });
      const stLow = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
      const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[0] });
      for (let i = 0; i < 30; i++) gm.step(stLow, { throttle: 0, steer: 1.0 }, p, oracle, gm.DT);
      near(stLow.steerAngle, SEMI_SPEC.maxSteerRad, 0.01, "low-speed steer clamp 38 deg");

      const stFast = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 27.0, steerAngle: 0, mode: 6 };
      for (let i = 0; i < 30; i++) gm.step(stFast, { throttle: 1.0, steer: 1.0 }, p, oracle, gm.DT);
      assert(stFast.steerAngle < SEMI_SPEC.maxSteerRad * 0.75, `high-speed steer must taper below 38 deg, got ${stFast.steerAngle}`);
    }
  );

  await collector.checkFeature("T2.F2.02", 2, "F2:Semi379_Model", probeSemi, async ({ mod }) => {
    const THREE = await getThree();
    for (const badLivery of [-1, 99, NaN, undefined, null]) {
      const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379", liveryId: badLivery }, { liveryId: badLivery });
      assert(semi && semi.root, `invalid livery ${String(badLivery)} should fall back cleanly`);
      semi.dispose();
    }
  });

  await collector.checkFeature("T2.F2.03", 2, "F2:Semi379_Model", probeSemi, async ({ mod }) => {
    const THREE = await getThree();
    let vector3Allocs = 0;
    class MonitoredVector3 extends THREE.Vector3 {
      constructor(...args) {
        vector3Allocs += 1;
        super(...args);
      }
    }
    const customThree = Object.create(THREE);
    customThree.Vector3 = MonitoredVector3;
    const activeLights = [];
    const semi = mod.buildSemiTruck(customThree, { profileKey: "semi-379" }, { liveScene3d: { activeLights } });
    vector3Allocs = 0;
    for (let i = 0; i < 100; i++) {
      semi.update({ speed: 18, steerAngle: 0.2, headlights: true, handbrake: i % 2 === 0, trailerCoupled: true }, 0.016);
    }
    assert(vector3Allocs === 0, `semi.update() must do 0 Vector3 allocations, got ${vector3Allocs}`);
    semi.dispose();
  });

  await collector.checkFeature("T2.F2.04", 2, "F2:Semi379_Model", probeSemi, async ({ mod }) => {
    const THREE = await getThree();
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379" }, {});
    semi.update(null, 0.033);
    semi.update(undefined, 0);
    semi.update({ speed: NaN, steerAngle: Infinity, trailerPitch: -Infinity }, 0.5);
    assert(Number.isFinite(semi.wheelRollAngle ?? 0), "wheelRollAngle remains finite on hostile inputs");
    semi.dispose();
  });

  await collector.checkFeature("T2.F2.05", 2, "F2:Semi379_Model", probeSemi, async ({ mod }) => {
    const THREE = await getThree();
    const activeLights = [];
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379" }, { liveScene3d: { activeLights } });
    semi.update({ headlights: true, speed: 5 }, 0.033);
    semi.dispose();
    assert(activeLights.length === 0, `activeLights must be empty after dispose, got ${activeLights.length}`);
    semi.dispose(); // idempotent second call
  });

  // ---------------------------------------------------------------------------
  // F3: Trailer Chassis Boundaries
  // ---------------------------------------------------------------------------

  await collector.runCheck("T2.F3.01", 2, "F3:Trailer_Models", async () => {
    const { mod } = await tryImportVehicle("trailer_models.js");
    assert(mod.resolveTrailerKind("40ft") === "40ft", "40ft");
    assert(mod.resolveTrailerKind(40) === "40ft", "40");
    assert(mod.resolveTrailerKind("Chassis40ft") === "40ft", "Chassis40ft");
    assert(mod.resolveTrailerKind(4000031) === "40ft", "WCID 4000031");
    assert(mod.resolveTrailerKind("20ft") === "20ft", "20ft");
    assert(mod.resolveTrailerKind(null) === "20ft", "null defaults 20ft");
    assert(mod.resolveTrailerKind(999999) === "20ft", "unknown defaults 20ft");
  });

  await collector.checkFeature(
    "T2.F3.02",
    2,
    "F3:Trailer_Models",
    async () => {
      const r = await tryImportVehicle("trailer_models.js");
      if (!r.ok || r.mod.CHASSIS_KINGPIN_Z === undefined) {
        return { ok: false, reason: "trailer_models.js missing CHASSIS_KINGPIN_Z = 0.96 (M2)" };
      }
      return r;
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const { mod: cmod } = await tryImportVehicle("container_models.js");
      near(mod.CHASSIS_KINGPIN_Z, 0.96, 1e-6, "CHASSIS_KINGPIN_Z exact 0.96");
      near(mod.CHASSIS_DECK_Z, 1.32, 1e-6, "CHASSIS_DECK_Z exact 1.32");
      const tr40 = mod.buildSemiTrailer(THREE, "40ft");
      const hc = cmod.buildIsoContainer(THREE, 4000022);
      tr40.attachContainer(hc);
      tr40.root.updateMatrixWorld(true);
      const cb = new THREE.Box3().setFromObject(hc.root);
      near(cb.min.z, 1.32, 0.005, "40HC container base seated on deckZ=1.32");
      tr40.dispose();
    }
  );

  await collector.checkFeature(
    "T2.F3.03",
    2,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const ok = typeof tr.setLandingGearRetracted === "function" && Boolean(tr.landingGearGroup);
      tr.dispose();
      return ok ? r : { ok: false, reason: "landingGearGroup / setLandingGearRetracted missing (M2)" };
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const tr = mod.buildSemiTrailer(THREE, "20ft");
      const z0 = tr.landingGearGroup.position.z;
      tr.setLandingGearRetracted(true);
      tr.setLandingGearRetracted(true);
      near(tr.landingGearGroup.position.z - z0, 0.45, 0.02, "idempotent retract=true");
      tr.setLandingGearRetracted(false);
      tr.setLandingGearRetracted(false);
      near(tr.landingGearGroup.position.z, z0, 1e-5, "idempotent retract=false");
      tr.dispose();
    }
  );

  await collector.checkFeature(
    "T2.F3.04",
    2,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const ok = Array.isArray(tr.wheelGroups) && tr.wheelGroups.length === 2;
      tr.dispose();
      return ok ? r : { ok: false, reason: "wheelGroups missing (M2)" };
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const tr = mod.buildSemiTrailer(THREE, "40ft");
      tr.update(0, { speed: 20, twistlockState: 1 });
      tr.update(0.5, { speed: NaN, twistlockState: 0 });
      tr.update(0.033, null);
      for (const wg of tr.wheelGroups) {
        assert(Number.isFinite(wg.rotation.x), "wheelGroup rotation finite on hostile dt/speed");
      }
      tr.dispose();
    }
  );

  await collector.checkFeature(
    "T2.F3.05",
    2,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const ok = typeof tr.detachContainer === "function";
      tr.dispose();
      return ok ? r : { ok: false, reason: "detachContainer missing (M2)" };
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const { mod: cmod } = await tryImportVehicle("container_models.js");
      const tr = mod.buildSemiTrailer(THREE, "40ft");
      tr.detachContainer(); // empty no-op
      const c1 = cmod.buildIsoContainer(THREE, 4000020);
      const c2 = cmod.buildIsoContainer(THREE, 4000021);
      tr.attachContainer(c1);
      tr.attachContainer(c2); // replaces c1
      assert(tr.containerMount.children.length === 1 && tr.containerMount.children[0] === c2.root, "only c2 mounted");
      tr.detachContainer();
      assert(tr.containerMount.children.length === 0, "c2 detached");
      tr.dispose();
    }
  );

  // ---------------------------------------------------------------------------
  // F4: Kinematics & GroundModel Boundaries
  // ---------------------------------------------------------------------------

  const probeKin = async () => {
    const r = await tryImportVehicle("trailer_kinematics.js");
    if (!r.ok || typeof r.mod.stepCoupledTrailer !== "function") {
      return { ok: false, reason: "trailer_kinematics.js missing (M2)" };
    }
    return r;
  };

  await collector.checkFeature("T2.F4.01", 2, "F4:Kinematics_Ground", probeKin, ({ mod }) => {
    const spec = mod.TRAILER_PHYSICS_SPECS["40ft"];
    const maxJk = mod.MAX_JACKKNIFE_RAD;
    const oracle = () => 0;

    // +71.9 deg passes unclamped when heading=0 and trailer is at -71.9 deg
    const h719 = (-71.9 * Math.PI) / 180;
    const outPass = mod.stepCoupledTrailer({ x: 0, y: 0, z: 0, heading: 0, speed: 0, yawRate: 0 }, { heading: h719 }, SEMI_SPEC.fifthWheelOffsetY, spec, oracle, 1 / 30);
    near(wrapPi(0 - outPass.heading), (71.9 * Math.PI) / 180, 1e-4, "71.9 deg unclamped");

    // +75 deg clamps to +72 deg; -75 deg clamps to -72 deg (across 0 / 2pi wrap)
    const h75Pos = (0.05 - (75 * Math.PI) / 180);
    const outClampPos = mod.stepCoupledTrailer({ x: 0, y: 0, z: 0, heading: 0.05, speed: 0, yawRate: 0 }, { heading: h75Pos }, SEMI_SPEC.fifthWheelOffsetY, spec, oracle, 1 / 30);
    near(wrapPi(0.05 - outClampPos.heading), maxJk, 1e-4, "+75 deg clamps to +72 deg");

    const h75Neg = (0.05 + (75 * Math.PI) / 180);
    const outClampNeg = mod.stepCoupledTrailer({ x: 0, y: 0, z: 0, heading: 0.05, speed: 0, yawRate: 0 }, { heading: h75Neg }, SEMI_SPEC.fifthWheelOffsetY, spec, oracle, 1 / 30);
    near(wrapPi(0.05 - outClampNeg.heading), -maxJk, 1e-4, "-75 deg clamps to -72 deg");
  });

  await collector.checkFeature(
    "T2.F4.02",
    2,
    "F4:Kinematics_Ground",
    async () => {
      const r = await tryImportVehicle("ground_model.js");
      if (!r.ok || typeof r.mod.paramsFromProfile !== "function") {
        return { ok: false, reason: "ground_model.js paramsFromProfile / towMassMul not landed yet (M2)" };
      }
      return r;
    },
    ({ mod: gm }) => {
      const pBase = gm.paramsFromProfile({
        profileKey: "semi-379",
        wheelbase: SEMI_SPEC.wheelbase,
        vMax: SEMI_SPEC.vMax,
        reverseMax: SEMI_SPEC.reverseMax,
        accel: SEMI_SPEC.accel,
        decel: SEMI_SPEC.decel,
      });
      const road = () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[0] });
      const runSteps = (mul, n = 60) => {
        const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
        const p = { ...pBase, towMassMul: mul };
        for (let i = 0; i < n; i++) gm.step(st, { throttle: 1.0, steer: 0, towMassMul: mul }, p, road, gm.DT);
        return st.speed;
      };
      const vBobtail = runSteps(1.0, 60);
      const vEmpty = runSteps(0.72, 60);
      const vLoaded = runSteps(0.58, 60);
      assert(vBobtail > vEmpty && vEmpty > vLoaded, `expected towMassMul ordering vBobtail(${vBobtail}) > vEmpty(${vEmpty}) > vLoaded(${vLoaded})`);
    }
  );

  await collector.runCheck("T2.F4.03", 2, "F4:Kinematics_Ground", async () => {
    const { mod: gm } = await tryImportVehicle("ground_model.js");
    const golden = JSON.parse(readFileSync(path.join(GROUND_DOCS_DIR, "ground-golden.json"), "utf8"));
    const gen = await import(pathToFileURL(path.join(GROUND_DOCS_DIR, "gen_golden.mjs")).href);
    for (const seqName of ["low-speed-turn", "hill-climb", "water-ford"]) {
      const seq = golden.sequences.find((s) => s.name === seqName);
      const st = { ...seq.initial };
      const oracle = gen.getOracle(seqName);
      let ci = 0;
      seq.frames.forEach((f, i) => {
        gm.step(st, gm.inputFromFrame(f), golden.params, oracle, golden.dt);
        const cp = seq.checkpoints[ci];
        if (cp && cp.step === i + 1) {
          const d = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
          assert(d < 0.001, `jeep-mb ${seqName} step ${cp.step} diverged ${d} m`);
          ci += 1;
        }
      });
    }
  });

  await collector.checkFeature("T2.F4.04", 2, "F4:Kinematics_Ground", probeKin, ({ mod }) => {
    const spec = mod.TRAILER_PHYSICS_SPECS["20ft"];
    const nanOracle = () => NaN;
    for (const dt of [0, 0.25]) {
      const res = mod.stepCoupledTrailer({ x: 10, y: 20, z: 5, heading: 0.3, speed: 10, yawRate: 0.2 }, { heading: 0.1 }, -2.01, spec, nanOracle, dt);
      for (const k of ["x", "y", "z", "heading", "pitch", "bank"]) {
        assert(Number.isFinite(res[k]), `stepCoupledTrailer dt=${dt} produced non-finite ${k}=${res[k]}`);
      }
    }
  });

  await collector.checkFeature(
    "T2.F4.05",
    2,
    "F4:Kinematics_Ground",
    async () => {
      const r = await tryImportVehicle("ground_model.js");
      if (!r.ok || typeof r.mod.paramsFromProfile !== "function") {
        return { ok: false, reason: "ground_model.js paramsFromProfile not landed yet (M2)" };
      }
      return r;
    },
    ({ mod: gm }) => {
      const pSemi = gm.paramsFromProfile({ profileKey: "semi-379", vMax: 27, fordDepthMax: 1.05, wheelbase: 4.66 });
      const st100 = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6, steerAngle: 0, mode: 6 };
      gm.step(st100, { throttle: 1, steer: 0 }, pSemi, () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[7], waterDepth: 1.00 }), gm.DT);
      assert(st100.speed > 0, `1.00 m ford must permit forward speed on semi (limit 1.05), got ${st100.speed}`);

      const st106 = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6, steerAngle: 0, mode: 6 };
      gm.step(st106, { throttle: 1, steer: 0 }, pSemi, () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[7], waterDepth: 1.06 }), gm.DT);
      assert(st106.speed === 0, `1.06 m ford must halt forward motion on semi, got ${st106.speed}`);
    }
  );

  // ---------------------------------------------------------------------------
  // F5: Container Mounting & Door Lock Boundaries
  // ---------------------------------------------------------------------------

  await collector.runCheck("T2.F5.01", 2, "F5:Containers_Twistlocks", async () => {
    const THREE = await getThree();
    const { mod: tmod } = await tryImportVehicle("trailer_models.js");
    const { mod: cmod } = await tryImportVehicle("container_models.js");
    const tr40 = tmod.buildSemiTrailer(THREE, "40ft");
    const c20 = cmod.buildIsoContainer(THREE, 4000020);
    tr40.attachContainer(c20, { position: "front" });
    near(c20.root.position.y, 2.9295, 1e-4, "front slot Y");
    tr40.attachContainer(c20, { position: "rear" });
    near(c20.root.position.y, -2.9295, 1e-4, "rear slot Y");
    tr40.attachContainer(c20, { position: "auto" });
    near(c20.root.position.y, -2.9295, 1e-4, "auto slot defaults rear Y");
    tr40.attachContainer(c20, { position: "center" });
    near(c20.root.position.y, 0, 1e-4, "center slot Y");
    tr40.dispose();
  });

  await collector.checkFeature(
    "T2.F5.02",
    2,
    "F5:Containers_Twistlocks",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/Deployables/SemiTrailerDeployable.cs");
      if (!existsSync(p)) return { ok: false, reason: "ACE SemiTrailerDeployable.cs not landed yet (M4)" };
      const src = readFileSync(p, "utf8");
      const tmScope = extractCSharpMethodScope(src, "TryMountContainer");
      if (!tmScope.combined) return { ok: false, reason: "SemiTrailerDeployable.TryMountContainer not landed yet (M4)" };
      const fitScope = extractCSharpMethodScope(src, "CanFitContainer");
      return { ok: true, src, tmScope: tmScope.combined, fitScope: fitScope.combined || tmScope.combined, semiTestsSrc: getSemiTestsSrc() };
    },
    async ({ tmScope, fitScope, semiTestsSrc }, ctx) => {
      const tmClean = stripCSharpComments(tmScope);
      const fitClean = stripCSharpComments(fitScope);
      const callsCanFit = /\bCanFitContainer\s*\(/.test(tmClean);
      if (callsCanFit) {
        assert(
          /\bif\s*\(\s*!\s*CanFitContainer\s*\([^)]*\)\s*\)\s*(?:\{[^}]*\breturn\s+false\s*;|[^;]*\breturn\s+false\s*;)/.test(tmClean),
          "TryMountContainer must reject via !CanFitContainer(...) with return false"
        );
      }
      const checkScope = callsCanFit ? fitClean : tmClean;
      const branch20 = checkScope.match(
        /if\s*\([^)]*(?:==\s*(?:WcidChassis20|DeployableKind\.TrailerChassis20)|(?:WcidChassis20|DeployableKind\.TrailerChassis20)\s*==)[^)]*\)\s*(?:\{[^}]*\}|[^;]*;)/
      );
      assert(branch20, "length compatibility branch for 20ft chassis (WcidChassis20 / TrailerChassis20) missing in TryMountContainer / CanFitContainer");
      const branch20Body = branch20[0];
      assert(/(?:IsoContainer20|Wcid20ft)/.test(branch20Body), "length compatibility check for 20ft chassis missing IsoContainer20 / Wcid20ft");
      assert(
        !/Wcid40ft|Wcid40ftHC|IsoContainer40|\|\|/.test(branch20Body),
        `20ft chassis branch must reject 40ft/40HC containers, got: ${branch20Body}`
      );
      if (semiTestsSrc) {
        const testsClean = stripCSharpComments(semiTestsSrc);
        assert(
          /\[TestMethod\](?:(?!\[TestMethod\])[\s\S])*?Assert\.IsFalse\s*\(\s*[^;]*(?:trailer20|20)[^;]*TryMountContainer\s*\([^;]*(?:40|c40)/i.test(testsClean),
          "SemiTrailerTests.cs missing Assert.IsFalse 40ft-on-20ft length rejection test"
        );
      }
      if (ctx.mode === "live" && ctx.liveSession) {
        const live = ctx.liveSession;
        await live.cleanupWorld();
        try {
          await live.sendChatAndWait("@trailer spawn 20", /trailer|4000030|spawned/i, 10000);
          await live.sendChatAndWait("@container spawn 40", /container|4000021|spawned/i, 10000);
          const ids = await liveWaitUntil(async () => {
            return await live.evalInPage(`
              const t = (window.__vehicles?.trailers?.list?.() || []).find((x) => x.kind === 13 || x.last?.kind === 13);
              const c = (window.__vehicles?.containers?.list?.() || []).find((x) => (x.kind ?? x.last?.containerKind) === 11 || (x.kind ?? x.last?.containerKind) === 12);
              return t && c ? { tGuid: t.guid, cGuid: c.guid } : null;
            `);
          }, 10000, 250, "20ft trailer + 40ft container");
          await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${ids.tGuid}, 0, ${ids.cGuid}, ${TRAILER_ACTION_KIND.MountContainer}, 0); return true;`);
          await new Promise((r) => setTimeout(r, 600));
          const mounted = await live.evalInPage(`
            const t = window.__vehicles.trailers.get(${ids.tGuid});
            return (t?.mountedContainerGuid ?? t?.last?.mountedContainerGuid ?? 0) >>> 0;
          `);
          assert(mounted === 0, `40ft container must be rejected on 20ft chassis, got mountedContainerGuid=0x${mounted.toString(16)}`);
        } finally {
          await live.cleanupWorld();
        }
      }
    }
  );

  await collector.runCheck("T2.F5.03", 2, "F5:Containers_Twistlocks", async () => {
    const THREE = await getThree();
    const { mod: cmod } = await tryImportVehicle("container_models.js");
    const c = cmod.buildIsoContainer(THREE, 4000022);
    c.setDoorProgress(-5);
    assert(c.doorProgress === 0, "doorProgress clamps < 0 to 0");
    c.setDoorProgress(42);
    assert(c.doorProgress === 1, "doorProgress clamps > 1 to 1");
    c.setDoorProgress(NaN);
    assert(Number.isFinite(c.doorProgress), "doorProgress remains finite on NaN");
    c.dispose();
  });

  await collector.checkFeature(
    "T2.F5.04",
    2,
    "F5:Containers_Twistlocks",
    () => {
      const c = aceFilePath("Source/ACE.Server/Vehicles/Deployables/IsoContainerDeployable.cs");
      const m = aceFilePath("Source/ACE.Server/Vehicles/VehicleManager.cs");
      if (!existsSync(c) || !existsSync(m)) return { ok: false, reason: "ACE Vehicle files missing" };
      const cSrc = readFileSync(c, "utf8");
      const mSrc = readFileSync(m, "utf8");
      const canDoorsScope = extractCSharpMethodScope(cSrc, "CanOperateDoors");
      const handleContScope = extractCSharpMethodScope(mSrc, "HandleContainerAction");
      if (!canDoorsScope.combined) return { ok: false, reason: "IsoContainerDeployable.CanOperateDoors not landed yet (M4)" };
      if (!handleContScope.combined) return { ok: false, reason: "VehicleManager.HandleContainerAction not landed yet (M4)" };
      return {
        ok: true,
        canDoorsScope: canDoorsScope.combined,
        handleContScope: handleContScope.combined,
        semiTestsSrc: getSemiTestsSrc(),
      };
    },
    ({ canDoorsScope, handleContScope, semiTestsSrc }) => {
      const canDoorsClean = stripCSharpComments(canDoorsScope);
      const handleContClean = stripCSharpComments(handleContScope);
      assert(
        /(?:MountedOnTrailerGuid\s*!=\s*0|0\s*!=\s*MountedOnTrailerGuid)/.test(canDoorsClean),
        "IsoContainerDeployable.CanOperateDoors must inspect MountedOnTrailerGuid != 0"
      );
      assert(
        /CoupledTractorGuid/.test(canDoorsClean) && /\breturn\s+false\s*;/.test(canDoorsClean),
        "IsoContainerDeployable.CanOperateDoors must inspect CoupledTractorGuid and return false when moving"
      );
      assert(
        /(?:!\s*(?:\w+\.)?CanOperateDoors\s*\([^)]*\)|MountedOnTrailerGuid\s*!=\s*0)[\s\S]{0,160}\breturn\s+false\s*;/.test(handleContClean),
        "VehicleManager.HandleContainerAction must guard via !CanOperateDoors(...) / MountedOnTrailerGuid with return false"
      );
      if (semiTestsSrc) {
        const testsClean = stripCSharpComments(semiTestsSrc);
        assert(
          /Assert\.IsFalse\s*\(\s*VehicleManager\.HandleContainerAction\s*\(/.test(testsClean),
          "SemiTrailerTests.cs missing moving-trailer HandleContainerAction door-lock rejection test"
        );
      }
    }
  );

  await collector.checkFeature(
    "T2.F5.05",
    2,
    "F5:Containers_Twistlocks",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/Deployables/SemiTrailerDeployable.cs");
      if (!existsSync(p)) return { ok: false, reason: "ACE SemiTrailerDeployable.cs not landed yet (M4)" };
      const src = readFileSync(p, "utf8");
      const tmScope = extractCSharpMethodScope(src, "TryMountContainer");
      if (!tmScope.combined) return { ok: false, reason: "SemiTrailerDeployable.TryMountContainer not landed yet (M4)" };
      return { ok: true, tmScope: tmScope.combined, semiTestsSrc: getSemiTestsSrc() };
    },
    async ({ tmScope }, ctx) => {
      const tmClean = stripCSharpComments(tmScope);
      assert(
        /\bif\s*\(\s*(?:MountedContainerGuid\s*!=\s*0|0\s*!=\s*MountedContainerGuid)\s*\)\s*(?:\{[^}]*\breturn\s+false\s*;|[^;]*\breturn\s+false\s*;)/.test(tmClean),
        "occupied trailer guard (MountedContainerGuid != 0 -> return false) missing in TryMountContainer"
      );
      if (ctx.mode === "live" && ctx.liveSession) {
        const live = ctx.liveSession;
        await live.cleanupWorld();
        try {
          await live.sendChatAndWait("@trailer spawn 20", /trailer|4000030|spawned/i, 10000);
          await live.sendChatAndWait("@container spawn 20", /container|4000020|spawned/i, 10000);
          const first = await liveWaitUntil(async () => {
            return await live.evalInPage(`
              const t = (window.__vehicles?.trailers?.list?.() || [])[0];
              const c = (window.__vehicles?.containers?.list?.() || [])[0];
              return t && c ? { tGuid: t.guid, c1Guid: c.guid } : null;
            `);
          }, 10000, 250, "20ft trailer + first 20ft container");
          await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${first.tGuid}, 0, ${first.c1Guid}, ${TRAILER_ACTION_KIND.MountContainer}, 0); return true;`);
          await liveWaitUntil(async () => {
            return await live.evalInPage(`
              const t = window.__vehicles.trailers.get(${first.tGuid});
              return ((t?.mountedContainerGuid ?? t?.last?.mountedContainerGuid ?? 0) >>> 0) === ${first.c1Guid};
            `);
          }, 8000, 200, "first container mounted");

          await live.sendChatAndWait("@container spawn 20", /container|4000020|spawned/i, 10000);
          const c2Guid = await liveWaitUntil(async () => {
            return await live.evalInPage(`
              const c2 = (window.__vehicles?.containers?.list?.() || []).find((x) => x.guid !== ${first.c1Guid});
              return c2 ? c2.guid : null;
            `);
          }, 10000, 250, "second 20ft container");

          await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${first.tGuid}, 0, ${c2Guid}, ${TRAILER_ACTION_KIND.MountContainer}, 0); return true;`);
          await new Promise((r) => setTimeout(r, 600));
          const mountedAfter = await live.evalInPage(`
            const t = window.__vehicles.trailers.get(${first.tGuid});
            return (t?.mountedContainerGuid ?? t?.last?.mountedContainerGuid ?? 0) >>> 0;
          `);
          assert(mountedAfter === first.c1Guid, `occupied trailer must reject second container c2, got 0x${mountedAfter.toString(16)}`);
        } finally {
          await live.cleanupWorld();
        }
      }
    }
  );

  // ---------------------------------------------------------------------------
  // F6: Server Hitching & Despawn Boundaries
  // ---------------------------------------------------------------------------

  const probeVmHitch = () => {
    const p = aceFilePath("Source/ACE.Server/Vehicles/VehicleManager.cs");
    if (!existsSync(p)) return { ok: false, reason: "ACE VehicleManager.cs not found" };
    const src = readFileSync(p, "utf8");
    const vmScope = extractCSharpMethodScope(src, "HandleTrailerAction", /Hitch|Trailer/i);
    if (!vmScope.combined) return { ok: false, reason: "VehicleManager.HandleTrailerAction method body not landed yet (M4)" };
    return { ok: true, src, vmScope: vmScope.combined, semiTestsSrc: getSemiTestsSrc() };
  };

  await collector.checkFeature("T2.F6.01", 2, "F6:Server_Commands", probeVmHitch, async ({ vmScope, semiTestsSrc }, ctx) => {
    assert(/\b3\.5\s*[fFdD]?\b/.test(vmScope) && /\bToGlobal\s*\(/.test(vmScope), "HandleTrailerAction missing 3.5 m hitch distance boundary via ToGlobal");
    assert(/return\s+false/.test(vmScope), "HandleTrailerAction missing rejection return false");
    if (semiTestsSrc) {
      assert(/\[TestMethod\][\s\S]{0,800}(?:3\.5|Distance|Far|TooFar)/i.test(semiTestsSrc), "SemiTrailerTests.cs missing >3.5m distance rejection test");
    }
    if (ctx.mode === "live" && ctx.liveSession) {
      const live = ctx.liveSession;
      await live.cleanupWorld();
      try {
        await live.sendChatAndWait("@tele 41.35N 33.33E", /teleport|41\.35/i, 10000).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        await live.sendChatAndWait("@vehicle spawn semi", /Ironhorse 379|spawned/i, 10000);
        await live.sendChatAndWait("@trailer spawn 40", /trailer|4000031|spawned/i, 10000);
        const ids = await liveWaitUntil(async () => {
          return await live.evalInPage(`
            const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
            const t = (window.__vehicles?.trailers?.list?.() || [])[0];
            return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
          `);
        }, 10000, 250, "semi + 40ft trailer for >3.5m boundary");
        await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
        await liveWaitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting semi");
        await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.7 }, 1800); return true;`);
        const dist = await liveWaitUntil(async () => {
          const d = await live.evalInPage(`
            const v = (window.__vehicles?.vehicles?.() || []).find((x) => x.guid === ${ids.vGuid});
            const t = window.__vehicles?.trailers?.get(${ids.tGuid});
            const st = window.__vehicles?.status?.();
            if (!v || !t) return null;
            const vSt = st?.vehicles?.find((x) => x.guid === ${ids.vGuid});
            const gmPos = window.__vehicles?.groundModels?.get?.(${ids.vGuid})?.root?.position;
            const pState = (st?.pilot?.vehicle === undefined || st?.pilot?.vehicle === ${ids.vGuid}) ? st?.pilot?.state : null;
            const vx = pState?.x ?? vSt?.pos?.x ?? gmPos?.x;
            const vy = pState?.y ?? vSt?.pos?.y ?? gmPos?.y;
            const vh = pState?.heading ?? vSt?.pos?.heading ?? v.last?.heading;
            if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vh)) return null;
            const fwX = vx + Math.sin(vh) * (-2.01);
            const fwY = vy + Math.cos(vh) * (-2.01);
            const mPos = t.model?.root?.position;
            let tPos = Array.isArray(t.worldPos) && t.worldPos.length >= 2
              ? t.worldPos
              : (mPos && Number.isFinite(mPos.x) && Number.isFinite(mPos.y) ? [mPos.x, mPos.y, mPos.z ?? 0] : null);
            if (!tPos && t.last && Number.isFinite(t.last.cell) && Array.isArray(t.last.position)) {
              const c = t.last.cell >>> 0;
              const isDericost = ((c >>> 15) & 1) === 1;
              tPos = [((c >>> 24) & 0xff) * 192 + t.last.position[0], (isDericost ? 68928 : 0) + ((c >>> 16) & 0xff) * 192 + t.last.position[1], t.last.position[2] ?? 0];
            }
            if (!tPos || !Number.isFinite(tPos[0]) || !Number.isFinite(tPos[1])) return null;
            const th = t.last?.heading ?? t.heading ?? 0;
            const kpX = tPos[0] + Math.sin(th) * 5.35;
            const kpY = tPos[1] + Math.cos(th) * 5.35;
            const d = Math.hypot(fwX - kpX, fwY - kpY);
            return d > 5.0 ? d : null;
          `);
          return d;
        }, 8000, 150, "fifth-wheel distance > 5.0m");
        await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
        assert(dist > 3.5, `precondition failed: fwDist=${dist} <= 3.5`);
        await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${ids.tGuid}, ${ids.vGuid}, 0, ${TRAILER_ACTION_KIND.Hitch}, 0); return true;`);
        await new Promise((r) => setTimeout(r, 600));
        const coupled = await live.evalInPage(`
          const t = window.__vehicles.trailers.get(${ids.tGuid});
          return (t?.coupledTractorGuid ?? t?.last?.coupledTractorGuid ?? 0) >>> 0;
        `);
        assert(coupled === 0, `server must reject hitch at ${dist.toFixed(2)} m (>3.5 m), got coupledTractorGuid=0x${coupled.toString(16)}`);
      } finally {
        await live.evalInPage(`window.__vehicles?.exit?.(0); return true;`).catch(() => {});
        await live.cleanupWorld();
      }
    }
  });

  await collector.checkFeature("T2.F6.02", 2, "F6:Server_Commands", probeVmHitch, async ({ vmScope, semiTestsSrc }, ctx) => {
    assert(/(?:\b60(?:\.0+)?\s*[fFdD]?\b|Math\.PI\s*\/\s*3(?:\.0+)?|1\.04719)/.test(vmScope), "HandleTrailerAction missing 60 deg hitch alignment boundary");
    assert(/return\s+false/.test(vmScope), "HandleTrailerAction missing rejection return false");
    if (semiTestsSrc) {
      assert(/\[TestMethod\][\s\S]{0,800}(?:60|Angle|Jackknife|Align)/i.test(semiTestsSrc), "SemiTrailerTests.cs missing >60 deg alignment rejection test");
    }
    if (ctx.mode === "live" && ctx.liveSession) {
      const live = ctx.liveSession;
      await live.cleanupWorld();
      try {
        await live.sendChatAndWait("@tele 41.35N 33.33E", /teleport|41\.35/i, 10000).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        await live.sendChatAndWait("@vehicle spawn semi", /Ironhorse 379|spawned/i, 10000);
        await live.sendChatAndWait("@trailer spawn 40", /trailer|4000031|spawned/i, 10000);
        const ids = await liveWaitUntil(async () => {
          return await live.evalInPage(`
            const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
            const t = (window.__vehicles?.trailers?.list?.() || [])[0];
            return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
          `);
        }, 10000, 250, "semi + 40ft trailer for >60 deg boundary");
        await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
        await liveWaitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting semi");
        await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.6 }, 2300); return true;`);
        await new Promise((r) => setTimeout(r, 2400));

        // Closed-loop turn & side approach toward kingpin within <= 3.5 m at > 68 deg angle diff
        const tStart = Date.now();
        let phase = "uturn";
        let positioned = null;
        while (Date.now() - tStart < 18000) {
          const snap = await live.evalInPage(`
            const v = (window.__vehicles?.vehicles?.() || []).find((x) => x.guid === ${ids.vGuid});
            const t = window.__vehicles?.trailers?.get(${ids.tGuid});
            const st = window.__vehicles?.status?.();
            if (!v || !t) return null;
            const vSt = st?.vehicles?.find((x) => x.guid === ${ids.vGuid});
            const gmPos = window.__vehicles?.groundModels?.get?.(${ids.vGuid})?.root?.position;
            const pState = (st?.pilot?.vehicle === undefined || st?.pilot?.vehicle === ${ids.vGuid}) ? st?.pilot?.state : null;
            const vx = pState?.x ?? vSt?.pos?.x ?? gmPos?.x;
            const vy = pState?.y ?? vSt?.pos?.y ?? gmPos?.y;
            const vh = pState?.heading ?? vSt?.pos?.heading ?? v.last?.heading;
            if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vh)) return null;
            const fwX = vx + Math.sin(vh) * (-2.01);
            const fwY = vy + Math.cos(vh) * (-2.01);
            const mPos = t.model?.root?.position;
            let tPos = Array.isArray(t.worldPos) && t.worldPos.length >= 2
              ? t.worldPos
              : (mPos && Number.isFinite(mPos.x) && Number.isFinite(mPos.y) ? [mPos.x, mPos.y, mPos.z ?? 0] : null);
            if (!tPos && t.last && Number.isFinite(t.last.cell) && Array.isArray(t.last.position)) {
              const c = t.last.cell >>> 0;
              const isDericost = ((c >>> 15) & 1) === 1;
              tPos = [((c >>> 24) & 0xff) * 192 + t.last.position[0], (isDericost ? 68928 : 0) + ((c >>> 16) & 0xff) * 192 + t.last.position[1], t.last.position[2] ?? 0];
            }
            if (!tPos || !Number.isFinite(tPos[0]) || !Number.isFinite(tPos[1])) return null;
            const th = t.last?.heading ?? t.heading ?? 0;
            const kpX = tPos[0] + Math.sin(th) * 5.35;
            const kpY = tPos[1] + Math.cos(th) * 5.35;
            return { vh, th, fwX, fwY, kpX, kpY, fwDist: Math.hypot(fwX - kpX, fwY - kpY) };
          `);
          if (snap) {
            const ang = Math.abs(angleDiff(snap.vh, snap.th));
            if (phase === "uturn" && ang >= (100 * Math.PI) / 180) phase = "approach";
            if (snap.fwDist <= 3.0 && ang > (68 * Math.PI) / 180) {
              await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0, handbrake: true }, 400); return true;`);
              await new Promise((r) => setTimeout(r, 450));
              positioned = { fwDist: snap.fwDist, angDeg: (ang * 180) / Math.PI };
              break;
            }
            if (phase === "uturn") {
              await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.45, yaw: 1.0 }, 250); return true;`);
            } else {
              const targetH = Math.atan2(snap.kpX - snap.fwX, snap.kpY - snap.fwY);
              const err = angleDiff(targetH, snap.vh);
              if (snap.fwDist < 6.5 && Math.abs(err) > 1.2) {
                const revYaw = err >= 0 ? -0.8 : 0.8;
                await live.evalInPage(`window.__vehicles.setSticks({ throttle: -0.35, yaw: ${revYaw} }, 220); return true;`);
              } else {
                const yaw = Math.max(-1, Math.min(1, err * 1.5));
                const thr = snap.fwDist > 6 ? 0.45 : 0.25;
                await live.evalInPage(`window.__vehicles.setSticks({ throttle: ${thr}, yaw: ${yaw} }, 200); return true;`);
              }
            }
          }
          await new Promise((r) => setTimeout(r, 120));
        }
        await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
        assert(positioned && positioned.fwDist <= 3.5 && positioned.angDeg > 60, `failed to reach <=3.5m & >60deg precondition (${JSON.stringify(positioned)})`);
        await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${ids.tGuid}, ${ids.vGuid}, 0, ${TRAILER_ACTION_KIND.Hitch}, 0); return true;`);
        await new Promise((r) => setTimeout(r, 600));
        const coupled = await live.evalInPage(`
          const t = window.__vehicles.trailers.get(${ids.tGuid});
          return (t?.coupledTractorGuid ?? t?.last?.coupledTractorGuid ?? 0) >>> 0;
        `);
        assert(coupled === 0, `server must reject >60 deg hitch (${positioned.angDeg.toFixed(1)} deg at ${positioned.fwDist.toFixed(2)} m), got coupledTractorGuid=0x${coupled.toString(16)}`);
      } finally {
        await live.evalInPage(`window.__vehicles?.exit?.(0); return true;`).catch(() => {});
        await live.cleanupWorld();
      }
    }
  });

  await collector.checkFeature("T2.F6.03", 2, "F6:Server_Commands", probeVmHitch, ({ vmScope, semiTestsSrc }) => {
    assert(/\bToGlobal\s*\(/.test(vmScope), "HandleTrailerAction must convert landblock Position via Vehicle.ToGlobal");
    assert(!/\.Location\.Pos\b/.test(vmScope), "HandleTrailerAction must not subtract raw landblock-local Location.Pos");
    if (semiTestsSrc) {
      assert(/\[TestMethod\][\s\S]{0,800}(?:Landblock|CrossLandblock|ToGlobal)/i.test(semiTestsSrc), "SemiTrailerTests.cs missing cross-landblock ToGlobal test");
    }
  });

  await collector.checkFeature(
    "T2.F6.04",
    2,
    "F6:Server_Commands",
    async () => {
      const env = await makeSemiLiveEnv();
      const hasTrailers = Boolean(env.api?.trailers);
      env.dispose();
      if (!hasTrailers) return { ok: false, reason: "index.js trailers Map not landed yet (M3)" };
      return { ok: true };
    },
    async () => {
      const env = await makeSemiLiveEnv();
      const cl = toCellLocal(1200, 1400, 10);
      env.inbox.push(
        { type: "ack", granted: 3 },
        { type: "profile", vehicle: 0x80099001, profileKey: "semi-379", displayName: "Ironhorse 379", locomotion: 2, vehicleClass: 3, fifthWheelOffsetY: -2.01, fifthWheelOffsetZ: 0.96, seats: SEMI_SPEC.seats.map((offset) => ({ offset })) },
        { type: "state", vehicle: 0x80099001, flags: 1, step: 1, mode: 6, cell: cl.cell, x: cl.x, y: cl.y, z: cl.z, hitchedTrailerGuid: 0x80099101, trailerFlags: 0x05 },
        { type: "trailer_state", trailerGuid: 0x80099101, kind: DEPLOYABLE_KIND.TrailerChassis40, cell: cl.cell, position: [cl.x, cl.y - 4.8, cl.z], coupledTractorGuid: 0x80099001, trailerFlags: 0x05 }
      );
      env.live.vehicles.afterTick(1.0, 0.016);
      // Despawn tractor (event kind = 4) and unhitched trailer_state
      env.inbox.push(
        { type: "event", vehicle: 0x80099001, kind: 4, step: 2 },
        { type: "trailer_state", trailerGuid: 0x80099101, kind: DEPLOYABLE_KIND.TrailerChassis40, cell: cl.cell, position: [cl.x, cl.y - 4.8, cl.z], coupledTractorGuid: 0, trailerFlags: 0 }
      );
      env.live.vehicles.afterTick(1.016, 0.016);
      assert(env.entityMap.get(0x80099001)._filmHidden === false, "despawned tractor stand-in unhidden");
      const tEntry = env.api.trailers.get(0x80099101);
      assert(tEntry && (tEntry.coupledTractorGuid ?? tEntry.last?.coupledTractorGuid ?? 0) === 0, "trailer unhitched after tractor despawn");
      env.dispose();
    }
  );

  await collector.checkFeature("T2.F6.05", 2, "F6:Server_Commands", probeVmHitch, async ({ vmScope }, ctx) => {
    assert(/TrailerActionKind|switch\s*\([^)]*Action/.test(vmScope), "HandleTrailerAction missing action dispatch switch");
    assert(/default\s*:[\s\S]{0,120}return\s+false/.test(vmScope), "HandleTrailerAction missing default: return false rejection");
    if (ctx.mode === "live" && ctx.liveSession) {
      const live = ctx.liveSession;
      await live.cleanupWorld();
      try {
        await live.sendChatAndWait("@vehicle spawn semi", /Ironhorse 379|spawned/i, 10000);
        await live.sendChatAndWait("@trailer spawn 40", /trailer|4000031|spawned/i, 10000);
        const ids = await liveWaitUntil(async () => {
          return await live.evalInPage(`
            const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
            const t = (window.__vehicles?.trailers?.list?.() || [])[0];
            return v && t ? { vGuid: v.guid, tGuid: t.guid } : null;
          `);
        }, 10000, 250, "semi + trailer for invalid Action=99");
        await live.evalInPage(`window.__sessionHandle.vehicleTrailerAction(${ids.tGuid}, ${ids.vGuid}, 0, 99, 0); return true;`);
        await new Promise((r) => setTimeout(r, 400));
        const coupled = await live.evalInPage(`
          const t = window.__vehicles.trailers.get(${ids.tGuid});
          return (t?.coupledTractorGuid ?? t?.last?.coupledTractorGuid ?? 0) >>> 0;
        `);
        assert(coupled === 0, `invalid TrailerActionKind=99 must be rejected, got coupledTractorGuid=0x${coupled.toString(16)}`);
      } finally {
        await live.cleanupWorld();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // F7: Client UX Boundaries
  // ---------------------------------------------------------------------------

  await collector.checkFeature(
    "T2.F7.01",
    2,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("camera_rig.js");
      if (!r.ok || !r.mod.DEFAULT_SEMI_CHASE) return { ok: false, reason: "camera_rig.js semi presets not landed yet (M3)" };
      return r;
    },
    ({ mod }) => {
      const rig = mod.createPilotCameraRig({ locomotion: 2, vehicleClass: 3, profileKey: "semi-379", hitchedTrailerKind: "unknown", ground: () => 0 });
      rig.setView("chase");
      const out = rig.step({ pose: { x: 0, y: 0, z: 0, heading: NaN, pitch: 0, bank: 0, speed: 0 }, params: { locomotion: 2, vehicleClass: 3, profileKey: "semi-379" }, dt: 0 });
      assert(out.cam.pos.every(Number.isFinite), "camera pos finite on NaN heading / dt=0");
    }
  );

  await collector.checkFeature(
    "T2.F7.02",
    2,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("audio.js");
      if (!r.ok || typeof r.mod.computeDieselI6EngineParams !== "function") {
        return { ok: false, reason: "audio.js computeDieselI6EngineParams not landed yet (M3)" };
      }
      return r;
    },
    ({ mod }) => {
      const p = mod.computeDieselI6EngineParams({ speed: NaN, throttle: 5, rpmRatio: -2 });
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "number") assert(Number.isFinite(v), `diesel param ${k} finite on hostile input`);
      }
    }
  );

  await collector.runCheck("T2.F7.03", 2, "F7:Client_UX", async () => {
    const { mod } = await tryImportVehicle("controls.js");
    const events = [];
    const win = makeFakeControlsWin();
    const ctrlPax = mod.createVehicleControls({ window: win, locomotion: 2, vehicleClass: 3, profileKey: "semi-379", seatIndex: 1 });
    ctrlPax.onAction((a) => events.push(a));
    ctrlPax.lock();
    try {
      win.dispatchKey("KeyG", "keydown");
      win.dispatchKey("KeyG", "keyup");
      assert(events.length === 0, `passenger seat (seatIndex=1) KeyG must not trigger actions, got ${JSON.stringify(events)}`);
      // Positive control: proves lock(), onAction(), and keydown wiring are active
      win.dispatchKey("KeyX", "keydown");
      win.dispatchKey("KeyX", "keyup");
      assert(events.some((e) => e.type === "exit"), `passenger KeyX must emit exit (proves listener wiring), got ${JSON.stringify(events)}`);
    } finally {
      ctrlPax.restore();
      ctrlPax.dispose();
    }
  });

  await collector.checkFeature(
    "T2.F7.04",
    2,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("osd.js");
      if (!r.ok) return r;
      const src = readFileSync(r.path, "utf8");
      if (!/semi|TRAILER|HITCH/i.test(src)) return { ok: false, reason: "osd.js semi telemetry not landed yet (M3)" };
      return r;
    },
    ({ mod }) => {
      const byId = new Map();
      const mk = (tag) => ({ tag, children: [], style: {}, id: "", textContent: "", setAttribute() {}, appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; }, remove() {} });
      const doc = { head: mk("head"), body: mk("body"), createElement: mk, getElementById: (id) => byId.get(id) ?? null };
      const hud = mod.createVehicleOsd({ document: doc });
      hud.update({ locomotion: 2, vehicleClass: 3, profileKey: "semi-379", name: "Ironhorse 379", speed: 999, trailerArticulationRad: Math.PI, hitchedTrailerGuid: 0 });
      const el = doc.getElementById(mod.OSD_ID);
      assert(el && el.style.display === "block" && el.textContent.length > 0 && !/NaN|undefined/.test(el.textContent), `extreme OSD output clean: ${el?.textContent}`);
      hud.dispose();
    }
  );

  await collector.runCheck("T2.F7.05", 2, "F7:Client_UX", async () => {
    const THREE = await getThree();
    const { mod } = await tryImportVehicle("ground_fx.js");
    const root = new THREE.Group();
    const fx = mod.createGroundFx({ THREE, root });
    for (let i = 0; i < mod.POOL_SIZE + 40; i++) {
      fx.update({ x: i * 0.5, y: 0, z: 0, heading: 0, speed: 15, surfaceFamily: 1, mode: 6, groundFlags: 1 }, 0.05);
    }
    const active = fx.getActiveCount();
    assert(active > 0 && active <= mod.POOL_SIZE, `ground_fx active count bounded in (0, ${mod.POOL_SIZE}], got ${active}`);
    fx.dispose();
    assert(root.children.length === 0, "ground_fx dispose cleans up all pool objects from root");
  });
}
