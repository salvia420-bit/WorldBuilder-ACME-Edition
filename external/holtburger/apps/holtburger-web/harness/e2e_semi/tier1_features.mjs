// harness/e2e_semi/tier1_features.mjs — Tier 1 Feature Coverage (>= 5 tests per feature area F1–F7 = >= 35 tests).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AC_C2S_FRAME,
  AC_S2C_FRAME,
  APP_ROOT,
  DEPLOYABLE_KIND,
  GROUND_DOCS_DIR,
  HBV1_TAG,
  HBV1_VERSION_V6,
  HOLTBURGER_ROOT,
  OPCODES,
  REPO_ROOT,
  SEMI_SPEC,
  TRAILER_ACTION_KIND,
  TRAILER_FLAGS,
  VEHICLE_EVENT_KIND,
  aceFilePath,
  assert,
  bytesToHex,
  createFakeWebGL2,
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
  extractCSharpMethods,
  fakeCanvas,
  getThree,
  hexToBytes,
  makeFakeControlsWin,
  makeSemiLiveEnv,
  near,
  oracleComputeMountedContainerPose,
  oracleStepCoupledTrailer,
  readProtocolFixtures,
  readXmlProtocol,
  toCellLocal,
  toGlobal,
  tryImportVehicle,
  tryLoadWasmPkg,
  unwrapC2SFrame,
  unwrapS2CFrame,
  wrapC2SFrame,
  wrapPi,
  wrapS2CFrame,
} from "./common.mjs";

export const TIER1_METADATA = [
  // F1: HBV1 v6 Protocol, 0x090F, Enums, Fixtures & WASM Bridge (8 tests)
  { id: "T1.F1.00", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.01", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.02", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.03", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.04", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.05", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.06", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  { id: "T1.F1.07", tier: 1, feature: "F1:HBV1_v6_Protocol", mode: "offline" },
  // F2: semi-379 Model, Profile, Dimensions, Liveries, Visual Budget (5 tests)
  { id: "T1.F2.01", tier: 1, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T1.F2.02", tier: 1, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T1.F2.03", tier: 1, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T1.F2.04", tier: 1, feature: "F2:Semi379_Model", mode: "offline" },
  { id: "T1.F2.05", tier: 1, feature: "F2:Semi379_Model", mode: "offline" },
  // F3: Trailer Chassis 20ft/40ft, z=0.96 Kingpin, Gear, Wheels, Brake Lamps (6 tests)
  { id: "T1.F3.01", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T1.F3.02", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T1.F3.03", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T1.F3.04", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T1.F3.05a", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  { id: "T1.F3.05b", tier: 1, feature: "F3:Trailer_Models", mode: "offline" },
  // F4: Articulated Kinematics (±72°), Ground Parity & towMassMul (6 tests)
  { id: "T1.F4.01", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T1.F4.02", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T1.F4.03", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T1.F4.04", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T1.F4.05", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  { id: "T1.F4.06", tier: 1, feature: "F4:Kinematics_Ground", mode: "offline" },
  // F5: Twistlocks, Container Mounting, Door Lock & Colliders (5 tests)
  { id: "T1.F5.01", tier: 1, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T1.F5.02", tier: 1, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T1.F5.03", tier: 1, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T1.F5.04", tier: 1, feature: "F5:Containers_Twistlocks", mode: "offline" },
  { id: "T1.F5.05", tier: 1, feature: "F5:Containers_Twistlocks", mode: "offline" },
  // F6: Server Hitching, Despawn Safety & @vehicle/@trailer Commands (5 tests)
  { id: "T1.F6.01", tier: 1, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T1.F6.02", tier: 1, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T1.F6.03", tier: 1, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T1.F6.04", tier: 1, feature: "F6:Server_Commands", mode: "offline" },
  { id: "T1.F6.05", tier: 1, feature: "F6:Server_Commands", mode: "live" },
  // F7: Client Integration, Controls, Camera, Audio, OSD, FX, Seat Poses (5 tests)
  { id: "T1.F7.01", tier: 1, feature: "F7:Client_UX", mode: "offline" },
  { id: "T1.F7.02", tier: 1, feature: "F7:Client_UX", mode: "offline" },
  { id: "T1.F7.03", tier: 1, feature: "F7:Client_UX", mode: "offline" },
  { id: "T1.F7.04", tier: 1, feature: "F7:Client_UX", mode: "offline" },
  { id: "T1.F7.05", tier: 1, feature: "F7:Client_UX", mode: "offline" },
];

export async function runTier1(collector) {
  // ---------------------------------------------------------------------------
  // F1: HBV1 v6 Header, Profile, State, 0x090F, Enums & WASM Bridge
  // ---------------------------------------------------------------------------

  await collector.runCheck("T1.F1.00", 1, "F1:HBV1_v6_Protocol", () => {
    // Unconditional wire codec self-verification against existing v1-v5 fixtures
    const { output } = readProtocolFixtures();
    assert(output && Array.isArray(output.fixtures), "vehicle-wire-fixtures.json must exist");
    const profFx = output.fixtures.find((f) => f.name === "vehicle_profile_hellcat" && f.expect === "ok");
    assert(profFx, "vehicle_profile_hellcat fixture missing");
    const profBytes = hexToBytes(profFx.hex);
    const decodedProf = decodeVehicleProfile(profBytes);
    assert(decodedProf && decodedProf.ProfileKey === "hellcat-demo", "decoded hellcat ProfileKey");
    assert(decodedProf.DisplayName === "Hellcat", "decoded hellcat DisplayName");
    assert(decodedProf._bytesConsumed === profBytes.length, `consumed ${decodedProf._bytesConsumed} vs ${profBytes.length}`);

    const stateFx = output.fixtures.find((f) => f.message === "Vehicle_State" && f.expect === "ok" && f.version >= 4);
    assert(stateFx, "v4/v5 Vehicle_State fixture missing");
    const stateBytes = hexToBytes(stateFx.hex);
    const decodedState = decodeVehicleState(stateBytes);
    assert(decodedState && decodedState.Vehicle === stateFx.fields.Vehicle, "decoded Vehicle_State Vehicle");
    assert(decodedState._bytesConsumed === stateBytes.length, `state consumed ${decodedState._bytesConsumed} vs ${stateBytes.length}`);
  });

  await collector.checkFeature(
    "T1.F1.01",
    1,
    "F1:HBV1_v6_Protocol",
    () => {
      const xml = readXmlProtocol();
      if (!xml.exists) return { ok: false, reason: "vehicles.protocol.xml not found" };
      if (!/version="(?:6|7)"/.test(xml.text)) {
        return { ok: false, reason: "vehicles.protocol.xml is not yet bumped to version=\"6\" or \"7\" (M1)" };
      }
      return { ok: true, text: xml.text };
    },
    ({ text }) => {
      assert(/<enum[^>]+name="DeployableKind"[\s\S]*?value="13"[^>]+name="TrailerChassis20"/m.test(text), "DeployableKind 13 TrailerChassis20 missing");
      assert(/<enum[^>]+name="DeployableKind"[\s\S]*?value="14"[^>]+name="TrailerChassis40"/m.test(text), "DeployableKind 14 TrailerChassis40 missing");
      assert(/<enum[^>]+name="VehicleEventKind"[\s\S]*?value="19"[^>]+name="TrailerHitched"/m.test(text), "VehicleEventKind 19 TrailerHitched missing");
      assert(/<enum[^>]+name="VehicleEventKind"[\s\S]*?value="20"[^>]+name="TrailerUnhitched"/m.test(text), "VehicleEventKind 20 TrailerUnhitched missing");
      assert(/<enum[^>]+name="VehicleEventKind"[\s\S]*?value="21"[^>]+name="TwistlockToggled"/m.test(text), "VehicleEventKind 21 TwistlockToggled missing");

      const actionEnum = text.match(/<enum[^>]+name="TrailerActionKind"[\s\S]*?<\/enum>/)?.[0] || "";
      assert(actionEnum, "TrailerActionKind enum missing");
      for (const [val, name] of [[0, "None"], [1, "Hitch"], [2, "Unhitch"], [3, "ToggleTwistlock"], [4, "MountContainer"], [5, "UnmountContainer"]]) {
        assert(new RegExp(`value="${val}"[^>]+name="${name}"`).test(actionEnum), `TrailerActionKind ${val}=${name} missing`);
      }

      const profileType = text.match(/<type[^>]+name="Vehicle_Profile"[\s\S]*?<\/type>/)?.[0] || "";
      assert(profileType, "Vehicle_Profile type block missing");
      for (const fname of ["FifthWheelOffsetY", "FifthWheelOffsetZ", "LiveryId", "VehicleClass", "Reserved4"]) {
        assert(new RegExp(`name="${fname}"[^>]+since="6"`).test(profileType), `Vehicle_Profile since="6" field ${fname} missing`);
      }

      const stateType = text.match(/<type[^>]+name="Vehicle_State"[\s\S]*?<\/type>/)?.[0] || "";
      assert(stateType, "Vehicle_State type block missing");
      for (const fname of ["HitchedTrailerGuid", "TrailerHeading", "TrailerPitch", "TrailerFlags", "Reserved4", "Reserved5"]) {
        assert(new RegExp(`name="${fname}"[^>]+since="6"`).test(stateType), `Vehicle_State since="6" field ${fname} missing`);
      }

      assert(/<type[^>]+name="Vehicle_TrailerAction"[^>]+queue="Weenie"[^>]+type="0x090F"/m.test(text), "Vehicle_TrailerAction 0x090F Weenie missing");
      assert(/<type[^>]+name="Vehicle_TrailerState"[^>]+queue="UIQueue"[^>]+type="0x090F"/m.test(text), "Vehicle_TrailerState 0x090F UIQueue missing");
    }
  );

  await collector.checkFeature(
    "T1.F1.02",
    1,
    "F1:HBV1_v6_Protocol",
    () => {
      const fx = readProtocolFixtures();
      if (!fx.input || !fx.output) return { ok: false, reason: "protocol fixture JSON missing" };
      if (fx.output.version !== 6 && fx.output.version !== 7) {
        return { ok: false, reason: `vehicle-wire-fixtures.json version is ${fx.output.version}, awaiting v6/v7 (M1)` };
      }
      return { ok: true, ...fx };
    },
    ({ input, output }) => {
      const schemaVer = output.version;
      const futureIn = input.fixtures.find((f) => f.name === "future_version_extra_bytes");
      assert(futureIn && futureIn.fields?.Header?.Version === schemaVer + 1, `future_version_extra_bytes must use Header.Version === ${schemaVer + 1}`);

      const getFx = (name) => {
        const fx = output.fixtures.find((f) => f.name === name && f.expect === "ok");
        assert(fx, `fixture "${name}" missing in vehicle-wire-fixtures.json`);
        return fx;
      };

      // 1. vehicle_trailer_action (24B, 0x090F C2S)
      const ta = getFx("vehicle_trailer_action");
      const taVer = ta.version ?? schemaVer;
      assert(ta.opcode === OPCODES.Vehicle_TrailerAction, "Vehicle_TrailerAction opcode 0x090F");
      const taDec = decodeTrailerAction(hexToBytes(ta.hex));
      assert(taDec && taDec._bytesConsumed === 24, `TrailerAction wire length must be 24B, got ${taDec?._bytesConsumed}`);
      assert(taDec.Header.Version === taVer, `TrailerAction Header.Version === ${taVer}`);
      assert(taDec.TrailerGuid === ta.fields.TrailerGuid && taDec.TrailerGuid !== 0xffffffff, "TrailerAction.TrailerGuid");
      assert(taDec.VehicleGuid === ta.fields.VehicleGuid, "TrailerAction.VehicleGuid");
      assert(taDec.ContainerGuid === ta.fields.ContainerGuid, "TrailerAction.ContainerGuid");
      assert(taDec.Action === ta.fields.Action && taDec.Action === TRAILER_ACTION_KIND.MountContainer, "TrailerAction.Action === 4");
      assert(taDec.Slot === ta.fields.Slot && taDec.Slot === 1, "TrailerAction.Slot === 1");
      assert(taDec.Flags === ta.fields.Flags, "TrailerAction.Flags");
      assert(bytesToHex(encodeTrailerAction(taDec, taVer)) === ta.hex, "TrailerAction decode->encode hex mismatch");
      assert(bytesToHex(encodeTrailerAction(ta.fields, taVer)) === ta.hex, "TrailerAction fields->hex mismatch");

      // 2. vehicle_trailer_state v6 (60B, 0x090F S2C)
      const ts = output.fixtures.find((f) => f.name === "vehicle_trailer_state_v6" && f.expect === "ok") || getFx("vehicle_trailer_state");
      const tsVer = ts.version ?? 6;
      assert(ts.opcode === OPCODES.Vehicle_TrailerState, "Vehicle_TrailerState opcode 0x090F");
      const tsDec = decodeTrailerState(hexToBytes(ts.hex));
      assert(tsDec && tsDec._bytesConsumed === (tsVer >= 7 ? 84 : 60), `TrailerState wire length mismatch, got ${tsDec?._bytesConsumed}`);
      assert(tsDec.Header.Version === tsVer, `TrailerState Header.Version === ${tsVer}`);
      assert(tsDec.TrailerGuid === ts.fields.TrailerGuid, "TrailerState.TrailerGuid");
      assert(tsDec.Kind === ts.fields.Kind && tsDec.Kind === DEPLOYABLE_KIND.TrailerChassis40, "TrailerState.Kind === 14");
      assert(tsDec.Cell === ts.fields.Cell, "TrailerState.Cell");
      near(tsDec.Position.X, ts.fields.Position.X, 1e-5, "TrailerState.Position.X");
      near(tsDec.Position.Y, ts.fields.Position.Y, 1e-5, "TrailerState.Position.Y");
      near(tsDec.Position.Z, ts.fields.Position.Z, 1e-5, "TrailerState.Position.Z");
      near(tsDec.Heading, ts.fields.Heading, 1e-5, "TrailerState.Heading");
      near(tsDec.Pitch, ts.fields.Pitch, 1e-5, "TrailerState.Pitch");
      near(tsDec.Bank, ts.fields.Bank, 1e-5, "TrailerState.Bank");
      assert(tsDec.CoupledTractorGuid === ts.fields.CoupledTractorGuid, "TrailerState.CoupledTractorGuid");
      assert(tsDec.MountedContainerGuid === ts.fields.MountedContainerGuid, "TrailerState.MountedContainerGuid");
      assert(tsDec.ContainerSlot === ts.fields.ContainerSlot, "TrailerState.ContainerSlot");
      assert(tsDec.TrailerFlags === ts.fields.TrailerFlags, "TrailerState.TrailerFlags");
      assert(tsDec.OwnerGuid === ts.fields.OwnerGuid, "TrailerState.OwnerGuid");
      assert(bytesToHex(encodeTrailerState(tsDec, tsVer)) === ts.hex, "TrailerState decode->encode hex mismatch");
      assert(bytesToHex(encodeTrailerState(ts.fields, tsVer)) === ts.hex, "TrailerState fields->hex mismatch");

      // 3. vehicle_profile_semi (v6/v7)
      const sp = getFx("vehicle_profile_semi");
      const spVer = sp.version ?? schemaVer;
      const spBytes = hexToBytes(sp.hex);
      const spDec = decodeVehicleProfile(spBytes);
      assert(spDec && spDec._bytesConsumed === spBytes.length, `vehicle_profile_semi consumed ${spDec?._bytesConsumed} vs ${spBytes.length}`);
      assert(spDec.ProfileKey === "semi-379" && spDec.DisplayName === "Ironhorse 379", "semi profile key/name");
      assert(spDec.StandInSetup === SEMI_SPEC.standInSetup, "semi StandInSetup 0x0200026B");
      near(spDec.Wheelbase, SEMI_SPEC.wheelbase, 1e-4, "semi Wheelbase");
      near(spDec.VMax, SEMI_SPEC.vMax, 1e-4, "semi VMax");
      near(spDec.FifthWheelOffsetY, SEMI_SPEC.fifthWheelOffsetY, 1e-5, "semi FifthWheelOffsetY -2.01");
      near(spDec.FifthWheelOffsetZ, SEMI_SPEC.fifthWheelOffsetZ, 1e-5, "semi FifthWheelOffsetZ 0.96");
      assert(spDec.LiveryId === sp.fields.LiveryId && spDec.LiveryId === 1, "semi LiveryId === 1");
      assert(spDec.VehicleClass === 3, "semi VehicleClass === 3");
      assert(spDec.Reserved4 === sp.fields.Reserved4, "semi Reserved4");
      assert(bytesToHex(encodeVehicleProfile(spDec, spVer)) === sp.hex, "vehicle_profile_semi decode->encode hex mismatch");
      assert(bytesToHex(encodeVehicleProfile(sp.fields, spVer)) === sp.hex, "vehicle_profile_semi fields->hex mismatch");

      // 4. vehicle_state_coupled (100B v6/v7)
      const sc = getFx("vehicle_state_coupled");
      const scVer = sc.version ?? schemaVer;
      const scBytes = hexToBytes(sc.hex);
      assert(scBytes.length === 100, `vehicle_state_coupled must be 100B, got ${scBytes.length}`);
      const scDec = decodeVehicleState(scBytes);
      assert(scDec && scDec._bytesConsumed === 100, "vehicle_state_coupled full 100B consumed");
      assert(scDec.Vehicle === sc.fields.Vehicle, "coupled state Vehicle");
      assert(scDec.HitchedTrailerGuid === sc.fields.HitchedTrailerGuid && scDec.HitchedTrailerGuid !== 0, "coupled state HitchedTrailerGuid");
      near(scDec.TrailerHeading, sc.fields.TrailerHeading, 1e-5, "coupled state TrailerHeading");
      near(scDec.TrailerPitch, sc.fields.TrailerPitch, 1e-5, "coupled state TrailerPitch");
      assert(scDec.TrailerFlags === sc.fields.TrailerFlags && scDec.TrailerFlags === 7, "coupled state TrailerFlags === 7");
      assert(bytesToHex(encodeVehicleState(scDec, scVer)) === sc.hex, "vehicle_state_coupled decode->encode hex mismatch");
      assert(bytesToHex(encodeVehicleState(sc.fields, scVer)) === sc.hex, "vehicle_state_coupled fields->hex mismatch");

      // 5. vehicle_profile_jeep_v5 (v5 -> v6/v7 repack_hex)
      const jv5 = getFx("vehicle_profile_jeep_v5");
      const jv5Dec = decodeVehicleProfile(hexToBytes(jv5.hex));
      assert(jv5Dec && jv5Dec.Header.Version === 5 && jv5Dec._bytesConsumed === hexToBytes(jv5.hex).length, "jeep_v5 consumed");
      assert(jv5Dec.ProfileKey === "jeep-mb" && jv5Dec.FifthWheelOffsetY === 0 && jv5Dec.VehicleClass === 0, "jeep_v5 v6 defaults zero");
      assert(bytesToHex(encodeVehicleProfile(jv5Dec, 5)) === jv5.hex, "jeep_v5 decode->encode v5 hex mismatch");
      assert(bytesToHex(encodeVehicleProfile(jv5Dec, schemaVer)) === jv5.repack_hex, "jeep_v5 repack_hex mismatch");

      // 6. vehicle_state_driving_v5 (84B v5 -> 100B v6/v7 repack_hex)
      const dv5 = getFx("vehicle_state_driving_v5");
      const dv5Bytes = hexToBytes(dv5.hex);
      assert(dv5Bytes.length === 84, `vehicle_state_driving_v5 must be 84B, got ${dv5Bytes.length}`);
      const dv5Dec = decodeVehicleState(dv5Bytes);
      assert(dv5Dec && dv5Dec.Header.Version === 5 && dv5Dec._bytesConsumed === 84, "driving_v5 consumed");
      assert(dv5Dec.HitchedTrailerGuid === 0 && dv5Dec.TrailerFlags === 0, "driving_v5 v6 defaults zero");
      assert(bytesToHex(encodeVehicleState(dv5Dec, 5)) === dv5.hex, "driving_v5 decode->encode v5 hex mismatch");
      assert(bytesToHex(encodeVehicleState(dv5Dec, schemaVer)) === dv5.repack_hex, "driving_v5 repack_hex mismatch");
    }
  );

  await collector.runCheck("T1.F1.03", 1, "F1:HBV1_v6_Protocol", () => {
    const baseProfile = {
      Vehicle: 0x80099001,
      ProfileKey: "semi-379",
      DisplayName: "Ironhorse 379",
      Locomotion: 2,
      StandInSetup: SEMI_SPEC.standInSetup,
      SimHz: 30,
      VCruise: 22.0,
      VMax: SEMI_SPEC.vMax,
      SpeedCap: SEMI_SPEC.vMax,
      Accel: SEMI_SPEC.accel,
      Decel: SEMI_SPEC.decel,
      YawRate: 4.0,
      LeadSeconds: 6.0,
      ObjectRadius: 4,
      Seats: SEMI_SPEC.seats.map((s, idx) => ({
        Role: idx,
        Motion: 0x41000013,
        Offset: { X: s[0], Y: s[1], Z: s[2] },
      })),
      Wheelbase: SEMI_SPEC.wheelbase,
      TrackWidth: SEMI_SPEC.trackWidth,
      WheelRadius: SEMI_SPEC.wheelRadius,
      MaxSteerRad: SEMI_SPEC.maxSteerRad,
      ReverseMax: SEMI_SPEC.reverseMax,
      ClimbLimitCos: SEMI_SPEC.climbLimitCos,
      FordDepthMax: SEMI_SPEC.fordDepthMax,
      CargoWcid: 0,
    };
    const v5Bytes = encodeVehicleProfile(baseProfile, 5);
    const v6Bytes = encodeVehicleProfile({
      ...baseProfile,
      FifthWheelOffsetY: SEMI_SPEC.fifthWheelOffsetY,
      FifthWheelOffsetZ: SEMI_SPEC.fifthWheelOffsetZ,
      LiveryId: 1,
      VehicleClass: SEMI_SPEC.vehicleClass,
      Reserved4: 0,
    }, 6);
    assert(v6Bytes.length === v5Bytes.length + 12, `v6 profile must add exact +12B over v5 (got v5=${v5Bytes.length}, v6=${v6Bytes.length})`);
    const dec = decodeVehicleProfile(v6Bytes);
    assert(dec && dec.Header.Version === 6, "v6 profile header version");
    assert(dec.ProfileKey === "semi-379", "ProfileKey semi-379");
    assert(dec.DisplayName === "Ironhorse 379", "DisplayName Ironhorse 379");
    near(dec.FifthWheelOffsetY, -2.01, 1e-5, "FifthWheelOffsetY");
    near(dec.FifthWheelOffsetZ, 0.96, 1e-5, "FifthWheelOffsetZ");
    assert(dec.LiveryId === 1, "LiveryId");
    assert(dec.VehicleClass === 3, "VehicleClass");
    assert(dec._bytesConsumed === v6Bytes.length, "full v6 profile consumed");

    const { output } = readProtocolFixtures();
    const semiFx = output?.fixtures?.find((f) => f.name === "vehicle_profile_semi" && f.expect === "ok");
    assert(semiFx, "vehicle_profile_semi fixture missing in vehicle-wire-fixtures.json");
    assert(v6Bytes.length === semiFx.hex.length / 2, `v6 semi length ${v6Bytes.length} vs fixture ${semiFx.hex.length / 2}`);
    const fxVer = semiFx.version ?? 6;
    assert(bytesToHex(encodeVehicleProfile(semiFx.fields, fxVer)) === semiFx.hex, `encodeVehicleProfile(vehicle_profile_semi.fields, ${fxVer}) must match fixture hex`);
    assert(bytesToHex(encodeVehicleProfile(semiFx.fields, 6).slice(8)) === bytesToHex(hexToBytes(semiFx.hex).slice(8)), "v6 and v7 Vehicle_Profile payloads must be byte-identical");
  });

  await collector.runCheck("T1.F1.04", 1, "F1:HBV1_v6_Protocol", () => {
    const v5Bytes = encodeVehicleState({ Vehicle: 0x80099001, Step: 42 }, 5);
    assert(v5Bytes.length === 84, `v5 Vehicle_State must be 84B, got ${v5Bytes.length}`);
    const v6Bytes = encodeVehicleState({
      Vehicle: 0x80099001,
      Step: 42,
      AckInputSeq: 40,
      Cell: 0x42100001,
      Position: { X: 12.5, Y: 44.25, Z: 10.0 },
      Heading: 1.25,
      Pitch: 0.03,
      Bank: 0.0,
      Speed: 18.5,
      VCap: 27.0,
      Mode: 6,
      Flags: 1,
      SteerAngle: -0.15,
      GroundFlags: 0x11,
      SurfaceFamily: 0,
      HitchedTrailerGuid: 0x80099101,
      TrailerHeading: 1.18,
      TrailerPitch: 0.02,
      TrailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.TwistlocksLocked | TRAILER_FLAGS.GearRetracted,
    }, 6);
    assert(v6Bytes.length === 100, `v6 Vehicle_State must be 100B, got ${v6Bytes.length}`);
    const dec = decodeVehicleState(v6Bytes);
    assert(dec.HitchedTrailerGuid === 0x80099101, "HitchedTrailerGuid");
    near(dec.TrailerHeading, 1.18, 1e-5, "TrailerHeading");
    near(dec.TrailerPitch, 0.02, 1e-5, "TrailerPitch");
    assert(dec.TrailerFlags === 0x07, "TrailerFlags 0x07");
    assert(dec._bytesConsumed === 100, "full 100B v6 Vehicle_State consumed");
  });

  await collector.runCheck("T1.F1.05", 1, "F1:HBV1_v6_Protocol", () => {
    const taPayload = encodeTrailerAction({
      TrailerGuid: 0x80099101,
      VehicleGuid: 0x80099001,
      ContainerGuid: 0x80099201,
      Action: TRAILER_ACTION_KIND.MountContainer,
      Slot: 1,
      Flags: 0,
    });
    assert(taPayload.length === 24, `Vehicle_TrailerAction must be 24B, got ${taPayload.length}`);
    const framedC2S = wrapC2SFrame(17, OPCODES.Vehicle_TrailerAction, taPayload);
    const unwrappedC2S = unwrapC2SFrame(framedC2S);
    assert(unwrappedC2S.frameTag === AC_C2S_FRAME && unwrappedC2S.opcode === 0x090f, "C2S 0xF7B1 0x090F frame");
    const taDec = decodeTrailerAction(unwrappedC2S.payload);
    assert(taDec.Action === TRAILER_ACTION_KIND.MountContainer && taDec.Slot === 1, "TrailerAction round-trip");

    const local = toCellLocal(5000, 3200, 12.5);
    const tsPayload = encodeTrailerState({
      TrailerGuid: 0x80099101,
      Kind: DEPLOYABLE_KIND.TrailerChassis40,
      Cell: local.cell,
      Position: { X: local.x, Y: local.y, Z: local.z },
      Heading: 0.75,
      Pitch: 0.01,
      Bank: -0.005,
      CoupledTractorGuid: 0x80099001,
      MountedContainerGuid: 0x80099201,
      ContainerSlot: 0,
      TrailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.TwistlocksLocked | TRAILER_FLAGS.GearRetracted,
      OwnerGuid: 0x50000001,
    });
    assert(tsPayload.length === 60, `Vehicle_TrailerState must be 60B, got ${tsPayload.length}`);
    const framedS2C = wrapS2CFrame(0x50000001, 99, OPCODES.Vehicle_TrailerState, tsPayload);
    const unwrappedS2C = unwrapS2CFrame(framedS2C);
    assert(unwrappedS2C.frameTag === AC_S2C_FRAME && unwrappedS2C.opcode === 0x090f, "S2C 0xF7B0 0x090F frame");
    const tsDec = decodeTrailerState(unwrappedS2C.payload);
    assert(tsDec.Kind === DEPLOYABLE_KIND.TrailerChassis40, "TrailerState Kind 14");
    assert(tsDec.Position.X >= 0 && tsDec.Position.X < 192, "landblock-local X");
    assert(tsDec.Position.Y >= 0 && tsDec.Position.Y < 192, "landblock-local Y");
    const glob = toGlobal(tsDec.Cell, tsDec.Position.X, tsDec.Position.Y, tsDec.Position.Z);
    near(glob[0], 5000, 1e-3, "reconstructed global X");
    near(glob[1], 3200, 1e-3, "reconstructed global Y");
  });

  await collector.checkFeature(
    "T1.F1.06",
    1,
    "F1:HBV1_v6_Protocol",
    async () => {
      const wasm = await tryLoadWasmPkg();
      if (!wasm.ok) return wasm;
      const fn = wasm.ns?.SessionHandle?.prototype?.vehicleTrailerAction;
      if (typeof fn !== "function") {
        return { ok: false, reason: "pkg/ SessionHandle.prototype.vehicleTrailerAction not exported yet (M1)" };
      }
      return { ok: true, ns: wasm.ns, fn };
    },
    ({ fn }) => {
      assert(fn.length === 5 || fn.length === 6, `vehicleTrailerAction arity expected 5 or 6 (trailer, vehicle, container, action, slot[, flags]), got ${fn.length}`);
      const dtsPath = path.join(APP_ROOT, "pkg", "holtburger_web.d.ts");
      const linkRsPath = path.join(APP_ROOT, "src", "vehicle_link.rs");
      assert(existsSync(dtsPath), "pkg/holtburger_web.d.ts missing");
      assert(existsSync(linkRsPath), "src/vehicle_link.rs missing");
      const dts = readFileSync(dtsPath, "utf8");
      const linkRs = readFileSync(linkRsPath, "utf8");
      assert(/vehicleTrailerAction\s*\([^)]*trailer_guid:\s*number[^)]*slot:\s*number(?:\s*,\s*flags\?:\s*number\s*\|\s*null)?\s*\):\s*void/.test(dts), "pkg/holtburger_web.d.ts missing vehicleTrailerAction signature");
      assert(/VehicleS2C::TrailerState/.test(linkRs) && /"trailer_state"/.test(linkRs), "vehicle_link.rs missing VehicleS2C::TrailerState -> trailer_state");
      assert(/"position":\s*v3\(ts\.position\)/.test(linkRs), "vehicle_link.rs TrailerState must serialize position: v3(ts.position)");
      assert(/"fifthWheelOffsetY"/.test(linkRs) && /"hitchedTrailerGuid"/.test(linkRs), "vehicle_link.rs missing v6 JSON fields");
    }
  );

  await collector.checkFeature(
    "T1.F1.07",
    1,
    "F1:HBV1_v6_Protocol",
    () => {
      const modRs = path.join(HOLTBURGER_ROOT, "crates/holtburger-protocol/src/messages/vehicle/mod.rs");
      if (!existsSync(modRs)) return { ok: false, reason: "vehicle/mod.rs missing" };
      const txt = readFileSync(modRs, "utf8");
      if (!/HBV1_VERSION\s*:\s*u16\s*=\s*(?:6|7)\b/.test(txt)) {
        return { ok: false, reason: "holtburger-protocol HBV1_VERSION is not 6 or 7 yet (M1)" };
      }
      return { ok: true, txt };
    },
    ({ txt }) => {
      assert(/VehicleTrailerAction/.test(txt), "VehicleTrailerAction Rust struct missing");
      assert(/VehicleTrailerState/.test(txt), "VehicleTrailerState Rust struct missing");
      assert(/TRAILER_CHASSIS_20\s*:\s*u32\s*=\s*13/.test(txt), "deployable_kind::TRAILER_CHASSIS_20 missing");
      assert(/TRAILER_CHASSIS_40\s*:\s*u32\s*=\s*14/.test(txt), "deployable_kind::TRAILER_CHASSIS_40 missing");
    }
  );

  // ---------------------------------------------------------------------------
  // F2: semi-379 Profile, Dimensions, Liveries, Seats, Visual Budget
  // ---------------------------------------------------------------------------

  const probeSemiModel = async () => {
    const r = await tryImportVehicle("semi_truck_model.js");
    if (!r.ok) return r;
    if (typeof r.mod.buildSemiTruck !== "function") {
      return { ok: false, reason: "semi_truck_model.js missing buildSemiTruck export" };
    }
    return r;
  };

  await collector.checkFeature("T1.F2.01", 1, "F2:Semi379_Model", probeSemiModel, async ({ mod }) => {
    const THREE = await getThree();
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379", liveryId: 0 }, {});
    let meshes = 0;
    let lights = 0;
    semi.root.traverse((o) => {
      if (o.isMesh) meshes += 1;
      if (o.isLight) lights += 1;
    });
    assert(lights === 0, `semi-379 must add 0 THREE.Light instances, got ${lights}`);
    assert(meshes <= SEMI_SPEC.maxDrawCalls, `semi-379 mesh/draw-call budget exceeded: ${meshes} > ${SEMI_SPEC.maxDrawCalls}`);

    // Render one frame through fake_webgl2 to verify valid geometry/material shaders
    const gl = createFakeWebGL2();
    const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
    const scene = new THREE.Scene();
    scene.add(semi.root);
    const cam = new THREE.PerspectiveCamera(64, 16 / 9, 0.1, 1000);
    cam.position.set(10, -10, 5);
    cam.lookAt(0, 0, 1);
    gl.__fake.reset();
    renderer.render(scene, cam);
    assert(gl.__fake.unitConflicts === 0, `fake_webgl2 unit conflicts: ${gl.__fake.conflictLog.join("; ")}`);
    assert(gl.__fake.uboErrors === 0, `fake_webgl2 UBO errors: ${gl.__fake.uboErrorLog.join("; ")}`);
    semi.dispose();
  });

  await collector.checkFeature("T1.F2.02", 1, "F2:Semi379_Model", probeSemiModel, async ({ mod }) => {
    const THREE = await getThree();
    assert(mod.SEMI_DIMENSIONS, "SEMI_DIMENSIONS export missing");
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379" }, {});
    const box = new THREE.Box3().setFromObject(semi.root);
    const lenY = box.max.y - box.min.y;
    assert(lenY >= 6.5 && lenY <= 7.6, `overall length ${lenY.toFixed(3)} m out of ~7.00 m spec range`);
    assert(Math.abs(box.min.z) < 0.05, `tires should sit near z=0, got min.z=${box.min.z}`);
    near(mod.SEMI_DIMENSIONS.wheelRadius, SEMI_SPEC.wheelRadius, 1e-4, "SEMI_DIMENSIONS.wheelRadius");
    near(mod.SEMI_DIMENSIONS.fifthWheelY, SEMI_SPEC.fifthWheelOffsetY, 1e-4, "SEMI_DIMENSIONS.fifthWheelY");
    near(mod.SEMI_DIMENSIONS.fifthWheelZ, SEMI_SPEC.fifthWheelOffsetZ, 1e-4, "SEMI_DIMENSIONS.fifthWheelZ");
    semi.dispose();
  });

  await collector.checkFeature("T1.F2.03", 1, "F2:Semi379_Model", probeSemiModel, async ({ mod }) => {
    const THREE = await getThree();
    assert(mod.SEMI_LIVERIES, "SEMI_LIVERIES export missing");
    const liveryKeys = Array.isArray(mod.SEMI_LIVERIES) ? mod.SEMI_LIVERIES : Object.keys(mod.SEMI_LIVERIES);
    assert(liveryKeys.length >= 6, `expected 6 fleet liveries, got ${liveryKeys.length}`);
    const sigs = new Set();
    for (let id = 0; id < 6; id++) {
      const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379", liveryId: id }, { liveryId: id });
      let colorSum = 0;
      semi.root.traverse((o) => {
        if (o.isMesh && o.geometry?.attributes?.color) {
          const arr = o.geometry.attributes.color.array;
          for (let i = 0; i < Math.min(arr.length, 300); i++) colorSum += arr[i];
        }
      });
      assert(colorSum > 0, `livery ${id} produced zero vertex color sum`);
      sigs.add(Math.round(colorSum * 100));
      semi.dispose();
    }
    assert(sigs.size >= 4, `expected distinct vertex color signatures across 6 liveries, got ${sigs.size}`);
  });

  await collector.checkFeature("T1.F2.04", 1, "F2:Semi379_Model", probeSemiModel, async ({ mod }) => {
    const THREE = await getThree();
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379" }, {});
    semi.update({ speed: 15.0, steerAngle: 0.4, headlights: true, handbrake: false, trailerCoupled: true }, 0.1);
    const roll1 = semi.wheelRollAngle ?? 0;
    assert(Number.isFinite(roll1) && Math.abs(roll1) > 0.1, `wheels must roll on update, got wheelRollAngle=${roll1}`);
    semi.update({ speed: 15.0, steerAngle: -0.4, headlights: false, handbrake: true, trailerCoupled: false }, 0.1);
    const roll2 = semi.wheelRollAngle ?? 0;
    assert(roll2 > roll1, "wheelRollAngle must advance monotonically at positive speed");
    semi.dispose();
  });

  await collector.checkFeature("T1.F2.05", 1, "F2:Semi379_Model", probeSemiModel, async ({ mod }) => {
    const THREE = await getThree();
    assert(mod.manifest && mod.manifest.id === "vfx-semi-379-model", "manifest id must be vfx-semi-379-model");
    assert(mod.manifest.lightCountDelta === 0, "manifest lightCountDelta must be 0");
    const semi = mod.buildSemiTruck(THREE, { profileKey: "semi-379" }, {});
    semi.root.position.set(100, 200, 10);
    semi.root.updateMatrixWorld(true);
    assert(typeof semi.getFifthWheelWorldAnchor === "function", "getFifthWheelWorldAnchor() missing");
    const anchor = semi.getFifthWheelWorldAnchor();
    const ax = Array.isArray(anchor) ? anchor[0] : anchor.x;
    const ay = Array.isArray(anchor) ? anchor[1] : anchor.y;
    const az = Array.isArray(anchor) ? anchor[2] : anchor.z;
    near(ax, 100, 0.05, "fifth-wheel world anchor X");
    near(ay, 200 + SEMI_SPEC.fifthWheelOffsetY, 0.05, "fifth-wheel world anchor Y");
    near(az, 10 + SEMI_SPEC.fifthWheelOffsetZ, 0.05, "fifth-wheel world anchor Z");
    semi.dispose();
  });

  // ---------------------------------------------------------------------------
  // F3: Trailer Chassis 20ft/40ft, z=0.96 Kingpin, Gear, Wheels, Brake Lamps
  // ---------------------------------------------------------------------------

  await collector.runCheck("T1.F3.01", 1, "F3:Trailer_Models", async () => {
    const THREE = await getThree();
    const { mod } = await tryImportVehicle("trailer_models.js");
    const { mod: cmod } = await tryImportVehicle("container_models.js");
    assert(mod.TRAILER_WCID.Chassis20ft === 4000030, "Chassis20ft WCID must be 4000030");
    assert(mod.TRAILER_WCID.Chassis40ft === 4000031, "Chassis40ft WCID must be 4000031");
    for (const w of Object.values(mod.TRAILER_WCID)) {
      assert(!Object.values(cmod.CONTAINER_WCID).includes(w), `WCID collision ${w}`);
    }
    for (const kind of ["20ft", "40ft"]) {
      const tr = mod.buildSemiTrailer(THREE, kind);
      let lights = 0;
      tr.root.traverse((o) => { if (o.isLight) lights += 1; });
      assert(lights === 0, `${kind} trailer must have 0 lights`);
      tr.dispose();
    }
  });

  await collector.checkFeature(
    "T1.F3.02",
    1,
    "F3:Trailer_Models",
    async () => {
      const r = await tryImportVehicle("trailer_models.js");
      if (!r.ok) return r;
      if (r.mod.CHASSIS_KINGPIN_Z === undefined) {
        return { ok: false, reason: "trailer_models.js missing CHASSIS_KINGPIN_Z = 0.96 (M2)" };
      }
      return r;
    },
    async ({ mod }) => {
      const THREE = await getThree();
      near(mod.CHASSIS_KINGPIN_Z, 0.96, 1e-6, "CHASSIS_KINGPIN_Z");
      near(mod.CHASSIS_DECK_Z, 1.32, 1e-6, "CHASSIS_DECK_Z");
      for (const kind of ["20ft", "40ft"]) {
        const spec = mod.TRAILER_SPECS[kind];
        const expected = SEMI_SPEC.trailers[kind];
        near(spec.kingpinY, expected.kpY, 0.02, `${kind} kingpinY`);
        near(spec.bogieY, expected.bogieY, 0.02, `${kind} bogieY`);
        near(spec.effectiveWheelbase, expected.wheelbase, 0.02, `${kind} effectiveWheelbase`);
        const tr = mod.buildSemiTrailer(THREE, kind);
        // Verify kingpin plate underside mesh vertices exist near z=0.96 at kpY
        const frame = tr.root.getObjectByName("trailer-frame");
        assert(frame && frame.geometry, `${kind} trailer-frame missing`);
        const pos = frame.geometry.attributes.position.array;
        let plateMinZ = Infinity;
        let plateVerts = 0;
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], y = pos[i + 1], z = pos[i + 2];
          const pinDist = Math.hypot(x, y - expected.kpY);
          // Coupler plate corners are at (±0.65, kpY ± 0.80); exclude only the 2" kingpin cylinder (r <= 0.04 m)
          if (pinDist > 0.04 && Math.abs(x) <= 0.66 && Math.abs(y - expected.kpY) <= 0.85 && z >= 0.75 && z <= 1.05) {
            plateVerts += 1;
            if (z < plateMinZ) plateMinZ = z;
          }
        }
        assert(plateVerts >= 4, `${kind} kingpin coupler plate vertices missing near kpY=${expected.kpY}`);
        near(plateMinZ, 0.96, 0.015, `${kind} kingpin coupler underside Z`);
        tr.dispose();
      }
    }
  );

  await collector.checkFeature(
    "T1.F3.03",
    1,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      if (!r.ok) return r;
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const hasFeature = typeof tr.setLandingGearRetracted === "function" && Boolean(tr.landingGearGroup);
      tr.dispose();
      if (!hasFeature) return { ok: false, reason: "trailer_models.js missing landingGearGroup / setLandingGearRetracted (M2)" };
      return r;
    },
    async ({ mod }) => {
      const THREE = await getThree();
      for (const kind of ["20ft", "40ft"]) {
        const tr = mod.buildSemiTrailer(THREE, kind, { landingGearRetracted: false });
        const zDown = tr.landingGearGroup.position.z;
        tr.setLandingGearRetracted(true);
        const zUp = tr.landingGearGroup.position.z;
        near(zUp - zDown, SEMI_SPEC.landingGearRetractDz, 0.02, `${kind} landingGear retraction delta`);
        tr.setLandingGearRetracted(false);
        near(tr.landingGearGroup.position.z, zDown, 1e-4, `${kind} landingGear extend restore`);
        tr.dispose();
      }
    }
  );

  await collector.checkFeature(
    "T1.F3.04",
    1,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      if (!r.ok) return r;
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const hasFeature = Array.isArray(tr.wheelGroups) && tr.wheelGroups.length === 2;
      tr.dispose();
      if (!hasFeature) return { ok: false, reason: "trailer_models.js missing 2 wheelGroups (M2)" };
      return r;
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const tr = mod.buildSemiTrailer(THREE, "40ft");
      const dt = 0.1;
      const speed = 10.1;
      tr.update(dt, { speed, twistlockState: 1 });
      const expectedAngle = (speed * dt) / SEMI_SPEC.wheelRadius;
      for (let i = 0; i < 2; i++) {
        const rot = Math.abs(tr.wheelGroups[i].rotation.x);
        near(rot, expectedAngle, 0.05, `wheelGroups[${i}] roll angle`);
      }
      tr.dispose();
    }
  );

  await collector.runCheck("T1.F3.05a", 1, "F3:Trailer_Models", async () => {
    const THREE = await getThree();
    const { mod } = await tryImportVehicle("trailer_models.js");
    const { mod: cmod } = await tryImportVehicle("container_models.js");
    const tr = mod.buildSemiTrailer(THREE, "40ft");
    const c = cmod.buildIsoContainer(THREE, cmod.CONTAINER_WCID.IsoContainer40HC);
    tr.attachContainer(c);
    tr.root.updateMatrixWorld(true);
    const cb = new THREE.Box3().setFromObject(c.root);
    near(cb.min.z, SEMI_SPEC.chassisDeckZ, 0.05, "container mounted at CHASSIS_DECK_Z=1.32");
    tr.dispose();
  });

  await collector.checkFeature(
    "T1.F3.05b",
    1,
    "F3:Trailer_Models",
    async () => {
      const THREE = await getThree();
      const r = await tryImportVehicle("trailer_models.js");
      if (!r.ok) return r;
      const tr = r.mod.buildSemiTrailer(THREE, "40ft");
      const hasFeature = typeof tr.setBrakeLights === "function" && typeof tr.detachContainer === "function";
      tr.dispose();
      if (!hasFeature) return { ok: false, reason: "trailer_models.js missing setBrakeLights / detachContainer (M2)" };
      return r;
    },
    async ({ mod }) => {
      const THREE = await getThree();
      const { mod: cmod } = await tryImportVehicle("container_models.js");
      const tr = mod.buildSemiTrailer(THREE, "40ft");
      const brakeMat = tr.materials?.brakeLampMat ?? tr.root.getObjectByName("trailer-brake-lamps")?.material ?? tr.root.getObjectByName("trailer-lamps")?.material;
      assert(brakeMat, "trailer brake lamp material missing");
      const offIntensity = brakeMat.emissiveIntensity;
      tr.setBrakeLights(true);
      const onIntensity = brakeMat.emissiveIntensity;
      assert(onIntensity > offIntensity, `brake lights must increase emissiveIntensity (${onIntensity} <= ${offIntensity})`);
      tr.setBrakeLights(false);
      near(brakeMat.emissiveIntensity, offIntensity, 1e-4, "brake lights restored");

      const c = cmod.buildIsoContainer(THREE, cmod.CONTAINER_WCID.IsoContainer40);
      tr.attachContainer(c);
      assert(tr.containerMount.children.length === 1, "container mounted");
      tr.detachContainer();
      assert(tr.containerMount.children.length === 0, "detachContainer cleared containerMount");
      tr.dispose();
    }
  );

  // ---------------------------------------------------------------------------
  // F4: Articulated Kinematics (±72°), Ground Parity & towMassMul
  // ---------------------------------------------------------------------------

  const probeKinematics = async () => {
    const r = await tryImportVehicle("trailer_kinematics.js");
    if (!r.ok) return r;
    if (typeof r.mod.stepCoupledTrailer !== "function") {
      return { ok: false, reason: "trailer_kinematics.js missing stepCoupledTrailer export" };
    }
    return r;
  };

  await collector.checkFeature("T1.F4.01", 1, "F4:Kinematics_Ground", probeKinematics, ({ mod }) => {
    assert(mod.TRAILER_PHYSICS_SPECS, "TRAILER_PHYSICS_SPECS missing");
    near(mod.MAX_JACKKNIFE_RAD, SEMI_SPEC.maxJackknifeRad, 1e-6, "MAX_JACKKNIFE_RAD");
    for (const k of ["20ft", "40ft"]) {
      const s = mod.TRAILER_PHYSICS_SPECS[k];
      const e = SEMI_SPEC.trailers[k];
      near(s.kpY, e.kpY, 1e-5, `${k} kpY`);
      near(s.bogieY, e.bogieY, 1e-5, `${k} bogieY`);
      near(s.wheelbase, e.wheelbase, 1e-5, `${k} wheelbase`);
      near(s.deckZ, e.deckZ, 1e-5, `${k} deckZ`);
    }
  });

  await collector.checkFeature("T1.F4.02", 1, "F4:Kinematics_Ground", probeKinematics, ({ mod }) => {
    const spec = mod.TRAILER_PHYSICS_SPECS["40ft"];
    const oracle = () => 10;
    let tractor = { x: 0, y: 0, z: 10, heading: 0, speed: 15, yawRate: 0 };
    let tr = { heading: (15 * Math.PI) / 180 };
    let trRef = { heading: (15 * Math.PI) / 180 };
    const dt = 1 / 30;
    const initDiff = Math.abs(wrapPi(tractor.heading - tr.heading));
    for (let i = 0; i < 60; i++) {
      tr = mod.stepCoupledTrailer(tractor, tr, SEMI_SPEC.fifthWheelOffsetY, spec, oracle, dt);
      trRef = oracleStepCoupledTrailer(tractor, trRef, SEMI_SPEC.fifthWheelOffsetY, SEMI_SPEC.trailers["40ft"], oracle, dt);
      tractor = { ...tractor, y: tractor.y + tractor.speed * dt };
    }
    const finalDiff = Math.abs(wrapPi(tractor.heading - tr.heading));
    assert(finalDiff < initDiff * 0.5, `expected straight-pull alignment convergence: ${initDiff} -> ${finalDiff}`);
    near(tr.heading, trRef.heading, 1e-4, "heading matches independent oracle");
    near(tr.x, trRef.x, 1e-3, "x matches independent oracle");
    near(tr.y, trRef.y, 1e-3, "y matches independent oracle");
  });

  await collector.checkFeature("T1.F4.03", 1, "F4:Kinematics_Ground", probeKinematics, ({ mod }) => {
    const spec = mod.TRAILER_PHYSICS_SPECS["20ft"];
    const flatOracle = () => 0;
    const tractorRev = { x: 0, y: 0, z: 0, heading: 0, speed: -4.0, yawRate: 0.25 };
    const resRev = mod.stepCoupledTrailer(tractorRev, { heading: 0 }, SEMI_SPEC.fifthWheelOffsetY, spec, flatOracle, 1 / 30);
    assert(Number.isFinite(resRev.heading) && Math.abs(wrapPi(resRev.heading)) > 0, "reverse steer must articulate trailer");

    // Sloped terrain: hitch at z=1, bogie higher at z=2 -> nose-down negative pitch
    const slopeOracle = (_x, y) => (y < -4.0 ? 2.0 : 1.0);
    const resPitch = mod.stepCoupledTrailer({ x: 0, y: 0, z: 1, heading: 0, speed: 0, yawRate: 0 }, { heading: 0 }, SEMI_SPEC.fifthWheelOffsetY, spec, slopeOracle, 1 / 30);
    assert(Number.isFinite(resPitch.pitch) && resPitch.pitch < -0.1, `expected negative nose-down pitch when bogie is elevated, got ${resPitch.pitch}`);
  });

  await collector.checkFeature("T1.F4.04", 1, "F4:Kinematics_Ground", probeKinematics, ({ mod }) => {
    assert(typeof mod.computeMountedContainerPose === "function", "computeMountedContainerPose missing");
    const trailerPose = { x: 100, y: 200, z: 10, heading: Math.PI / 2, pitch: 0, bank: 0 };
    for (const slot of ["front", "rear", "center"]) {
      const got = mod.computeMountedContainerPose(trailerPose, "40ft", 6.058, slot);
      const exp = oracleComputeMountedContainerPose(trailerPose, "40ft", 6.058, slot);
      near(got.x, exp.x, 1e-4, `slot=${slot} x`);
      near(got.y, exp.y, 1e-4, `slot=${slot} y`);
      near(got.z, exp.z, 1e-4, `slot=${slot} z`);
    }
  });

  await collector.runCheck("T1.F4.05", 1, "F4:Kinematics_Ground", async () => {
    // Willys MB golden parity non-regression
    const { mod: gm } = await tryImportVehicle("ground_model.js");
    const goldenPath = path.join(GROUND_DOCS_DIR, "ground-golden.json");
    const genPath = path.join(GROUND_DOCS_DIR, "gen_golden.mjs");
    assert(existsSync(goldenPath) && existsSync(genPath), "ground-golden.json / gen_golden.mjs missing");
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const gen = await import(pathToFileURL(genPath).href);
    const seq = golden.sequences.find((s) => s.name === "road-sprint");
    const st = { ...seq.initial };
    const oracle = gen.getOracle(seq.name);
    let ci = 0;
    seq.frames.forEach((f, i) => {
      gm.step(st, gm.inputFromFrame(f), golden.params, oracle, golden.dt);
      const cp = seq.checkpoints[ci];
      if (cp && cp.step === i + 1) {
        const d = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
        assert(d < 0.001, `Willys MB golden diverged at step ${cp.step}: ${d} m`);
        ci += 1;
      }
    });
    assert(ci === seq.checkpoints.length, "verified all Willys MB checkpoints");
  });

  await collector.checkFeature(
    "T1.F4.06",
    1,
    "F4:Kinematics_Ground",
    async () => {
      const r = await tryImportVehicle("ground_model.js");
      if (!r.ok) return r;
      if (typeof r.mod.paramsFromProfile !== "function") {
        return { ok: false, reason: "ground_model.js missing paramsFromProfile export (M2)" };
      }
      return r;
    },
    ({ mod: gm }) => {
      const semiProf = {
        profileKey: "semi-379",
        wheelbase: SEMI_SPEC.wheelbase,
        trackWidth: SEMI_SPEC.trackWidth,
        wheelRadius: SEMI_SPEC.wheelRadius,
        maxSteerRad: SEMI_SPEC.maxSteerRad,
        vMax: SEMI_SPEC.vMax,
        reverseMax: SEMI_SPEC.reverseMax,
        accel: SEMI_SPEC.accel,
        decel: SEMI_SPEC.decel,
        climbLimitCos: SEMI_SPEC.climbLimitCos,
        fordDepthMax: SEMI_SPEC.fordDepthMax,
      };
      const p = gm.paramsFromProfile(semiProf);
      near(p.wheelbase, 4.66, 1e-4, "params.wheelbase");
      near(p.vMaxRoad, 27.0, 1e-4, "params.vMaxRoad");
      near(p.vReverseMax, -7.0, 1e-4, "params.vReverseMax");
      near(p.launchAccel, 4.8, 1e-4, "params.launchAccel");
      near(p.normalBrake, 9.5, 1e-4, "params.normalBrake");
      near(p.climbLimitCos, 0.788, 1e-4, "params.climbLimitCos");
      near(p.fordDepthMax, 1.05, 1e-4, "params.fordDepthMax");

      // Step to road terminal speed and verify scaling (27.0, not 29.0) + 0x10/0x20 flags
      const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
      const roadOracle = () => ({ z: 0, normal: [0, 0, 1], surface: gm.SURFACE_FAMILIES[0], waterDepth: 0 });
      for (let i = 0; i < 450; i++) {
        gm.step(st, { throttle: 1.0, steer: 0, headlights: true, horn: true }, p, roadOracle, gm.DT);
      }
      near(st.speed, 27.0, 0.15, "semi road terminal speed");
      assert((st.groundFlags & 0x10) !== 0, "groundFlags 0x10 (headlights) missing");
      assert((st.groundFlags & 0x20) !== 0, "groundFlags 0x20 (horn) missing");
    }
  );

  // ---------------------------------------------------------------------------
  // F5: Twistlocks, Container Mounting, Door Lock & Colliders
  // ---------------------------------------------------------------------------

  await collector.runCheck("T1.F5.01", 1, "F5:Containers_Twistlocks", async () => {
    const THREE = await getThree();
    const { mod } = await tryImportVehicle("container_models.js");
    for (const [kind, wcid, expH] of [["20ft", 4000020, 2.591], ["40ft", 4000021, 2.591], ["40hc", 4000022, 2.896]]) {
      const c = mod.buildIsoContainer(THREE, wcid);
      let meshes = 0, lights = 0;
      c.root.traverse((o) => { if (o.isMesh) meshes++; if (o.isLight) lights++; });
      assert(lights === 0, `${kind} container must have 0 lights`);
      assert(meshes <= 12, `${kind} container mesh count ${meshes} reasonable`);
      near(c.spec.external.height, expH, 1e-3, `${kind} container height`);
      c.dispose();
    }
    const hcSpec = mod.ISO_CONTAINER_SPECS[4000022];
    assert(hcSpec.hasGooseneckTunnel, "40HC must have gooseneck tunnel");
    near(hcSpec.gooseneckTunnel.height, 0.120, 1e-4, "40HC tunnel height");
  });

  await collector.runCheck("T1.F5.02", 1, "F5:Containers_Twistlocks", async () => {
    const THREE = await getThree();
    const { mod } = await tryImportVehicle("trailer_models.js");
    for (const [kind, count] of [["20ft", 4], ["40ft", 8]]) {
      const tr = mod.buildSemiTrailer(THREE, kind, { twistlockState: mod.TWISTLOCK_STATE.Unlocked });
      assert(tr.twistlockPivots.length === count, `${kind} twistlock count`);
      assert(tr.twistlockPivots[0].rotation.z === 0, "unlocked rotation 0");
      tr.setTwistlockState(mod.TWISTLOCK_STATE.Locked);
      near(tr.twistlockPivots[0].rotation.z, Math.PI / 2, 1e-6, "locked rotation pi/2");
      tr.dispose();
    }
  });

  await collector.runCheck("T1.F5.03", 1, "F5:Containers_Twistlocks", async () => {
    const THREE = await getThree();
    const { mod: tmod } = await tryImportVehicle("trailer_models.js");
    const { mod: cmod } = await tryImportVehicle("container_models.js");
    const tr20 = tmod.buildSemiTrailer(THREE, "20ft");
    const c20 = cmod.buildIsoContainer(THREE, 4000020);
    tr20.attachContainer(c20);
    near(c20.root.position.y, 0, 1e-5, "20ft on 20ft y=0");
    tr20.dispose();

    const tr40 = tmod.buildSemiTrailer(THREE, "40ft");
    const c20f = cmod.buildIsoContainer(THREE, 4000020);
    tr40.attachContainer(c20f, { position: "front" });
    near(c20f.root.position.y, 2.9295, 1e-4, "20ft on 40ft front");
    tr40.attachContainer(c20f, { position: "rear" });
    near(c20f.root.position.y, -2.9295, 1e-4, "20ft on 40ft rear");
    tr40.attachContainer(c20f, { position: "center" });
    near(c20f.root.position.y, 0, 1e-4, "20ft on 40ft center");
    tr40.dispose();
  });

  await collector.checkFeature(
    "T1.F5.04",
    1,
    "F5:Containers_Twistlocks",
    async () => {
      const env = await makeSemiLiveEnv();
      const ok = Boolean(env.api?.trailers);
      env.dispose();
      if (!ok) return { ok: false, reason: "index.js missing window.__vehicles.trailers API (M3)" };
      return { ok: true };
    },
    async () => {
      const env = await makeSemiLiveEnv();
      const cl = toCellLocal(2000, 3000, 10);
      env.inbox.push(
        {
          type: "trailer_state",
          trailerGuid: 0x80099101,
          kind: DEPLOYABLE_KIND.TrailerChassis40,
          cell: cl.cell,
          position: [cl.x, cl.y, cl.z],
          heading: 0.4,
          pitch: 0,
          bank: 0,
          coupledTractorGuid: 0,
          mountedContainerGuid: 0x80099201,
          containerSlot: 0,
          trailerFlags: TRAILER_FLAGS.TwistlocksLocked,
          ownerGuid: 1001,
        },
        {
          type: "container_state",
          containerGuid: 0x80099201,
          containerKind: DEPLOYABLE_KIND.IsoContainer40HC,
          doorState: 0,
          liveryId: 1,
          maxFullSlots: 21,
          flags: 0,
          ownerGuid: 1001,
          cell: cl.cell,
          position: [cl.x, cl.y, cl.z + 1.32],
          heading: 0.4,
          doorProgress: 0,
          serialNumber: 123456,
          slots: [],
        }
      );
      env.api.afterTick?.(1, 0.016);
      env.live.vehicles.afterTick(1.016, 0.016);
      const tEntry = env.api.trailers.get(0x80099101);
      assert(tEntry, "trailer entry created in window.__vehicles.trailers");
      const mountedGuid = (tEntry.mountedContainerGuid ?? tEntry.last?.mountedContainerGuid) >>> 0;
      assert(mountedGuid === 0x80099201, `expected tEntry mountedContainerGuid 0x80099201, got 0x${mountedGuid.toString(16)}`);
      assert(env.api.containers.get(0x80099201), "mounted container entry present in window.__vehicles.containers");
      assert(env.entityMap.get(0x80099101)._filmHidden === true, "trailer stand-in 0x0200026B hidden");
      env.dispose();
    }
  );

  await collector.checkFeature(
    "T1.F5.05",
    1,
    "F5:Containers_Twistlocks",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/Deployables/SemiTrailerDeployable.cs");
      const c = aceFilePath("Source/ACE.Server/Vehicles/Deployables/IsoContainerDeployable.cs");
      if (!existsSync(p) || !existsSync(c)) {
        return { ok: false, reason: "ACE SemiTrailerDeployable.cs / MountedOnTrailerGuid not landed yet (M4)" };
      }
      return { ok: true, trailerSrc: readFileSync(p, "utf8"), containerSrc: readFileSync(c, "utf8") };
    },
    ({ trailerSrc, containerSrc }) => {
      assert(/TryMountContainer/.test(trailerSrc), "TryMountContainer missing");
      assert(/MountedOnTrailerGuid/.test(containerSrc), "IsoContainerDeployable.MountedOnTrailerGuid missing");
    }
  );

  // ---------------------------------------------------------------------------
  // F6: Server Hitching Validation, Despawn Safety & @vehicle/@trailer Commands
  // ---------------------------------------------------------------------------

  await collector.checkFeature(
    "T1.F6.01",
    1,
    "F6:Server_Commands",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/VehicleProfile.cs");
      if (!existsSync(p)) return { ok: false, reason: "ACE VehicleProfile.cs not found" };
      const txt = readFileSync(p, "utf8");
      if (!/Semi379/.test(txt)) return { ok: false, reason: "ACE VehicleProfile.Semi379 not landed yet (M4)" };
      return { ok: true, txt };
    },
    ({ txt }) => {
      assert(/semi-379/.test(txt), "semi-379 key missing");
      assert(/Ironhorse 379/.test(txt), "Ironhorse 379 display name missing");
      assert(/0x0200026B/i.test(txt), "StandInSetup 0x0200026B missing");
      assert(/-2\.01f/.test(txt) && /0\.96f/.test(txt), "FifthWheelOffsetY=-2.01 / Z=0.96 missing");
      for (const alias of ["semi", "truck", "tractor", "379"]) {
        assert(new RegExp(`"${alias}"`).test(txt), `ByKey alias "${alias}" missing`);
      }
    }
  );

  await collector.checkFeature(
    "T1.F6.02",
    1,
    "F6:Server_Commands",
    () => {
      const k = aceFilePath("Source/ACE.Server/Vehicles/TrailerKinematics.cs");
      const d = aceFilePath("Source/ACE.Server/Vehicles/Deployables/SemiTrailerDeployable.cs");
      if (!existsSync(k) || !existsSync(d)) {
        return { ok: false, reason: "ACE TrailerKinematics.cs / SemiTrailerDeployable.cs not landed yet (M4)" };
      }
      return { ok: true, kTxt: readFileSync(k, "utf8"), dTxt: readFileSync(d, "utf8") };
    },
    ({ kTxt, dTxt }) => {
      assert(/4000030/.test(dTxt) && /4000031/.test(dTxt), "WCIDs 4000030/4000031 missing");
      assert(/0x0200026B/i.test(dTxt), "SemiTrailerDeployable StandInSetup 0x0200026B missing");
      assert(/CreateTrailerStateMsg/.test(dTxt) && /Location\.Pos/.test(dTxt), "landblock-local Location.Pos missing in CreateTrailerStateMsg");
      assert(/72/.test(kTxt), "72 deg jackknife constant missing in TrailerKinematics.cs");
    }
  );

  await collector.checkFeature(
    "T1.F6.03",
    1,
    "F6:Server_Commands",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/VehicleManager.cs");
      if (!existsSync(p)) return { ok: false, reason: "ACE VehicleManager.cs not found" };
      const txt = readFileSync(p, "utf8");
      const scope = extractCSharpMethodScope(txt, "HandleTrailerAction", /Hitch|Trailer/i);
      if (!scope.combined) {
        return { ok: false, reason: "VehicleManager.HandleTrailerAction method body not landed yet (M4)" };
      }
      return { ok: true, scope: scope.combined };
    },
    ({ scope }) => {
      assert(/\bToGlobal\s*\(/.test(scope), "VehicleManager.HandleTrailerAction must use global coords via ToGlobal");
      assert(/\b3\.5\s*[fFdD]?\b/.test(scope), "3.5 m fifth-wheel proximity check missing in HandleTrailerAction");
      assert(/(?:\b60(?:\.0+)?\s*[fFdD]?\b|Math\.PI\s*\/\s*3(?:\.0+)?|1\.04719)/.test(scope), "60 deg alignment check missing in HandleTrailerAction");
    }
  );

  await collector.checkFeature(
    "T1.F6.04",
    1,
    "F6:Server_Commands",
    () => {
      const p = aceFilePath("Source/ACE.Server/Vehicles/VehicleCommands.cs");
      if (!existsSync(p)) return { ok: false, reason: "ACE VehicleCommands.cs not found" };
      const txt = readFileSync(p, "utf8");
      const attrMatch = txt.match(/\[CommandHandler\("trailer"[\s\S]*?public\s+static\s+\w+\s+(\w+)\s*\(/);
      if (!attrMatch) {
        return { ok: false, reason: "@trailer CommandHandler not landed yet (M4)" };
      }
      const methodName = attrMatch[1];
      const scope = extractCSharpMethods(txt, methodName);
      if (!scope.combined) {
        return { ok: false, reason: `@trailer handler method ${methodName} body missing` };
      }
      return { ok: true, scope: `${attrMatch[0]}\n${scope.combined}` };
    },
    ({ scope }) => {
      for (const sub of ["spawn", "hitch", "unhitch", "mount", "unmount", "twistlock", "preset", "list", "despawn"]) {
        assert(new RegExp(sub).test(scope), `@trailer subcommand "${sub}" missing inside @trailer handler`);
      }
      for (const preset of ["rig20", "rig40", "rig40hc"]) {
        assert(new RegExp(preset).test(scope), `@trailer preset "${preset}" missing inside @trailer handler`);
      }
    }
  );

  await collector.checkLive("T1.F6.05", 1, "F6:Server_Commands", async (live) => {
    await live.cleanupWorld();
    const spawnSemiMsg = await live.sendChatAndWait("@vehicle spawn semi", /Ironhorse 379|spawned/i, 10000);
    assert(/Ironhorse 379/i.test(spawnSemiMsg), `unexpected semi spawn response: ${spawnSemiMsg}`);
    const spawnTrMsg = await live.sendChatAndWait("@trailer spawn 40", /trailer|4000031|spawned/i, 10000);
    assert(spawnTrMsg.length > 0, "trailer spawn response missing");
    const listMsg = await live.sendChatAndWait("@trailer list", /40ft|0x/i, 8000);
    assert(/0x/i.test(listMsg), "trailer list missing hex guid");
    await live.cleanupWorld();
  });

  // ---------------------------------------------------------------------------
  // F7: Client Integration, Controls, Camera, Audio, OSD, Dual-Stack FX, Seat Poses
  // ---------------------------------------------------------------------------

  await collector.checkFeature(
    "T1.F7.01",
    1,
    "F7:Client_UX",
    async () => {
      const env = await makeSemiLiveEnv();
      const ok = Boolean(env.api?.trailers && env.api?.semi);
      env.dispose();
      if (!ok) return { ok: false, reason: "index.js missing window.__vehicles.trailers / .semi (M3)" };
      return { ok: true };
    },
    async () => {
      const env = await makeSemiLiveEnv();
      const cl = toCellLocal(1000, 2000, 10);
      env.inbox.push(
        { type: "ack", granted: 3 },
        {
          type: "profile",
          vehicle: 0x80099001,
          profileKey: "semi-379",
          displayName: "Ironhorse 379",
          locomotion: 2,
          vehicleClass: 3,
          liveryId: 2,
          vMax: 27.0,
          accel: 4.8,
          decel: 9.5,
          wheelbase: 4.66,
          trackWidth: 2.12,
          wheelRadius: 0.505,
          maxSteerRad: SEMI_SPEC.maxSteerRad,
          reverseMax: -7.0,
          climbLimitCos: 0.788,
          fordDepthMax: 1.05,
          fifthWheelOffsetY: -2.01,
          fifthWheelOffsetZ: 0.96,
          seats: SEMI_SPEC.seats.map((offset) => ({ offset })),
        },
        {
          type: "state",
          vehicle: 0x80099001,
          flags: 1,
          step: 1,
          mode: 6,
          cell: cl.cell,
          x: cl.x,
          y: cl.y,
          z: cl.z,
          heading: 0,
          speed: 5,
        }
      );
      env.live.vehicles.afterTick(1.0, 0.016);
      const gmModel = env.api.groundModels.get(0x80099001);
      assert(gmModel, "groundModel built for semi-379");
      assert(typeof gmModel.getFifthWheelWorldAnchor === "function", "built model must be semi-379 (not Jeep)");
      assert(env.entityMap.get(0x80099001)._filmHidden === true, "tractor stand-in 0x0200026B hidden");
      env.dispose();
    }
  );

  await collector.checkFeature(
    "T1.F7.02",
    1,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("camera_rig.js");
      if (!r.ok) return r;
      if (!r.mod.DEFAULT_SEMI_CHASE || !r.mod.SEMI_CAB_EYES || !r.mod.SEMI_HOOD_EYE) {
        return { ok: false, reason: "camera_rig.js missing DEFAULT_SEMI_CHASE / SEMI_CAB_EYES / SEMI_HOOD_EYE (M3)" };
      }
      return r;
    },
    ({ mod }) => {
      near(mod.DEFAULT_SEMI_CHASE.back, SEMI_SPEC.camera.chaseBack, 0.2, "DEFAULT_SEMI_CHASE.back");
      near(mod.DEFAULT_SEMI_CHASE.up, SEMI_SPEC.camera.chaseUp, 0.2, "DEFAULT_SEMI_CHASE.up");
      near(mod.DEFAULT_SEMI_CHASE.fov, SEMI_SPEC.camera.chaseFov, 1.0, "DEFAULT_SEMI_CHASE.fov");
      near(mod.SEMI_CAB_EYES[0].right, SEMI_SPEC.camera.cabEyes[0][0], 0.05, "SEMI_CAB_EYES driver right");
      near(mod.SEMI_CAB_EYES[0].forward, SEMI_SPEC.camera.cabEyes[0][1], 0.05, "SEMI_CAB_EYES driver forward");
      near(mod.SEMI_CAB_EYES[0].up, SEMI_SPEC.camera.cabEyes[0][2], 0.05, "SEMI_CAB_EYES driver up");
      near(mod.SEMI_HOOD_EYE.forward, SEMI_SPEC.camera.hoodEye[1], 0.05, "SEMI_HOOD_EYE forward");
      near(mod.SEMI_HOOD_EYE.up, SEMI_SPEC.camera.hoodEye[2], 0.05, "SEMI_HOOD_EYE up");
      const rig40 = mod.createPilotCameraRig({ locomotion: 2, vehicleClass: 3, profileKey: "semi-379", hitchedTrailerKind: "40ft", ground: () => 0 });
      rig40.setView("chase");
      const out40 = rig40.step({
        pose: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0 },
        params: { locomotion: 2, vehicleClass: 3, profileKey: "semi-379", hitchedTrailerKind: "40ft" },
        dt: 1 / 60,
      });
      assert(out40.cam.pos[1] <= -20.0, `40ft towed camera should zoom back ~22.5m, got y=${out40.cam.pos[1]}`);
    }
  );

  await collector.checkFeature(
    "T1.F7.03",
    1,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("audio.js");
      if (!r.ok) return r;
      if (typeof r.mod.computeDieselI6EngineParams !== "function") {
        return { ok: false, reason: "audio.js missing computeDieselI6EngineParams (M3)" };
      }
      return r;
    },
    ({ mod }) => {
      const pIdle = mod.computeDieselI6EngineParams({ speed: 0, throttle: 0 });
      const pPull = mod.computeDieselI6EngineParams({ speed: 20, throttle: 1.0 });
      const idleRumble = pIdle.rumbleHz ?? pIdle.fundamentalHz;
      const pullRumble = pPull.rumbleHz ?? pPull.fundamentalHz;
      assert(Number.isFinite(idleRumble) && idleRumble >= 20 && idleRumble <= 35, `idle rumble ${idleRumble} Hz`);
      assert(Number.isFinite(pullRumble) && pullRumble > idleRumble && pullRumble <= 90, `pull rumble ${pullRumble} Hz`);
      assert(Number.isFinite(pIdle.firingHz) && pIdle.firingHz > 20, `idle firingHz ${pIdle.firingHz} Hz`);
      assert(Number.isFinite(pPull.firingHz) && pPull.firingHz > pIdle.firingHz, `pull firingHz ${pPull.firingHz} Hz`);
      assert(pPull.turboGain > pIdle.turboGain, "turbo spool must rise under load");
    }
  );

  await collector.checkFeature(
    "T1.F7.04",
    1,
    "F7:Client_UX",
    async () => {
      const r = await tryImportVehicle("controls.js");
      if (!r.ok) return r;
      const src = readFileSync(r.path, "utf8");
      if (!/semi-379|vehicleClass\s*===\s*3|trailerHitch/.test(src)) {
        return { ok: false, reason: "controls.js missing semi-379 KeyG trailerHitch dispatch (M3)" };
      }
      return r;
    },
    ({ mod }) => {
      const events = [];
      const win = makeFakeControlsWin();
      const ctrlSemi = mod.createVehicleControls({ window: win, locomotion: 2, vehicleClass: 3, profileKey: "semi-379", seatIndex: 0 });
      ctrlSemi.onAction((a) => events.push(a));
      ctrlSemi.lock();
      try {
        win.dispatchKey("KeyG", "keydown");
        win.dispatchKey("KeyG", "keyup");
      } finally {
        ctrlSemi.restore();
        ctrlSemi.dispose();
      }
      assert(events.some((e) => e.type === "trailerHitch" || e.type === "hitch"), `semi-379 KeyG should emit trailerHitch action, got ${JSON.stringify(events)}`);
    }
  );

  await collector.checkFeature(
    "T1.F7.05",
    1,
    "F7:Client_UX",
    async () => {
      const osd = await tryImportVehicle("osd.js");
      const gfx = await tryImportVehicle("ground_fx.js");
      const sp = await tryImportVehicle("seat_poses.js");
      if (!osd.ok || !gfx.ok || !sp.ok) return { ok: false, reason: "OSD/ground_fx/seat_poses import failed" };
      const osdSrc = readFileSync(osd.path, "utf8");
      const gfxSrc = readFileSync(gfx.path, "utf8");
      const spSrc = readFileSync(sp.path, "utf8");
      if (!/semi|TRAILER|HITCH/i.test(osdSrc) || !/semi-379|3\.72/.test(gfxSrc) || !/semi|1\.98|0\.76/.test(spSrc)) {
        return { ok: false, reason: "osd.js / ground_fx.js / seat_poses.js semi-379 UX updates not landed yet (M3)" };
      }
      return { ok: true, osd: osd.mod, gfx: gfx.mod, sp: sp.mod };
    },
    ({ osd }) => {
      const byId = new Map();
      const mk = (tag) => {
        const n = { tag, children: [], style: {}, id: "", textContent: "", setAttribute() {}, appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; }, remove() {} };
        return n;
      };
      const doc = { head: mk("head"), body: mk("body"), createElement: mk, getElementById: (id) => byId.get(id) ?? null };
      const hud = osd.createVehicleOsd({ document: doc });
      hud.update({
        locomotion: 2,
        vehicleClass: 3,
        profileKey: "semi-379",
        name: "Ironhorse 379",
        speed: 18.0,
        hitchedTrailerGuid: 0x80099101,
        trailerFlags: TRAILER_FLAGS.Coupled | TRAILER_FLAGS.TwistlocksLocked,
        trailerArticulationRad: 0.22,
      });
      const el = doc.getElementById(osd.OSD_ID);
      assert(el && el.style.display === "block", "semi OSD display must be block after update");
      assert(el.textContent.length > 0, "semi OSD populated");
      assert(!/NaN|undefined/.test(el.textContent), `NaN/undefined in semi OSD: ${el.textContent}`);
      hud.dispose();
    }
  );
}
