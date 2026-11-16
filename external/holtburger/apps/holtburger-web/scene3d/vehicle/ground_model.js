// scene3d/vehicle/ground_model.js — 30 Hz Deterministic Ground Physics Engine (Milestone 2)
// SPECIFIED ONCE, IMPLEMENTED TWICE: Mirrors ~/ace-server/Source/ACE.Server/Vehicles/GroundModel.cs

const f32 = Math.fround;
const deg = (d) => f32((d * Math.PI) / 180);

export const SIM_HZ = 30;
export const DT = 1.0 / SIM_HZ;
const TWO_PI = 2.0 * Math.PI;

export const MODE = Object.freeze({
  PARKED: 0,
  TAKEOFF: 1,
  FLIGHT: 2,
  LANDING: 3,
  CRASHED: 4,
  DERELICT: 5,
  DRIVING: 6,
});

export const MODE_NAMES = Object.freeze([
  "Parked", "Takeoff", "Flight", "Landing", "Crashed", "Derelict", "Driving",
]);

export const BUTTON = Object.freeze({
  BOOST: 0x01,      // 4WD Low-Range
  FIRE: 0x02,
  LAND: 0x04,
  HANDBRAKE: 0x20,  // Mechanical handbrake
  HORN: 0x40,       // Sparton horn
  HEADLIGHTS: 0x80, // Headlights
});

export const PARAMS = {
  wheelbase: f32(2.04),
  trackWidth: f32(1.48),
  wheelRadius: f32(0.38),
  maxSteerRad: deg(40),        // ~0.69813 rad
  minSteerRad: deg(12),        // ~0.20944 rad
  steerSlewRateLow: f32(5.2),  // rad/s (<= 12 m/s)
  steerSlewRateHigh: f32(2.6), // rad/s (>= 29 m/s)
  steerSpeedLow: f32(12.0),
  steerSpeedHigh: f32(29.0),
  turnRadiusMin: f32(2.431),
  vMaxRoad: f32(29.0),
  vReverseMax: f32(-10.0),
  launchAccel: f32(11.2),      // a0
  normalBrake: f32(14.0),
  handbrakeDecel: f32(22.0),
  lowRangeTorqueMul: f32(1.85),
  lowRangeSpeedCap: f32(15.0),
  climbLimitCos: f32(0.71934), // 44 deg
  floorZ: f32(0.66417415),     // 48.38 deg
  fordDepthMax: f32(0.8),
  coastLinear: f32(1.8),
  coastQuad: f32(0.04),
  treeGlanceThreshold: f32(0.65),
  treeGlanceScrub: f32(0.25),
  treeYawNudge: f32(0.05),
};

export const SURFACE_FAMILIES = Object.freeze([
  { id: 0, name: "Road", vMax: 29.0, mu: 1.00, muLat: 1.30 },
  { id: 1, name: "Dirt", vMax: 24.4, mu: 0.88, muLat: 1.05 },
  { id: 2, name: "Grass", vMax: 23.5, mu: 0.82, muLat: 0.95 },
  { id: 3, name: "Forest", vMax: 21.5, mu: 0.75, muLat: 0.90 },
  { id: 4, name: "SnowIce", vMax: 19.1, mu: 0.55, muLat: 0.50 },
  { id: 5, name: "Sand", vMax: 18.6, mu: 0.60, muLat: 0.70 },
  { id: 6, name: "Swamp", vMax: 15.4, mu: 0.50, muLat: 0.65 },
  { id: 7, name: "ShallowFord", vMax: 12.5, mu: 0.45, muLat: 0.60 },
  { id: 8, name: "Rock", vMax: 22.0, mu: 0.80, muLat: 1.10 },
  { id: 9, name: "Obsidian", vMax: 20.0, mu: 0.70, muLat: 0.85 },
  { id: 10, name: "AshVolcano", vMax: 17.5, mu: 0.55, muLat: 0.65 },
]);

export function wrapHeading(h) {
  return h - TWO_PI * Math.floor(h / TWO_PI);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function stick(v) {
  return Math.max(-1.0, v / 127.0);
}

export function quantizeInput(raw) {
  const r = raw || {};
  const q = (v) => {
    const n = Math.round(clamp(Number.isFinite(v) ? v : 0, -1, 1) * 127);
    return n < -127 ? -127 : (n > 127 ? 127 : n);
  };
  const thrRaw = Number.isFinite(r.throttle) ? r.throttle : 0;
  const thr = thrRaw >= 0 ? Math.round(clamp(thrRaw, 0, 1) * 255) : 0;
  const pitchVal = thrRaw < 0 ? q(thrRaw) : q(r.pitch);
  const steerVal = r.steer !== undefined ? r.steer : (r.yaw || 0);

  let buttons = Number.isFinite(r.buttons) ? (r.buttons >>> 0) : 0;
  if (r.boost) buttons |= BUTTON.BOOST;
  if (r.handbrake) buttons |= BUTTON.HANDBRAKE;
  if (r.horn) buttons |= BUTTON.HORN;
  if (r.headlights) buttons |= BUTTON.HEADLIGHTS;
  if (r.fire) buttons |= BUTTON.FIRE;
  if (r.land) buttons |= BUTTON.LAND;

  return {
    throttle: thr,
    pitch: pitchVal,
    roll: q(r.roll),
    yaw: q(steerVal),
    steer: q(steerVal),
    buttons,
  };
}

export function inputFromFrame(f) {
  const isArr = Array.isArray(f);
  const rawThr = isArr ? f[0] : (f.throttle !== undefined ? f.throttle : 0);
  const p = isArr ? f[1] : (f.pitch || 0);
  const r = isArr ? f[2] : (f.roll || 0);
  const y = isArr ? f[3] : (f.yaw || 0);
  const btn = isArr ? f[4] : (f.buttons || 0);

  let thr;
  if (typeof rawThr === "number" && rawThr < 0) {
    thr = rawThr;
  } else if (rawThr === 0 && p !== 0) {
    thr = stick(p);
  } else {
    thr = rawThr / 255.0;
  }

  let st;
  if (!isArr && f.steer !== undefined) {
    st = f.steer;
  } else {
    st = stick(y !== 0 ? y : r);
  }

  return {
    throttle: thr,
    pitch: stick(p),
    roll: stick(r),
    yaw: stick(y),
    steer: st,
    buttons: btn,
    boost: (btn & BUTTON.BOOST) !== 0,
    handbrake: (btn & BUTTON.HANDBRAKE) !== 0,
    horn: (btn & BUTTON.HORN) !== 0,
    headlights: (btn & BUTTON.HEADLIGHTS) !== 0,
  };
}

export function cloneState(s) {
  return {
    x: s.x, y: s.y, z: s.z,
    heading: s.heading, pitch: s.pitch, bank: s.bank || 0, roll: s.roll || 0,
    speed: s.speed, steerAngle: s.steerAngle || 0,
    mode: s.mode,
    surfaceFamily: s.surfaceFamily !== undefined ? s.surfaceFamily : 0,
    groundFlags: s.groundFlags !== undefined ? s.groundFlags : 1,
    wheelSpin: s.wheelSpin || 0,
  };
}

function resolveOracle(oracle, x, y, z, sf) {
  if (typeof oracle === "function") {
    const res = oracle(x, y, z);
    if (typeof res === "number") {
      return { z: res, normal: [0, 0, 1], surface: SURFACE_FAMILIES[0], waterDepth: 0, isBridge: false };
    }
    return res || { z: 0.0, normal: [0, 0, 1], surface: SURFACE_FAMILIES[0], waterDepth: 0, isBridge: false };
  }
  return { z: 0.0, normal: [0, 0, 1], surface: SURFACE_FAMILIES[0], waterDepth: 0, isBridge: false };
}

export function step(state, input, params, oracle, dt = DT) {
  let inp;
  if (Array.isArray(input)) {
    inp = inputFromFrame(input);
  } else if (input && typeof input === "object") {
    const btn = Number.isFinite(input.buttons) ? input.buttons : 0;
    const boost = input.boost !== undefined ? Boolean(input.boost) : ((btn & BUTTON.BOOST) !== 0);
    const handbrake = input.handbrake !== undefined ? Boolean(input.handbrake) : ((btn & BUTTON.HANDBRAKE) !== 0);
    const horn = input.horn !== undefined ? Boolean(input.horn) : ((btn & BUTTON.HORN) !== 0);
    const headlights = input.headlights !== undefined ? Boolean(input.headlights) : ((btn & BUTTON.HEADLIGHTS) !== 0);

    let thr = input.throttle;
    if (thr === undefined) thr = 0;
    if (thr > 1.0) {
      thr = thr / 255.0;
    }

    let st = input.steer !== undefined ? input.steer : (input.yaw !== undefined ? input.yaw : 0);
    if (Math.abs(st) > 1.0) {
      st = stick(st);
    }

    inp = {
      throttle: thr,
      steer: st,
      buttons: btn,
      boost,
      handbrake,
      horn,
      headlights,
    };
  } else {
    inp = inputFromFrame(input);
  }
  const p = params || PARAMS;

  // 1. Steering slew & speed clamp
  const vAbs = Math.abs(state.speed);
  let steerLock, slewRate;
  if (vAbs <= p.steerSpeedLow) {
    steerLock = p.maxSteerRad;
    slewRate = p.steerSlewRateLow;
  } else if (vAbs < p.steerSpeedHigh) {
    const alpha = (vAbs - p.steerSpeedLow) / (p.steerSpeedHigh - p.steerSpeedLow);
    steerLock = (1.0 - alpha) * p.maxSteerRad + alpha * p.minSteerRad;
    slewRate = (1.0 - alpha) * p.steerSlewRateLow + alpha * p.steerSlewRateHigh;
  } else {
    steerLock = p.minSteerRad;
    slewRate = p.steerSlewRateHigh;
  }

  const targetSteer = clamp(inp.steer, -1.0, 1.0) * steerLock;
  const maxSteerDelta = slewRate * dt;
  const steerDiff = targetSteer - (state.steerAngle || 0);
  state.steerAngle = (state.steerAngle || 0) + clamp(steerDiff, -maxSteerDelta, maxSteerDelta);

  // 2. Terrain query
  const terr = resolveOracle(oracle, state.x, state.y, state.z, state.surfaceFamily);
  const surf = terr.surface || SURFACE_FAMILIES[0];
  const normal = terr.normal || [0, 0, 1];
  const groundZ = terr.z !== undefined ? terr.z : 0.0;
  const waterDepth = terr.waterDepth || 0.0;
  const isBridge = terr.isBridge || false;

  // 3. Slope gradient along heading
  const sinH = Math.sin(state.heading);
  const cosH = Math.cos(state.heading);
  const slopeDot = (normal[0] * sinH + normal[1] * cosH);
  const isCliff = normal[2] < p.floorZ;
  let gParallel = 0.0;
  if (!isCliff && normal[2] > 0.1) {
    gParallel = 9.8 * slopeDot / normal[2];
  }

  // 4. Longitudinal Drive / Brake / Coast
  let spd = state.speed;
  if (inp.handbrake) {
    const b = p.handbrakeDecel * surf.mu;
    if (Math.abs(spd) <= 0.05 || Math.abs(spd) <= b * dt) {
      spd = 0.0;
    } else {
      spd -= Math.sign(spd) * b * dt;
    }
  } else if (inp.throttle > 0.0) {
    const vTarget = Math.pow(inp.throttle, 1.0 / 1.8) * surf.vMax;
    if (spd < vTarget) {
      const taper = Math.sqrt(Math.max(0.0, inp.throttle - Math.pow(Math.max(0.0, spd) / surf.vMax, 1.8)));
      let aDrive = p.launchAccel * surf.mu * taper;
      if (inp.boost && spd <= p.lowRangeSpeedCap) {
        aDrive *= p.lowRangeTorqueMul;
      }
      spd += (aDrive + gParallel) * dt;
      if (spd > vTarget && gParallel <= 0.0) spd = vTarget;
    } else {
      const drag = (p.coastLinear + p.coastQuad * Math.abs(spd)) * dt;
      spd = Math.max(vTarget, spd - drag + gParallel * dt);
    }
    if (spd > surf.vMax * 1.15) spd = surf.vMax * 1.15;
  } else if (inp.throttle < 0.0) {
    if (spd > 0.0) {
      const b = p.normalBrake * surf.mu * Math.abs(inp.throttle) + p.coastLinear;
      spd = Math.max(0.0, spd - b * dt);
    } else {
      const taper = Math.sqrt(Math.max(0.0, 1.0 - Math.pow(Math.abs(spd) / Math.abs(p.vReverseMax), 1.8)));
      let aRev = p.launchAccel * surf.mu * taper * Math.abs(inp.throttle);
      if (inp.boost && Math.abs(spd) <= p.lowRangeSpeedCap) {
        aRev *= p.lowRangeTorqueMul;
      }
      spd = Math.max(p.vReverseMax, spd - (aRev - gParallel) * dt);
    }
  } else {
    // Coasting down (throttle === 0)
    if (Math.abs(spd) > 0.0) {
      const drag = (p.coastLinear + p.coastQuad * Math.abs(spd)) * dt;
      if (Math.abs(spd) <= drag) {
        spd = 0.0;
      } else {
        spd -= Math.sign(spd) * drag;
        spd += gParallel * dt;
        if (spd > surf.vMax * 1.15) spd = surf.vMax * 1.15;
        if (spd < p.vReverseMax) spd = p.vReverseMax;
      }
    }
  }

  // Water halt check: deep water or ocean surf halts forward motion while permitting reverse
  if (!isBridge && (waterDepth > p.fordDepthMax || (groundZ <= -0.5 && state.z <= 0.0))) {
    if (spd > 0.0) spd = 0.0;
  }
  state.speed = spd;

  // 5. Yaw integration (bicycle model)
  const muLat = surf.muLat || 1.0;
  const yawRate = (state.speed * Math.tan(state.steerAngle) / p.wheelbase) * muLat;
  state.heading = wrapHeading(state.heading + yawRate * dt);

  // 6. Velocity vector & collision
  let vx = Math.sin(state.heading) * state.speed;
  let vy = Math.cos(state.heading) * state.speed;

  // Cliff deflection (FloorZ threshold)
  if (normal[2] < p.floorZ) {
    const len2D = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1]);
    if (len2D > 1e-6) {
      const nx = normal[0] / len2D;
      const ny = normal[1] / len2D;
      const dot = vx * nx + vy * ny;
      if (dot < 0.0) {
        vx -= dot * nx;
        vy -= dot * ny;
        state.speed = Math.sqrt(vx * vx + vy * vy) * (state.speed < 0.0 ? -1.0 : 1.0);
      }
    }
  }

  // Tree obstacle deflection (if active)
  if (terr.obstacle) {
    const nx = terr.obstacle.nx;
    const ny = terr.obstacle.ny;
    const dotN = vx * nx + vy * ny;
    if (dotN <= 0.0) {
      const align = Math.abs(sinH * nx + cosH * ny);
      if (align < p.treeGlanceThreshold) {
        vx -= dotN * nx;
        vy -= dotN * ny;
        state.speed *= (1.0 - p.treeGlanceScrub);
        const cross = sinH * ny - cosH * nx;
        const nudgeSign = terr.obstacle.nudgeSign !== undefined && terr.obstacle.nudgeSign !== 0 ? terr.obstacle.nudgeSign : (cross >= 0 ? -1.0 : 1.0);
        state.heading = wrapHeading(state.heading + nudgeSign * p.treeYawNudge);
      } else {
        state.speed = 0.0;
        vx = 0.0;
        vy = 0.0;
      }
    }
  }

  state.x += vx * dt;
  state.y += vy * dt;
  state.z = groundZ;
  state.pitch = Math.asin(clamp(-slopeDot, -1.0, 1.0));
  state.roll = 0.0;

  // 7. State flags & mode
  state.surfaceFamily = surf.id !== undefined ? surf.id : 0;
  state.groundFlags = 0x01; // onGround
  if (inp.handbrake) state.groundFlags |= 0x02;
  if (inp.boost) state.groundFlags |= 0x04;
  if (surf.id === 4) state.groundFlags |= 0x08; // slipping

  if (Math.abs(state.speed) < 0.001 && inp.throttle === 0.0) {
    state.mode = MODE.PARKED;
  } else {
    state.mode = MODE.DRIVING;
  }
}
