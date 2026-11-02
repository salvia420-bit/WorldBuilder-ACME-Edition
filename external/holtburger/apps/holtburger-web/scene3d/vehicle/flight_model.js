// scene3d/vehicle/flight_model.js — the Air locomotion model, v1 (vehicles DESIGN.md §4.4).
//
// SPECIFIED ONCE, IMPLEMENTED TWICE: this file is the pilot's predictor twin of the authoritative server model,
// ~/ace-server/Source/ACE.Server/Vehicles/FlightModel.cs. Keep the operation ORDER identical (same branches, same
// expression order, double precision); the golden-trajectory test pair (tests/vehicle_flight.test.mjs and
// ACE.Server.Tests/Vehicles/FlightModelParityTests.cs, both reading docs/vehicles-2026-11-01/flight/flight-golden.json)
// holds them within 1 mm after 30 s. Pure module: no DOM, no three, no clocks.
//
// State (AC world metres: x = landblockX * 192 + local x, y likewise, z up):
//   {x, y, z, heading (compass rad, 0 = north/+y, clockwise), pitch (nose up +), bank (right wing down +),
//    speed (m/s), mode}
// Input (dequantized EXACTLY like the server — what the pilot sends is what both sides integrate):
//   {throttle [0,1], pitch, roll, yaw [-1,1], boost, land, fire}
// ground(x, y) → terrain height or NaN when unknown (then no clamps apply).

export const MODE = Object.freeze({ PARKED: 0, TAKEOFF: 1, FLIGHT: 2, LANDING: 3, CRASHED: 4, DERELICT: 5 });
export const MODE_NAMES = Object.freeze(["Parked", "Takeoff", "Flight", "Landing", "Crashed", "Derelict"]);

export const GRAVITY = 9.8;
export const SIM_HZ = 30;
export const DT = 1.0 / SIM_HZ;
export const TAKEOFF_THROTTLE = 0.25;
export const MIN_TURN_SPEED = 10.0;
export const LANDING_SPEED_SLACK = 0.5;
export const WORLD_MIN = 0.5;
// 255 landblocks a side (0x00-0xFE): landblock 0xFF does not exist (same constant as the server's FlightModel.WorldMax)
export const WORLD_MAX = 255.0 * 192.0 - 0.5;
const TWO_PI = 2.0 * Math.PI;

// HBV1 v2: MISSILE (held: the next lightning rail every 0.3 s), BOMB (rising edge: release the next bomb) — the server's
// VehicleInputFrame.ButtonMissile / ButtonBomb; neither changes the flight, so the predictor stays exact
export const BUTTON = Object.freeze({ BOOST: 0x01, FIRE: 0x02, LAND: 0x04, MISSILE: 0x08, BOMB: 0x10 });

export function moveToward(cur, target, maxDelta) {
  let d = target - cur;
  if (d > maxDelta) d = maxDelta;
  else if (d < -maxDelta) d = -maxDelta;
  return cur + d;
}

export function wrapHeading(h) {
  return h - TWO_PI * Math.floor(h / TWO_PI);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Server-identical stick dequantization: i8 / 127, -128 clamps to -1. */
export function stick(v) {
  return Math.max(-1.0, v / 127.0);
}

/** Quantize an analog input the way it goes on the wire (u8 throttle, i8 sticks, button bits). */
export function quantizeInput(raw) {
  const r = raw || {};
  const q = (v) => {
    const n = Math.round(clamp(Number.isFinite(v) ? v : 0, -1, 1) * 127);
    return n < -127 ? -127 : (n > 127 ? 127 : n);
  };
  const thr = Math.round(clamp(Number.isFinite(r.throttle) ? r.throttle : 0, 0, 1) * 255);
  let buttons = 0;
  if (r.boost) buttons |= BUTTON.BOOST;
  if (r.fire) buttons |= BUTTON.FIRE;
  if (r.land) buttons |= BUTTON.LAND;
  if (r.missile) buttons |= BUTTON.MISSILE;
  if (r.bomb) buttons |= BUTTON.BOMB;
  return { throttle: thr, pitch: q(r.pitch), roll: q(r.roll), yaw: q(r.yaw), buttons };
}

/** The FlightInput both sides integrate, from a quantized frame (FlightInput.FromFrame in C#). */
export function inputFromFrame(f) {
  return {
    throttle: f.throttle / 255.0,
    pitch: stick(f.pitch),
    roll: stick(f.roll),
    yaw: stick(f.yaw),
    boost: (f.buttons & BUTTON.BOOST) !== 0,
    fire: (f.buttons & BUTTON.FIRE) !== 0,
    land: (f.buttons & BUTTON.LAND) !== 0,
    missile: (f.buttons & BUTTON.MISSILE) !== 0,
    bomb: (f.buttons & BUTTON.BOMB) !== 0,
  };
}

/** No pilot (derelict): idle throttle, nose half down, wings level. */
export const DERELICT_INPUT = Object.freeze({ throttle: 0, pitch: -0.5, roll: 0, yaw: 0, boost: false, fire: false, land: false });

/** Movement params from a VehicleProfile message (f32 values, as received — identical to the server's). */
export function paramsFromProfile(p) {
  return {
    vMin: p.vMin, vCruise: p.vCruise, vMax: p.vMax, accel: p.accel, decel: p.decel,
    maxBank: p.maxBank, rollRate: p.rollRate, maxPitch: p.maxPitch, pitchRate: p.pitchRate, yawRate: p.yawRate,
    climbMax: p.climbMax, sinkMax: p.sinkMax, floorAgl: p.floorAgl, ceilingAgl: p.ceilingAgl,
    takeoffClimb: p.takeoffClimb, landingSpeed: p.landingSpeed,
  };
}

export function cloneState(s) {
  return { x: s.x, y: s.y, z: s.z, heading: s.heading, pitch: s.pitch, bank: s.bank, speed: s.speed, mode: s.mode };
}

/**
 * Advance one fixed step IN PLACE. Mirrors FlightModel.Step (C#) branch for branch.
 * @param {object} s state (mutated)  @param {object} u input  @param {object} p params
 * @param {number} vCap  @param {(x:number,y:number)=>number} ground  @param {number} [dt]
 */
export function step(s, u, p, vCap, ground, dt = DT) {
  switch (s.mode) {
    case MODE.PARKED: {
      s.speed = 0.0;
      s.pitch = 0.0;
      s.bank = 0.0;
      s.heading = wrapHeading(s.heading + u.yaw * p.yawRate * dt);
      const g = ground(s.x, s.y);
      if (!Number.isNaN(g)) s.z = g;
      if (u.throttle >= TAKEOFF_THROTTLE && !u.land) s.mode = MODE.TAKEOFF;
      return s;
    }
    case MODE.TAKEOFF: {
      s.speed = 0.0;
      s.bank = moveToward(s.bank, 0.0, p.rollRate * dt);
      s.pitch = moveToward(s.pitch, 0.0, p.pitchRate * dt);
      s.heading = wrapHeading(s.heading + u.yaw * p.yawRate * dt);
      s.z = s.z + p.takeoffClimb * dt;
      const g = ground(s.x, s.y);
      if (Number.isNaN(g) || s.z >= g + p.floorAgl) {
        if (!Number.isNaN(g)) s.z = g + p.floorAgl;
        s.mode = MODE.FLIGHT;
        s.speed = Math.min(p.vMin, vCap);
      }
      return s;
    }
    case MODE.FLIGHT:
    case MODE.DERELICT: {
      const derelict = s.mode === MODE.DERELICT;
      // 1. speed
      let target;
      if (u.land) target = p.landingSpeed;
      else if (u.boost) target = p.vMax;
      else target = p.vMin + clamp(u.throttle, 0.0, 1.0) * (p.vCruise - p.vMin);
      if (target > vCap) target = vCap;
      s.speed = moveToward(s.speed, target, (target > s.speed ? p.accel : p.decel) * dt);
      // 2. attitude
      s.bank = moveToward(s.bank, clamp(u.roll, -1.0, 1.0) * p.maxBank, p.rollRate * dt);
      s.pitch = moveToward(s.pitch, clamp(u.pitch, -1.0, 1.0) * p.maxPitch, p.pitchRate * dt);
      // 3. coordinated turn + rudder
      const psiDot = GRAVITY * Math.tan(s.bank) / Math.max(s.speed, MIN_TURN_SPEED) + clamp(u.yaw, -1.0, 1.0) * p.yawRate;
      s.heading = wrapHeading(s.heading + psiDot * dt);
      // 4. velocity
      const w = clamp(s.speed * Math.sin(s.pitch), -p.sinkMax, p.climbMax);
      const h = s.speed * Math.cos(s.pitch);
      // 5. integrate, then the envelope
      const nx = clamp(s.x + h * Math.sin(s.heading) * dt, WORLD_MIN, WORLD_MAX);
      const ny = clamp(s.y + h * Math.cos(s.heading) * dt, WORLD_MIN, WORLD_MAX);
      let nz = s.z + w * dt;
      const g = ground(nx, ny);
      if (!Number.isNaN(g)) {
        if (derelict) {
          if (nz <= g) {
            nz = g;
            s.mode = MODE.CRASHED;
            s.speed = 0.0;
          }
        } else if (nz < g + p.floorAgl) {
          nz = g + p.floorAgl;
        }
        if (nz > g + p.ceilingAgl) nz = g + p.ceilingAgl;
      }
      s.x = nx;
      s.y = ny;
      s.z = nz;
      if (s.mode === MODE.FLIGHT && u.land && s.speed <= p.landingSpeed + LANDING_SPEED_SLACK) s.mode = MODE.LANDING;
      return s;
    }
    case MODE.LANDING: {
      s.bank = moveToward(s.bank, 0.0, p.rollRate * dt);
      s.pitch = moveToward(s.pitch, 0.0, p.pitchRate * dt);
      s.speed = moveToward(s.speed, 0.0, p.decel * dt);
      s.heading = wrapHeading(s.heading + clamp(u.yaw, -1.0, 1.0) * p.yawRate * dt);
      const nx = clamp(s.x + s.speed * Math.sin(s.heading) * dt, WORLD_MIN, WORLD_MAX);
      const ny = clamp(s.y + s.speed * Math.cos(s.heading) * dt, WORLD_MIN, WORLD_MAX);
      let nz = s.z - p.takeoffClimb * dt;
      const g = ground(nx, ny);
      if (!Number.isNaN(g) && nz <= g) {
        nz = g;
        s.mode = MODE.PARKED;
        s.speed = 0.0;
        s.pitch = 0.0;
        s.bank = 0.0;
      }
      s.x = nx;
      s.y = ny;
      s.z = nz;
      return s;
    }
    default:
      s.speed = 0.0;
      return s;
  }
}

/** World velocity [vx, vy, vz] m/s (FlightModel.Velocity). */
export function velocity(s, p) {
  switch (s.mode) {
    case MODE.TAKEOFF:
      return [0, 0, p.takeoffClimb];
    case MODE.LANDING:
      return [s.speed * Math.sin(s.heading), s.speed * Math.cos(s.heading), -p.takeoffClimb];
    case MODE.FLIGHT:
    case MODE.DERELICT: {
      const w = clamp(s.speed * Math.sin(s.pitch), -p.sinkMax, p.climbMax);
      const h = s.speed * Math.cos(s.pitch);
      return [h * Math.sin(s.heading), h * Math.cos(s.heading), w];
    }
    default:
      return [0, 0, 0];
  }
}

// ---- AC frame helpers -------------------------------------------------------------------

/** AC quaternion [w, x, y, z] = Rz(-heading) · Rx(pitch) · Ry(bank) (the server's Vehicle.Orientation). */
export function orientation(heading, pitch, bank) {
  const ch = Math.cos(-heading / 2), sh = Math.sin(-heading / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(bank / 2), sr = Math.sin(bank / 2);
  // qz(-h) * qx(p)
  const aw = ch * cp, ax = ch * sp, ay = sh * sp, az = sh * cp;
  // (qz qx) * qy(r)
  return [
    aw * cr - ay * sr,
    ax * cr - az * sr,
    aw * sr + ay * cr,
    az * cr + ax * sr,
  ];
}

/** Rotate an AC vector by an AC quaternion [w, x, y, z]. */
export function rotate(q, v) {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** Global AC metres → {cell, x, y, z} landblock-local outdoor position (the server's Vehicle.ToPosition). */
export function toCellLocal(gx, gy, gz) {
  let lbX = Math.floor(gx / 192.0);
  let lbY = Math.floor(gy / 192.0);
  // 0..254 (= the server's Vehicle.ToPosition): landblock 0xFF does not exist
  lbX = clamp(lbX, 0, 254);
  lbY = clamp(lbY, 0, 254);
  const lx = clamp(Math.fround(gx - lbX * 192.0), 0, 191.999);
  const ly = clamp(Math.fround(gy - lbY * 192.0), 0, 191.999);
  const cellX = Math.floor(lx / 24.0);
  const cellY = Math.floor(ly / 24.0);
  const cell = ((lbX << 24) | (lbY << 16) | (cellX * 8 + cellY + 1)) >>> 0;
  return { cell, x: lx, y: ly, z: gz };
}

/** {cell, x, y} landblock-local → global AC metres. */
export function toGlobal(cell, x, y, z) {
  const lbX = (cell >>> 24) & 0xff;
  const lbY = (cell >>> 16) & 0xff;
  return [lbX * 192.0 + x, lbY * 192.0 + y, z];
}
