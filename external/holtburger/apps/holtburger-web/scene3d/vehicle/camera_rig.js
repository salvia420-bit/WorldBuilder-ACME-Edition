// scene3d/vehicle/camera_rig.js — 3-mode dynamic fighter camera rig ("chase", "cockpit", "hood"),
// physiological G-load estimator, speed-scaled FOV, and deterministic multi-source harmonic airframe shake.
//
// Pure / injected module: no DOM, no three, no Math.random() (coherent phase accumulators only).

import * as FM from "./flight_model.js";

export const VIEW_MODES = Object.freeze(["chase", "cockpit", "hood"]);

export function nextViewMode(cur) {
  const idx = VIEW_MODES.indexOf(cur);
  return VIEW_MODES[(idx + 1) % VIEW_MODES.length];
}

export const DEFAULT_CHASE = Object.freeze({
  back: 16,
  up: 4.5,
  lookAhead: 30,
  pitch: -0.12,
  fov: 70,
  headingTau: 0.25,
  pitchTau: 0.14,
  rollTau: 0.14,
  groundClear: 2,
  groundAttackTau: 0.06,
  groundReleaseTau: 0.28,
});

/**
 * Dedicated WWII 4x4 Ground Vehicle chase camera configuration:
 * tight framing (5.4m back, 1.95m up, 7.5m lookAhead, 62° base FOV).
 */
export const DEFAULT_GROUND_CHASE = Object.freeze({
  back: 5.4,
  up: 1.95,
  lookAhead: 7.5,
  pitch: -0.06,
  fov: 62,
  headingTau: 0.18,
  pitchTau: 0.12,
  rollTau: 0.12,
  groundClear: 0.6,
  groundAttackTau: 0.05,
  groundReleaseTau: 0.22,
});

/**
 * Class 8 Conventional Semi-Tractor ("Ironhorse 379") chase camera configuration:
 * elevated framing over sleeper/headache rack & fifth-wheel (10.8m back, 3.8m up, 12.0m lookAhead, 64° base FOV).
 */
export const DEFAULT_SEMI_CHASE = Object.freeze({
  back: 10.8,
  up: 3.8,
  lookAhead: 12.0,
  pitch: -0.08,
  fov: 64,
  headingTau: 0.20,
  pitchTau: 0.14,
  rollTau: 0.14,
  groundClear: 0.9,
  groundAttackTau: 0.05,
  groundReleaseTau: 0.24,
});

export const SEMI_TRAILER_CHASE = Object.freeze({
  "20ft": Object.freeze({ back: 17.5, up: 3.8 }),
  "40ft": Object.freeze({ back: 22.5, up: 5.6 }),
});

/**
 * Seated eye offset in the F6F Hellcat cockpit:
 * seat z (2.34 m) + up (1.24 m) = 3.58 m — aligns eye directly through the armored windscreen
 * and Mk 8 Reflector Gunsight (z ≈ 3.56..3.58 m).
 */
export const COCKPIT_EYE = Object.freeze({ right: 0, forward: 0.16, up: 1.24, fov: 76 });

/**
 * Calibrated per-seat eye anchors for 1943 Willys MB 1/4-ton 4x4 Jeep (relative to vehicle center):
 * Seat 0 (Driver Front-Left):  [-0.38, -0.18, 0.62 + 0.68] = [-0.38, -0.18, 1.30] behind 3-spoke wheel over gauges & windscreen
 * Seat 1 (Shotgun Front-Right): [+0.38, -0.18, 0.62 + 0.68] = [+0.38, -0.18, 1.30] behind dash grab-bar
 * Seats 2 & 3 (Rear Bench):    [±0.36, -0.96, 0.68 + 0.68] = [±0.36, -0.96, 1.36] looking forward past front seats
 */
export const GROUND_CAB_EYES = Object.freeze([
  Object.freeze({ right: -0.38, forward: -0.18, up: 1.30, fov: 70 }),
  Object.freeze({ right:  0.38, forward: -0.18, up: 1.30, fov: 70 }),
  Object.freeze({ right: -0.36, forward: -0.96, up: 1.36, fov: 70 }),
  Object.freeze({ right:  0.36, forward: -0.96, up: 1.36, fov: 70 }),
]);

/**
 * Calibrated 2-seat Day-Cab eye anchors for semi-379 (seat cushion z=1.72 + 0.68 = 2.40 m).
 */
export const SEMI_CAB_EYES = Object.freeze([
  Object.freeze({ right: -0.52, forward: 0.28, up: 2.40, fov: 70 }),
  Object.freeze({ right:  0.52, forward: 0.28, up: 2.40, fov: 70 }),
]);

/**
 * Over-the-cowling / gun-camera view: Sea-Blue radial nose, spinning prop disc, and wing gunfire in periphery.
 */
export const HOOD_EYE = Object.freeze({ right: 0, forward: 1.28, up: 1.10, fov: 74 });

/**
 * Hood-star rally camera for Willys MB ground vehicle: [0, +0.55, +1.18], FOV 66°.
 */
export const GROUND_HOOD_EYE = Object.freeze({ right: 0, forward: 0.55, up: 1.18, fov: 66 });

/**
 * Long-hood cowl camera for semi-379: [0, +1.55, +2.18], FOV 66°.
 */
export const SEMI_HOOD_EYE = Object.freeze({ right: 0, forward: 1.55, up: 2.18, fov: 66 });

function normalizeTrailerKind(k) {
  if (k === "40ft" || k === 40 || k === 14 || k === 4000031 || k === "Chassis40ft" || k === "TrailerChassis40") {
    return "40ft";
  }
  if (k === "20ft" || k === 20 || k === 13 || k === 4000030 || k === "Chassis20ft" || k === "TrailerChassis20") {
    return "20ft";
  }
  return null;
}

const TWO_PI = 2 * Math.PI;
const G_MIN = -2.5;
const G_MAX = 6.0;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  let d = a % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d === 0 ? 0 : d;
}

function angleDiff(a, b) {
  return wrapPi((Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0));
}

function unwrapNear(a, ref) {
  if (!Number.isFinite(ref)) return wrapPi(a);
  if (!Number.isFinite(a)) return ref;
  return ref + wrapPi(a - ref);
}

/** Multiply two AC quaternions [w, x, y, z]. */
function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Extract AC gimbal angles {h, p, r} from AC quaternion [w, x, y, z] (consistent with film/core/gimbal.js). */
function hprFromQuat(q, headingHint = 0, rollHint = 0) {
  const hint = Number.isFinite(headingHint) ? headingHint : 0;
  if (!q || q.length < 4) return { h: hint, p: 0, r: 0 };
  let [w, x, y, z] = q;
  const len = Math.hypot(w, x, y, z);
  if (!(len > 0) || !Number.isFinite(len)) return { h: hint, p: 0, r: 0 };
  w /= len; x /= len; y /= len; z /= len;
  const fx = 2 * (x * y - w * z), fy = 1 - 2 * (x * x + z * z), fz = 2 * (y * z + w * x);
  const ux = 2 * (x * z + w * y), uy = 2 * (y * z - w * x), uz = 1 - 2 * (x * x + y * y);
  const horiz = Math.hypot(fx, fy);
  const p = Math.atan2(fz, horiz);
  const h = horiz < 1e-6 ? hint : unwrapNear(Math.atan2(fx, fy), hint);
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  const sinR = ux * ch - uy * sh;
  const cosR = -ux * sh * sp - uy * ch * sp + uz * cp;
  const r = unwrapNear(Math.atan2(sinR, cosR), rollHint);
  return { h: FM.wrapHeading(h), p, r };
}

/**
 * Compute normal load factor `gLoad` in [-2.5, +6.0]:
 * combines coordinated turn bank load `1 / max(0.35, cos(bank))` with vertical pitch-pull `(speed * pitchRate) / 9.8`.
 * When `prevG` is provided, applies smooth first-order filtering (`tau` s).
 */
export function computeGLoad(prevPose, pose, dt, prevG = null, tau = 0.10) {
  if (!pose || typeof pose !== "object") return Number.isFinite(prevG) ? prevG : 1.0;
  const speed = Number.isFinite(pose.speed) ? pose.speed : 0;
  const parked = pose.mode === FM.MODE.PARKED || pose.mode === FM.MODE.CRASHED || speed < 5;
  let instG = 1.0;
  if (!parked) {
    const bank = Number.isFinite(pose.bank) ? pose.bank : 0;
    const speedAuth = clamp(speed / 25, 0, 1);
    const bankLoad = 1 + (1 / Math.max(0.35, Math.cos(bank)) - 1) * speedAuth;
    let pitchPull = 0;
    if (prevPose && typeof prevPose === "object" && Number.isFinite(dt) && dt > 1e-4) {
      const p0 = Number.isFinite(prevPose.pitch) ? prevPose.pitch : 0;
      const p1 = Number.isFinite(pose.pitch) ? pose.pitch : 0;
      const pitchRate = (p1 - p0) / dt;
      pitchPull = (speed * pitchRate) / FM.GRAVITY;
    }
    instG = clamp(bankLoad + pitchPull, G_MIN, G_MAX);
  }
  if (Number.isFinite(prevG) && Number.isFinite(dt) && dt > 0 && tau > 0) {
    const a = 1 - Math.exp(-dt / tau);
    return clamp(prevG + (instG - prevG) * a, G_MIN, G_MAX);
  }
  return instG;
}

/**
 * @param {{ground?: (x:number, y:number)=>number, chaseCfg?: object, initialView?: string}} [opts]
 */
export function createPilotCameraRig(opts = {}) {
  const ground = typeof opts.ground === "function" ? opts.ground : () => NaN;
  const cfg = { ...DEFAULT_CHASE, ...(opts.chaseCfg || {}) };

  let view = VIEW_MODES.includes(opts.initialView) ? opts.initialView : "chase";
  let seatIndex = opts.seatIndex ?? 0;
  let activeTrailerKind = normalizeTrailerKind(opts.hitchedTrailerKind ?? null);
  let chaseBack = null;
  let chaseUp = null;
  let camHeading = null;
  let camPitch = null;
  let camRoll = null;
  let camLift = 0;
  let longLag = 0;
  let fovBoost = 0;
  let gLoad = 1.0;
  let headSink = 0;
  let headPitchLag = 0;
  let headRollLag = 0;
  let prevPose = null;
  let bumpOffset = 0;
  let bumpVel = 0;
  let prevVertSpeed = 0;
  let joltEnv = 0;
  let joltPitch = 0;
  let joltRoll = 0;

  // Deterministic coherent shake state
  let shakePhase = 0;
  let gunEnv = 0;
  let wepEnv = 0;

  function triggerJolt(impulse = 1.0) {
    const val = Number.isFinite(impulse) ? impulse : 1.0;
    joltEnv = clamp(joltEnv + val, 0, 3.0);
    joltPitch += (Math.sin(shakePhase * 17) * 0.08 + 0.05) * val;
    joltRoll += Math.cos(shakePhase * 13) * 0.06 * val;
  }

  function reset(heading = null) {
    camHeading = Number.isFinite(heading) ? FM.wrapHeading(heading) : null;
    camPitch = null;
    camRoll = null;
    camLift = 0;
    chaseBack = null;
    chaseUp = null;
    longLag = 0;
    fovBoost = 0;
    gLoad = 1.0;
    headSink = 0;
    headPitchLag = 0;
    headRollLag = 0;
    prevPose = null;
    bumpOffset = 0;
    bumpVel = 0;
    prevVertSpeed = 0;
    joltEnv = 0;
    joltPitch = 0;
    joltRoll = 0;
    gunEnv = 0;
    wepEnv = 0;
  }

  function setView(mode) {
    if (VIEW_MODES.includes(mode)) {
      view = mode;
      if (mode === "chase") {
        camPitch = null;
        camRoll = null;
      }
    }
    return view;
  }

  function cycleView() {
    return setView(nextViewMode(view));
  }

  /**
   * Advance camera rig one render frame.
   * @param {{seat: object, pose: object, params?: object, controlsStatus?: object, dt?: number, firing?: boolean, explosionShake?: number, camTweak?: object|null, seatIndex?: number|null, collisionJolt?: number, jolt?: number}} arg
   */
  function step({
    seat,
    pose,
    params = null,
    controlsStatus = null,
    dt = 1 / 60,
    firing = false,
    explosionShake = 0,
    camTweak = null,
    seatIndex: stepSeatIndex = null,
    collisionJolt = 0,
    jolt = 0,
    hitchedTrailerKind = undefined,
    vehicleClass = undefined,
    profileKey = undefined,
  }) {
    const stepDt = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    const isGround = (params?.locomotion === 2) || (opts.locomotion === 2);
    const effVehicleClass = vehicleClass ?? params?.vehicleClass ?? opts.vehicleClass ?? 0;
    const effProfileKey = profileKey ?? params?.profileKey ?? opts.profileKey ?? "";
    const isHeavySemi = effVehicleClass === 3 || effProfileKey === "semi-379";
    const vMaxGround = (Number.isFinite(params?.vMaxRoad) && params.vMaxRoad > 0)
      ? params.vMaxRoad
      : ((Number.isFinite(params?.vMax) && params.vMax > 0) ? params.vMax : (isHeavySemi ? 27.0 : 29.0));
    const trailerKind = normalizeTrailerKind(
      hitchedTrailerKind !== undefined
        ? hitchedTrailerKind
        : (pose?.hitchedTrailerKind ?? params?.hitchedTrailerKind ?? activeTrailerKind ?? opts.hitchedTrailerKind),
    );
    const curSeat = clamp(Math.round(stepSeatIndex ?? (controlsStatus?.seatIndex ?? seatIndex)), 0, isHeavySemi ? 1 : 3);
    const joltIn = Number(collisionJolt) || Number(jolt) || 0;
    if (joltIn > 0) triggerJolt(joltIn);

    const p = pose || { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: FM.MODE.PARKED };
    const sx = Number.isFinite(seat?.x) ? seat.x : (p.x || 0);
    const sy = Number.isFinite(seat?.y) ? seat.y : (p.y || 0);
    const sz = Number.isFinite(seat?.z) ? seat.z : (p.z || 0);
    const qSeat = Array.isArray(seat?.q) && seat.q.length === 4
      ? seat.q
      : FM.orientation(p.heading || 0, p.pitch || 0, p.bank || 0);

    // 1. Physiological G-load
    gLoad = computeGLoad(prevPose, p, stepDt, prevPose ? gLoad : null, 0.10);

    // Angular rates for subtle cockpit head inertia
    let pitchRate = 0;
    let rollRateActual = 0;
    let accel = 0;
    if (prevPose && stepDt > 1e-4) {
      pitchRate = ((p.pitch || 0) - (prevPose.pitch || 0)) / stepDt;
      rollRateActual = angleDiff(p.bank || 0, prevPose.bank || 0) / stepDt;
      accel = ((p.speed || 0) - (prevPose.speed || 0)) / stepDt;
    }

    const boost = !!(controlsStatus?.boost);
    const firingNow = !!(firing || controlsStatus?.fire);
    const flYaw = Number.isFinite(controlsStatus?.freelook?.yaw) ? controlsStatus.freelook.yaw : 0;
    const flPitch = Number.isFinite(controlsStatus?.freelook?.pitch) ? controlsStatus.freelook.pitch : 0;

    // Suspension bump spring filter
    if (isGround && stepDt > 0) {
      const kSpring = 240;
      const kDamp = 18;
      let bumpImpulse = 0;
      if (prevPose && stepDt > 1e-4) {
        const vertSpeed = (sz - (prevPose.sz ?? sz)) / stepDt;
        const dVert = vertSpeed - prevVertSpeed;
        bumpImpulse = clamp(dVert * 0.012, -0.25, 0.25);
        prevVertSpeed = vertSpeed;
      }
      bumpVel += (-kSpring * bumpOffset - kDamp * bumpVel + (bumpImpulse / stepDt)) * stepDt;
      bumpOffset += bumpVel * stepDt;
      bumpOffset = clamp(bumpOffset, -0.15, 0.15);
    } else {
      bumpOffset = 0;
      bumpVel = 0;
      prevVertSpeed = 0;
    }

    if (stepDt > 0) {
      joltEnv *= Math.exp(-stepDt / 0.15);
      joltPitch *= Math.exp(-stepDt / 0.12);
      joltRoll *= Math.exp(-stepDt / 0.12);
    }

    // 2. Speed-scaled FOV
    const speed = Number.isFinite(p.speed) ? p.speed : 0;
    const vMin = Number.isFinite(params?.vMin) && params.vMin > 0 ? params.vMin : 30;
    const vCruise = Number.isFinite(params?.vCruise) && params.vCruise > 0 ? params.vCruise : 83;
    if (isGround) {
      const groundSpeed = Math.abs(speed);
      const speedFrac = clamp(groundSpeed / vMaxGround, 0, 1);
      const wantFovBoost = speedFrac * 6.0;
      const aFov = stepDt > 0 ? 1 - Math.exp(-stepDt / 0.16) : 1;
      fovBoost += (wantFovBoost - fovBoost) * aFov;
    } else {
      const vMax = Number.isFinite(params?.vMax) && params.vMax > vCruise ? params.vMax : Math.max(vCruise + 14, 97);
      const overCruise = speed > vCruise ? clamp((speed - vCruise) / Math.max(5, vMax - vCruise), 0, 1.1) : 0;
      const wantFovBoost = clamp(overCruise * 5.5 + (boost && speed > 5 ? 2.0 : 0), 0, 7.5);
      const aFov = stepDt > 0 ? 1 - Math.exp(-stepDt / 0.16) : 1;
      fovBoost += (wantFovBoost - fovBoost) * aFov;
    }

    // 3. Mode-specific camera framing
    let camPos;
    let camH;
    let camP;
    let camR;
    let baseFov;

    if (view === "cockpit") {
      const wantSink = clamp(-0.018 * (gLoad - 1.0), -0.09, 0.03);
      const aHead = stepDt > 0 ? 1 - Math.exp(-stepDt / 0.10) : 1;
      headSink += (wantSink - headSink) * aHead;
      headPitchLag += (clamp(-pitchRate * 0.03, -0.045, 0.045) - headPitchLag) * aHead;
      headRollLag += (clamp(-rollRateActual * 0.035, -0.06, 0.06) - headRollLag) * aHead;

      if (isGround) {
        const cabEyes = isHeavySemi ? SEMI_CAB_EYES : GROUND_CAB_EYES;
        const cabEye = cabEyes[curSeat] || cabEyes[0];
        // Seats 2 & 3: rear bench looking forward past front seats with unconstrained head-turn (±155° yaw, ±65° pitch)
        const maxYaw = 155 * Math.PI / 180;
        const maxPitch = 65 * Math.PI / 180;
        const boundedFlYaw = clamp(flYaw, -maxYaw, maxYaw);
        const boundedFlPitch = clamp(flPitch, -maxPitch, maxPitch);

        const qPose = FM.orientation(p.heading || 0, p.pitch || 0, p.bank || 0);
        const eye = FM.rotate(qPose, [cabEye.right, cabEye.forward, cabEye.up + headSink + bumpOffset]);
        camPos = [p.x + eye[0], p.y + eye[1], p.z + eye[2] + joltEnv * 0.06];
        const qHead = FM.orientation(boundedFlYaw, boundedFlPitch + headPitchLag + joltPitch, headRollLag + joltRoll);
        const hpr = hprFromQuat(qMul(qPose, qHead), (p.heading || 0) + boundedFlYaw, p.bank || 0);
        camH = hpr.h;
        camP = hpr.p;
        camR = hpr.r;
        baseFov = cabEye.fov;
      } else {
        const eye = FM.rotate(qSeat, [COCKPIT_EYE.right, COCKPIT_EYE.forward, COCKPIT_EYE.up + headSink]);
        camPos = [sx + eye[0], sy + eye[1], sz + eye[2]];
        const qPose = FM.orientation(p.heading || 0, p.pitch || 0, p.bank || 0);
        const qHead = FM.orientation(flYaw, flPitch + headPitchLag, headRollLag);
        const hpr = hprFromQuat(qMul(qPose, qHead), (p.heading || 0) + flYaw, p.bank || 0);
        camH = hpr.h;
        camP = hpr.p;
        camR = hpr.r;
        baseFov = COCKPIT_EYE.fov;
      }
    } else if (view === "hood") {
      if (isGround) {
        const hoodEye = isHeavySemi ? SEMI_HOOD_EYE : GROUND_HOOD_EYE;
        const qPose = FM.orientation(p.heading || 0, p.pitch || 0, p.bank || 0);
        const eye = FM.rotate(qPose, [hoodEye.right, hoodEye.forward, hoodEye.up + bumpOffset]);
        camPos = [p.x + eye[0], p.y + eye[1], p.z + eye[2] + joltEnv * 0.06];
        const qHead = FM.orientation(flYaw, flPitch + joltPitch, joltRoll);
        const hpr = hprFromQuat(qMul(qPose, qHead), (p.heading || 0) + flYaw, p.bank || 0);
        camH = hpr.h;
        camP = hpr.p;
        camR = hpr.r;
        baseFov = hoodEye.fov;
      } else {
        const eye = FM.rotate(qSeat, [HOOD_EYE.right, HOOD_EYE.forward, HOOD_EYE.up]);
        camPos = [sx + eye[0], sy + eye[1], sz + eye[2]];
        const qPose = FM.orientation(p.heading || 0, p.pitch || 0, p.bank || 0);
        const qHead = FM.orientation(flYaw, flPitch, 0);
        const hpr = hprFromQuat(qMul(qPose, qHead), (p.heading || 0) + flYaw, p.bank || 0);
        camH = hpr.h;
        camP = hpr.p;
        camR = hpr.r;
        baseFov = HOOD_EYE.fov;
      }
    } else {
      // Dynamic "chase" mode
      const baseGroundCfg = isHeavySemi ? DEFAULT_SEMI_CHASE : DEFAULT_GROUND_CHASE;
      const activeCfg = isGround ? { ...baseGroundCfg, ...(opts.chaseCfg || {}) } : cfg;
      const trailerZoom = (isGround && isHeavySemi && trailerKind) ? SEMI_TRAILER_CHASE[trailerKind] : null;
      const wantBack = trailerZoom ? trailerZoom.back : activeCfg.back;
      const wantUp = trailerZoom ? trailerZoom.up : activeCfg.up;
      if (chaseBack === null || chaseUp === null || !Number.isFinite(chaseBack) || !Number.isFinite(chaseUp)) {
        chaseBack = wantBack;
        chaseUp = wantUp;
      } else if (stepDt > 0) {
        const aZoom = 1 - Math.exp(-stepDt / 0.35);
        chaseBack += (wantBack - chaseBack) * aZoom;
        chaseUp += (wantUp - chaseUp) * aZoom;
      } else {
        chaseBack = wantBack;
        chaseUp = wantUp;
      }

      const hdg = p.heading || 0;
      if (camHeading === null || !Number.isFinite(camHeading)) {
        camHeading = FM.wrapHeading(hdg);
      } else if (stepDt > 0) {
        camHeading = FM.wrapHeading(camHeading + angleDiff(hdg, camHeading) * (1 - Math.exp(-stepDt / activeCfg.headingTau)));
      }

      // Longitudinal spring lag
      const accelRef = Math.max(1, params?.accel ?? (isGround ? 5 : 8));
      const decelRef = Math.max(1, params?.decel ?? (isGround ? 8 : 12));
      const accelTerm = accel >= 0
        ? clamp(accel / accelRef, 0, 1) * (isGround ? 0.8 : 1.6)
        : clamp(accel / decelRef, -1, 0) * (isGround ? 0.5 : 1.0);
      const boostTerm = boost ? (isGround ? 0.6 : 1.85) : 0;
      const wantLag = clamp(accelTerm + boostTerm, isGround ? -0.6 : -1.0, isGround ? 1.2 : 2.6);
      const aLag = stepDt > 0 ? 1 - Math.exp(-stepDt / 0.18) : 1;
      longLag += (wantLag - longLag) * aLag;

      const rawBack = (camTweak?.back ?? (isGround ? chaseBack : activeCfg.back)) + (camTweak ? 0 : longLag);
      const rawUp = camTweak?.up ?? (isGround ? chaseUp : activeCfg.up);
      const orbitAz = camHeading + (camTweak?.yaw ?? 0) + flYaw;

      let horizBack = rawBack;
      let vertUp = rawUp;
      if (Math.abs(flPitch) > 1e-5 && !camTweak) {
        const radius = Math.hypot(rawBack, rawUp);
        const baseElev = Math.atan2(rawUp, rawBack);
        const elev = clamp(baseElev - flPitch * (isGround ? 0.8 : 0.65), isGround ? -0.85 : -0.35, isGround ? 1.45 : 1.35);
        horizBack = Math.max(isGround ? 1.2 : 2.0, Math.cos(elev) * radius);
        vertUp = Math.sin(elev) * radius;
      }

      const ex = sx - Math.sin(orbitAz) * horizBack;
      const ey = sy - Math.cos(orbitAz) * horizBack;
      let ez = sz + vertUp;

      // Smooth terrain ground clearance
      const g = ground(ex, ey);
      const wantLift = Number.isFinite(g) ? Math.max(0, (g + activeCfg.groundClear) - ez) : 0;
      const tauLift = wantLift > camLift ? activeCfg.groundAttackTau : activeCfg.groundReleaseTau;
      const aLift = stepDt > 0 ? 1 - Math.exp(-stepDt / tauLift) : 1;
      camLift += (wantLift - camLift) * aLift;
      ez += camLift;
      if (Number.isFinite(g) && ez < g + activeCfg.groundClear) ez = g + activeCfg.groundClear;

      const rawPitch = Number.isFinite(p.pitch) ? p.pitch : 0;
      const rawBank = Number.isFinite(p.bank) ? p.bank : 0;
      const aPitch = stepDt > 0 ? 1 - Math.exp(-stepDt / activeCfg.pitchTau) : 1;
      const aRoll = stepDt > 0 ? 1 - Math.exp(-stepDt / activeCfg.rollTau) : 1;
      camPitch = Number.isFinite(camPitch) ? camPitch + (rawPitch - camPitch) * aPitch : rawPitch;
      camRoll = Number.isFinite(camRoll) ? camRoll + (rawBank - camRoll) * aRoll : rawBank;

      if (camTweak) {
        camPos = [ex, ey, ez];
        camH = FM.wrapHeading(orbitAz);
        camP = camTweak.pitch ?? -Math.atan2(ez - sz, Math.max(0.1, horizBack));
        camR = camTweak.roll ?? 0;
        baseFov = camTweak.fov ?? activeCfg.fov;
      } else {
        const flMag = Math.hypot(flYaw, flPitch);
        const flBlend = clamp(flMag / 0.55, 0, 1);
        const speedScale = isGround
          ? (p.mode === FM.MODE.PARKED ? 0.35 : clamp(0.5 + (speed / vMaxGround) * 0.5, 0.5, 1.0))
          : (p.mode === FM.MODE.PARKED ? 0.25 : clamp(0.4 + (speed / Math.max(20, vCruise)) * 0.6, 0.4, 1.2));
        const leadDist = Math.max(0, activeCfg.lookAhead) * speedScale * (1 - flBlend);

        const steerInput = Number.isFinite(p.steer) ? p.steer : (Number.isFinite(controlsStatus?.steer) ? controlsStatus.steer : (p.bank || 0));
        const turnRate = speed > (isGround ? 0.5 : 5) ? (FM.GRAVITY * Math.tan(rawBank)) / Math.max(speed, FM.MIN_TURN_SPEED) : 0;
        const turnYawLead = isGround
          ? clamp(steerInput * 0.38 + rawBank * 0.25, -0.55, 0.55)
          : clamp(turnRate * 0.65 + rawBank * 0.22, -0.55, 0.55);
        const leadH = hdg + turnYawLead;
        const leadP = isGround ? camPitch : camPitch * 0.85;

        const tx = sx + Math.sin(leadH) * Math.cos(leadP) * leadDist;
        const ty = sy + Math.cos(leadH) * Math.cos(leadP) * leadDist;
        const tz = sz + Math.sin(leadP) * leadDist;

        const dx = tx - ex;
        const dy = ty - ey;
        const dz = tz - ez;
        const dhHoriz = Math.hypot(dx, dy);

        camPos = [ex, ey, ez + bumpOffset + joltEnv * 0.08];
        camH = dhHoriz > 1e-4 ? FM.wrapHeading(Math.atan2(dx, dy)) : FM.wrapHeading(orbitAz);
        const geomPitch = dhHoriz > 1e-4 ? Math.atan2(dz, dhHoriz) : activeCfg.pitch;
        const steadyPitch = isGround ? (activeCfg.pitch + camPitch * 0.95) : (activeCfg.pitch + camPitch * 0.48);
        const pitchBlend = isGround
          ? (geomPitch * 0.25 + steadyPitch * 0.75)
          : (geomPitch * 0.55 + steadyPitch * 0.45);
        camP = (flBlend > 0
          ? geomPitch * flBlend + pitchBlend * (1 - flBlend)
          : pitchBlend) + joltPitch;
        camR = (isGround ? (camRoll * 0.25 * (1 - flBlend)) : (camRoll * 0.48 * (1 - flBlend))) + joltRoll;
        baseFov = activeCfg.fov;
      }
    }

    // 4. Deterministic Multi-Source Coherent Harmonic Shake (ZERO Math.random())
    shakePhase = (shakePhase + stepDt) % 3600;
    const gunTau = firingNow ? 0.025 : 0.075;
    const aGun = stepDt > 0 ? 1 - Math.exp(-stepDt / gunTau) : (firingNow ? 1 : 0);
    gunEnv += ((firingNow ? 1 : 0) - gunEnv) * aGun;

    const wepActive = boost && p.mode !== FM.MODE.PARKED && p.mode !== FM.MODE.CRASHED;
    const aWep = stepDt > 0 ? 1 - Math.exp(-stepDt / 0.08) : (wepActive ? 1 : 0);
    wepEnv += ((wepActive ? 1 : 0) - wepEnv) * aWep;

    const gBuffet = p.mode === FM.MODE.FLIGHT && Math.abs(gLoad) > 2.1
      ? clamp((Math.abs(gLoad) - 2.1) / 2.8, 0, 1)
      : 0;
    let stallBuffet = 0;
    let floorBuffet = 0;
    if (p.mode === FM.MODE.FLIGHT) {
      if (speed < vMin * 1.12) {
        stallBuffet = clamp((vMin * 1.12 - speed) / Math.max(3, vMin * 0.18), 0, 1) * 0.65;
      }
      const gz = ground(p.x, p.y);
      const floorAgl = Number.isFinite(params?.floorAgl) ? params.floorAgl : 30;
      const aglNow = Number.isFinite(gz) ? p.z - gz : Infinity;
      if (aglNow > 0.5 && aglNow <= floorAgl + 0.25 && (p.pitch || 0) < -0.02) {
        floorBuffet = 0.55;
      }
    }
    const aeroEnv = Math.max(gBuffet, stallBuffet, floorBuffet);
    const expEnv = clamp(Number.isFinite(explosionShake) ? explosionShake : 0, 0, 2.5);

    if (expEnv > 1e-3 || gunEnv > 1e-3 || wepEnv > 1e-3 || aeroEnv > 1e-3) {
      const ph = shakePhase;
      const posScale = view === "chase" ? 1.0 : 0.22;

      // 1) Explosion shockwave (6.5 Hz + 11.3 Hz + 17.7 Hz)
      const exX = expEnv * (0.34 * Math.sin(TWO_PI * 6.5 * ph) + 0.18 * Math.sin(TWO_PI * 11.3 * ph + 1.1));
      const exY = expEnv * (0.32 * Math.cos(TWO_PI * 7.1 * ph + 0.4) + 0.16 * Math.sin(TWO_PI * 17.7 * ph));
      const exZ = expEnv * (0.38 * Math.sin(TWO_PI * 8.3 * ph + 2.0));

      // 2) 6x .50 cal airframe recoil thump (10 Hz + 23 Hz)
      const gnX = gunEnv * 0.022 * Math.sin(TWO_PI * 23.0 * ph + 0.6);
      const gnY = gunEnv * -0.045 * (0.65 * Math.sin(TWO_PI * 10.0 * ph) + 0.35 * Math.sin(TWO_PI * 23.0 * ph));
      const gnZ = gunEnv * 0.028 * Math.cos(TWO_PI * 10.0 * ph + 0.3);

      // 3) R-2800 Double Wasp WEP high-frequency radial vibration (29 Hz + 47 Hz)
      const wpX = wepEnv * 0.012 * Math.sin(TWO_PI * 29.0 * ph);
      const wpY = wepEnv * 0.008 * Math.cos(TWO_PI * 47.0 * ph + 0.9);
      const wpZ = wepEnv * 0.014 * Math.sin(TWO_PI * 47.0 * ph + 1.7);

      // 4) High-G / stall / floor aerodynamic buffet (8.5 Hz + 14.2 Hz)
      const aeX = aeroEnv * 0.036 * Math.sin(TWO_PI * 8.5 * ph + 1.3);
      const aeY = aeroEnv * 0.020 * Math.cos(TWO_PI * 14.2 * ph);
      const aeZ = aeroEnv * 0.048 * Math.sin(TWO_PI * 14.2 * ph + 0.5);

      const localOff = [
        (gnX + wpX + aeX) * posScale,
        (gnY + wpY + aeY) * posScale,
        (gnZ + wpZ + aeZ) * posScale,
      ];
      const worldOff = FM.rotate(qSeat, localOff);
      camPos = [
        camPos[0] + worldOff[0] + exX * posScale,
        camPos[1] + worldOff[1] + exY * posScale,
        camPos[2] + worldOff[2] + exZ * posScale,
      ];

      camP += expEnv * 0.011 * Math.sin(TWO_PI * 8.3 * ph + 0.8)
        + gunEnv * 0.0038 * (0.6 * Math.sin(TWO_PI * 10.0 * ph) + 0.4 * Math.cos(TWO_PI * 23.0 * ph))
        + wepEnv * 0.0014 * Math.sin(TWO_PI * 29.0 * ph + 0.4)
        + aeroEnv * 0.0055 * Math.sin(TWO_PI * 14.2 * ph + 1.1);

      camR += expEnv * 0.014 * Math.cos(TWO_PI * 6.5 * ph + 0.2)
        + gunEnv * 0.0026 * Math.sin(TWO_PI * 23.0 * ph + 1.5)
        + wepEnv * 0.0018 * Math.cos(TWO_PI * 47.0 * ph)
        + aeroEnv * 0.0075 * Math.sin(TWO_PI * 8.5 * ph + 2.2);
    }

    const finalFov = camTweak && Number.isFinite(camTweak.fov)
      ? camTweak.fov
      : (isGround ? (view === "cockpit" ? baseFov : (view === "hood" ? baseFov : (baseFov + 6.0 * clamp(Math.abs(speed) / vMaxGround, 0, 1)))) : baseFov + fovBoost);

    prevPose = {
      x: p.x || 0,
      y: p.y || 0,
      z: p.z || 0,
      sz,
      heading: p.heading || 0,
      pitch: p.pitch || 0,
      bank: p.bank || 0,
      speed,
      mode: p.mode,
    };

    return {
      cam: {
        pos: camPos,
        h: camH,
        p: clamp(camP, -Math.PI / 2, Math.PI / 2),
        r: camR,
        fov: finalFov,
      },
      gLoad,
      view,
    };
  }

  return {
    getView: () => view,
    setView,
    cycleView,
    reset,
    step,
    triggerJolt,
    setSeatIndex(idx) { seatIndex = clamp(Math.round(idx || 0), 0, 3); },
    getSeatIndex: () => seatIndex,
    setHitchedTrailerKind(k) { activeTrailerKind = normalizeTrailerKind(k); },
    getHitchedTrailerKind: () => activeTrailerKind,
  };
}
