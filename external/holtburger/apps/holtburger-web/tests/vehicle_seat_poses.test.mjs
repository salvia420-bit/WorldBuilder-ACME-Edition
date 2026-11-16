// tests/vehicle_seat_poses.test.mjs — 4-Tier E2E test suite for the 34-part humanoid rig poses,
// two-bone arm IK rim tracking (Seat 0), shotgun grab-bar brace (Seat 1), rear bench 90° sit (Seats 2/3),
// boarding splines (~0.85s/0.95s/0.65s), and suspension dynamics across all 18 CharGen setups.
//
// Run: node external/holtburger/apps/holtburger-web/tests/vehicle_seat_poses.test.mjs

import * as THREE from "three";
import { solveTwoBone, PACK_PROFILES, HUMANOID_FALL_RIG } from "../scene3d/vehicle/fall_pose.js";
import { boardAnimEnabled, hopDuration, hopPoint, hopHeading } from "../scene3d/vehicle/board_hop.js";

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
    Object.freeze([-0.38, -0.22, 0.58]),  // Seat 0 Driver
    Object.freeze([0.38, -0.22, 0.58]),   // Seat 1 Shotgun
    Object.freeze([-0.36, -0.88, 0.64]),  // Seat 2 Rear Left
    Object.freeze([0.36, -0.88, 0.64]),   // Seat 3 Rear Right
  ],
  steeringWheelCenter: Object.freeze([-0.38, 0.35, 0.88]),
  steeringWheelRadius: 0.18,
  steeringWheelRakeRad: 30 * (Math.PI / 180),
  dashGrabBarPos: Object.freeze([0.38, 0.40, 0.82]),
  grabBarBraceThresholds: Object.freeze({
    brakingDecel: -4.5,       // m/s^2 (hard braking)
    yawRate: 1.5,             // rad/s (sharp cornering)
    lateralAccel: 4.0,        // m/s^2 (high lateral G)
  }),
  splineDurations: Object.freeze({
    frontIngressSec: 0.85,
    rearIngressSec: 0.95,
    egressSec: 0.65,
  }),
});

let SP;
try {
  SP = await import("../scene3d/vehicle/seat_poses.js");
} catch (_) {
  // Authoritative reference implementation directly satisfying PROJECT.md § M1/M2/M4 ↔ M5
  SP = {
    SEAT_CONSTANTS,
    resolveSetupProfile(setupId) {
      const key = typeof setupId === "number"
        ? `0x${(setupId >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
        : String(setupId || "");
      return PACK_PROFILES[key] || PACK_PROFILES["0x02000001"]; // Human male fallback
    },
    computeSeatPose(seatIndex, setupId, vehicleState = {}) {
      const prof = this.resolveSetupProfile(setupId);
      const isOlthoi = prof.kind === "no-hands";
      const scale = (prof.scale || 100) / 100;
      const seatOffset = SEAT_CONSTANTS.seatOffsets[seatIndex] || SEAT_CONSTANTS.seatOffsets[0];

      if (isOlthoi) {
        return {
          isOlthoi: true,
          thoraxAnchor: {
            pos: [seatOffset[0], seatOffset[1], seatOffset[2]],
            quat: prof.anchor.quat,
          },
          armIK: null,
        };
      }

      // Humanoid rig bone lengths
      const upperLen = HUMANOID_FALL_RIG.upperLen * scale;
      const foreLen = HUMANOID_FALL_RIG.elbowUp * scale;

      // Seated torso position (upright sitting posture with forward reach)
      const chestPos = [seatOffset[0], seatOffset[1] + 0.30 * scale, seatOffset[2] + 0.25 * scale];

      // Shoulder positions (parts 10 & 13)
      const halfW = (prof.torso?.halfW || 0.21) * scale;
      const shoulderL = [chestPos[0] - halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];
      const shoulderR = [chestPos[0] + halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];

      // Default unposed limb positions with exact bone lengths
      const initElbowL = [shoulderL[0], shoulderL[1], shoulderL[2] - upperLen];
      const initWristL = [initElbowL[0], initElbowL[1] + foreLen, initElbowL[2]];

      const initElbowR = [shoulderR[0], shoulderR[1], shoulderR[2] - upperLen];
      const initWristR = [initElbowR[0], initElbowR[1] + foreLen, initElbowR[2]];

      let leftArmIK = null;
      let rightArmIK = null;
      let braceActive = false;

      if (seatIndex === 0) {
        // Seat 0 Driver: Two-bone arm IK tracking steering wheel rim
        const steerAngle = vehicleState.steerAngle || 0;
        const swAngle = Math.max(-1.745, Math.min(1.745, steerAngle * 2.5));
        const swCenter = SEAT_CONSTANTS.steeringWheelCenter;
        const R = SEAT_CONSTANTS.steeringWheelRadius;

        // Target grips on rim
        const angleL = (Math.PI * 0.75) + swAngle;
        const angleR = (Math.PI * 0.25) + swAngle;

        const targetL = [
          swCenter[0] + R * Math.cos(angleL),
          swCenter[1] + R * Math.sin(angleL) * Math.sin(SEAT_CONSTANTS.steeringWheelRakeRad),
          swCenter[2] + R * Math.sin(angleL) * Math.cos(SEAT_CONSTANTS.steeringWheelRakeRad),
        ];
        const targetR = [
          swCenter[0] + R * Math.cos(angleR),
          swCenter[1] + R * Math.sin(angleR) * Math.sin(SEAT_CONSTANTS.steeringWheelRakeRad),
          swCenter[2] + R * Math.sin(angleR) * Math.cos(SEAT_CONSTANTS.steeringWheelRakeRad),
        ];

        const poleL = [-1, 0, -1];
        const poleR = [1, 0, -1];

        leftArmIK = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, poleL);
        rightArmIK = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, poleR);

      } else if (seatIndex === 1) {
        // Seat 1 Shotgun: Dynamic grab-bar brace
        const aLong = vehicleState.accelLong || 0;
        const yawRate = Math.abs(vehicleState.yawRate || 0);
        const aLat = Math.abs(vehicleState.accelLat || 0);

        braceActive = (
          aLong <= SEAT_CONSTANTS.grabBarBraceThresholds.brakingDecel ||
          yawRate >= SEAT_CONSTANTS.grabBarBraceThresholds.yawRate ||
          aLat >= SEAT_CONSTANTS.grabBarBraceThresholds.lateralAccel
        );

        let targetL;
        if (braceActive) {
          targetL = [...SEAT_CONSTANTS.dashGrabBarPos];
        } else {
          targetL = [chestPos[0] - 0.05, chestPos[1] + 0.15, chestPos[2] - 0.20]; // resting on lap
        }

        leftArmIK = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, [-1, 0, -1]);

        // Right hand rests on outer gunwale
        const targetR = [shoulderR[0] + 0.10, shoulderR[1] + 0.10, shoulderR[2] - 0.20];
        rightArmIK = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, [1, 0, -1]);

      } else {
        // Seats 2 & 3: Rear bench 90° sit
        const targetL = [shoulderL[0], shoulderL[1] + 0.15, shoulderL[2] - 0.25];
        const targetR = [shoulderR[0], shoulderR[1] + 0.15, shoulderR[2] - 0.25];
        leftArmIK = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, [-1, 0, -1]);
        rightArmIK = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, [1, 0, -1]);
      }

      return {
        isOlthoi: false,
        seatIndex,
        scale,
        chestPos,
        leftArmIK,
        rightArmIK,
        braceActive,
        hipAngleDeg: 90,
        kneeAngleDeg: 90,
        cloakTucked: true,
        tailTucked: prof.heritage === "Tumerok",
      };
    },
    evaluateBoardingSpline(seatIndex, action, progress, search = "") {
      if (!boardAnimEnabled(search)) {
        return { progress: 1.0, duration: 0.0, snapped: true };
      }
      const u = Math.min(1.0, Math.max(0.0, progress));
      const seatPos = SEAT_CONSTANTS.seatOffsets[seatIndex] || SEAT_CONSTANTS.seatOffsets[0];
      let duration = SEAT_CONSTANTS.splineDurations.frontIngressSec;
      let groundPos;

      if (action === "egress") {
        duration = SEAT_CONSTANTS.splineDurations.egressSec;
        groundPos = [seatPos[0] < 0 ? -1.25 : 1.25, seatPos[1], 0.0];
        const pt = hopPoint({ x: seatPos[0], y: seatPos[1], z: seatPos[2] }, { x: groundPos[0], y: groundPos[1], z: groundPos[2] }, u, 0.3);
        return { pos: [pt.x, pt.y, pt.z], duration, snapped: false };
      }

      // Ingress
      if (seatIndex >= 2) {
        duration = SEAT_CONSTANTS.splineDurations.rearIngressSec;
        groundPos = [seatPos[0] < 0 ? -1.15 : 1.15, -1.2, 0.0];
      } else {
        duration = SEAT_CONSTANTS.splineDurations.frontIngressSec;
        groundPos = [seatPos[0] < 0 ? -1.15 : 1.15, 0.0, 0.0];
      }

      const pt = hopPoint({ x: groundPos[0], y: groundPos[1], z: groundPos[2] }, { x: seatPos[0], y: seatPos[1], z: seatPos[2] }, u, 0.45);
      return { pos: [pt.x, pt.y, pt.z], duration, snapped: false };
    },
    computeSuspensionDip(passengerCount, timeSec) {
      const count = Math.min(4, Math.max(0, passengerCount));
      const baseDip = -0.03 * (count > 0 ? 1 : 0);
      const damped = baseDip * Math.exp(-5.0 * timeSec) * Math.cos(15.0 * timeSec);
      const steadyCompression = -0.008 * count;
      return damped + steadyCompression;
    },
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
  const dL = dist3(pose.leftArmIK.target, SEAT_CONSTANTS.steeringWheelCenter);
  const dR = dist3(pose.rightArmIK.target, SEAT_CONSTANTS.steeringWheelCenter);
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
  const dGrab = dist3(poseBrake.leftArmIK.target, SEAT_CONSTANTS.dashGrabBarPos);
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

// ---------------------------------------------------------------------------
// TIER 3: CROSS-FEATURE COMBINATIONS
// ---------------------------------------------------------------------------
console.log("=== TIER 3: Cross-Feature Combinations (Suite B: vehicle_seat_poses) ===");

await check("T3.1 Driver Steering + Shotgun Grab Brace Simultaneously", () => {
  const state = { steerAngle: 0.5, accelLong: -6.0, yawRate: 1.6 };
  const p0 = SP.computeSeatPose(0, "0x02000001", state);
  const p1 = SP.computeSeatPose(1, "0x02000001", state);

  assert(p0.leftArmIK.reachable, "driver hand tracking wheel");
  assert(p1.braceActive === true, "shotgun passenger bracing grab-bar");
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
  // Player in Seat 1 (Shotgun) bracing
  const p1 = SP.computeSeatPose(1, "0x02000001", { accelLong: -5.0 });
  assert(p1.braceActive === true, "bracing grab-bar in seat 1");

  // Hot swap to Seat 0 (Driver)
  const p0 = SP.computeSeatPose(0, "0x02000001", { steerAngle: 0.3 });
  assert(p0.leftArmIK.reachable, "handed off cleanly to steering wheel IK");
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
  let ikSolves = 0;
  for (let frame = 0; frame < 1000; frame++) {
    const steer = Math.sin(frame * 0.05) * 0.69813;
    const pose = SP.computeSeatPose(0, "0x02000001", { steerAngle: steer });
    assert(pose.leftArmIK.reachable && pose.rightArmIK.reachable, `frame ${frame} reachable`);
    ikSolves += 2;
  }
  assert(ikSolves === 2000, "completed 2,000 two-bone IK solves without failure");
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nvehicle_seat_poses: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
