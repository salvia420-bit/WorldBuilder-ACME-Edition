/**
 * Pure zero-import 30 Hz deterministic 3+3 wave-locked marine hydrodynamics,
 * quay fender spring-damper contact, terrain water-code grounding guard,
 * ISO 9711 shipboard cargo stowage store, and Autonomous Ship Captain state machine
 * for the coastal cellular feeder container vessel (M/V Dereth Feeder).
 *
 * Both human helm inputs AND the Autonomous Captain drive the exact same
 * physical EOT / rudder / bow-thruster / stern-thruster actuators.
 *
 * 1:1 parity contract for future ACE C# promotion.
 * Imports ONLY `./port_specs.js`.
 */

import {
  PORT_ORIGIN,
  PORT_SITE,
  QUAY_SPECS,
  BERTH_SPECS,
  BERTH_MOORED_OFFSET_Y,
  OFFSHORE_WAYPOINTS,
  SHIP_SPECS,
  SHIP_EOT_NOTCHES,
  SHIP_BAY_DEFS,
  SHIP_ROW_DEFS,
  SHIP_TIER_DEFS,
  PORT_LIVERY_KEYS,
  resolvePortContainerSpec,
  formatIso6346Bic,
  formatBrtCode,
  isEvenBay,
  shipOddPairForEvenBay,
  shipEvenBayForOddBay,
  validateShipPlacement,
  computeShipSlotLocalPose,
  localToWorld2D,
  waterSwellLattice,
  quayWallSdf,
  estimateChartDepthM,
  buildPortLayout,
} from "./port_specs.js";

const TAU = Math.PI * 2.0;
const RAD_PER_DEG = Math.PI / 180.0;
const KNOTS_PER_MPS = 1.94384449;

export const SHIP_SIM_HZ = SHIP_SPECS.simHz; // 30
export const SHIP_SIM_DT = 1.0 / SHIP_SIM_HZ;

export const SHIP_MODE = Object.freeze({
  MANUAL: "manual",
  AUTONOMOUS: "autonomous",
});

export const CAPTAIN_STATE = Object.freeze({
  IDLE: "IDLE",
  UNDERWAY_TRANSIT: "UNDERWAY_TRANSIT",
  APPROACH_STAGING: "APPROACH_STAGING",
  FINAL_BERTHING: "FINAL_BERTHING",
  MOORING: "MOORING",
  CARGO_OPS: "CARGO_OPS",
  UNMOORING: "UNMOORING",
  DEPARTING: "DEPARTING",
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v, fb) {
  return Number.isFinite(v) ? v : fb;
}

export function wrapHeading(h) {
  if (!Number.isFinite(h)) return 0.0;
  let a = h % TAU;
  if (a < 0.0) a += TAU;
  if (a >= TAU) a -= TAU;
  return a;
}

export function wrapPi(a) {
  if (!Number.isFinite(a)) return 0.0;
  let d = a - TAU * Math.floor((a + Math.PI) / TAU);
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function angleDiff(target, current) {
  return wrapPi(finiteOr(target, 0.0) - finiteOr(current, 0.0));
}

function moveToward(cur, target, maxDelta) {
  if (!Number.isFinite(maxDelta) || maxDelta <= 0.0) return cur;
  const diff = target - cur;
  if (Math.abs(diff) <= maxDelta) return target;
  return cur + Math.sign(diff) * maxDelta;
}

export function eotNotchToThrottle(notch) {
  const n = clamp(Math.round(finiteOr(notch, 0)), -3, 3);
  const found = SHIP_EOT_NOTCHES.find((e) => e.notch === n);
  return found ? found.throttle : 0.0;
}

export function throttleToEotNotch(throttle) {
  const t = clamp(finiteOr(throttle, 0.0), -1.0, 1.0);
  let best = SHIP_EOT_NOTCHES[3];
  let bestErr = Infinity;
  for (const e of SHIP_EOT_NOTCHES) {
    const err = Math.abs(e.throttle - t);
    if (err < bestErr) { bestErr = err; best = e; }
  }
  return best.notch;
}

// ---------------------------------------------------------------------------
// 1. Ship State Construction & Berth Alignment Geometry
// ---------------------------------------------------------------------------

export function resolveBerthTarget(berthId, origin = PORT_ORIGIN) {
  const ox = finiteOr(origin?.[0], PORT_ORIGIN[0]);
  const oy = finiteOr(origin?.[1], PORT_ORIGIN[1]);
  const oz = finiteOr(origin?.[2], PORT_ORIGIN[2]);
  const spec = BERTH_SPECS[berthId] || BERTH_SPECS.B1;
  return {
    id: spec.id,
    name: spec.name,
    x: ox + spec.localX,
    y: oy + BERTH_MOORED_OFFSET_Y,
    z: oz,
    stagingX: ox + spec.localX,
    stagingY: oy + 60.0,
    fenderY: oy + QUAY_SPECS.fenderDepthM,
    quayY: oy,
    defaultHeading: spec.defaultHeading,
    alternateHeading: spec.alternateHeading,
    tolerance: spec.mooringTolerance,
  };
}

export function computeBerthAlignment(state, berthId = null, origin = PORT_ORIGIN) {
  const targetId = berthId || state.targetBerthId || state.mooredBerthId || "B1";
  const b = resolveBerthTarget(targetId, origin);
  const lateralErrM = state.y - b.y; // + = seaward of fenders, 0 = kissing fenders
  const longErrM = state.x - b.x;    // + = east of berth center
  // Accept either starboard-side-to (+PI/2) or port-side-to (-PI/2)
  const errStbd = angleDiff(b.defaultHeading, state.heading);
  const errPort = angleDiff(b.alternateHeading, state.heading);
  const usePort = Math.abs(errPort) < Math.abs(errStbd);
  const headingErrRad = usePort ? errPort : errStbd;
  const mooringSide = usePort ? "port" : "starboard";
  const speedMps = Math.hypot(state.surgeU, state.swayV);
  const tol = b.tolerance;
  const inEnvelope =
    lateralErrM >= -0.6 &&
    lateralErrM <= tol.maxLateralErrM &&
    Math.abs(longErrM) <= tol.maxLongErrM &&
    Math.abs(headingErrRad) <= tol.maxHeadingErrRad &&
    speedMps <= tol.maxSpeedMps;

  return {
    berthId: b.id,
    lateralErrM,
    fenderGapM: Math.max(0.0, lateralErrM),
    longErrM,
    headingErrRad,
    headingErrDeg: headingErrRad / RAD_PER_DEG,
    mooringSide,
    speedMps,
    inEnvelope,
  };
}

export function createShipState(opts = {}) {
  const origin = Array.isArray(opts.origin) ? opts.origin : PORT_ORIGIN;
  const ox = finiteOr(origin[0], PORT_ORIGIN[0]);
  const oy = finiteOr(origin[1], PORT_ORIGIN[1]);
  const oz = finiteOr(origin[2], PORT_ORIGIN[2]);

  let initX = finiteOr(opts.x, OFFSHORE_WAYPOINTS.WP_SEA[0] + (ox - PORT_ORIGIN[0]));
  let initY = finiteOr(opts.y, OFFSHORE_WAYPOINTS.WP_SEA[1] + (oy - PORT_ORIGIN[1]));
  let initHeading = wrapHeading(finiteOr(opts.heading, Math.PI)); // heading South toward quay
  let moored = Boolean(opts.moored);
  let mooredBerthId = opts.mooredBerthId || null;
  let captainState = opts.captainState || CAPTAIN_STATE.IDLE;

  if (opts.spawnAtBerth && BERTH_SPECS[opts.spawnAtBerth]) {
    const b = resolveBerthTarget(opts.spawnAtBerth, [ox, oy, oz]);
    initX = b.x;
    initY = b.y;
    initHeading = wrapHeading(finiteOr(opts.heading, b.defaultHeading));
    moored = opts.moored !== false;
    mooredBerthId = moored ? b.id : null;
    captainState = moored ? CAPTAIN_STATE.CARGO_OPS : CAPTAIN_STATE.IDLE;
  }

  const state = {
    id: String(opts.id || "SHIP-1"),
    name: String(opts.name || SHIP_SPECS.defaultName),
    hullHex: opts.hullHex ?? 0x162b44,
    funnelHex: opts.funnelHex ?? 0xc83e2b,
    mode: opts.mode === SHIP_MODE.MANUAL ? SHIP_MODE.MANUAL : SHIP_MODE.AUTONOMOUS,
    captainState,
    origin: [ox, oy, oz],
    // 6-DOF pose
    x: initX,
    y: initY,
    z: oz,
    heading: initHeading,
    pitch: 0.0,
    roll: 0.0,
    // Velocities (body frame: surgeU forward +Y_ship, swayV starboard +X_ship, yawRateR clockwise rad/s)
    surgeU: 0.0,
    swayV: 0.0,
    yawRateR: 0.0,
    heaveVel: 0.0,
    pitchVel: 0.0,
    rollVel: 0.0,
    vx: 0.0,
    vy: 0.0,
    speed: 0.0,
    sogKnots: 0.0,
    rotDegPerMin: 0.0,
    // Actuators
    eotNotch: 0,
    throttle: 0.0,
    rudderRad: 0.0,
    targetRudderRad: 0.0,
    bowThruster: 0.0,
    sternThruster: 0.0,
    propSpinRad: 0.0,
    radarSpinRad: 0.0,
    // Berth & mooring
    targetBerthId: opts.targetBerthId || mooredBerthId || "B1",
    berthHeading: wrapHeading(finiteOr(opts.berthHeading, BERTH_SPECS.B1.defaultHeading)),
    moored,
    mooredBerthId,
    mooringSide: "starboard",
    mooringProgress: moored ? 1.0 : 0.0,
    // Hatch covers (0 = closed, 1 = open) for even bays 02, 04, 06
    hatchCovers: { 2: 0.0, 4: 0.0, 6: 0.0 },
    targetHatchCovers: { 2: 0.0, 4: 0.0, 6: 0.0 },
    // Cargo trim/list
    cargoCount: 0,
    cargoWeightTonnes: 0.0,
    cargoTrimRad: 0.0,
    cargoListRad: 0.0,
    // Safety / Telemetry
    waterDepthM: PORT_SITE.fairwayDepthM,
    ukcM: PORT_SITE.fairwayDepthM - SHIP_SPECS.draftM,
    grounded: false,
    fenderContact: false,
    fenderCompressionM: 0.0,
    berthAlignment: null,
    // Autonomous navigation plan
    waypoints: [],
    waypointIndex: 0,
    departureExit: "W",
    autoCargoComplete: false,
    timeSec: 0.0,
    accumSec: 0.0,
    lastEvent: null,
  };

  state.berthAlignment = computeBerthAlignment(state, state.targetBerthId, state.origin);
  state.mooringSide = state.berthAlignment.mooringSide;
  return state;
}

// ---------------------------------------------------------------------------
// 2. 3+3 Wave-Locked Hydrodynamics + Fender Contact + Grounding Guard (30 Hz)
// ---------------------------------------------------------------------------

function stepShipSubstep(state, ctrl, dt, env = {}) {
  const origin = env.origin || state.origin || PORT_ORIGIN;
  const swellOn = env.swellEnabled !== false;
  const waterCodeAt = typeof env.waterCodeAt === "function" ? env.waterCodeAt : null;
  const maxSpeedMps = finiteOr(env.maxSpeedMps, SHIP_SPECS.maxSpeedMps);

  // Actuator command extraction
  const cmdThrottle = clamp(finiteOr(ctrl?.throttle, state.throttle), -1.0, 1.0);
  const cmdRudder = clamp(finiteOr(ctrl?.targetRudderRad, state.targetRudderRad), -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);
  const cmdBow = clamp(finiteOr(ctrl?.bowThruster, 0.0), -1.0, 1.0);
  const cmdStern = clamp(finiteOr(ctrl?.sternThruster, 0.0), -1.0, 1.0);

  state.throttle = moveToward(state.throttle, cmdThrottle, 1.6 * dt);
  state.eotNotch = throttleToEotNotch(state.throttle);
  state.targetRudderRad = cmdRudder;
  state.rudderRad = moveToward(state.rudderRad, cmdRudder, SHIP_SPECS.rudderRateRadSec * dt);
  state.bowThruster = moveToward(state.bowThruster, cmdBow, 3.5 * dt);
  state.sternThruster = moveToward(state.sternThruster, cmdStern, 3.5 * dt);

  // Animate hatch covers smoothly
  for (const bay of [2, 4, 6]) {
    state.hatchCovers[bay] = moveToward(state.hatchCovers[bay], clamp(finiteOr(state.targetHatchCovers[bay], 0.0), 0.0, 1.0), 0.35 * dt);
  }

  // Radar & CPP propeller rotation
  state.radarSpinRad = (state.radarSpinRad + 1.8 * dt) % TAU;
  state.propSpinRad = (state.propSpinRad + (state.throttle * 14.0 + state.surgeU * 1.2) * dt) % TAU;

  const prevX = state.x;
  const prevY = state.y;

  // 1) Planar 3-DOF Maneuvering (surgeU, swayV, yawRateR)
  if (state.moored && state.mooredBerthId) {
    // Gently hold moored at berth fenders
    const b = resolveBerthTarget(state.mooredBerthId, origin);
    const tgtH = state.mooringSide === "port" ? b.alternateHeading : b.defaultHeading;
    state.x = moveToward(state.x, b.x, 1.5 * dt);
    state.y = moveToward(state.y, b.y, 1.5 * dt);
    state.heading = wrapHeading(state.heading + clamp(angleDiff(tgtH, state.heading), -0.4 * dt, 0.4 * dt));
    state.surgeU = moveToward(state.surgeU, 0.0, 2.0 * dt);
    state.swayV = moveToward(state.swayV, 0.0, 2.0 * dt);
    state.yawRateR = moveToward(state.yawRateR, 0.0, 1.0 * dt);
    state.fenderContact = true;
    state.fenderCompressionM = 0.08;
    state.grounded = false;
  } else {
    const speedScale = maxSpeedMps / SHIP_SPECS.maxSpeedMps;
    const thrustScale = speedScale * speedScale;
    const fProp = state.throttle >= 0.0
      ? state.throttle * SHIP_SPECS.maxAheadThrustN * thrustScale
      : state.throttle * SHIP_SPECS.maxAsternThrustN * thrustScale;

    // Rudder lift from hull flow + propeller wash (works cleanly even at low speed when kicking ahead)
    const rudderSin = Math.sin(state.rudderRad);
    const flowFactor = state.surgeU * Math.abs(state.surgeU);
    const washForce = Math.max(0.0, state.throttle) * SHIP_SPECS.propWashKickN * rudderSin;
    const rudderSideN = -(flowFactor * SHIP_SPECS.rudderLiftCoeff * rudderSin + washForce);
    // Turning moment: rudder at stern (y = -36.8 m) pushing stern port (-X) swings bow starboard (+clockwise)!
    const rudderYawNm = -rudderSideN * Math.abs(SHIP_SPECS.rudderY);

    // Bow & stern tunnel thrusters (+cmd = starboard thrust)
    const fBowN = state.bowThruster * SHIP_SPECS.bowThrusterMaxN;
    const fSternN = state.sternThruster * SHIP_SPECS.sternThrusterMaxN;

    // Hydrodynamic drag (anisotropic: sleek surge, heavy beam sway)
    const dragSurgeN =
      SHIP_SPECS.surgeLinDrag * state.surgeU +
      SHIP_SPECS.surgeQuadDrag * state.surgeU * Math.abs(state.surgeU);
    const dragSwayN =
      SHIP_SPECS.swayLinDrag * state.swayV +
      SHIP_SPECS.swayQuadDrag * state.swayV * Math.abs(state.swayV);
    const dragYawNm =
      SHIP_SPECS.yawLinDrag * state.yawRateR +
      SHIP_SPECS.yawQuadDrag * state.yawRateR * Math.abs(state.yawRateR);

    // Rigid-body Coriolis coupling + thrust + drag
    const m = SHIP_SPECS.massKg;
    const Iz = SHIP_SPECS.yawInertiaKgM2;
    const fSurgeTotal = fProp - dragSurgeN + m * state.swayV * state.yawRateR * 0.25;
    const fSwayTotal = fBowN + fSternN + rudderSideN * 0.15 - dragSwayN - m * state.surgeU * state.yawRateR * 0.25;
    const tauYawTotal = fBowN * SHIP_SPECS.bowThrusterY + fSternN * SHIP_SPECS.sternThrusterY + rudderYawNm - dragYawNm;

    state.surgeU = clamp(state.surgeU + (fSurgeTotal / m) * dt, SHIP_SPECS.maxReverseMps, maxSpeedMps);
    state.swayV = clamp(state.swayV + (fSwayTotal / m) * dt, -SHIP_SPECS.maxSwayMps, SHIP_SPECS.maxSwayMps);
    state.yawRateR = clamp(state.yawRateR + (tauYawTotal / Iz) * dt, -SHIP_SPECS.maxYawRateRadSec, SHIP_SPECS.maxYawRateRadSec);

    // Body -> AC World velocity (forward = [sin h, cos h], starboard = [cos h, -sin h])
    const s = Math.sin(state.heading);
    const c = Math.cos(state.heading);
    const vx = state.surgeU * s + state.swayV * c;
    const vy = state.surgeU * c - state.swayV * s;

    state.x += vx * dt;
    state.y += vy * dt;
    state.heading = wrapHeading(state.heading + state.yawRateR * dt);

    // 2) Quay Fender Spring-Damper Contact & Land Grounding Guard
    state.fenderContact = false;
    state.fenderCompressionM = 0.0;
    state.grounded = false;

    const qMinX = origin[0] + PORT_SITE.localMinX;
    const qMaxX = origin[0] + PORT_SITE.localMaxX;
    const fenderY = origin[1] + QUAY_SPECS.fenderDepthM;
    const halfB = SHIP_SPECS.halfBeamM;
    const halfL = SHIP_SPECS.halfLoaM * 0.90;

    // Test 6 hull perimeter points (bow/mid/stern x port/stbd)
    const hullPts = [
      [-halfB, +halfL], [+halfB, +halfL],
      [-halfB, 0.0], [+halfB, 0.0],
      [-halfB, -halfL], [+halfB, -halfL],
    ];
    let maxQuayPen = 0.0;
    let hitDryLand = false;

    for (const [lx, ly] of hullPts) {
      const [wx, wy] = localToWorld2D(lx, ly, state.x, state.y, state.heading);
      // Engineered quay fender line contact
      if (wx >= qMinX - 2.0 && wx <= qMaxX + 2.0 && wy < fenderY + 0.15) {
        const pen = (fenderY + 0.15) - wy;
        if (pen > maxQuayPen) maxQuayPen = pen;
      }
      // General shoreline SDF or non-water terrain code check
      const sdf = quayWallSdf(wx, wy, origin);
      if (sdf < 0.0) {
        hitDryLand = true;
      }
      if (waterCodeAt) {
        const code = waterCodeAt(wx, wy);
        if (code !== undefined && code !== null && code !== 20 && code !== 18 && code !== 19) {
          hitDryLand = true;
        }
      }
    }

    if (maxQuayPen > 0.0) {
      state.fenderContact = true;
      state.fenderCompressionM = clamp(maxQuayPen, 0.0, 0.8);
      // Push vessel cleanly outside fender face so hull never penetrates quay concrete
      state.y += maxQuayPen;
      // Dampen southward velocity component on contact
      const s2 = Math.sin(state.heading);
      const c2 = Math.cos(state.heading);
      const curVy = state.surgeU * c2 - state.swayV * s2;
      if (curVy < 0.0) {
        const curVx = state.surgeU * s2 + state.swayV * c2;
        const nextVy = Math.max(0.0, -curVy * 0.08);
        state.surgeU = curVx * s2 + nextVy * c2;
        state.swayV = curVx * c2 - nextVy * s2;
        state.yawRateR *= 0.6;
      }
    } else if (hitDryLand) {
      // Grounding arrest: revert into water & stop inward motion
      state.grounded = true;
      state.x = prevX;
      state.y = Math.max(prevY, origin[1] + QUAY_SPECS.fenderDepthM + halfB);
      state.surgeU *= 0.1;
      state.swayV *= 0.1;
      state.yawRateR *= 0.2;
    }

    // World edge guard (stay inside safe Dereth near-ring bounds)
    const minB = PORT_SITE.bodyEdgeMin + 60.0;
    const maxB = PORT_SITE.bodyEdgeMax - 60.0;
    state.x = clamp(state.x, minB, maxB);
    state.y = clamp(state.y, minB, maxB);
  }

  // 3) 3-DOF Wave-Locked Seakeeping (heave Z, pitch, roll)
  const t = state.timeSec;
  let targetZ = origin[2];
  let targetPitch = state.cargoTrimRad;
  let targetRoll = state.cargoListRad;

  if (swellOn) {
    const damp = state.moored ? 0.35 : 1.0;
    const [bx, by] = localToWorld2D(0.0, +32.0, state.x, state.y, state.heading);
    const [sx, sy] = localToWorld2D(0.0, -32.0, state.x, state.y, state.heading);
    const [rx, ry] = localToWorld2D(+6.5, 0.0, state.x, state.y, state.heading);
    const [px, py] = localToWorld2D(-6.5, 0.0, state.x, state.y, state.heading);
    const zBow = waterSwellLattice(bx, by, t);
    const zStern = waterSwellLattice(sx, sy, t);
    const zStbd = waterSwellLattice(rx, ry, t);
    const zPort = waterSwellLattice(px, py, t);

    targetZ += 0.25 * (zBow + zStern + zStbd + zPort) * damp;
    targetPitch += Math.atan2(zBow - zStern, 64.0) * damp;
    targetRoll += Math.atan2(zPort - zStbd, 13.0) * damp;
  }

  // Turn heel (subtle outward roll in high-speed rudder turns)
  targetRoll += clamp(-state.surgeU * state.yawRateR * 0.06, -0.055, 0.055);

  // Critically damped harmonic buoyancy integrators
  const kHeave = 14.0, cHeave = 6.5;
  state.heaveVel += ((targetZ - state.z) * kHeave - state.heaveVel * cHeave) * dt;
  state.z += state.heaveVel * dt;

  const kPitch = 9.0, cPitch = 5.2;
  state.pitchVel += ((targetPitch - state.pitch) * kPitch - state.pitchVel * cPitch) * dt;
  state.pitch = clamp(state.pitch + state.pitchVel * dt, -0.18, 0.18);

  const kRoll = 7.5, cRoll = 4.6;
  state.rollVel += ((targetRoll - state.roll) * kRoll - state.rollVel * cRoll) * dt;
  state.roll = clamp(state.roll + state.rollVel * dt, -0.22, 0.22);

  // 4) Derived World Kinematics & Chart Sounding Telemetry
  const sF = Math.sin(state.heading);
  const cF = Math.cos(state.heading);
  state.vx = state.surgeU * sF + state.swayV * cF;
  state.vy = state.surgeU * cF - state.swayV * sF;
  state.speed = Math.hypot(state.vx, state.vy);
  state.sogKnots = state.speed * KNOTS_PER_MPS;
  state.rotDegPerMin = (state.yawRateR / RAD_PER_DEG) * 60.0;

  const centerCode = waterCodeAt ? waterCodeAt(state.x, state.y) : PORT_SITE.waterDeepCode;
  state.waterDepthM = estimateChartDepthM(state.x, state.y, centerCode, origin);
  state.ukcM = Math.max(0.0, state.waterDepthM - SHIP_SPECS.draftM);
  state.berthAlignment = computeBerthAlignment(state, state.targetBerthId, origin);
  state.timeSec += dt;
}

/**
 * Step ship hydrodynamics using fixed 30 Hz deterministic substeps.
 */
export function stepShipHydrodynamics(state, controls = null, dt = SHIP_SIM_DT, env = {}) {
  const frameDt = clamp(finiteOr(dt, 0.0), 0.0, 0.25);
  state.accumSec += frameDt;
  let steps = 0;
  while (state.accumSec >= SHIP_SIM_DT - 1e-9 && steps < 10) {
    stepShipSubstep(state, controls, SHIP_SIM_DT, env);
    state.accumSec -= SHIP_SIM_DT;
    steps++;
  }
  if (steps === 0 && frameDt > 0.0) {
    // Allow tiny-dt callers (e.g. direct tests passing 0.016 s) to still advance smoothly
    stepShipSubstep(state, controls, frameDt, env);
    state.accumSec = 0.0;
  }
  return state;
}

// ---------------------------------------------------------------------------
// 3. Autonomous Ship Captain State Machine (Berth 1 & Berth 2 + Dual-Ship Safe)
// ---------------------------------------------------------------------------

export function commandShipGoToBerth(state, berthId = "B1", opts = {}) {
  const origin = opts.origin || state.origin || PORT_ORIGIN;
  const b = resolveBerthTarget(berthId, origin);
  const dxO = origin[0] - PORT_ORIGIN[0];
  const dyO = origin[1] - PORT_ORIGIN[1];

  state.mode = SHIP_MODE.AUTONOMOUS;
  state.targetBerthId = b.id;
  state.berthHeading = wrapHeading(
    opts.side === "port" ? b.alternateHeading : finiteOr(opts.heading, b.defaultHeading)
  );
  state.autoCargoComplete = false;

  if (state.moored) {
    if (state.mooredBerthId === b.id) {
      state.captainState = CAPTAIN_STATE.CARGO_OPS;
      return state;
    }
    // Unmoor first, then transit to the new berth!
    state.waypoints = [
      { x: b.stagingX, y: b.stagingY + 30.0 },
      { x: b.stagingX, y: b.stagingY },
    ];
    state.waypointIndex = 0;
    state.captainState = CAPTAIN_STATE.UNMOORING;
    return state;
  }

  // Build per-berth approach lane waypoints so dual-berth traffic stays laterally separated (~200 m between B1 & B2)
  const wps = [];
  const distToStaging = Math.hypot(b.stagingX - state.x, b.stagingY - state.y);
  if (state.y > origin[1] + 220.0 && distToStaging > 180.0) {
    wps.push({ x: b.stagingX, y: origin[1] + 180.0 });
  }
  if (distToStaging > 18.0) {
    wps.push({ x: b.stagingX, y: b.stagingY });
    state.waypoints = wps;
    state.waypointIndex = 0;
    state.captainState = CAPTAIN_STATE.UNDERWAY_TRANSIT;
  } else {
    state.waypoints = [{ x: b.stagingX, y: b.stagingY }];
    state.waypointIndex = 0;
    state.captainState = CAPTAIN_STATE.APPROACH_STAGING;
  }
  return state;
}

export function commandShipDepart(state, opts = {}) {
  const origin = opts.origin || state.origin || PORT_ORIGIN;
  const dxO = origin[0] - PORT_ORIGIN[0];
  const dyO = origin[1] - PORT_ORIGIN[1];
  const exitSide = String(opts.exit || "W").toUpperCase() === "E" ? "E" : "W";
  state.departureExit = exitSide;
  state.mode = SHIP_MODE.AUTONOMOUS;

  const exitWp = exitSide === "E"
    ? { x: OFFSHORE_WAYPOINTS.WP_EXIT_E[0] + dxO, y: OFFSHORE_WAYPOINTS.WP_EXIT_E[1] + dyO }
    : { x: OFFSHORE_WAYPOINTS.WP_EXIT_W[0] + dxO, y: OFFSHORE_WAYPOINTS.WP_EXIT_W[1] + dyO };
  const turnWp = { x: state.x, y: origin[1] + 140.0 };

  state.waypoints = [turnWp, exitWp];
  state.waypointIndex = 0;

  if (state.moored || state.mooringProgress > 0.01) {
    state.targetHatchCovers[2] = 0.0;
    state.targetHatchCovers[4] = 0.0;
    state.targetHatchCovers[6] = 0.0;
    state.captainState = CAPTAIN_STATE.UNMOORING;
  } else {
    state.captainState = CAPTAIN_STATE.DEPARTING;
  }
  return state;
}

export function signalCargoOpsComplete(state) {
  state.autoCargoComplete = true;
  return state;
}

export function tryManualMoorToggle(state, origin = PORT_ORIGIN) {
  if (state.moored) {
    state.moored = false;
    state.mooredBerthId = null;
    state.mooringProgress = 0.0;
    state.lastEvent = "unmoored";
    return { ok: true, moored: false, reason: "Cast off mooring lines" };
  }
  // Check closest berth
  let best = null;
  for (const bid of Object.keys(BERTH_SPECS)) {
    const al = computeBerthAlignment(state, bid, origin);
    if (!best || Math.hypot(al.lateralErrM, al.longErrM) < Math.hypot(best.lateralErrM, best.longErrM)) {
      best = al;
    }
  }
  if (!best || !best.inEnvelope) {
    return {
      ok: false,
      moored: false,
      alignment: best,
      reason: best
        ? `Outside berth ${best.berthId} envelope (lat ${best.lateralErrM.toFixed(1)}m, long ${best.longErrM.toFixed(1)}m, hdg ${best.headingErrDeg.toFixed(1)}°, spd ${best.speedMps.toFixed(2)}m/s)`
        : "No berth available",
    };
  }
  state.moored = true;
  state.mooredBerthId = best.berthId;
  state.targetBerthId = best.berthId;
  state.mooringSide = best.mooringSide;
  state.mooringProgress = 1.0;
  state.throttle = 0.0;
  state.eotNotch = 0;
  state.bowThruster = 0.0;
  state.sternThruster = 0.0;
  state.lastEvent = "moored";
  return { ok: true, moored: true, berthId: best.berthId, reason: `Moored at ${best.berthId}` };
}

/**
 * Compute body-frame control vector `{ throttle, targetRudderRad, bowThruster, sternThruster }`
 * for the Autonomous Captain, then advance ship hydrodynamics by `dt`.
 */
export function stepAutonomousCaptain(state, dt = SHIP_SIM_DT, env = {}) {
  const origin = env.origin || state.origin || PORT_ORIGIN;
  const b = resolveBerthTarget(state.targetBerthId || "B1", origin);
  const ctrl = { throttle: 0.0, targetRudderRad: 0.0, bowThruster: 0.0, sternThruster: 0.0 };
  state.lastEvent = null;

  // Dual-ship separation helper: if another vessel is dangerously close directly ahead, yield throttle
  let trafficYield = 1.0;
  if (Array.isArray(env.otherShips) && env.otherShips.length > 0 && !state.moored) {
    const fx = Math.sin(state.heading);
    const fy = Math.cos(state.heading);
    for (const o of env.otherShips) {
      if (!o || o.id === state.id) continue;
      const dx = o.x - state.x;
      const dy = o.y - state.y;
      const d = Math.hypot(dx, dy);
      if (d < 110.0 && d > 1e-3) {
        const ahead = (dx * fx + dy * fy) / d;
        if (ahead > 0.45) {
          trafficYield = Math.min(trafficYield, clamp((d - 65.0) / 45.0, 0.0, 1.0));
        }
      }
    }
  }

  switch (state.captainState) {
    case CAPTAIN_STATE.IDLE:
      break;

    case CAPTAIN_STATE.UNDERWAY_TRANSIT: {
      if (!state.waypoints || state.waypoints.length === 0) {
        state.captainState = CAPTAIN_STATE.APPROACH_STAGING;
        break;
      }
      const wp = state.waypoints[clamp(state.waypointIndex, 0, state.waypoints.length - 1)];
      const dx = wp.x - state.x;
      const dy = wp.y - state.y;
      const dist = Math.hypot(dx, dy);
      const isLast = state.waypointIndex >= state.waypoints.length - 1;
      const acceptR = isLast ? 14.0 : 28.0;

      if (dist <= acceptR) {
        if (!isLast) {
          state.waypointIndex++;
        } else {
          state.captainState = CAPTAIN_STATE.APPROACH_STAGING;
          break;
        }
      }

      const desiredH = wrapHeading(Math.atan2(dx, dy));
      const hErr = angleDiff(desiredH, state.heading);
      ctrl.targetRudderRad = clamp(hErr * 1.4, -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);

      // Assist large heading turns with bow/stern thrusters when slow
      if (Math.abs(hErr) > 0.35) {
        const turnSign = clamp(hErr * 1.6, -1.0, 1.0);
        ctrl.bowThruster = turnSign;
        ctrl.sternThruster = -turnSign;
      }

      let targetSpeed = isLast ? clamp(dist * 0.08, 0.8, 5.8) : 6.0;
      if (Math.abs(hErr) > 0.8) targetSpeed = Math.min(targetSpeed, 1.5);
      targetSpeed *= trafficYield;
      ctrl.throttle = clamp((targetSpeed - state.surgeU) * 0.45, -0.5, 1.0);
      break;
    }

    case CAPTAIN_STATE.APPROACH_STAGING: {
      // Align vessel cleanly at [b.stagingX, b.stagingY] parallel to quay (`state.berthHeading`)
      const errWorldX = b.stagingX - state.x;
      const errWorldY = b.stagingY - state.y;
      const hErr = angleDiff(state.berthHeading, state.heading);

      // Project world position error into ship body frame (forward = [sin h, cos h], stbd = [cos h, -sin h])
      const s = Math.sin(state.heading);
      const c = Math.cos(state.heading);
      const errFwd = errWorldX * s + errWorldY * c;
      const errStbd = errWorldX * c - errWorldY * s;

      const uCmd = clamp(errFwd * 0.14, -2.0, 2.0);
      ctrl.throttle = clamp((uCmd - state.surgeU) * 0.7, -0.65, 0.65);

      const vCmd = clamp(errStbd * 0.16, -1.2, 1.2);
      const swayForceCmd = clamp((vCmd - state.swayV) * 1.2, -0.85, 0.85);
      const yawCmd = clamp(hErr * 2.2 - state.yawRateR * 4.5, -0.85, 0.85);

      ctrl.bowThruster = clamp(swayForceCmd + yawCmd, -1.0, 1.0);
      ctrl.sternThruster = clamp(swayForceCmd - yawCmd, -1.0, 1.0);

      if (
        Math.abs(errWorldX) <= 3.0 &&
        Math.abs(errWorldY) <= 6.0 &&
        Math.abs(hErr) <= 3.5 * RAD_PER_DEG &&
        Math.abs(state.surgeU) <= 0.45 &&
        Math.abs(state.yawRateR) <= 0.04
      ) {
        state.captainState = CAPTAIN_STATE.FINAL_BERTHING;
        state.lastEvent = "approachAligned";
      }
      break;
    }

    case CAPTAIN_STATE.FINAL_BERTHING: {
      // Closed-loop PID lateral thruster crabbing directly onto berth fenders [b.x, b.y]
      const errWorldX = b.x - state.x;
      const errWorldY = b.y - state.y; // negative while offshore north of berth
      const hErr = angleDiff(state.berthHeading, state.heading);

      const s = Math.sin(state.heading);
      const c = Math.cos(state.heading);
      const errFwd = errWorldX * s + errWorldY * c;
      const errStbd = errWorldX * c - errWorldY * s;

      // Gentle longitudinal trim via EOT
      const uCmd = clamp(errFwd * 0.18, -1.0, 1.0);
      ctrl.throttle = clamp((uCmd - state.surgeU) * 0.9, -0.45, 0.45);

      // Lateral crab speed tapers smoothly to <= 0.22 m/s near fenders
      const distLat = Math.abs(errStbd);
      const maxCrab = distLat > 12.0 ? 1.15 : (distLat > 4.0 ? 0.55 : 0.25);
      const vCmd = clamp(errStbd * 0.16, -maxCrab, maxCrab);
      const swayCmd = clamp((vCmd - state.swayV) * 1.6, -1.0, 1.0);
      const yawCmd = clamp(hErr * 3.0 - state.yawRateR * 5.5, -0.8, 0.8);

      ctrl.bowThruster = clamp(swayCmd + yawCmd, -1.0, 1.0);
      ctrl.sternThruster = clamp(swayCmd - yawCmd, -1.0, 1.0);

      const al = computeBerthAlignment(state, b.id, origin);
      if (
        al.lateralErrM <= 0.75 &&
        al.lateralErrM >= -0.5 &&
        Math.abs(al.longErrM) <= 1.2 &&
        Math.abs(al.headingErrRad) <= 2.8 * RAD_PER_DEG &&
        al.speedMps <= 0.35
      ) {
        state.mooringSide = al.mooringSide;
        state.captainState = CAPTAIN_STATE.MOORING;
        state.lastEvent = "berthContact";
      }
      break;
    }

    case CAPTAIN_STATE.MOORING: {
      // Hold gentle inward thruster press onto fenders while lines are made fast
      const sideSign = state.mooringSide === "port" ? -1.0 : +1.0;
      ctrl.bowThruster = sideSign * 0.12;
      ctrl.sternThruster = sideSign * 0.12;
      state.mooringProgress = moveToward(state.mooringProgress, 1.0, 0.4 * dt);
      if (state.mooringProgress >= 1.0) {
        state.moored = true;
        state.mooredBerthId = b.id;
        state.captainState = CAPTAIN_STATE.CARGO_OPS;
        state.lastEvent = "moored";
      }
      break;
    }

    case CAPTAIN_STATE.CARGO_OPS: {
      if (state.autoCargoComplete) {
        state.autoCargoComplete = false;
        commandShipDepart(state, { origin, exit: state.departureExit });
      }
      break;
    }

    case CAPTAIN_STATE.UNMOORING: {
      state.mooringProgress = moveToward(state.mooringProgress, 0.0, 0.5 * dt);
      if (state.mooringProgress <= 0.0) {
        state.moored = false;
        state.mooredBerthId = null;
        state.lastEvent = "unmoored";
        // If we were commanded to switch to another berth, transit there; otherwise depart!
        if (state.waypoints && state.waypoints.length > 0 && state.targetBerthId && Math.abs(state.waypoints[state.waypoints.length - 1].y - (origin[1] + 60.0)) < 5.0) {
          state.captainState = CAPTAIN_STATE.UNDERWAY_TRANSIT;
        } else {
          state.captainState = CAPTAIN_STATE.DEPARTING;
        }
      }
      break;
    }

    case CAPTAIN_STATE.DEPARTING: {
      // Phase 1: Crab straight North off quay fenders to Y >= quayY + 55 m
      const clearY = origin[1] + 55.0;
      if (state.y < clearY) {
        const s = Math.sin(state.heading);
        const c = Math.cos(state.heading);
        // World +Y (North) projected onto ship starboard (+X_ship)
        const stbdNorth = -s;
        const crabSign = stbdNorth >= 0 ? +1.0 : -1.0;
        const hErr = angleDiff(state.berthHeading, state.heading);
        const yawCmd = clamp(hErr * 2.0 - state.yawRateR * 4.0, -0.5, 0.5);
        ctrl.bowThruster = clamp(crabSign * 0.75 + yawCmd, -1.0, 1.0);
        ctrl.sternThruster = clamp(crabSign * 0.75 - yawCmd, -1.0, 1.0);
        break;
      }

      // Phase 2: Underway along departure channel waypoints
      if (!state.waypoints || state.waypoints.length === 0) {
        state.captainState = CAPTAIN_STATE.IDLE;
        state.lastEvent = "departed";
        break;
      }
      const wp = state.waypoints[clamp(state.waypointIndex, 0, state.waypoints.length - 1)];
      const dx = wp.x - state.x;
      const dy = wp.y - state.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 28.0) {
        if (state.waypointIndex < state.waypoints.length - 1) {
          state.waypointIndex++;
        } else {
          state.captainState = CAPTAIN_STATE.IDLE;
          state.lastEvent = "departed";
          break;
        }
      }
      const desiredH = wrapHeading(Math.atan2(dx, dy));
      const hErr = angleDiff(desiredH, state.heading);
      ctrl.targetRudderRad = clamp(hErr * 1.4, -SHIP_SPECS.maxRudderRad, SHIP_SPECS.maxRudderRad);
      if (Math.abs(hErr) > 0.35) {
        const turnSign = clamp(hErr * 1.5, -1.0, 1.0);
        ctrl.bowThruster = turnSign;
        ctrl.sternThruster = -turnSign;
      }
      const targetSpd = (Math.abs(hErr) > 0.75 ? 1.8 : 5.6) * trafficYield;
      ctrl.throttle = clamp((targetSpd - state.surgeU) * 0.5, -0.4, 1.0);
      break;
    }
  }

  return stepShipHydrodynamics(state, ctrl, dt, env);
}

/**
 * Compute world-space mooring hawser line endpoints from vessel bitts to nearest quay bollards.
 */
export function computeMooringLines(state, layout = null) {
  if (!state || state.mooringProgress <= 0.02) return [];
  const portLayout = layout || buildPortLayout(state.origin || PORT_ORIGIN);
  const bollards = portLayout.bollards || [];
  if (bollards.length === 0) return [];

  const bitts = state.mooringSide === "port" ? SHIP_SPECS.mooringBitts.port : SHIP_SPECS.mooringBitts.starboard;
  const lines = [];
  for (const bitt of bitts) {
    const [wx, wy] = localToWorld2D(bitt.pos[0], bitt.pos[1], state.x, state.y, state.heading);
    const wz = state.z + bitt.pos[2];
    let bestBol = bollards[0];
    let bestD = Infinity;
    for (const bol of bollards) {
      const d = Math.hypot(bol.pos[0] - wx, bol.pos[1] - wy);
      if (d < bestD) { bestD = d; bestBol = bol; }
    }
    if (bestD <= 45.0) {
      lines.push({
        id: bitt.id,
        bollardId: bestBol.id,
        from: [wx, wy, wz],
        to: [bestBol.pos[0], bestBol.pos[1], bestBol.pos[2] + 0.35],
        tension: clamp(state.mooringProgress, 0.0, 1.0),
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 4. Shipboard ISO 9711 Cargo Stowage Store
// ---------------------------------------------------------------------------

export function createShipCargoStore() {
  const slots = new Map(); // key = 6-digit BRT string -> entry
  let nextSerial = 500001;

  function lookup(bay, row, tier) {
    return slots.get(formatBrtCode(bay, row, tier)) ?? null;
  }

  function hasAbove(bay, row, tier) {
    if (SHIP_TIER_DEFS.hold.includes(tier)) return false; // deck hatch separates hold from deck
    const idx = SHIP_TIER_DEFS.deck.indexOf(tier);
    if (idx < 0 || idx >= SHIP_TIER_DEFS.deck.length - 1) return false;
    const aboveT = SHIP_TIER_DEFS.deck[idx + 1];
    if (slots.has(formatBrtCode(bay, row, aboveT))) return true;
    if (isEvenBay(bay)) {
      const pair = shipOddPairForEvenBay(bay);
      return Boolean(pair && (slots.has(formatBrtCode(pair[0], row, aboveT)) || slots.has(formatBrtCode(pair[1], row, aboveT))));
    }
    const parentEven = shipEvenBayForOddBay(bay);
    return Boolean(parentEven && slots.has(formatBrtCode(parentEven, row, aboveT)));
  }

  function hasDeckCargoOverHold(evenBay) {
    const pair = shipOddPairForEvenBay(evenBay) || [];
    const bays = [evenBay, ...pair];
    for (const b of bays) {
      for (const r of SHIP_ROW_DEFS) {
        for (const t of SHIP_TIER_DEFS.deck) {
          if (slots.has(formatBrtCode(b, r.row, t))) return true;
        }
      }
    }
    return false;
  }

  function load(bay, row, tier, meta = {}) {
    const kindOrWcid = meta.wcid ?? meta.kind ?? meta.containerKind ?? (isEvenBay(bay) ? "40ft" : "20ft");
    const check = validateShipPlacement(bay, row, tier, kindOrWcid, slots);
    if (!check.ok) return { ok: false, reason: check.reason, entry: null };

    const localPose = computeShipSlotLocalPose(bay, row, tier, check.spec.wcid, lookup);
    const liveryId = Number.isInteger(meta.liveryId)
      ? ((meta.liveryId % PORT_LIVERY_KEYS.length) + PORT_LIVERY_KEYS.length) % PORT_LIVERY_KEYS.length
      : (nextSerial % PORT_LIVERY_KEYS.length);
    const bic = meta.bic || formatIso6346Bic(nextSerial++);

    const entry = {
      brt: localPose.brt,
      bay,
      row,
      tier,
      inHold: localPose.inHold,
      hatchBay: localPose.hatchBay,
      wcid: check.spec.wcid,
      kind: check.spec.kind,
      sizeFt: check.spec.sizeFt,
      teu: check.spec.teu,
      extW: check.spec.extW,
      extL: check.spec.extL,
      extH: check.spec.extH,
      localX: localPose.x,
      localY: localPose.y,
      localZ: localPose.z,
      topLocalZ: localPose.z + check.spec.extH,
      liveryId,
      bic,
      reefer: Boolean(meta.reefer),
      weightTonnes: finiteOr(meta.weightTonnes, check.spec.sizeFt === 20 ? 14.0 : 22.0),
      slots: Array.isArray(meta.slots) ? meta.slots : [],
    };
    slots.set(entry.brt, entry);
    return { ok: true, entry, reason: null };
  }

  function unload(bay, row, tier) {
    const brt = formatBrtCode(bay, row, tier);
    const entry = slots.get(brt);
    if (!entry) return { ok: false, reason: `Ship slot ${brt} is empty`, entry: null };
    if (hasAbove(bay, row, tier)) {
      return { ok: false, reason: `Cannot unload ${brt}: container stacked above`, entry: null };
    }
    if (entry.inHold && hasDeckCargoOverHold(entry.hatchBay)) {
      return { ok: false, reason: `Cannot unload hold slot ${brt}: deck containers still atop hatch bay ${entry.hatchBay}`, entry: null };
    }
    slots.delete(brt);
    return { ok: true, entry, reason: null };
  }

  /**
   * Compute subtle ship trim (pitch rad) and list (roll rad) from asymmetric cargo distribution.
   */
  function computeStabilitySummary() {
    let count = 0;
    let totalTonnes = 0;
    let momentX = 0;
    let momentY = 0;
    for (const e of slots.values()) {
      count++;
      totalTonnes += e.weightTonnes;
      momentX += e.weightTonnes * e.localX;
      momentY += e.weightTonnes * e.localY;
    }
    // Anti-heeling ballast absorbs most moment, leaving subtle realistic visual feedback
    const cargoListRad = clamp(momentX / 35000.0, -0.025, 0.025);
    const cargoTrimRad = clamp(-momentY / 180000.0, -0.02, 0.02);
    return { count, totalTonnes, cargoListRad, cargoTrimRad };
  }

  function get(bay, row, tier) {
    return slots.get(formatBrtCode(bay, row, tier)) ?? null;
  }

  function list() {
    return [...slots.values()];
  }

  function findNextDischargeable(preferredBay = null) {
    // Prefer highest on-deck tier first, then open holds
    const candidates = list().filter((e) => !hasAbove(e.bay, e.row, e.tier) && (!e.inHold || !hasDeckCargoOverHold(e.hatchBay)));
    candidates.sort((a, b) => {
      if (preferredBay !== null) {
        const aP = (a.hatchBay === preferredBay ? 0 : 1);
        const bP = (b.hatchBay === preferredBay ? 0 : 1);
        if (aP !== bP) return aP - bP;
      }
      if (a.inHold !== b.inHold) return a.inHold ? 1 : -1;
      return b.tier - a.tier;
    });
    return candidates[0] || null;
  }

  function findFreeDeckSlot(containerKindOrWcid = "40ft", preferredBay = null) {
    const spec = resolvePortContainerSpec(containerKindOrWcid);
    const is20 = spec.sizeFt === 20;
    const bays = is20
      ? SHIP_BAY_DEFS.odd20.map((b) => b.bay)
      : SHIP_BAY_DEFS.even40.map((b) => b.bay);
    if (preferredBay !== null) {
      bays.sort((a, b) => (a === preferredBay ? -1 : b === preferredBay ? 1 : 0));
    }
    for (const tier of SHIP_TIER_DEFS.deck) {
      for (const bay of bays) {
        for (const r of SHIP_ROW_DEFS) {
          const v = validateShipPlacement(bay, r.row, tier, spec.wcid, slots);
          if (v.ok) {
            return { bay, row: r.row, tier, brt: v.brt, pose: computeShipSlotLocalPose(bay, r.row, tier, spec.wcid, lookup) };
          }
        }
      }
    }
    return null;
  }

  function clear() {
    slots.clear();
  }

  return {
    load,
    unload,
    get,
    list,
    hasAbove,
    hasDeckCargoOverHold,
    computeStabilitySummary,
    findNextDischargeable,
    findFreeDeckSlot,
    clear,
    count: () => slots.size,
    slots,
  };
}
