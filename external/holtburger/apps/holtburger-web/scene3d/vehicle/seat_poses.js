// scene3d/vehicle/seat_poses.js — 34-part humanoid rig IK seat poses, two-bone arm IK rim tracking,
// shotgun grab-bar brace, rear bench 90° sit, boarding splines, and suspension dynamics.
// Pure math & pose module (vehicles DESIGN §4.8, §6.2, Milestone 5 Feature 39).

import { solveTwoBone, PACK_PROFILES, HUMANOID_FALL_RIG } from "./fall_pose.js";
import { boardAnimEnabled, hopPoint } from "./board_hop.js";

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vNorm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
}

function quatFromTo(u, v) {
  const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (d > 1 - 1e-12) return [0, 0, 0, 1];
  if (d < -1 + 1e-9) {
    let ax = [0, -u[2], u[1]];
    if (Math.hypot(ax[0], ax[1], ax[2]) < 1e-6) ax = [u[2], 0, -u[0]];
    const l = Math.hypot(ax[0], ax[1], ax[2]);
    return [ax[0] / l, ax[1] / l, ax[2] / l, 0];
  }
  const cx = u[1] * v[2] - u[2] * v[1];
  const cy = u[2] * v[0] - u[0] * v[2];
  const cz = u[0] * v[1] - u[1] * v[0];
  const qw = 1 + d;
  const l = Math.hypot(cx, cy, cz, qw);
  return [cx / l, cy / l, cz / l, qw / l];
}

/** Rotate a 3D vector by a quaternion [qw, qx, qy, qz]. */
export function rotateVecByQuat(q, v) {
  const [qw, qx, qy, qz] = q;
  const [x, y, z] = v;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Euler angles (yaw around Z, pitch around X, roll around Y) in Three.js YXZ order to [qw, qx, qy, qz]. */
export function eulerToQuat(yaw, pitch, roll) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

export const SEAT_CONSTANTS = Object.freeze({
  seatOffsets: Object.freeze([
    Object.freeze([-0.38, -0.18, 0.62]),  // Seat 0 Driver (Front Left)
    Object.freeze([0.38, -0.18, 0.62]),   // Seat 1 Shotgun (Front Right)
    Object.freeze([-0.36, -0.96, 0.68]),  // Seat 2 Rear Left Passenger
    Object.freeze([0.36, -0.96, 0.68]),   // Seat 3 Rear Right Passenger
  ]),
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

export const SEMI_SEAT_CONSTANTS = Object.freeze({
  seatOffsets: Object.freeze([
    Object.freeze([-0.52, 0.28, 1.72]), // Seat 0 Driver
    Object.freeze([ 0.52, 0.28, 1.72]), // Seat 1 Co-Driver
  ]),
  steeringWheelCenter: Object.freeze([-0.52, 0.76, 1.98]),
  steeringWheelRadius: 0.24,
  steeringWheelRakeRad: 30 * (Math.PI / 180),
  dashGrabBarPos: Object.freeze([0.52, 0.90, 1.98]),
});

function isSemiProfile(src) {
  return Boolean(src && (src.vehicleClass === 3 || src.profileKey === "semi-379" || src.Key === "semi-379"));
}

/**
 * Returns the local seat offset for a given seat index,
 * honoring profile-supplied seats/offsets or semi-379 cab dimensions, falling back to Jeep SEAT_CONSTANTS.
 */
export function getSeatOffset(seatIndex, profileOrOpts = null) {
  const isSemi = isSemiProfile(profileOrOpts);
  const maxSeats = Array.isArray(profileOrOpts?.seats) && profileOrOpts.seats.length > 0
    ? profileOrOpts.seats.length
    : (isSemi ? SEMI_SEAT_CONSTANTS.seatOffsets.length : SEAT_CONSTANTS.seatOffsets.length);
  const idx = (typeof seatIndex === "number" && seatIndex >= 0 && seatIndex < maxSeats) ? Math.trunc(seatIndex) : 0;

  if (profileOrOpts && typeof profileOrOpts === "object") {
    const seatEntry = profileOrOpts.seats?.[idx];
    const off = Array.isArray(seatEntry?.offset) ? seatEntry.offset : (Array.isArray(seatEntry) ? seatEntry : null);
    if (off && off.length >= 3 && (off[0] !== 0 || off[1] !== 0 || off[2] !== 0)) {
      return off;
    }
    const customOff = profileOrOpts.seatOffsets?.[idx];
    if (Array.isArray(customOff) && customOff.length >= 3) {
      return customOff;
    }
    if (isSemi) {
      return SEMI_SEAT_CONSTANTS.seatOffsets[idx] || SEMI_SEAT_CONSTANTS.seatOffsets[0];
    }
  }
  return SEAT_CONSTANTS.seatOffsets[idx] || SEAT_CONSTANTS.seatOffsets[0];
}

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
  const vs = vehicleState && typeof vehicleState === "object" ? vehicleState : {};
  const profCtx = vs.profile ?? vs;
  const isSemi = isSemiProfile(profCtx);
  const prof = resolveSetupProfile(setupId);
  const isOlthoi = prof.kind === "no-hands";
  const scale = (prof.scale || 100) / 100;
  const seatOffset = Array.isArray(vs.seatOffset) && vs.seatOffset.length >= 3
    ? vs.seatOffset
    : getSeatOffset(seatIndex, profCtx);

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

  // Check if passenger in Seat 1 is bracing under hard braking or sharp cornering
  let braceActive = false;
  if (seatIndex === 1) {
    const aLong = vehicleState.accelLong || 0;
    const yawRate = Math.abs(vehicleState.yawRate || 0);
    const aLat = Math.abs(vehicleState.accelLat || 0);

    braceActive = (
      aLong <= SEAT_CONSTANTS.grabBarBraceThresholds.brakingDecel ||
      yawRate >= SEAT_CONSTANTS.grabBarBraceThresholds.yawRate ||
      aLat >= SEAT_CONSTANTS.grabBarBraceThresholds.lateralAccel
    );
  }

  // Seated torso position in SEAT-RELATIVE space (cushion surface is [0, 0, 0])
  const forwardBraceLean = braceActive ? (0.12 * scale) : 0;
  const downBraceDip = braceActive ? (0.02 * scale) : 0;
  const chestPos = [
    0,
    (0.30 * scale) + forwardBraceLean,
    (0.25 * scale) - downBraceDip,
  ];

  // Shoulder origins (parts 10 & 13) in SEAT-RELATIVE space
  const halfW = (prof.torso?.halfW || 0.21) * scale;
  const shoulderL = [chestPos[0] - halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];
  const shoulderR = [chestPos[0] + halfW * 0.65, chestPos[1], chestPos[2] + 0.05 * scale];

  // Unposed reference limb vectors in SEAT-RELATIVE space
  const initElbowL = [shoulderL[0], shoulderL[1], shoulderL[2] - upperLen];
  const initWristL = [initElbowL[0], initElbowL[1] + foreLen, initElbowL[2]];

  const initElbowR = [shoulderR[0], shoulderR[1], shoulderR[2] - upperLen];
  const initWristR = [initElbowR[0], initElbowR[1] + foreLen, initElbowR[2]];

  let leftArmIK = null;
  let rightArmIK = null;

  if (seatIndex === 0) {
    // Seat 0 Driver: Two-bone arm IK tracking steering wheel rim in seat-relative coordinates
    const steerAngle = vs.steerAngle || 0;
    const swAngle = Math.max(-1.745, Math.min(1.745, steerAngle * 2.5));
    const swCenterVeh = Array.isArray(vs.steeringWheelCenter) && vs.steeringWheelCenter.length >= 3
      ? vs.steeringWheelCenter
      : (isSemi ? SEMI_SEAT_CONSTANTS.steeringWheelCenter : SEAT_CONSTANTS.steeringWheelCenter);
    const swCenterSeat = [
      swCenterVeh[0] - seatOffset[0],
      swCenterVeh[1] - seatOffset[1],
      swCenterVeh[2] - seatOffset[2],
    ];
    const R = Number.isFinite(vs.steeringWheelRadius) && vs.steeringWheelRadius > 0
      ? vs.steeringWheelRadius
      : (isSemi ? SEMI_SEAT_CONSTANTS.steeringWheelRadius : SEAT_CONSTANTS.steeringWheelRadius);
    const rake = Number.isFinite(vs.steeringWheelRakeRad)
      ? vs.steeringWheelRakeRad
      : (isSemi ? SEMI_SEAT_CONSTANTS.steeringWheelRakeRad : SEAT_CONSTANTS.steeringWheelRakeRad);

    // Rim grips at neutral 135° (left) and 45° (right)
    const angleL = (Math.PI * 0.75) + swAngle;
    const angleR = (Math.PI * 0.25) + swAngle;

    const targetL = [
      swCenterSeat[0] + R * Math.cos(angleL),
      swCenterSeat[1] + R * Math.sin(angleL) * Math.sin(rake),
      swCenterSeat[2] + R * Math.sin(angleL) * Math.cos(rake),
    ];
    const targetR = [
      swCenterSeat[0] + R * Math.cos(angleR),
      swCenterSeat[1] + R * Math.sin(angleR) * Math.sin(rake),
      swCenterSeat[2] + R * Math.sin(angleR) * Math.cos(rake),
    ];

    const poleL = [-1, 0, -1];
    const poleR = [1, 0, -1];

    const solL = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, poleL);
    const solR = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, poleR);

    leftArmIK = {
      ...solL,
      shoulder: shoulderL,
      vehicleTarget: [solL.target[0] + seatOffset[0], solL.target[1] + seatOffset[1], solL.target[2] + seatOffset[2]],
      vehicleElbow: [solL.elbow[0] + seatOffset[0], solL.elbow[1] + seatOffset[1], solL.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderL[0] + seatOffset[0], shoulderL[1] + seatOffset[1], shoulderL[2] + seatOffset[2]],
    };
    rightArmIK = {
      ...solR,
      shoulder: shoulderR,
      vehicleTarget: [solR.target[0] + seatOffset[0], solR.target[1] + seatOffset[1], solR.target[2] + seatOffset[2]],
      vehicleElbow: [solR.elbow[0] + seatOffset[0], solR.elbow[1] + seatOffset[1], solR.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderR[0] + seatOffset[0], shoulderR[1] + seatOffset[1], shoulderR[2] + seatOffset[2]],
    };

  } else if (seatIndex === 1) {
    // Seat 1 Shotgun: Dynamic grab-bar brace in seat-relative coordinates
    let targetL;
    if (braceActive) {
      const grabVeh = Array.isArray(vs.dashGrabBarPos) && vs.dashGrabBarPos.length >= 3
        ? vs.dashGrabBarPos
        : (isSemi ? SEMI_SEAT_CONSTANTS.dashGrabBarPos : SEAT_CONSTANTS.dashGrabBarPos);
      targetL = [
        grabVeh[0] - seatOffset[0],
        grabVeh[1] - seatOffset[1],
        grabVeh[2] - seatOffset[2],
      ];
    } else {
      targetL = [chestPos[0] - 0.05, chestPos[1] + 0.15, chestPos[2] - 0.20]; // resting on lap
    }

    const solL = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, [-1, 0, -1]);
    leftArmIK = {
      ...solL,
      shoulder: shoulderL,
      vehicleTarget: [solL.target[0] + seatOffset[0], solL.target[1] + seatOffset[1], solL.target[2] + seatOffset[2]],
      vehicleElbow: [solL.elbow[0] + seatOffset[0], solL.elbow[1] + seatOffset[1], solL.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderL[0] + seatOffset[0], shoulderL[1] + seatOffset[1], shoulderL[2] + seatOffset[2]],
    };

    // Right hand rests on outer gunwale
    const targetR = [shoulderR[0] + 0.10, shoulderR[1] + 0.10, shoulderR[2] - 0.20];
    const solR = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, [1, 0, -1]);
    rightArmIK = {
      ...solR,
      shoulder: shoulderR,
      vehicleTarget: [solR.target[0] + seatOffset[0], solR.target[1] + seatOffset[1], solR.target[2] + seatOffset[2]],
      vehicleElbow: [solR.elbow[0] + seatOffset[0], solR.elbow[1] + seatOffset[1], solR.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderR[0] + seatOffset[0], shoulderR[1] + seatOffset[1], shoulderR[2] + seatOffset[2]],
    };

  } else if (seatIndex === 2) {
    // Seat 2 Rear Left: Seated on rear bench, left hand rests on outer gunwale, right hand on lap
    const targetL = [shoulderL[0] - 0.10, shoulderL[1] + 0.10, shoulderL[2] - 0.15];
    const targetR = [shoulderR[0] - 0.05, shoulderR[1] + 0.15, shoulderR[2] - 0.25];
    const solL = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, [-1, 0, -1]);
    const solR = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, [1, 0, -1]);
    leftArmIK = {
      ...solL,
      shoulder: shoulderL,
      vehicleTarget: [solL.target[0] + seatOffset[0], solL.target[1] + seatOffset[1], solL.target[2] + seatOffset[2]],
      vehicleElbow: [solL.elbow[0] + seatOffset[0], solL.elbow[1] + seatOffset[1], solL.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderL[0] + seatOffset[0], shoulderL[1] + seatOffset[1], shoulderL[2] + seatOffset[2]],
    };
    rightArmIK = {
      ...solR,
      shoulder: shoulderR,
      vehicleTarget: [solR.target[0] + seatOffset[0], solR.target[1] + seatOffset[1], solR.target[2] + seatOffset[2]],
      vehicleElbow: [solR.elbow[0] + seatOffset[0], solR.elbow[1] + seatOffset[1], solR.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderR[0] + seatOffset[0], shoulderR[1] + seatOffset[1], shoulderR[2] + seatOffset[2]],
    };
  } else {
    // Seat 3 Rear Right: Seated on rear bench, left hand on lap, right hand on outer gunwale
    const targetL = [shoulderL[0] + 0.05, shoulderL[1] + 0.15, shoulderL[2] - 0.25];
    const targetR = [shoulderR[0] + 0.10, shoulderR[1] + 0.10, shoulderR[2] - 0.15];
    const solL = solveTwoBone(shoulderL, initElbowL, initWristL, targetL, [-1, 0, -1]);
    const solR = solveTwoBone(shoulderR, initElbowR, initWristR, targetR, [1, 0, -1]);
    leftArmIK = {
      ...solL,
      shoulder: shoulderL,
      vehicleTarget: [solL.target[0] + seatOffset[0], solL.target[1] + seatOffset[1], solL.target[2] + seatOffset[2]],
      vehicleElbow: [solL.elbow[0] + seatOffset[0], solL.elbow[1] + seatOffset[1], solL.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderL[0] + seatOffset[0], shoulderL[1] + seatOffset[1], shoulderL[2] + seatOffset[2]],
    };
    rightArmIK = {
      ...solR,
      shoulder: shoulderR,
      vehicleTarget: [solR.target[0] + seatOffset[0], solR.target[1] + seatOffset[1], solR.target[2] + seatOffset[2]],
      vehicleElbow: [solR.elbow[0] + seatOffset[0], solR.elbow[1] + seatOffset[1], solR.elbow[2] + seatOffset[2]],
      vehicleShoulder: [shoulderR[0] + seatOffset[0], shoulderR[1] + seatOffset[1], shoulderR[2] + seatOffset[2]],
    };
  }

  return {
    isOlthoi: false,
    seatIndex,
    scale,
    chestPos,
    shoulderL,
    shoulderR,
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
 * 0.35s smooth seat-to-seat slide interpolation for hot-swaps between seats 0..3.
 * Includes a subtle vertical clearance arc over the center transmission tunnel.
 */
export function interpolateSeatHotSwap(fromSeat, toSeat, t, profileOrOpts = null) {
  const u = Math.min(1.0, Math.max(0.0, typeof t === "number" ? t : 0.0));
  // Smoothstep easing: S(u) = 3u^2 - 2u^3
  const s = u * u * (3.0 - 2.0 * u);

  const p0 = getSeatOffset(fromSeat, profileOrOpts);
  const p1 = getSeatOffset(toSeat, profileOrOpts);

  const x = p0[0] + (p1[0] - p0[0]) * s;
  const y = p0[1] + (p1[1] - p0[1]) * s;
  // Arc lift up to +0.08m over central hump
  const arc = 0.08 * Math.sin(Math.PI * u);
  const z = p0[2] + (p1[2] - p0[2]) * s + arc;

  const result = [x, y, z];
  result.pos = [x, y, z];
  result.duration = SEAT_CONSTANTS.splineDurations.hotSwapSec;
  result.progress = u;
  result.fromSeat = fromSeat;
  result.toSeat = toSeat;
  return result;
}

/**
 * Evaluates the boarding, exit, or hot-swap spline for an occupant.
 * Respects ?vehicleBoardAnim=off flag for instant snap.
 */
export function evaluateBoardingSpline(seatIndex, action, progress, search = "", profileOrOpts = null) {
  if (!boardAnimEnabled(search)) {
    return { progress: 1.0, duration: 0.0, snapped: true };
  }
  const u = Math.min(1.0, Math.max(0.0, progress));
  const seatPos = getSeatOffset(seatIndex, profileOrOpts);
  const isSemi = isSemiProfile(profileOrOpts);
  let duration = SEAT_CONSTANTS.splineDurations.frontIngressSec;
  let groundPos;

  if (action === "hotswap" || action === "hot-swap") {
    return interpolateSeatHotSwap(seatIndex, 0, u, profileOrOpts);
  }

  if (action === "egress") {
    duration = SEAT_CONSTANTS.splineDurations.egressSec;
    const xOut = isSemi ? 1.35 : 1.25;
    groundPos = [seatPos[0] < 0 ? -xOut : xOut, seatPos[1], 0.0];
    const pt = hopPoint(
      { x: seatPos[0], y: seatPos[1], z: seatPos[2] },
      { x: groundPos[0], y: groundPos[1], z: groundPos[2] },
      u,
      0.3
    );
    return { pos: [pt.x, pt.y, pt.z], duration, snapped: false };
  }

  // Ingress
  const xIn = isSemi ? 1.35 : 1.15;
  if (seatIndex >= 2 && !isSemi) {
    duration = SEAT_CONSTANTS.splineDurations.rearIngressSec;
    groundPos = [seatPos[0] < 0 ? -xIn : xIn, -1.2, 0.0];
  } else {
    duration = SEAT_CONSTANTS.splineDurations.frontIngressSec;
    groundPos = [seatPos[0] < 0 ? -xIn : xIn, isSemi ? seatPos[1] : 0.0, 0.0];
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

/**
 * Helper to safely set position on an entity part node.
 */
function setPartPos(part, x, y, z) {
  if (!part) return;
  if (part.position && typeof part.position.set === "function") {
    part.position.set(x, y, z);
  } else if (part.position && typeof part.position === "object") {
    part.position.x = x; part.position.y = y; part.position.z = z;
  } else {
    part.position = { x, y, z };
  }
}

/**
 * Helper to safely set quaternion on an entity part node.
 */
function setPartQuat(part, x, y, z, w) {
  if (!part) return;
  if (part.quaternion && typeof part.quaternion.set === "function") {
    part.quaternion.set(x, y, z, w);
  } else if (part.quaternion && typeof part.quaternion === "object") {
    part.quaternion.x = x; part.quaternion.y = y; part.quaternion.z = z; part.quaternion.w = w;
  } else {
    part.quaternion = { x, y, z, w };
  }
}

/**
 * Helper to set Euler angles on a part via quaternion rotation.
 */
function setPartEuler(part, pitchRad, yawRad, rollRad) {
  if (!part) return;
  const c1 = Math.cos(pitchRad * 0.5), s1 = Math.sin(pitchRad * 0.5);
  const c2 = Math.cos(yawRad * 0.5), s2 = Math.sin(yawRad * 0.5);
  const c3 = Math.cos(rollRad * 0.5), s3 = Math.sin(rollRad * 0.5);
  // Pitch (X), Yaw (Z), Roll (Y) composition
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  setPartQuat(part, qx, qy, qz, qw);
}

/**
 * Applies 34-part skeleton IK transforms to an entity instance seated in a vehicle.
 *
 * @param {object} entityInst - AC EntityInstance or mock with root & parts[0..33]
 * @param {number} seatIndex - 0: Driver, 1: Shotgun, 2: Rear Left, 3: Rear Right
 * @param {object} vehiclePose - { x, y, z, heading, pitch, roll, bank, q }
 * @param {object} vehicleKinematics - { steerAngle, speed, accelLong, accelLat, yawRate }
 * @param {number} dt - delta time seconds
 * @returns {object} { seatPose, seatIndex, seatOffset, setupId, braceActive }
 */
export function applySeatPoseToEntity(entityInst, seatIndex, vehiclePose = {}, vehicleKinematics = {}, dt = 0.016) {
  if (!entityInst) return null;

  const kin = vehicleKinematics && typeof vehicleKinematics === "object" ? vehicleKinematics : {};
  const vPose = vehiclePose && typeof vehiclePose === "object" ? vehiclePose : {};
  const profCtx = kin.profile ?? vPose.profile ?? (isSemiProfile(kin) ? kin : (isSemiProfile(vPose) ? vPose : null));
  const maxIdx = isSemiProfile(profCtx) ? 2 : 4;
  const sIdx = (typeof seatIndex === "number" && seatIndex >= 0 && seatIndex < maxIdx) ? Math.trunc(seatIndex) : 0;
  const setupId = entityInst.setupId || entityInst._setupId || entityInst.meta?.setupId || entityInst.meta?.modelId || "0x02000001";
  const seatOffset = Array.isArray(kin.seatOffset) && kin.seatOffset.length >= 3
    ? kin.seatOffset
    : getSeatOffset(sIdx, profCtx);
  const kinWithProf = profCtx ? { ...kin, profile: profCtx, seatOffset } : kin;
  const seatPose = computeSeatPose(sIdx, setupId, kinWithProf);

  const vx = vehiclePose.x ?? vehiclePose.pos?.[0] ?? 0;
  const vy = vehiclePose.y ?? vehiclePose.pos?.[1] ?? 0;
  const vz = vehiclePose.z ?? vehiclePose.pos?.[2] ?? 0;
  const heading = vehiclePose.heading || 0;
  const pitch = vehiclePose.pitch || 0;
  const roll = vehiclePose.roll || vehiclePose.bank || 0;

  // 1. Determine vehicle attitude quaternion qVeh = [qw, qx, qy, qz]
  const qVeh = (vehiclePose.q && Array.isArray(vehiclePose.q) && vehiclePose.q.length === 4)
    ? vehiclePose.q
    : (vehiclePose.orientation && Array.isArray(vehiclePose.orientation) && vehiclePose.orientation.length === 4)
      ? vehiclePose.orientation
      : eulerToQuat(heading, pitch, roll);

  // Position and orient the entity's root node in full 3D world space
  if (entityInst.root) {
    const rSeat = rotateVecByQuat(qVeh, seatOffset);
    setPartPos(entityInst.root, vx + rSeat[0], vy + rSeat[1], vz + rSeat[2]);

    // Wire format [qw, qx, qy, qz] -> THREE [qx, qy, qz, qw]
    setPartQuat(entityInst.root, qVeh[1], qVeh[2], qVeh[3], qVeh[0]);
  }

  // 2. Pose the 34-part skeleton rig if parts array is present
  const parts = entityInst.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const isHumanoid = !seatPose.isOlthoi;

    if (isHumanoid) {
      // --- Lower Body: 90° seated hip and knee flexion ---
      // Part 0: Pelvis anchor
      setPartPos(parts[0], 0, 0, 0.45);

      // Part 1 (Left Thigh) & Part 5 (Right Thigh): rotated +90° forward (+X pitch)
      const hipFlexRad = Math.PI * 0.5;
      setPartEuler(parts[1], hipFlexRad, 0, -0.05);
      setPartEuler(parts[5], hipFlexRad, 0, 0.05);

      // Parts 25 & 26 (Thigh overlays) track thighs
      setPartEuler(parts[25], hipFlexRad, 0, -0.05);
      setPartEuler(parts[26], hipFlexRad, 0, 0.05);

      // Part 2 (Left Shin/Knee) & Part 6 (Right Shin/Knee): bent -90° down
      const kneeFlexRad = -Math.PI * 0.5;
      setPartEuler(parts[2], kneeFlexRad, 0, 0);
      setPartEuler(parts[6], kneeFlexRad, 0, 0);

      // Parts 3, 4, 7, 8: Ankles and Toes resting level on floorboard
      setPartEuler(parts[3], 0, 0, 0);
      setPartEuler(parts[4], 0, 0, 0);
      setPartEuler(parts[7], 0, 0, 0);
      setPartEuler(parts[8], 0, 0, 0);

      // --- Torso / Chest (Part 9 & Part 29 overlay) ---
      let torsoPitch = 0.05;
      let torsoRoll = 0.0;
      let torsoYaw = 0.0;

      if (sIdx === 0) {
        // Driver: slight forward posture towards steering column
        torsoPitch = 0.08;
      } else if (sIdx === 1) {
        // Shotgun: dynamic forward lean under grab-bar brace
        torsoPitch = seatPose.braceActive ? 0.18 : 0.04;
      } else {
        // Rear passengers (Seats 2 & 3): torso sways with chassis pitch/roll
        const aLong = vehicleKinematics.accelLong || 0;
        const aLat = vehicleKinematics.accelLat || 0;
        torsoPitch = -pitch * 0.4 - aLong * 0.025;
        torsoRoll = -roll * 0.4 - aLat * 0.020;
      }
      setPartEuler(parts[9], torsoPitch, torsoYaw, torsoRoll);
      setPartEuler(parts[29], torsoPitch, torsoYaw, torsoRoll);

      // --- Head (Part 16) ---
      if (sIdx === 0) {
        // Driver: head dynamically tracks steering angle
        const steerAngle = vehicleKinematics.steerAngle || 0;
        const headYaw = steerAngle * 0.45;
        setPartEuler(parts[16], 0, headYaw, 0);
      } else if (sIdx === 1) {
        setPartEuler(parts[16], seatPose.braceActive ? 0.10 : 0, 0, 0);
      } else {
        setPartEuler(parts[16], -torsoPitch * 0.5, 0, -torsoRoll * 0.5);
      }

      // --- Upper Limbs (Two-Bone IK solved in computeSeatPose) ---
      // Left Arm: Parts 10 (Upper), 11 (Fore), 12 (Hand), 27 (Overlay)
      if (seatPose.leftArmIK) {
        const ik = seatPose.leftArmIK;
        const sh = ik.shoulder || seatPose.shoulderL;
        const el = ik.elbow;
        const tg = ik.target;

        // Upper arm segment: originates at shoulder (sh), points toward elbow (el)
        setPartPos(parts[10], sh[0], sh[1], sh[2]);
        setPartPos(parts[27], sh[0], sh[1], sh[2]);

        const uUpper = vNorm(vSub(el, sh));
        const qUpper = quatFromTo([0, 0, -1], uUpper);
        setPartQuat(parts[10], qUpper[0], qUpper[1], qUpper[2], qUpper[3]);
        setPartQuat(parts[27], qUpper[0], qUpper[1], qUpper[2], qUpper[3]);

        // Forearm segment: originates at elbow (el), points toward target (tg)
        setPartPos(parts[11], el[0], el[1], el[2]);
        const uFore = vNorm(vSub(tg, el));
        const qFore = quatFromTo([0, 0, -1], uFore);
        setPartQuat(parts[11], qFore[0], qFore[1], qFore[2], qFore[3]);

        // Hand: placed at target wrist grip point (tg), aligned with forearm
        setPartPos(parts[12], tg[0], tg[1], tg[2]);
        setPartQuat(parts[12], qFore[0], qFore[1], qFore[2], qFore[3]);
      }

      // Right Arm: Parts 13 (Upper), 14 (Fore), 15 (Hand), 28 (Overlay)
      if (seatPose.rightArmIK) {
        const ik = seatPose.rightArmIK;
        const sh = ik.shoulder || seatPose.shoulderR;
        const el = ik.elbow;
        const tg = ik.target;

        // Upper arm segment: originates at shoulder (sh), points toward elbow (el)
        setPartPos(parts[13], sh[0], sh[1], sh[2]);
        setPartPos(parts[28], sh[0], sh[1], sh[2]);

        const uUpper = vNorm(vSub(el, sh));
        const qUpper = quatFromTo([0, 0, -1], uUpper);
        setPartQuat(parts[13], qUpper[0], qUpper[1], qUpper[2], qUpper[3]);
        setPartQuat(parts[28], qUpper[0], qUpper[1], qUpper[2], qUpper[3]);

        // Forearm segment: originates at elbow (el), points toward target (tg)
        setPartPos(parts[14], el[0], el[1], el[2]);
        const uFore = vNorm(vSub(tg, el));
        const qFore = quatFromTo([0, 0, -1], uFore);
        setPartQuat(parts[14], qFore[0], qFore[1], qFore[2], qFore[3]);

        // Hand: placed at target wrist grip point (tg), aligned with forearm
        setPartPos(parts[15], tg[0], tg[1], tg[2]);
        setPartQuat(parts[15], qFore[0], qFore[1], qFore[2], qFore[3]);
      }

      // --- Cloak, Robes, and Tail Tucking (Parts 17..20, 30..33) ---
      // Tucked cleanly against seat cushion to prevent chassis clipping
      for (const pi of [17, 18, 19, 20, 30, 31, 32, 33]) {
        if (parts[pi]) {
          setPartEuler(parts[pi], -0.2, 0, 0);
        }
      }
    }
  }

  return {
    seatPose,
    seatIndex: sIdx,
    seatOffset,
    setupId,
    braceActive: seatPose.braceActive,
  };
}
