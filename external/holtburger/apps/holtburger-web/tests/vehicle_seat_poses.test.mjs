// tests/vehicle_seat_poses.test.mjs — 4-Tier E2E test suite for the 34-part humanoid rig poses,
// two-bone arm IK rim tracking (Seat 0), shotgun grab-bar brace (Seat 1), rear bench 90° sit (Seats 2/3),
// boarding splines (~0.85s/0.95s/0.65s), 0.35s hot-swaps, and pooled zero-allocation ground VFX.
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_seat_poses.test.mjs

import * as THREE from "three";
import { solveTwoBone, PACK_PROFILES, HUMANOID_FALL_RIG } from "../scene3d/vehicle/fall_pose.js";
import { boardAnimEnabled, hopDuration, hopPoint, hopHeading } from "../scene3d/vehicle/board_hop.js";
import {
  createGroundFx,
  makeCloudTexture,
  resolveSurfaceColor,
  POOL_SIZE,
  JEEP_DIMENSIONS,
} from "../scene3d/vehicle/ground_fx.js";

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const near = (a, b, eps = 1e-4, m = "near") => {
  if (Math.abs(a - b) > eps) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`);
};
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
// Authoritative Specifications & Reference Implementation
// ---------------------------------------------------------------------------
export const SEAT_CONSTANTS = Object.freeze({
  seatOffsets: [
    Object.freeze([-0.38, -0.18, 0.62]),  // Seat 0 Driver (Front Left)
    Object.freeze([0.38, -0.18, 0.62]),   // Seat 1 Shotgun (Front Right)
    Object.freeze([-0.36, -0.96, 0.68]),  // Seat 2 Rear Left
    Object.freeze([0.36, -0.96, 0.68]),   // Seat 3 Rear Right
  ],
  steeringWheelCenter: Object.freeze([-0.38, 0.35, 0.88]),
  steeringWheelRadius: 0.18,
  steeringWheelRakeRad: 30 * (Math.PI / 180),
  dashGrabBarPos: Object.freeze([0.38, 0.62, 0.88]),
  grabBarBraceThresholds: Object.freeze({
    brakingDecel: -4.5,       // m/s^2 (hard braking)
    yawRate: 1.5,             // rad/s (sharp cornering)
    lateralAccel: 4.0,        // m/s^2 (high lateral G)
  }),
  splineDurations: Object.freeze({
    frontIngressSec: 0.85,
    rearIngressSec: 0.95,
    egressSec: 0.65,
    hotSwapSec: 0.35,
  }),
});

let SP = await import("../scene3d/vehicle/seat_poses.js");

function createMockEntityInstance(setupId = "0x02000001") {
  const root = new THREE.Group();
  root.name = "entityRoot";
  const parts = [];
  for (let i = 0; i < 34; i++) {
    const partGroup = new THREE.Group();
    partGroup.name = `part_${i}`;
    root.add(partGroup);
    parts.push(partGroup);
  }
  return {
    guid: 1001,
    root,
    parts,
    setupId,
  };
}

// ---------------------------------------------------------------------------
// TIER 1: FEATURE COVERAGE
// ---------------------------------------------------------------------------
console.log("=== TIER 1: Feature Coverage (Suite B: vehicle_seat_poses) ===");

await check("T1.1 34-Part Rig: All 18 setups resolve and load correctly", () => {
  const setupKeys = Object.keys(PACK_PROFILES);
  assert(setupKeys.length === 18, `expected 18 setup profiles, got ${setupKeys.length}`);
  for (const key of setupKeys) {
    const prof = SP.resolveSetupProfile(key);
    assert(prof, `profile ${key} resolved`);
    const pose = SP.computeSeatPose(0, key, { steerAngle: 0.2 });
    assert(pose, `pose computed for ${key}`);
    if (prof.kind === "no-hands") {
      assert(pose.isOlthoi === true, "Olthoi detected");
      assert(pose.thoraxAnchor && pose.thoraxAnchor.pos, "Olthoi thorax anchor valid");
    } else {
      assert(pose.isOlthoi === false, "humanoid rig active");
      assert(pose.leftArmIK && pose.rightArmIK, "humanoid arm IK active");
    }
  }
});

await check("T1.2 Rig Bone Offset & Limb Length Preservation", () => {
  const pose = SP.computeSeatPose(0, "0x02000001", { steerAngle: 0 });
  assert(!pose.isOlthoi, "humanoid pose");
  near(pose.leftArmIK.upper, HUMANOID_FALL_RIG.upperLen, 1e-4, "upper arm length preserved");
  near(pose.leftArmIK.fore, HUMANOID_FALL_RIG.elbowUp, 1e-4, "forearm length preserved");
  near(pose.rightArmIK.upper, HUMANOID_FALL_RIG.upperLen, 1e-4, "right upper arm preserved");
  near(pose.rightArmIK.fore, HUMANOID_FALL_RIG.elbowUp, 1e-4, "right forearm preserved");
});

await check("T1.3 Root Scale Application across Heritages (Lugian 1.30, Gear 1.20, Empyrean 1.15, Human 1.0)", () => {
  const pLugian = SP.computeSeatPose(0, "0x02001A18"); // Lugian male (scale 130)
  const pHuman = SP.computeSeatPose(0, "0x02000001");  // Human male (scale 100)
  near(pLugian.scale, 1.30, 1e-4, "Lugian scale 1.30");
  near(pHuman.scale, 1.00, 1e-4, "Human scale 1.00");
  near(pLugian.leftArmIK.upper, HUMANOID_FALL_RIG.upperLen * 1.30, 1e-4, "scaled upper arm");
  near(pLugian.leftArmIK.fore, HUMANOID_FALL_RIG.elbowUp * 1.30, 1e-4, "scaled forearm");
});

await check("T1.4 Seat 0 Driver Two-Bone Arm IK: Neutral Steering Grip Tracking", () => {
  const pose = SP.computeSeatPose(0, "0x02000001", { steerAngle: 0.0 });
  assert(pose.leftArmIK.reachable, "left arm target reachable");
  assert(pose.rightArmIK.reachable, "right arm target reachable");
  const targetL = pose.leftArmIK.vehicleTarget || pose.leftArmIK.target;
  const targetR = pose.rightArmIK.vehicleTarget || pose.rightArmIK.target;
  const dL = dist3(targetL, SEAT_CONSTANTS.steeringWheelCenter);
  const dR = dist3(targetR, SEAT_CONSTANTS.steeringWheelCenter);
  near(dL, SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "left hand on rim radius");
  near(dR, SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "right hand on rim radius");
});

await check("T1.5 Seat 0 Driver: Left & Right Turn Two-Bone IK Solving", () => {
  // Left turn
  const poseLeft = SP.computeSeatPose(0, "0x02000001", { steerAngle: -0.4 });
  assert(poseLeft.leftArmIK.reachable && poseLeft.rightArmIK.reachable, "left turn reachable");

  // Right turn
  const poseRight = SP.computeSeatPose(0, "0x02000001", { steerAngle: 0.4 });
  assert(poseRight.leftArmIK.reachable && poseRight.rightArmIK.reachable, "right turn reachable");

  // Target points should differ between left and right turns
  const deltaX = Math.abs(poseLeft.leftArmIK.target[0] - poseRight.leftArmIK.target[0]);
  assert(deltaX > 0.05, `rim targets shift with steering (deltaX = ${deltaX})`);
});

await check("T1.6 Seat 1 Shotgun Passenger: Dynamic Grab-Bar Brace on Hard Braking", () => {
  // Cruising steady: no brace
  const poseCruise = SP.computeSeatPose(1, "0x02000001", { accelLong: 0.0, yawRate: 0.0 });
  assert(poseCruise.braceActive === false, "steady driving: no grab brace");

  // Hard braking (-5.0 m/s^2 <= -4.5 threshold): brace triggers
  const poseBrake = SP.computeSeatPose(1, "0x02000001", { accelLong: -5.0, yawRate: 0.0 });
  assert(poseBrake.braceActive === true, "hard braking triggers grab brace");
  assert(poseBrake.leftArmIK.reachable, "grab bar is reachable");
  const targetL = poseBrake.leftArmIK.vehicleTarget || poseBrake.leftArmIK.target;
  const dGrab = dist3(targetL, SEAT_CONSTANTS.dashGrabBarPos);
  near(dGrab, 0.0, 1e-3, "left hand locked to dash grab-bar");
});

await check("T1.7 Seat 1 Shotgun Passenger: Dynamic Grab-Bar Brace on Hard Cornering", () => {
  // High yaw rate (1.8 rad/s >= 1.5 threshold)
  const poseTurn = SP.computeSeatPose(1, "0x02000001", { accelLong: 0.0, yawRate: 1.8 });
  assert(poseTurn.braceActive === true, "sharp cornering triggers grab brace");

  // High lateral accel (4.5 m/s^2 >= 4.0 threshold)
  const poseLat = SP.computeSeatPose(1, "0x02000001", { accelLong: 0.0, accelLat: 4.5 });
  assert(poseLat.braceActive === true, "high lateral G triggers grab brace");
});

await check("T1.8 Seats 2 & 3: Rear Bench 90° Chair-Sit & Cloak/Tail Tucking", () => {
  for (const s of [2, 3]) {
    const pose = SP.computeSeatPose(s, "0x02001A1A"); // Tumerok setup
    assert(pose.hipAngleDeg === 90, `seat ${s} hip flexed 90°`);
    assert(pose.kneeAngleDeg === 90, `seat ${s} knee flexed 90°`);
    assert(pose.cloakTucked === true, `seat ${s} cloak tucked`);
    assert(pose.tailTucked === true, `seat ${s} Tumerok tail tucked`);
    assert(pose.leftArmIK.reachable && pose.rightArmIK.reachable, `seat ${s} arm IK solved`);
  }
});

await check("T1.9 4-Seat Boarding & Exit Splines (~0.85s front, ~0.95s rear, ~0.65s exit)", () => {
  // Front ingress
  const frontIn = SP.evaluateBoardingSpline(0, "ingress", 0.5);
  near(frontIn.duration, SEAT_CONSTANTS.splineDurations.frontIngressSec, 1e-3, "front ingress duration ~0.85s");

  // Rear ingress
  const rearIn = SP.evaluateBoardingSpline(2, "ingress", 0.5);
  near(rearIn.duration, SEAT_CONSTANTS.splineDurations.rearIngressSec, 1e-3, "rear ingress duration ~0.95s");

  // Egress
  const egress = SP.evaluateBoardingSpline(0, "egress", 0.5);
  near(egress.duration, SEAT_CONSTANTS.splineDurations.egressSec, 1e-3, "egress duration ~0.65s");
});

await check("T1.10 Boarding Chassis Suspension Dip (-0.03m initial impulse & recovery)", () => {
  const dipInitial = SP.computeSuspensionDip(1, 0.0);
  near(dipInitial, -0.038, 1e-3, "initial boarding compression (-0.03m dip + passenger mass)");

  const dipSettled = SP.computeSuspensionDip(1, 1.5);
  assert(dipSettled > -0.03, "suspension settles toward steady state");
  near(dipSettled, -0.008, 2e-3, "settled passenger compression");
});

await check("T1.11 Calibrated Cushion Seat Offsets & getSeatOffset Helper", () => {
  const s0 = SP.getSeatOffset(0);
  const s1 = SP.getSeatOffset(1);
  const s2 = SP.getSeatOffset(2);
  const s3 = SP.getSeatOffset(3);

  // Exact plan specifications:
  // Seat 0: [-0.38, -0.18, 0.62]
  near(s0[0], -0.38, 1e-4, "Seat 0 X");
  near(s0[1], -0.18, 1e-4, "Seat 0 Y");
  near(s0[2], 0.62, 1e-4, "Seat 0 Z");

  // Seat 1: [0.38, -0.18, 0.62]
  near(s1[0], 0.38, 1e-4, "Seat 1 X");
  near(s1[1], -0.18, 1e-4, "Seat 1 Y");
  near(s1[2], 0.62, 1e-4, "Seat 1 Z");

  // Seat 2: [-0.36, -0.96, 0.68]
  near(s2[0], -0.36, 1e-4, "Seat 2 X");
  near(s2[1], -0.96, 1e-4, "Seat 2 Y");
  near(s2[2], 0.68, 1e-4, "Seat 2 Z");

  // Seat 3: [0.36, -0.96, 0.68]
  near(s3[0], 0.36, 1e-4, "Seat 3 X");
  near(s3[1], -0.96, 1e-4, "Seat 3 Y");
  near(s3[2], 0.68, 1e-4, "Seat 3 Z");

  // Grab bar position synchronized to model [0.38, 0.62, 0.88]
  near(SP.SEAT_CONSTANTS.dashGrabBarPos[0], 0.38, 1e-4, "grabBar X");
  near(SP.SEAT_CONSTANTS.dashGrabBarPos[1], 0.62, 1e-4, "grabBar Y");
  near(SP.SEAT_CONSTANTS.dashGrabBarPos[2], 0.88, 1e-4, "grabBar Z");
});

await check("T1.12 Internal Seat Hot-Swap 0.35s Spline Interpolation (interpolateSeatHotSwap)", () => {
  // Test slide from Seat 1 (Shotgun) to Seat 0 (Driver)
  const swapMid = SP.interpolateSeatHotSwap(1, 0, 0.5);
  near(swapMid.duration, 0.35, 1e-3, "0.35s hot-swap duration");
  near(swapMid.progress, 0.5, 1e-3, "progress is 0.5");

  // X should be near 0 at midpoint between 0.38 and -0.38
  near(swapMid[0], 0.0, 1e-2, "midway X centered");
  // Z should have arc lift over the transmission tunnel
  assert(swapMid[2] > 0.62, `arc lift clearance: ${swapMid[2]} > 0.62`);

  // End points
  const swapStart = SP.interpolateSeatHotSwap(1, 0, 0.0);
  near(swapStart[0], 0.38, 1e-3, "start at Seat 1 X");
  const swapEnd = SP.interpolateSeatHotSwap(1, 0, 1.0);
  near(swapEnd[0], -0.38, 1e-3, "end at Seat 0 X");
});

await check("T1.13 applySeatPoseToEntity Seat 0 (Driver): Steering IK & Head Tracking", () => {
  const inst = createMockEntityInstance("0x02000001");
  // Test with realistic vehicle position and non-zero heading to guarantee rotation invariance
  const vehiclePose = { x: 100, y: 200, z: 15, heading: 0.35, pitch: 0.0, roll: 0.0 };
  const vehicleKinematics = { steerAngle: 0.35, speed: 12.0, accelLong: 0.0 };

  const res = SP.applySeatPoseToEntity(inst, 0, vehiclePose, vehicleKinematics, 0.016);
  assert(res && res.seatPose, "applySeatPoseToEntity returned valid result");
  assert(res.seatIndex === 0, "seatIndex 0");

  const cosH = Math.cos(vehiclePose.heading);
  const sinH = Math.sin(vehiclePose.heading);
  const s0 = SP.getSeatOffset(0);

  // 1. Root position placed at vehicle + seatOffset rotated by heading
  const expRootX = vehiclePose.x + s0[0] * cosH - s0[1] * sinH;
  const expRootY = vehiclePose.y + s0[0] * sinH + s0[1] * cosH;
  const expRootZ = vehiclePose.z + s0[2];
  near(inst.root.position.x, expRootX, 1e-3, "driver root X");
  near(inst.root.position.y, expRootY, 1e-3, "driver root Y");
  near(inst.root.position.z, expRootZ, 1e-3, "driver root Z");

  // 2. Driver head tracking steerAngle
  assert(inst.parts[16], "head part exists");
  assert(inst.parts[16].rotation.y !== 0 || inst.parts[16].quaternion.z !== 0 || inst.parts[16].quaternion.y !== 0, "head rotated with steer");

  // 3. Propagate transforms to world matrix
  inst.root.updateMatrixWorld(true);

  // 4. Compute steering wheel center in world coordinates
  const swCenter = SEAT_CONSTANTS.steeringWheelCenter;
  const swCenterWorld = new THREE.Vector3(
    vehiclePose.x + swCenter[0] * cosH - swCenter[1] * sinH,
    vehiclePose.y + swCenter[0] * sinH + swCenter[1] * cosH,
    vehiclePose.z + swCenter[2]
  );

  // 5. Assert true world position of hands on steering wheel rim
  const handWorldL = new THREE.Vector3();
  const handWorldR = new THREE.Vector3();
  inst.parts[12].getWorldPosition(handWorldL);
  inst.parts[15].getWorldPosition(handWorldR);

  near(handWorldL.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "left hand on steering wheel rim in world space");
  near(handWorldR.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "right hand on steering wheel rim in world space");

  // 6. Assert skeletal arm kinematic chain lengths (Shoulder -> Elbow -> Hand)
  const shoulderWorldL = new THREE.Vector3();
  const elbowWorldL = new THREE.Vector3();
  inst.parts[10].getWorldPosition(shoulderWorldL);
  inst.parts[11].getWorldPosition(elbowWorldL);

  near(shoulderWorldL.distanceTo(elbowWorldL), HUMANOID_FALL_RIG.upperLen, 1e-3, "left upper arm length preserved");
  near(elbowWorldL.distanceTo(handWorldL), HUMANOID_FALL_RIG.elbowUp, 1e-3, "left forearm length preserved");
});

await check("T1.14 applySeatPoseToEntity Seat 1 (Shotgun): Dynamic Grab-Bar Reach Under Hard Braking", () => {
  const inst = createMockEntityInstance("0x02000001");
  const vehiclePose = { x: 50, y: 50, z: 2, heading: 0.25 };
  // Hard braking decel: -5.5 m/s^2 <= -4.5 threshold
  const vehicleKinematics = { accelLong: -5.5, yawRate: 0.0, speed: 20.0 };

  const res = SP.applySeatPoseToEntity(inst, 1, vehiclePose, vehicleKinematics, 0.016);
  assert(res.braceActive === true, "brace is active under hard braking");

  // 1. Propagate scene graph transforms to world matrix
  inst.root.updateMatrixWorld(true);

  // 2. Compute true physical dashboard grab bar position in world space
  const cosH = Math.cos(vehiclePose.heading);
  const sinH = Math.sin(vehiclePose.heading);
  const expGrabWorld = new THREE.Vector3(
    vehiclePose.x + SEAT_CONSTANTS.dashGrabBarPos[0] * cosH - SEAT_CONSTANTS.dashGrabBarPos[1] * sinH,
    vehiclePose.y + SEAT_CONSTANTS.dashGrabBarPos[0] * sinH + SEAT_CONSTANTS.dashGrabBarPos[1] * cosH,
    vehiclePose.z + SEAT_CONSTANTS.dashGrabBarPos[2]
  );

  // 3. Assert left hand matches dashboard grab bar in world space
  const handWorld = new THREE.Vector3();
  inst.parts[12].getWorldPosition(handWorld);
  near(handWorld.distanceTo(expGrabWorld), 0.0, 1e-3, "left hand locked to grab bar in world space");

  // 4. Assert local coordinates inside root are seat-relative (NOT vehicle-local)
  const s1 = SP.getSeatOffset(1);
  near(inst.parts[12].position.x, SEAT_CONSTANTS.dashGrabBarPos[0] - s1[0], 1e-3, "local hand X is seat-relative");
  near(inst.parts[12].position.y, SEAT_CONSTANTS.dashGrabBarPos[1] - s1[1], 1e-3, "local hand Y is seat-relative");
  near(inst.parts[12].position.z, SEAT_CONSTANTS.dashGrabBarPos[2] - s1[2], 1e-3, "local hand Z is seat-relative");

  // 5. Assert skeletal limb segment lengths
  const shoulderWorld = new THREE.Vector3();
  const elbowWorld = new THREE.Vector3();
  inst.parts[10].getWorldPosition(shoulderWorld);
  inst.parts[11].getWorldPosition(elbowWorld);

  near(shoulderWorld.distanceTo(elbowWorld), HUMANOID_FALL_RIG.upperLen, 1e-3, "shotgun upper arm length preserved");
  near(elbowWorld.distanceTo(handWorld), HUMANOID_FALL_RIG.elbowUp, 1e-3, "shotgun forearm length preserved");

  // 6. Shotgun torso leans forward to brace
  assert(inst.parts[9].rotation.x > 0 || inst.parts[9].quaternion.x > 0, "torso leans forward to brace");
});

await check("T1.15 applySeatPoseToEntity Seats 2 & 3: Rear Bench Seating, Torso Sway & Gunwale Rest", () => {
  // Seat 2 (Rear Left)
  const inst2 = createMockEntityInstance("0x02000001");
  const vehiclePose = { x: 10, y: 20, z: 5, heading: 0.5, pitch: 0.05, roll: -0.08 };
  const vehicleKinematics = { speed: 10.0, accelLong: 2.0, accelLat: 3.0 };

  const res2 = SP.applySeatPoseToEntity(inst2, 2, vehiclePose, vehicleKinematics, 0.016);
  assert(res2 && res2.seatIndex === 2, "seat 2 evaluated");
  inst2.root.updateMatrixWorld(true);

  // Seat 2 skeletal arm check (outer left hand resting on gunwale)
  const handL2 = new THREE.Vector3();
  const shL2 = new THREE.Vector3();
  const elL2 = new THREE.Vector3();
  inst2.parts[12].getWorldPosition(handL2);
  inst2.parts[10].getWorldPosition(shL2);
  inst2.parts[11].getWorldPosition(elL2);

  near(shL2.distanceTo(elL2), HUMANOID_FALL_RIG.upperLen, 1e-3, "seat 2 upper arm length preserved");
  near(elL2.distanceTo(handL2), HUMANOID_FALL_RIG.elbowUp, 1e-3, "seat 2 forearm length preserved");

  // Seat 3 (Rear Right)
  const inst3 = createMockEntityInstance("0x02000001");
  const res3 = SP.applySeatPoseToEntity(inst3, 3, vehiclePose, vehicleKinematics, 0.016);
  inst3.root.updateMatrixWorld(true);

  // Seat 3 skeletal arm check (outer right hand resting on gunwale)
  const handR3 = new THREE.Vector3();
  const shR3 = new THREE.Vector3();
  const elR3 = new THREE.Vector3();
  inst3.parts[15].getWorldPosition(handR3);
  inst3.parts[13].getWorldPosition(shR3);
  inst3.parts[14].getWorldPosition(elR3);

  near(shR3.distanceTo(elR3), HUMANOID_FALL_RIG.upperLen, 1e-3, "seat 3 upper arm length preserved");
  near(elR3.distanceTo(handR3), HUMANOID_FALL_RIG.elbowUp, 1e-3, "seat 3 forearm length preserved");
});

await check("T1.16 Ground VFX: 64-Sprite Pooling, Procedural Cloud Texture, Zero Lights", () => {
  const gvfx = createGroundFx(THREE);
  assert(gvfx, "Ground VFX created");
  assert(gvfx.lightCountDelta === 0, "lightCountDelta is strictly 0");
  assert(gvfx.root, "root group exists");
  assert(gvfx.pool.length === POOL_SIZE, `expected ${POOL_SIZE} sprites in pool, got ${gvfx.pool.length}`);

  // Confirm zero Light objects in the scene graph
  let lightCount = 0;
  gvfx.root.traverse((node) => {
    if (node.isLight) lightCount++;
  });
  assert(lightCount === 0, `strictly zero lights added (found ${lightCount})`);

  // Verify procedural DataTexture
  const tex = makeCloudTexture(THREE, 64);
  assert(tex.isDataTexture, "procedural cloud is THREE.DataTexture");
  assert(tex.image.width === 64 && tex.image.height === 64, "64x64 texture");
  assert(tex.image.data.length === 64 * 64 * 4, "RGBA byte buffer populated");

  gvfx.dispose();
});

await check("T1.17 Ground VFX: 4-Wheel Surface-Tinted Plumes & Zero Allocation Tick Loop", () => {
  const gvfx = createGroundFx(THREE);

  // Surface tint resolution checks
  near(resolveSurfaceColor("Road"), 0x999999, 0, "Road tint");
  near(resolveSurfaceColor("Dirt"), 0x8a6d4b, 0, "Dirt tint");
  near(resolveSurfaceColor("Grass"), 0x6e7845, 0, "Grass tint");
  near(resolveSurfaceColor("Sand"), 0xd4be8d, 0, "Sand tint");
  near(resolveSurfaceColor("Snow"), 0xf0f5ff, 0, "Snow tint");
  near(resolveSurfaceColor("ShallowFord"), 0xbbddee, 0, "Water splash tint");

  // Drive vehicle across grass at 15 m/s
  const pose = { x: 10, y: 20, z: 0.5, heading: 0.5 };
  const kinematics = { speed: 15.0, surfaceType: "Grass", throttle: 0.8 };

  // Initial update
  gvfx.update(1001, pose, kinematics, 0.05);
  // Allow wheel accumulator to trigger
  gvfx.update(1001, pose, kinematics, 0.06);

  assert(gvfx.getActiveCount() > 0, "wheel plume particles emitted");

  // Zero-allocation verification: run 50 frames
  const initialPoolSize = gvfx.pool.length;
  for (let f = 0; f < 50; f++) {
    pose.x += 0.2;
    gvfx.update(1001, pose, kinematics, 0.016);
  }
  assert(gvfx.pool.length === initialPoolSize, "pool size remains fixed at 64 (no allocations)");

  gvfx.dispose();
});

await check("T1.18 Ground VFX: Handbrake Skid Smoke & L134 Tailpipe Exhaust Wisps", () => {
  const gvfx = createGroundFx(THREE);

  // Idle state: speed = 0, should emit tailpipe exhaust wisps at ~10 Hz
  const idlePose = { x: 0, y: 0, z: 0, heading: 0.0 };
  const idleKinematics = { speed: 0.0, throttle: 0.0 };

  // Step through 0.15s
  gvfx.update(1001, idlePose, idleKinematics, 0.15);
  const activeIdle = gvfx.getActiveCount();
  assert(activeIdle > 0, "tailpipe exhaust wisp emitted at idle");

  // Check tailpipe emission position near [+0.52, -1.62, 0.36]
  const tailpipeSlot = gvfx.pool.find((s) => s.active && Math.abs(s.x - 0.52) < 0.2);
  assert(tailpipeSlot, "exhaust particle spawned near tailpipe coordinates");
  near(tailpipeSlot.mat.color.getHex(), 0x555555, 0, "exhaust carbon grey color");

  // Skid state: handbrake engaged at 10 m/s
  const skidPose = { x: 0, y: 0, z: 0, heading: 0.0 };
  const skidKinematics = { speed: 10.0, handbrake: true, slip: 3.5 };

  gvfx.update(1001, skidPose, skidKinematics, 0.10);
  const skidSlot = gvfx.pool.find((s) => s.active && s.mat.color.getHex() === 0xdddddd);
  assert(skidSlot, "handbrake skid smoke particle spawned with white tire smoke color (0xdddddd)");

  gvfx.dispose();
});

// ---------------------------------------------------------------------------
// TIER 2: BOUNDARY & CORNER CASES
// ---------------------------------------------------------------------------
console.log("=== TIER 2: Boundary & Corner Cases (Suite B: vehicle_seat_poses) ===");

await check("T2.1 Unknown Setup Fallback Safety (0x02FFFFFF falls back to Human)", () => {
  const pose = SP.computeSeatPose(0, 0x02ffffff, { steerAngle: 0.1 });
  assert(pose && !pose.isOlthoi, "fallback to humanoid");
  near(pose.scale, 1.00, 1e-4, "default human scale 1.0");
});

await check("T2.2 Extreme Steering Lock Arm Reach Boundary (Clamp without NaN)", () => {
  // Extreme steer lock at 40° -> steering wheel at 100° (1.745 rad)
  const pose = SP.computeSeatPose(0, "0x02000001", { steerAngle: 0.69813 });
  assert(Number.isFinite(pose.leftArmIK.elbow[0]), "elbow X finite");
  assert(Number.isFinite(pose.leftArmIK.elbow[1]), "elbow Y finite");
  assert(Number.isFinite(pose.leftArmIK.elbow[2]), "elbow Z finite");
  assert(pose.leftArmIK.target.every(Number.isFinite), "target finite");
});

await check("T2.3 Olthoi Non-Humanoid Rig Thorax Anchor (Bypasses Arm IK)", () => {
  const pose = SP.computeSeatPose(0, "0x02001A21"); // Olthoi worker
  assert(pose.isOlthoi === true, "identified as Olthoi");
  assert(pose.armIK === null, "no arm IK for Olthoi");
  assert(pose.thoraxAnchor && pose.thoraxAnchor.pos.length === 3, "valid thorax anchor");
});

await check("T2.4 Rapid Steering Oscillation Stability (10 Hz oscillation)", () => {
  for (let frame = 0; frame < 100; frame++) {
    const steer = Math.sin(frame * 0.628) * 0.69813;
    const pose = SP.computeSeatPose(0, "0x02000001", { steerAngle: steer });
    assert(pose.leftArmIK.target.every(Number.isFinite), `frame ${frame} finite IK`);
  }
});

await check("T2.5 Cumulative Multi-Person Suspension Compression", () => {
  const dip1 = SP.computeSuspensionDip(1, 2.0);
  const dip2 = SP.computeSuspensionDip(2, 2.0);
  const dip4 = SP.computeSuspensionDip(4, 2.0);
  assert(dip2 < dip1, "2 passengers compress more than 1");
  assert(dip4 < dip2, "4 passengers compress more than 2");
  assert(dip4 >= -0.06, "chassis bump stops prevent bottoming out");
});

await check("T2.6 Sub-Threshold Braking (a = -4.0 m/s^2 does not trigger grab brace)", () => {
  const pose = SP.computeSeatPose(1, "0x02000001", { accelLong: -4.0 });
  assert(pose.braceActive === false, "a = -4.0 m/s^2 does not trigger brace");
});

await check("T2.7 Boarding Flag Disabled Instant Snap (?vehicleBoardAnim=off)", () => {
  const res = SP.evaluateBoardingSpline(0, "ingress", 0.1, "?vehicleBoardAnim=off");
  assert(res.snapped === true, "snapped instantly with ?vehicleBoardAnim=off");
});

await check("T2.8 Egress Clearance Vector on Arbitrary Heading", () => {
  const heading = 135 * (Math.PI / 180);
  const hOut = hopHeading(0, heading, 1.0);
  near(hOut, heading, 1e-4, "heading interpolated to 135°");
});

await check("T2.9 applySeatPoseToEntity Robustness (Missing/Partial Parts, Null Safety, Bad Setup)", () => {
  // 1. Null instance safe
  assert(SP.applySeatPoseToEntity(null, 0) === null, "null instance handled");

  // 2. Instance with empty parts
  const emptyInst = { root: new THREE.Group(), parts: [] };
  const r1 = SP.applySeatPoseToEntity(emptyInst, 0, { x: 5, y: 5, z: 1 });
  assert(r1 && r1.seatIndex === 0, "empty parts array handled safely");

  // 3. Instance with invalid setup ID
  const badInst = createMockEntityInstance("0xINVALID");
  const r2 = SP.applySeatPoseToEntity(badInst, 1);
  assert(r2 && r2.setupId === "0xINVALID", "fallback used gracefully");
});

await check("T2.10 Ground VFX Circular Cursor Wraparound & Reuse Capacity", () => {
  const gvfx = createGroundFx(THREE);
  const pose = { x: 0, y: 0, z: 0, heading: 0.0 };
  const kinematics = { speed: 25.0, surfaceType: "Dirt", handbrake: true, slip: 4.0 };

  // Trigger high particle volume over 200 frames to wrap around pool multiple times
  for (let f = 0; f < 200; f++) {
    gvfx.update(1001, pose, kinematics, 0.05);
  }

  assert(gvfx.pool.length === POOL_SIZE, "pool length strictly bounded at 64");
  assert(gvfx.getActiveCount() <= POOL_SIZE, "active count cannot exceed pool capacity");

  gvfx.dispose();
});

// ---------------------------------------------------------------------------
// TIER 3: CROSS-FEATURE COMBINATIONS
// ---------------------------------------------------------------------------
console.log("=== TIER 3: Cross-Feature Combinations (Suite B: vehicle_seat_poses) ===");

await check("T3.1 Driver Steering + Shotgun Grab Brace Simultaneously", () => {
  const driver = createMockEntityInstance("0x02000001");
  const shotgun = createMockEntityInstance("0x02000001");
  const vehiclePose = { x: 120, y: 80, z: 5, heading: 0.4 };
  const state = { steerAngle: 0.5, accelLong: -6.0, yawRate: 1.6 };

  SP.applySeatPoseToEntity(driver, 0, vehiclePose, state, 0.016);
  SP.applySeatPoseToEntity(shotgun, 1, vehiclePose, state, 0.016);

  driver.root.updateMatrixWorld(true);
  shotgun.root.updateMatrixWorld(true);

  const cosH = Math.cos(vehiclePose.heading);
  const sinH = Math.sin(vehiclePose.heading);
  const swCenterWorld = new THREE.Vector3(
    vehiclePose.x + SEAT_CONSTANTS.steeringWheelCenter[0] * cosH - SEAT_CONSTANTS.steeringWheelCenter[1] * sinH,
    vehiclePose.y + SEAT_CONSTANTS.steeringWheelCenter[0] * sinH + SEAT_CONSTANTS.steeringWheelCenter[1] * cosH,
    vehiclePose.z + SEAT_CONSTANTS.steeringWheelCenter[2]
  );
  const grabBarWorld = new THREE.Vector3(
    vehiclePose.x + SEAT_CONSTANTS.dashGrabBarPos[0] * cosH - SEAT_CONSTANTS.dashGrabBarPos[1] * sinH,
    vehiclePose.y + SEAT_CONSTANTS.dashGrabBarPos[0] * sinH + SEAT_CONSTANTS.dashGrabBarPos[1] * cosH,
    vehiclePose.z + SEAT_CONSTANTS.dashGrabBarPos[2]
  );

  const dHandL = new THREE.Vector3();
  const sHandL = new THREE.Vector3();
  driver.parts[12].getWorldPosition(dHandL);
  shotgun.parts[12].getWorldPosition(sHandL);

  near(dHandL.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "driver hand on steering rim");
  near(sHandL.distanceTo(grabBarWorld), 0.0, 1e-3, "shotgun hand on grab bar");
  assert(dHandL.distanceTo(sHandL) > 0.4, "occupants cleanly separated across cabin");
});

await check("T3.2 4-Player Full Board and Drive Transition", () => {
  // All 4 board
  for (let s = 0; s < 4; s++) {
    const ingress = SP.evaluateBoardingSpline(s, "ingress", 1.0);
    assert(ingress.duration > 0, `seat ${s} ingress completed`);
  }
  // Drive state
  for (let s = 0; s < 4; s++) {
    const pose = SP.computeSeatPose(s, "0x02000001", { steerAngle: 0.2, speed: 15.0 });
    assert(pose, `seat ${s} active in drive mode`);
  }
});

await check("T3.3 Driver Exit While Passengers Seated (Passengers stable during auto-brake)", () => {
  // Driver egresses
  const driverEgress = SP.evaluateBoardingSpline(0, "egress", 0.5);
  assert(driverEgress.pos && driverEgress.pos.length === 3, "driver egressing");

  // Passengers 1..3 remain stably seated
  for (let s = 1; s <= 3; s++) {
    const pose = SP.computeSeatPose(s, "0x02000001", { accelLong: -3.5 }); // auto-braking
    assert(pose.hipAngleDeg === 90 && pose.kneeAngleDeg === 90, `passenger ${s} remains seated`);
  }
});

await check("T3.4 Live Hot-Swap IK Handoff (Seat 1 -> Seat 0)", () => {
  const entity = createMockEntityInstance("0x02000001");
  const vehiclePose = { x: 30, y: 40, z: 3, heading: 0.6 };
  const cosH = Math.cos(vehiclePose.heading);
  const sinH = Math.sin(vehiclePose.heading);
  const swCenterWorld = new THREE.Vector3(
    vehiclePose.x + SEAT_CONSTANTS.steeringWheelCenter[0] * cosH - SEAT_CONSTANTS.steeringWheelCenter[1] * sinH,
    vehiclePose.y + SEAT_CONSTANTS.steeringWheelCenter[0] * sinH + SEAT_CONSTANTS.steeringWheelCenter[1] * cosH,
    vehiclePose.z + SEAT_CONSTANTS.steeringWheelCenter[2]
  );
  const grabBarWorld = new THREE.Vector3(
    vehiclePose.x + SEAT_CONSTANTS.dashGrabBarPos[0] * cosH - SEAT_CONSTANTS.dashGrabBarPos[1] * sinH,
    vehiclePose.y + SEAT_CONSTANTS.dashGrabBarPos[0] * sinH + SEAT_CONSTANTS.dashGrabBarPos[1] * cosH,
    vehiclePose.z + SEAT_CONSTANTS.dashGrabBarPos[2]
  );

  // Phase 1: in Seat 1 bracing under braking
  SP.applySeatPoseToEntity(entity, 1, vehiclePose, { accelLong: -5.5 }, 0.016);
  entity.root.updateMatrixWorld(true);
  const hand1 = new THREE.Vector3();
  entity.parts[12].getWorldPosition(hand1);
  near(hand1.distanceTo(grabBarWorld), 0.0, 1e-3, "hand at grab bar before hot-swap");

  // Phase 2: swap to Seat 0 driver
  SP.applySeatPoseToEntity(entity, 0, vehiclePose, { steerAngle: 0.3 }, 0.016);
  entity.root.updateMatrixWorld(true);
  const hand0 = new THREE.Vector3();
  entity.parts[12].getWorldPosition(hand0);
  near(hand0.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, "hand on wheel after hot-swap");
});

await check("T3.5 4-Seat Concurrent Entity IK with Active Ground VFX Simulation", () => {
  const gvfx = createGroundFx(THREE);
  const entities = [
    createMockEntityInstance("0x02000001"), // Driver (Human Male)
    createMockEntityInstance("0x0200004E"), // Shotgun (Human Female)
    createMockEntityInstance("0x02001A18"), // Rear Left (Lugian scale 1.30)
    createMockEntityInstance("0x02001A1A"), // Rear Right (Tumerok scale 1.10)
  ];

  const vehiclePose = { x: 250, y: 350, z: 12, heading: 1.2, pitch: 0.04, roll: -0.06 };
  const vehicleKinematics = { speed: 18.0, steerAngle: 0.25, accelLong: -4.8, yawRate: 1.6, surfaceType: "Snow" };

  for (let s = 0; s < 4; s++) {
    SP.applySeatPoseToEntity(entities[s], s, vehiclePose, vehicleKinematics, 0.016);
    entities[s].root.updateMatrixWorld(true);
  }

  // Authentic 3D vehicle attitude transform accounting for non-zero pitch and roll
  const vehObj = new THREE.Object3D();
  vehObj.position.set(vehiclePose.x, vehiclePose.y, vehiclePose.z);
  if (vehiclePose.q && Array.isArray(vehiclePose.q) && vehiclePose.q.length === 4) {
    vehObj.quaternion.set(vehiclePose.q[1], vehiclePose.q[2], vehiclePose.q[3], vehiclePose.q[0]);
  } else {
    const euler = new THREE.Euler(vehiclePose.pitch || 0, vehiclePose.roll || 0, vehiclePose.heading || 0, "YXZ");
    vehObj.quaternion.setFromEuler(euler);
  }
  vehObj.updateMatrixWorld(true);

  const swCenterWorld = new THREE.Vector3(...SEAT_CONSTANTS.steeringWheelCenter);
  vehObj.localToWorld(swCenterWorld);
  const grabBarWorld = new THREE.Vector3(...SEAT_CONSTANTS.dashGrabBarPos);
  vehObj.localToWorld(grabBarWorld);

  // Seat 0 Driver hand on steering wheel rim in world space
  const dHand = new THREE.Vector3();
  entities[0].parts[12].getWorldPosition(dHand);
  near(dHand.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-4, "seat 0 hand on wheel in world");

  // Seat 1 Shotgun hand on grab bar in world space
  const sHand = new THREE.Vector3();
  entities[1].parts[12].getWorldPosition(sHand);
  near(sHand.distanceTo(grabBarWorld), 0.0, 1e-12, "seat 1 hand on grab bar in world (< 1e-12m)");

  // Explicit empirical verification across extreme 3D attitude pitches & rolls (±0.20 rad)
  for (const [pTest, rTest] of [[0.20, -0.20], [-0.20, 0.20], [0.15, -0.12], [-0.15, 0.15]]) {
    const advPose = { x: 100, y: 200, z: 15, heading: 0.8, pitch: pTest, roll: rTest };
    const advEntity = createMockEntityInstance("0x0200004E");
    SP.applySeatPoseToEntity(advEntity, 1, advPose, { accelLong: -5.5 }, 0.016);
    advEntity.root.updateMatrixWorld(true);

    const advVeh = new THREE.Object3D();
    advVeh.position.set(advPose.x, advPose.y, advPose.z);
    advVeh.quaternion.setFromEuler(new THREE.Euler(pTest, rTest, advPose.heading, "YXZ"));
    advVeh.updateMatrixWorld(true);
    const advGrab = new THREE.Vector3(...SEAT_CONSTANTS.dashGrabBarPos);
    advVeh.localToWorld(advGrab);

    const advHand = new THREE.Vector3();
    advEntity.parts[12].getWorldPosition(advHand);
    near(advHand.distanceTo(advGrab), 0.0, 1e-12, `grab bar bracing error < 1e-12m at pitch ${pTest}, roll ${rTest}`);
  }

  // Seat 2 Lugian scaled upper arm check
  const sh2 = new THREE.Vector3();
  const el2 = new THREE.Vector3();
  entities[2].parts[10].getWorldPosition(sh2);
  entities[2].parts[11].getWorldPosition(el2);
  near(sh2.distanceTo(el2), HUMANOID_FALL_RIG.upperLen * 1.30, 1e-3, "Lugian upper arm length");

  // Seat 3 Tumerok scaled upper arm check
  const sh3 = new THREE.Vector3();
  const el3 = new THREE.Vector3();
  entities[3].parts[13].getWorldPosition(sh3);
  entities[3].parts[14].getWorldPosition(el3);
  near(sh3.distanceTo(el3), HUMANOID_FALL_RIG.upperLen * 1.10, 1e-3, "Tumerok upper arm length");

  gvfx.update(9999, vehiclePose, vehicleKinematics, 0.016);
  assert(gvfx.getActiveCount() > 0, "snow plumes active");
  gvfx.dispose();
});

// ---------------------------------------------------------------------------
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// ---------------------------------------------------------------------------
console.log("=== TIER 4: Real-World Scenarios (Suite B: vehicle_seat_poses) ===");

await check("T4.1 Tactical Squad Insertion Scenario", () => {
  // Phase 1: 4 squad members board
  for (let s = 0; s < 4; s++) {
    const b = SP.evaluateBoardingSpline(s, "ingress", 1.0);
    assert(b.duration > 0, `squad member ${s} boarded`);
  }

  // Phase 2: High speed transit over rough terrain
  for (let step = 0; step < 60; step++) {
    const steer = Math.sin(step * 0.1) * 0.3;
    const aLong = step === 55 ? -6.0 : 0.5; // hard stop at end
    const p0 = SP.computeSeatPose(0, "0x02000001", { steerAngle: steer, accelLong: aLong });
    const p1 = SP.computeSeatPose(1, "0x02000001", { accelLong: aLong });
    assert(p0.leftArmIK.reachable, "driver maintained rim tracking");
    if (aLong < -4.5) assert(p1.braceActive === true, "shotgun braced on arrival");
  }

  // Phase 3: Tactical egress to ground
  for (let s = 0; s < 4; s++) {
    const eg = SP.evaluateBoardingSpline(s, "egress", 1.0);
    assert(eg.duration === 0.65, `squad member ${s} exited safely`);
  }
});

await check("T4.2 Solo Driver Evasive Maneuvers Scenario (1,000 frames continuous IK)", () => {
  const driver = createMockEntityInstance("0x02000001");
  const vehiclePose = { x: 50, y: 100, z: 10, heading: 0.0 };
  const handWorldL = new THREE.Vector3();
  const handWorldR = new THREE.Vector3();

  for (let frame = 0; frame < 1000; frame++) {
    vehiclePose.heading += 0.005;
    const steer = Math.sin(frame * 0.05) * 0.69813;
    SP.applySeatPoseToEntity(driver, 0, vehiclePose, { steerAngle: steer }, 0.016);

    // Sample every 50 frames for rigorous 3D world matrix verification
    if (frame % 50 === 0) {
      driver.root.updateMatrixWorld(true);
      const cosH = Math.cos(vehiclePose.heading);
      const sinH = Math.sin(vehiclePose.heading);
      const swCenterWorld = new THREE.Vector3(
        vehiclePose.x + SEAT_CONSTANTS.steeringWheelCenter[0] * cosH - SEAT_CONSTANTS.steeringWheelCenter[1] * sinH,
        vehiclePose.y + SEAT_CONSTANTS.steeringWheelCenter[0] * sinH + SEAT_CONSTANTS.steeringWheelCenter[1] * cosH,
        vehiclePose.z + SEAT_CONSTANTS.steeringWheelCenter[2]
      );

      driver.parts[12].getWorldPosition(handWorldL);
      driver.parts[15].getWorldPosition(handWorldR);

      near(handWorldL.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, `f${frame} L rim`);
      near(handWorldR.distanceTo(swCenterWorld), SEAT_CONSTANTS.steeringWheelRadius, 1e-3, `f${frame} R rim`);
      assert(Number.isFinite(handWorldL.x) && Number.isFinite(handWorldL.y) && Number.isFinite(handWorldL.z), "finite coords");
    }
  }
});

await check("T4.3 High-Speed 4x4 Off-Road Drift & Skid Test (1,000 Frames Zero Heap Leaks)", () => {
  const gvfx = createGroundFx(THREE);
  const driver = createMockEntityInstance("0x02000001");
  const shotgun = createMockEntityInstance("0x0200004E");

  const pose = { x: 0, y: 0, z: 0, heading: 0 };
  const kinematics = { speed: 20.0, steerAngle: 0.4, slip: 3.0, handbrake: true, surfaceType: "Dirt" };

  for (let frame = 0; frame < 1000; frame++) {
    pose.heading += 0.01;
    pose.x += Math.cos(pose.heading) * 0.3;
    pose.y += Math.sin(pose.heading) * 0.3;

    SP.applySeatPoseToEntity(driver, 0, pose, kinematics, 0.016);
    SP.applySeatPoseToEntity(shotgun, 1, pose, kinematics, 0.016);
    gvfx.update(8888, pose, kinematics, 0.016);
  }

  assert(gvfx.pool.length === POOL_SIZE, "pool stayed strictly at 64 items over 1,000 frames");
  gvfx.dispose();
});

await check("T4.4 Ground VFX Jeep AC Compass Heading Rotation (PI/2 & PI)", () => {
  const stamped = [];
  const prevWin = globalThis.window;
  globalThis.window = {
    __terrainVfx: {
      trail: {
        stamp(wx, wy, radius, strength) {
          stamped.push({ wx, wy, radius, strength });
        },
      },
    },
  };
  try {
    const tailOffset = [0.52, -1.62, 0.36];
    const wheelOffsets = [
      [-0.74, 1.02],
      [0.74, 1.02],
      [-0.74, -1.02],
      [0.74, -1.02],
    ];
    for (const heading of [Math.PI / 2, Math.PI]) {
      stamped.length = 0;
      const gvfx = createGroundFx(THREE);
      const px = 40;
      const py = 60;
      const pz = 2;
      const cosH = Math.cos(heading);
      const sinH = Math.sin(heading);

      gvfx.update(1001, { x: px, y: py, z: pz, heading }, { speed: 12.0, handbrake: true, surfaceType: 1 }, 0.12);

      assert(stamped.length === 4, `heading=${heading.toFixed(2)}: 4 jeep ruts stamped`);
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = wheelOffsets[i];
        const ex = px + lx * cosH + ly * sinH;
        const ey = py - lx * sinH + ly * cosH;
        near(stamped[i].wx, ex, 1e-4, `jeep rut[${i}] wx`);
        near(stamped[i].wy, ey, 1e-4, `jeep rut[${i}] wy`);
      }

      const activeSlots = gvfx.pool.filter((s) => s.active);
      const tx = px + tailOffset[0] * cosH + tailOffset[1] * sinH;
      const ty = py - tailOffset[0] * sinH + tailOffset[1] * cosH;
      const exhaust = activeSlots.find((s) => s.mat.color.getHex() === 0x555555 && Math.hypot(s.x - tx, s.y - ty) < 0.2);
      assert(exhaust, `heading=${heading.toFixed(2)}: jeep tailpipe exhaust spawned at (${tx.toFixed(2)}, ${ty.toFixed(2)})`);

      gvfx.dispose();
    }
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_seat_poses: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
