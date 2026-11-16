// scene3d/vehicle/seat_poses.js — 34-part humanoid rig IK seat poses, two-bone arm IK rim tracking,
// shotgun grab-bar brace, rear bench 90° sit, boarding splines, and suspension dynamics.
// Pure math & pose module (vehicles DESIGN §4.8, §6.2, Milestone 5 Feature 39).

import { solveTwoBone, PACK_PROFILES, HUMANOID_FALL_RIG } from "./fall_pose.js";
import { boardAnimEnabled, hopPoint } from "./board_hop.js";

export const SEAT_CONSTANTS = Object.freeze({
  seatOffsets: Object.freeze([
    Object.freeze([-0.38, -0.22, 0.58]),  // Seat 0 Driver
    Object.freeze([0.38, -0.22, 0.58]),   // Seat 1 Shotgun
    Object.freeze([-0.36, -0.88, 0.64]),  // Seat 2 Rear Left
    Object.freeze([0.36, -0.88, 0.64]),   // Seat 3 Rear Right
  ]),
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

/**
 * Normalizes and resolves a CharGen setup ID against PACK_PROFILES.
 * Falls back to human male Setup 0x02000001 if unknown.
 */
export function resolveSetupProfile(setupId) {
  const key = typeof setupId === "number"
    ? `0x${(setupId >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
    : String(setupId || "");
  return PACK_PROFILES[key] || PACK_PROFILES["0x02000001"];
}

/**
 * Computes the 34-part IK seat pose for an occupant in a given seat.
 * Handles Driver wheel tracking (Seat 0), Shotgun brace/lap (Seat 1), and Rear 90° sit (Seats 2/3).
 */
export function computeSeatPose(seatIndex, setupId, vehicleState = {}) {
  const prof = resolveSetupProfile(setupId);
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

  // Humanoid bone lengths scaled to heritage
  const upperLen = HUMANOID_FALL_RIG.upperLen * scale;
  const foreLen = HUMANOID_FALL_RIG.elbowUp * scale;

  // Seated torso position (upright sitting posture with forward reach)
  const chestPos = [seatOffset[0], seatOffset[1] + 0.30 * scale, seatOffset[2] + 0.25 * scale];

  // Shoulder origins (parts 10 & 13)
  const halfW = (prof.torso?.halfW || 0.21) * scale;
  const shoulderL = [chestPos[0] - halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];
  const shoulderR = [chestPos[0] + halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];

  // Unposed reference limb vectors
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
    const rake = SEAT_CONSTANTS.steeringWheelRakeRad;

    // Rim grips at neutral 135° (left) and 45° (right)
    const angleL = (Math.PI * 0.75) + swAngle;
    const angleR = (Math.PI * 0.25) + swAngle;

    const targetL = [
      swCenter[0] + R * Math.cos(angleL),
      swCenter[1] + R * Math.sin(angleL) * Math.sin(rake),
      swCenter[2] + R * Math.sin(angleL) * Math.cos(rake),
    ];
    const targetR = [
      swCenter[0] + R * Math.cos(angleR),
      swCenter[1] + R * Math.sin(angleR) * Math.sin(rake),
      swCenter[2] + R * Math.sin(angleR) * Math.cos(rake),
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
    // Seats 2 & 3: Rear bench 90° sit with hands on lap
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
}

/**
 * Evaluates the boarding or exit spline for an occupant.
 * Respects ?vehicleBoardAnim=off flag for instant snap.
 */
export function evaluateBoardingSpline(seatIndex, action, progress, search = "") {
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
    const pt = hopPoint(
      { x: seatPos[0], y: seatPos[1], z: seatPos[2] },
      { x: groundPos[0], y: groundPos[1], z: groundPos[2] },
      u,
      0.3
    );
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

  const pt = hopPoint(
    { x: groundPos[0], y: groundPos[1], z: groundPos[2] },
    { x: seatPos[0], y: seatPos[1], z: seatPos[2] },
    u,
    0.45
  );
  return { pos: [pt.x, pt.y, pt.z], duration, snapped: false };
}

/**
 * Computes the chassis suspension vertical dip from boarding impulses and settled mass.
 */
export function computeSuspensionDip(passengerCount, timeSec) {
  const count = Math.min(4, Math.max(0, passengerCount));
  const baseDip = -0.03 * (count > 0 ? 1 : 0);
  const damped = baseDip * Math.exp(-5.0 * timeSec) * Math.cos(15.0 * timeSec);
  const steadyCompression = -0.008 * count;
  return damped + steadyCompression;
}
