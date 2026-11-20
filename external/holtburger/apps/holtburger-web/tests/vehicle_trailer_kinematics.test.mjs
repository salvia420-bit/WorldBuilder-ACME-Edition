// tests/vehicle_trailer_kinematics.test.mjs — 30 Hz Articulated Fifth-Wheel Trailer Kinematics & GroundModel Parity
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_trailer_kinematics.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as TK from "../scene3d/vehicle/trailer_kinematics.js";
import * as GM from "../scene3d/vehicle/ground_model.js";
import { orientation, rotate } from "../scene3d/vehicle/flight_model.js";
import { getOracle } from "../docs/vehicles-2026-11-01/ground/gen_golden.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, "..");
const GOLDEN_PATH = join(APP_ROOT, "docs/vehicles-2026-11-01/ground/ground-golden.json");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

function near(a, b, eps = 1e-4, msg = "near") {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a}`);
  }
}

const deg = (d) => (d * Math.PI) / 180.0;

const SEMI_379_PROFILE_CAMEL = {
  profileKey: "semi-379",
  displayName: "Ironhorse 379",
  locomotion: 2,
  vehicleClass: 3,
  liveryId: 0,
  wheelbase: 4.66,
  trackWidth: 2.12,
  wheelRadius: 0.505,
  maxSteerRad: deg(38.0),
  yawRate: 5.2,
  vMax: 27.0,
  reverseMax: -7.0,
  accel: 4.8,
  decel: 9.5,
  climbLimitCos: 0.788,
  fordDepthMax: 1.05,
  fifthWheelOffsetY: -2.01,
  fifthWheelOffsetZ: 0.96,
};

const SEMI_379_PROFILE_PASCAL = {
  Key: "semi-379",
  Locomotion: 2,
  VehicleClass: 3,
  LiveryId: 2,
  Wheelbase: 4.66,
  TrackWidth: 2.12,
  WheelRadius: 0.505,
  MaxSteerRad: deg(38.0),
  YawRate: 5.2,
  VMax: 27.0,
  ReverseMax: -7.0,
  Accel: 4.8,
  Decel: 9.5,
  ClimbLimitCos: 0.788,
  FordDepthMax: 1.05,
  FifthWheelOffsetY: -2.01,
  FifthWheelOffsetZ: 0.96,
};

const JEEP_MB_PROFILE = {
  profileKey: "jeep-mb",
  locomotion: 2,
  wheelbase: 2.04,
  trackWidth: 1.48,
  wheelRadius: 0.38,
  maxSteerRad: deg(40.0),
  yawRate: 5.2,
  vMax: 29.0,
  reverseMax: -10.0,
  accel: 11.2,
  decel: 14.0,
  climbLimitCos: 0.71934,
  fordDepthMax: 0.8,
};

console.log("=== Trailer Kinematics & GroundModel Parity Suite ===");

// 1. Specs & wrapPi
check("TRAILER_PHYSICS_SPECS & MAX_JACKKNIFE_RAD constants", () => {
  const s20 = TK.TRAILER_PHYSICS_SPECS["20ft"];
  const s40 = TK.TRAILER_PHYSICS_SPECS["40ft"];
  near(s20.kpY, 2.80, 1e-9, "20ft kpY");
  near(s20.bogieY, -1.895, 1e-9, "20ft bogieY");
  near(s20.wheelbase, 4.695, 1e-9, "20ft wheelbase");
  near(s20.kpY - s20.bogieY, s20.wheelbase, 1e-9, "20ft kpY - bogieY");
  near(s20.deckZ, 1.32, 1e-9, "20ft deckZ");
  near(s20.kingpinZ, 0.96, 1e-9, "20ft kingpinZ");

  near(s40.kpY, 5.35, 1e-9, "40ft kpY");
  near(s40.bogieY, -4.445, 1e-9, "40ft bogieY");
  near(s40.wheelbase, 9.795, 1e-9, "40ft wheelbase");
  near(s40.kpY - s40.bogieY, s40.wheelbase, 1e-9, "40ft kpY - bogieY");
  near(s40.deckZ, 1.32, 1e-9, "40ft deckZ");
  near(s40.kingpinZ, 0.96, 1e-9, "40ft kingpinZ");

  near(TK.MAX_JACKKNIFE_RAD, (72.0 * Math.PI) / 180.0, 1e-12, "MAX_JACKKNIFE_RAD");
  assert.equal(TK.resolveTrailerSpec(4000031), s40);
  assert.equal(TK.resolveTrailerSpec(14), s40);
  assert.equal(TK.resolveTrailerSpec("40ft"), s40);
  assert.equal(TK.resolveTrailerSpec(4000030), s20);
  assert.equal(TK.resolveTrailerSpec(13), s20);
});

check("wrapPi wraps angles across [-pi, pi]", () => {
  near(TK.wrapPi(0), 0, 1e-12);
  near(Math.abs(TK.wrapPi(Math.PI)), Math.PI, 1e-12);
  near(Math.abs(TK.wrapPi(-Math.PI)), Math.PI, 1e-12);
  near(TK.wrapPi(1.5 * Math.PI), -0.5 * Math.PI, 1e-12);
  near(TK.wrapPi(-1.5 * Math.PI), 0.5 * Math.PI, 1e-12);
  near(TK.wrapPi(2.0 * Math.PI), 0, 1e-12);
  near(TK.wrapPi(-2.0 * Math.PI), 0, 1e-12);
});

// 2. Forward Alignment Convergence (30 Hz)
for (const kind of ["20ft", "40ft"]) {
  for (const initAngleDeg of [35, -35]) {
    check(`forward alignment convergence: ${kind} from ${initAngleDeg}°`, () => {
      const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
      const tractor = {
        x: 1000, y: 1000, z: 40, heading: 0, pitch: 0, roll: 0,
        speed: 12.0, steerAngle: 0, mode: GM.MODE.DRIVING,
        wheelbase: semiParams.wheelbase,
      };
      const trailer = { heading: deg(initAngleDeg) };
      const spec = TK.resolveTrailerSpec(kind);
      let prevErr = Math.abs(TK.wrapPi(tractor.heading - trailer.heading));

      for (let step = 0; step < 120; step++) {
        GM.step(tractor, { throttle: 0.7, steer: 0, buttons: 0 }, semiParams, () => 40.0, TK.DT);
        TK.stepCoupledTrailer(tractor, trailer, -2.01, kind, () => 40.0, TK.DT);

        const err = Math.abs(TK.wrapPi(tractor.heading - trailer.heading));
        assert.ok(err <= prevErr + 1e-9, `monotonic convergence step ${step}: ${err} > ${prevErr}`);
        prevErr = err;

        // Fifth-wheel vs kingpin coincidence
        const fw = TK.computeFifthWheelPose(tractor, -2.01, 0.96);
        const kpX = trailer.x + Math.sin(trailer.heading) * spec.kpY;
        const kpY = trailer.y + Math.cos(trailer.heading) * spec.kpY;
        assert.ok(Math.hypot(fw.x - kpX, fw.y - kpY) < 1e-9, "hitch coincidence");
      }

      const finalErr = Math.abs(TK.wrapPi(tractor.heading - trailer.heading));
      const limit = kind === "20ft" ? 0.02 : 0.12;
      assert.ok(finalErr < limit, `${kind} final error ${finalErr} >= ${limit}`);
    });
  }
}

// 3. Steady-State Turn Tracking
check("steady-state right turn tracks smoothly inside tractor radius", () => {
  const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  const tractor = {
    x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0,
    speed: 8.0, steerAngle: 0, mode: GM.MODE.DRIVING,
    wheelbase: semiParams.wheelbase,
  };
  const trailer = { heading: 0 };
  for (let i = 0; i < 300; i++) {
    GM.step(tractor, { throttle: 0.45, steer: 0.5, buttons: 0 }, semiParams, () => 0.0, TK.DT);
    TK.stepCoupledTrailer(tractor, trailer, -2.01, "40ft", () => 0.0, TK.DT);
    assert.ok(Math.abs(trailer.articulationRad) <= TK.MAX_JACKKNIFE_RAD + 1e-12);
    const fw = TK.computeFifthWheelPose(tractor, -2.01, 0.96);
    const kpX = trailer.x + Math.sin(trailer.heading) * TK.TRAILER_PHYSICS_SPECS["40ft"].kpY;
    const kpY = trailer.y + Math.cos(trailer.heading) * TK.TRAILER_PHYSICS_SPECS["40ft"].kpY;
    assert.ok(Math.hypot(fw.x - kpX, fw.y - kpY) < 1e-9);
  }
  // Right turn (steer > 0, forward speed > 0) produces positive articulation angle (tractor ahead of trailer clockwise)
  assert.ok(trailer.articulationRad > 0.05 && trailer.articulationRad < TK.MAX_JACKKNIFE_RAD);
});

// 4. Reverse Steering Articulation from Straight
check("reverse steering articulation from straight (right steer swings rear left, left swings right)", () => {
  const trRight = { heading: 0 };
  const tractorR = {
    x: 0, y: 0, z: 0, heading: 0, pitch: 0,
    speed: -4.0, steerAngle: 0.5, wheelbase: 4.66,
  };
  TK.stepCoupledTrailer(tractorR, trRight, -2.01, "20ft", () => 0.0, TK.DT);
  // Tractor reversing with right steer -> omegaT < 0 -> hitch (-2.01) swings +X -> omegaTr > 0
  assert.ok(trRight.hitchX === 0);
  assert.ok(trRight.heading > 0 && trRight.heading < Math.PI, `right steer reverse heading=${trRight.heading}`);

  const trLeft = { heading: 0 };
  const tractorL = {
    x: 0, y: 0, z: 0, heading: 0, pitch: 0,
    speed: -4.0, steerAngle: -0.5, wheelbase: 4.66,
  };
  TK.stepCoupledTrailer(tractorL, trLeft, -2.01, "20ft", () => 0.0, TK.DT);
  // Left steer reverse -> omegaTr < 0 -> wrapped heading near 2*pi
  assert.ok(trLeft.heading > Math.PI, `left steer reverse heading=${trLeft.heading}`);
});

// 5. ±72° Jackknife Clamp
check("sustained reverse hard steer & direct steps clamp strictly to ±72°", () => {
  const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  for (const steerDir of [1.0, -1.0]) {
    const tractor = {
      x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0,
      speed: -4.0, steerAngle: steerDir * semiParams.maxSteerRad, mode: GM.MODE.DRIVING,
      wheelbase: semiParams.wheelbase,
    };
    const trailer = { heading: 0 };
    for (let i = 0; i < 200; i++) {
      GM.step(tractor, { throttle: -1.0, steer: steerDir, buttons: 0 }, semiParams, () => 0.0, TK.DT);
      TK.stepCoupledTrailer(tractor, trailer, -2.01, "20ft", () => 0.0, TK.DT);
      const rel = Math.abs(TK.wrapPi(tractor.heading - trailer.heading));
      assert.ok(rel <= TK.MAX_JACKKNIFE_RAD + 1e-12, `step ${i} jackknife ${rel} > ${TK.MAX_JACKKNIFE_RAD}`);
      assert.ok(trailer.heading >= 0 && trailer.heading < 2 * Math.PI, "heading in [0, 2pi)");
    }
    near(Math.abs(TK.wrapPi(tractor.heading - trailer.heading)), TK.MAX_JACKKNIFE_RAD, 1e-6, "jackknife saturated at 72°");
  }

  // Direct extreme initial misalignment clamp
  const tOut = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 0, heading: 0, speed: 0 },
    { heading: deg(120) },
    -2.01,
    "40ft",
    null,
    TK.DT,
  );
  near(Math.abs(TK.wrapPi(0 - tOut.heading)), TK.MAX_JACKKNIFE_RAD, 1e-9, "direct clamp at 72°");
});

// 6. Bogie Terrain Pitch & Bank
check("bogie terrain pitch & bank (flat, uphill, crest, lateral slopes, null/NaN fallback)", () => {
  // Flat ground
  const flat = TK.stepCoupledTrailer({ x: 0, y: 0, z: 40, heading: 0, pitch: 0, speed: 0 }, { heading: 0 }, -2.01, "20ft", () => 40.0, TK.DT);
  near(flat.pitch, 0.0, 1e-9, "flat pitch");
  near(flat.bank, 0.0, 1e-9, "flat bank");
  near(flat.z, 40.0, 1e-9, "flat z");

  // 15° uphill ramp along +Y: z(x, y) = 40 + y * tan(15°)
  const slope15 = deg(15);
  const rampOracle = (_x, y) => 40.0 + y * Math.tan(slope15);
  const trRamp = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 40.0, heading: 0, pitch: slope15, speed: 0 },
    { heading: 0 },
    -2.01,
    "20ft",
    rampOracle,
    TK.DT,
  );
  // Note: kpGroundZ at hitchY = -2.01, bogieY_world = -6.705 => kpGroundZ - bogieZ = 4.695 * tan(15°) roughly with cos/sin offset
  assert.ok(trRamp.pitch > deg(12) && trRamp.pitch < deg(18), `ramp pitch ${trRamp.pitch}`);

  // Downhill crest (hitch below bogie) -> negative pitch
  const crestOracle = (_x, y) => (y < -4 ? 42.0 : 40.0);
  const trCrest = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 40.0, heading: 0, pitch: 0, speed: 0 },
    { heading: 0 },
    -2.01,
    "20ft",
    crestOracle,
    TK.DT,
  );
  assert.ok(trCrest.pitch < 0, `crest pitch ${trCrest.pitch} < 0`);

  // Lateral right-down side slope: z = 40 - 0.15 * x => zL > zR => bank > 0
  const trBankR = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 40, heading: 0, pitch: 0, speed: 0 },
    { heading: 0 },
    -2.01,
    "20ft",
    (x) => 40.0 - 0.15 * x,
    TK.DT,
  );
  near(trBankR.bank, Math.atan(0.15), 1e-9, "right-down bank > 0");

  // Lateral left-down side slope: z = 40 + 0.15 * x => bank < 0
  const trBankL = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 40, heading: 0, pitch: 0, speed: 0 },
    { heading: 0 },
    -2.01,
    "20ft",
    (x) => 40.0 + 0.15 * x,
    TK.DT,
  );
  near(trBankL.bank, -Math.atan(0.15), 1e-9, "left-down bank < 0");

  // Null / NaN terrain oracle fallback
  const trNull = TK.stepCoupledTrailer({ x: 0, y: 0, z: 12, heading: 0, pitch: 0, speed: 0 }, { heading: 0 }, -2.01, "40ft", null, TK.DT);
  near(trNull.pitch, 0, 1e-9, "null oracle pitch");
  near(trNull.bank, 0, 1e-9, "null oracle bank");
  const trNaN = TK.stepCoupledTrailer({ x: 0, y: 0, z: 12, heading: 0, pitch: 0, speed: 0 }, { heading: 0 }, -2.01, "40ft", () => NaN, TK.DT);
  near(trNaN.pitch, 0, 1e-9, "NaN oracle pitch");
  near(trNaN.bank, 0, 1e-9, "NaN oracle bank");
});

// 7. computeMountedContainerPose
check("computeMountedContainerPose 20ft/40ft slots & 3D orientation transform", () => {
  const basePose = { x: 100, y: 200, z: 40, heading: 0, pitch: 0, bank: 0 };

  const c20on20 = TK.computeMountedContainerPose(basePose, "20ft", 6.058, "auto");
  near(c20on20.localY, 0, 1e-9);
  near(c20on20.localZ, 1.32, 1e-9);
  near(c20on20.z, 41.32, 1e-9);

  const c40on40 = TK.computeMountedContainerPose(basePose, "40ft", 12.192, "auto");
  near(c40on40.localY, 0, 1e-9);
  near(c40on40.z, 41.32, 1e-9);

  for (const rearSlot of ["auto", 0, "rear", 2]) {
    const c = TK.computeMountedContainerPose(basePose, "40ft", 6.058, rearSlot);
    near(c.localY, -2.9295, 1e-9, `rear slot ${rearSlot}`);
    near(c.y, 200 - 2.9295, 1e-9);
  }
  for (const frontSlot of ["front", 1]) {
    const c = TK.computeMountedContainerPose(basePose, "40ft", 6.058, frontSlot);
    near(c.localY, 2.9295, 1e-9, `front slot ${frontSlot}`);
    near(c.y, 200 + 2.9295, 1e-9);
  }
  const cCenter = TK.computeMountedContainerPose(basePose, "40ft", 6.058, "center");
  near(cCenter.localY, 0, 1e-9);

  // Pitched & yawed trailer transform
  const tiltedPose = { x: 50, y: 80, z: 10, heading: Math.PI / 2, pitch: 0.1, bank: -0.05 };
  const mounted = TK.computeMountedContainerPose(tiltedPose, "40ft", 6.058, "front");
  const q = orientation(tiltedPose.heading, tiltedPose.pitch, tiltedPose.bank);
  const [dx, dy, dz] = rotate(q, [0, 2.9295, 1.32]);
  near(mounted.x, 50 + dx, 1e-9, "rotated x");
  near(mounted.y, 80 + dy, 1e-9, "rotated y");
  near(mounted.z, 10 + dz, 1e-9, "rotated z");
});

// 8. GM.paramsFromProfile Parity
check("GM.paramsFromProfile matches GroundParams.FromProfile (camelCase, PascalCase, jeep-mb, empty)", () => {
  const camel = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  const pascal = GM.paramsFromProfile(SEMI_379_PROFILE_PASCAL);

  for (const p of [camel, pascal]) {
    near(p.wheelbase, 4.66, 1e-6, "wheelbase");
    near(p.trackWidth, 2.12, 1e-6, "trackWidth");
    near(p.wheelRadius, 0.505, 1e-6, "wheelRadius");
    near(p.maxSteerRad, deg(38.0), 1e-6, "maxSteerRad");
    near(p.minSteerRad, deg(12.0), 1e-6, "minSteerRad");
    near(p.steerSlewRateLow, 5.2, 1e-6, "steerSlewRateLow");
    near(p.steerSlewRateHigh, 2.6, 1e-6, "steerSlewRateHigh");
    near(p.steerSpeedLow, 12.0, 1e-6, "steerSpeedLow");
    near(p.steerSpeedHigh, 29.0, 1e-6, "steerSpeedHigh");
    near(p.turnRadiusMin, 2.431, 1e-6, "turnRadiusMin");
    near(p.vMaxRoad, 27.0, 1e-6, "vMaxRoad");
    near(p.vReverseMax, -7.0, 1e-6, "vReverseMax");
    near(p.launchAccel, 4.8, 1e-6, "launchAccel");
    near(p.normalBrake, 9.5, 1e-6, "normalBrake");
    near(p.handbrakeDecel, 22.0, 1e-6, "handbrakeDecel");
    near(p.lowRangeTorqueMul, 1.85, 1e-6, "lowRangeTorqueMul");
    near(p.lowRangeSpeedCap, 15.0, 1e-6, "lowRangeSpeedCap");
    near(p.climbLimitCos, 0.788, 1e-6, "climbLimitCos");
    near(p.floorZ, 0.66417415, 1e-6, "floorZ");
    near(p.fordDepthMax, 1.05, 1e-6, "fordDepthMax");
    near(p.coastLinear, 1.8, 1e-6, "coastLinear");
    near(p.coastQuad, 0.04, 1e-6, "coastQuad");
    near(p.treeGlanceThreshold, 0.65, 1e-6, "treeGlanceThreshold");
    near(p.treeGlanceScrub, 0.25, 1e-6, "treeGlanceScrub");
    near(p.treeYawNudge, 0.05, 1e-6, "treeYawNudge");
    near(p.fifthWheelOffsetY, -2.01, 1e-6, "fifthWheelOffsetY");
    near(p.fifthWheelOffsetZ, 0.96, 1e-6, "fifthWheelOffsetZ");
  }

  for (const emptyIn of [{}, null, undefined, JEEP_MB_PROFILE]) {
    const jp = GM.paramsFromProfile(emptyIn);
    for (const k of Object.keys(GM.PARAMS)) {
      near(jp[k], GM.PARAMS[k], 1e-6, `jeep/default param ${k}`);
    }
  }
});

// 9. vMaxRoad / 29.0 Surface Scaling & towMassMul
check("vMaxRoad / 29.0 per-surface scaling & towMassMul (1.0 / 0.72 / 0.58) + cloneState preservation", () => {
  const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  const roadOracle = () => ({ z: 0, normal: [0, 0, 1], surface: GM.SURFACE_FAMILIES[0] });
  const dirtOracle = () => ({ z: 0, normal: [0, 0, 1], surface: GM.SURFACE_FAMILIES[1] });

  // Road top speed = 27.0
  const stRoad = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  for (let i = 0; i < 900; i++) GM.step(stRoad, { throttle: 1.0, steer: 0, buttons: 0 }, semiParams, roadOracle, GM.DT);
  near(stRoad.speed, 27.0, 1e-3, "semi road vMax");

  // Dirt top speed = 24.4 * (27.0 / 29.0)
  const stDirt = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  for (let i = 0; i < 900; i++) GM.step(stDirt, { throttle: 1.0, steer: 0, buttons: 0 }, semiParams, dirtOracle, GM.DT);
  near(stDirt.speed, 24.4 * (27.0 / 29.0), 1e-3, "semi dirt scaled vMax");

  // towMassMul scaling for initial launch accel & terminal speed via state/input/params
  for (const [mul, source] of [[1.0, "state"], [0.72, "state"], [0.58, "state"], [0.72, "input"], [0.58, "params"]]) {
    const p = source === "params" ? { ...semiParams, towMassMul: mul } : semiParams;
    const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
    if (source === "state") st.towMassMul = mul;
    const inp = source === "input" ? { throttle: 1.0, steer: 0, buttons: 0, towMassMul: mul } : { throttle: 1.0, steer: 0, buttons: 0 };

    GM.step(st, inp, p, roadOracle, GM.DT);
    const a0 = st.speed / GM.DT;
    near(a0, 4.8 * mul, 0.05, `a0 for mul=${mul} (${source})`);

    for (let i = 0; i < 1200; i++) GM.step(st, inp, p, roadOracle, GM.DT);
    near(st.speed, 27.0 * mul, 1e-2, `terminal speed for mul=${mul} (${source})`);
  }

  // cloneState preserves towMassMul when set, omits key when undefined
  const plain = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, speed: 0, mode: 0 };
  const clonedPlain = GM.cloneState(plain);
  assert.equal("towMassMul" in clonedPlain, false, "plain cloneState omits towMassMul key");
  const towed = { ...plain, towMassMul: 0.58 };
  const clonedTowed = GM.cloneState(towed);
  near(clonedTowed.towMassMul, 0.58, 1e-12, "clonedState preserves towMassMul");
});

// 10. groundFlags Parity & jeep-mb Golden Parity
check("groundFlags 0x02 reverse braking, 0x10 headlights, 0x20 horn & jeep-mb golden parity", () => {
  const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 10.0, steerAngle: 0, mode: 6 };
  GM.step(st, { throttle: -0.5, steer: 0, buttons: GM.BUTTON.HEADLIGHTS | GM.BUTTON.HORN }, semiParams, null, GM.DT);
  assert.ok((st.groundFlags & 0x01) !== 0, "onGround bit");
  assert.ok((st.groundFlags & 0x02) !== 0, "reverse brake bit");
  assert.ok((st.groundFlags & 0x10) !== 0, "headlights bit");
  assert.ok((st.groundFlags & 0x20) !== 0, "horn bit");

  // Replay all 5 ground-golden.json sequences using GM.paramsFromProfile(JEEP_MB_PROFILE)
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const jeepParams = GM.paramsFromProfile(JEEP_MB_PROFILE);
  for (const seq of golden.sequences) {
    const s = { ...seq.initial };
    const oracle = getOracle(seq.name);
    let ci = 0;
    seq.frames.forEach((fr, idx) => {
      GM.step(s, GM.inputFromFrame(fr), jeepParams, oracle, golden.dt);
      const cp = seq.checkpoints[ci];
      if (cp && cp.step === idx + 1) {
        const dist = Math.hypot(s.x - cp.state.x, s.y - cp.state.y, s.z - cp.state.z);
        assert.ok(dist < 0.001, `${seq.name} step ${cp.step}: dist=${dist}`);
        assert.equal(s.groundFlags, cp.state.groundFlags, `${seq.name} step ${cp.step} groundFlags`);
        ci++;
      }
    });
    assert.equal(ci, seq.checkpoints.length);
  }
});

// 11. Regression: Steep-Slope 3D Kingpin Coincidence & Defensive Input Guards
check("15° and ±35° steep-slope 3D kingpin coincidence (<1e-12 m) & TK/GM input guards", () => {
  // 11a. Steep-slope 3D kingpin coincidence on 15° and ±35° grades
  for (const kind of ["20ft", "40ft"]) {
    const spec = TK.resolveTrailerSpec(kind);
    for (const slopeDeg of [15, 35, -35]) {
      const slope = deg(slopeDeg);
      const rampOracle = (_x, y) => 40.0 + y * Math.tan(slope);
      const tractor = {
        x: 0,
        y: 0,
        z: 40.0,
        heading: 0,
        pitch: slope,
        speed: 0,
      };
      const tr = TK.stepCoupledTrailer(tractor, { heading: 0.2 }, -2.01, kind, rampOracle, TK.DT);
      const qTr = orientation(tr.heading, tr.pitch, tr.bank);
      const [kx, ky, kz] = rotate(qTr, [0, spec.kpY, spec.kingpinZ]);
      const err3D = Math.hypot(
        (tr.x + kx) - tr.hitchX,
        (tr.y + ky) - tr.hitchY,
        (tr.z + kz) - tr.hitchZ,
      );
      assert.ok(err3D < 1e-12, `${kind} slope ${slopeDeg}° 3D kingpin error ${err3D}`);
    }
  }

  // 11b. resolveTrailerSpec({ wheelbase: 0 }) and computeMountedContainerPose(..., null)
  const badSpecOut = TK.stepCoupledTrailer(
    { x: 0, y: 0, z: 0, heading: 0, speed: 5 },
    { heading: 0 },
    -2.01,
    { wheelbase: 0, kpY: 2.8, bogieY: -1.895, kingpinZ: 0.96, deckZ: 1.32 },
    () => 0,
    TK.DT,
  );
  for (const k of ["x", "y", "z", "heading", "pitch", "bank", "bogieX", "bogieY"]) {
    assert.ok(Number.isFinite(badSpecOut[k]), `badSpecOut.${k} must be finite`);
  }
  const nullLenFront = TK.computeMountedContainerPose(
    { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0 },
    "40ft",
    null,
    "front",
  );
  near(nullLenFront.localY, 2.9295, 1e-9, "null containerLength falls back to 6.058m (20ft front slot)");

  // 11c. ground_model.js guards: vMaxRoad: 0, vCruise: 0, TowMassMul, state.towMassMul: 0, surf.vMax: 0
  const gp = GM.paramsFromProfile({
    vMaxRoad: 0,
    vMax: 27,
    vCruise: 0,
    TowMassMul: 0.72,
  });
  near(gp.vMaxRoad, 27, 1e-6, "vMaxRoad: 0 does not shadow vMax: 27");
  near(gp.vCruise, 27 * 0.75, 1e-6, "vCruise: 0 falls back to vMaxRoad * 0.75");
  near(gp.towMassMul, 0.72, 1e-6, "TowMassMul PascalCase supported");

  const stZeroMul = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0, towMassMul: 0 };
  const semiParams = GM.paramsFromProfile(SEMI_379_PROFILE_CAMEL);
  GM.step(stZeroMul, { throttle: 1.0, steer: 0, buttons: 0, towMassMul: 0.58 }, semiParams, () => 0, GM.DT);
  near(stZeroMul.speed / GM.DT, 4.8 * 0.58, 0.05, "state.towMassMul: 0 falls through to input.towMassMul");

  const stZeroSurf = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: -1.0, steerAngle: 0, mode: 6 };
  GM.step(
    stZeroSurf,
    { throttle: 1.0, steer: 0, buttons: 0 },
    semiParams,
    () => ({ z: 0, normal: [0, 0, 1], surface: { id: 9, name: "Bad", vMax: 0, mu: 0 } }),
    GM.DT,
  );
  assert.ok(Number.isFinite(stZeroSurf.speed), "surf.vMax=0 falls back to SURFACE_FAMILIES[0] without NaN");
});

// 12. Regression: Extreme dt Sanitization, Large-dt Jackknife Sign Preservation & 3D bogieZ Slope Consistency
check("extreme dt (NaN, Infinity, -0.1, 0, 2.0) & 3D bogieZ consistency on 15° and ±35° slopes", () => {
  // 12a. dt = NaN, Infinity, -0.1, 0 all produce finite, non-negative-time-integrated poses matching dt = 0
  const tsTurning = { x: 100, y: 100, z: 0, heading: 0.5, pitch: 0, speed: 20, wheelbase: 4.66, steerAngle: 0.5 };
  const refZero = TK.stepCoupledTrailer(tsTurning, { heading: 0.5 }, -2.01, "20ft", () => 0.0, 0.0);
  const poseKeys = [
    "x", "y", "z", "heading", "pitch", "bank", "roll",
    "articulationRad", "hitchX", "hitchY", "hitchZ", "bogieX", "bogieY", "bogieZ",
  ];
  for (const k of poseKeys) {
    assert.ok(Number.isFinite(refZero[k]), `dt=0 ${k} must be finite`);
  }
  near(refZero.heading, 0.5, 1e-12, "dt=0 preserves heading");
  near(refZero.articulationRad, 0.0, 1e-12, "dt=0 preserves articulationRad");

  for (const badDt of [NaN, Infinity, -Infinity, -0.1]) {
    const out = TK.stepCoupledTrailer(tsTurning, { heading: 0.5 }, -2.01, "20ft", () => 0.0, badDt);
    for (const k of poseKeys) {
      assert.ok(Number.isFinite(out[k]), `dt=${badDt} ${k} must be finite`);
      near(out[k], refZero[k], 1e-12, `dt=${badDt} ${k} matches dt=0`);
    }
  }

  // 12b. Large dt = 2.0 during fast turn preserves +72° (and -72° for left turn) without wrapPi aliasing
  const tsFastRight = { x: 100, y: 100, z: 0, heading: 0, pitch: 0, speed: 27, wheelbase: 4.66, steerAngle: 0.66 };
  const fastRight = TK.stepCoupledTrailer(tsFastRight, { heading: 0 }, -2.01, "20ft", () => 0.0, 2.0);
  near(fastRight.articulationRad, TK.MAX_JACKKNIFE_RAD, 1e-12, "dt=2.0 fast right turn clamps to +72°");
  near(fastRight.heading, 2.0 * Math.PI - TK.MAX_JACKKNIFE_RAD, 1e-12, "dt=2.0 fast right turn heading");

  const tsFastLeft = { x: 100, y: 100, z: 0, heading: 0, pitch: 0, speed: 27, wheelbase: 4.66, steerAngle: -0.66 };
  const fastLeft = TK.stepCoupledTrailer(tsFastLeft, { heading: 0 }, -2.01, "20ft", () => 0.0, 2.0);
  near(fastLeft.articulationRad, -TK.MAX_JACKKNIFE_RAD, 1e-12, "dt=2.0 fast left turn clamps to -72°");
  near(fastLeft.heading, TK.MAX_JACKKNIFE_RAD, 1e-12, "dt=2.0 fast left turn heading");

  // 12c. 3D bogie (bogieX, bogieY, bogieZ) === (x, y, z) + rotate(qTr, [0, spec.bogieY, 0]) on 0°, 15°, ±35° slopes
  for (const kind of ["20ft", "40ft"]) {
    const spec = TK.resolveTrailerSpec(kind);
    for (const slopeDeg of [0, 15, 35, -35]) {
      const slope = deg(slopeDeg);
      const rampOracle = (_x, y) => 40.0 + y * Math.tan(slope);
      const tr = TK.stepCoupledTrailer(
        { x: 0, y: 0, z: 40.0, heading: 0, pitch: slope, speed: 0 },
        { heading: slopeDeg === 0 ? 0 : 0.2 },
        -2.01,
        kind,
        rampOracle,
        TK.DT,
      );
      const qTr = orientation(tr.heading, tr.pitch, tr.bank);
      const [bgOffX, bgOffY, bgOffZ] = rotate(qTr, [0.0, spec.bogieY, 0.0]);
      near(tr.bogieX, tr.x + bgOffX, 1e-12, `${kind} slope ${slopeDeg}° bogieX`);
      near(tr.bogieY, tr.y + bgOffY, 1e-12, `${kind} slope ${slopeDeg}° bogieY`);
      near(tr.bogieZ, tr.z + bgOffZ, 1e-12, `${kind} slope ${slopeDeg}° bogieZ === zTr + bgOffZ`);
      if (slopeDeg === 0) {
        near(tr.bogieZ, tr.z, 1e-12, `${kind} flat bogieZ === zTr`);
      }
    }
  }
});

// 13. Adversarial (Finding 8): wrapPi(NaN/Infinity) and hitchOffsetY=NaN sanitization
check("Adversarial (Finding 8): wrapPi(NaN/Infinity) returns finite 0 and hitchOffsetY=NaN falls back to -2.01", () => {
  assert.ok(Number.isFinite(TK.wrapPi(NaN)) && TK.wrapPi(NaN) === 0.0, "wrapPi(NaN) === 0.0");
  assert.ok(Number.isFinite(TK.wrapPi(Infinity)) && TK.wrapPi(Infinity) === 0.0, "wrapPi(Infinity) === 0.0");
  assert.ok(Number.isFinite(TK.wrapPi(-Infinity)) && TK.wrapPi(-Infinity) === 0.0, "wrapPi(-Infinity) === 0.0");

  const tractor = { x: 100, y: 100, z: 0, heading: 0.4, pitch: 0.05, speed: 10 };
  const ref = TK.stepCoupledTrailer(tractor, { heading: 0.1 }, -2.01, "40ft", () => 0, 0.033);
  const bad = TK.stepCoupledTrailer(tractor, { heading: 0.1 }, NaN, "40ft", () => 0, 0.033);
  for (const k of ["x", "y", "z", "heading", "pitch", "bank", "roll", "articulationRad", "hitchX", "hitchY", "hitchZ", "bogieX", "bogieY", "bogieZ"]) {
    assert.ok(Number.isFinite(bad[k]), `bad.${k} must be finite`);
    near(bad[k], ref[k], 1e-12, `hitchOffsetY=NaN ${k} matches -2.01`);
  }

  const fwRef = TK.computeFifthWheelPose(tractor, -2.01, 0.96);
  const fwBad = TK.computeFifthWheelPose(tractor, NaN, NaN);
  near(fwBad.x, fwRef.x, 1e-12, "computeFifthWheelPose NaN hitchOffsetY x");
  near(fwBad.y, fwRef.y, 1e-12, "computeFifthWheelPose NaN hitchOffsetY y");
  near(fwBad.z, fwRef.z, 1e-12, "computeFifthWheelPose NaN fifthWheelOffsetZ z");
});

console.log(`\nvehicle_trailer_kinematics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
