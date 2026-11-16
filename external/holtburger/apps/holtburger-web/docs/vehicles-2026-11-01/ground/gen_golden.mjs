// Golden ground trajectories for C# / JS ground-model parity test (vehicles DESIGN §7 & PROJECT.md Feature 19).
//
// Runs scene3d/vehicle/ground_model.js (the predictor twin) over fixed quantized input sequences on an analytic
// ground and writes ground-golden.json: the inputs + the state every 30 steps. tests/vehicle_ground_physics.test.mjs re-runs
// the JS model against it; ACE.Server.Tests/Vehicles/GroundModelParityTests.cs runs C# GroundModel and
// must agree within 1 mm after 30 s (900 steps).
//
//   node docs/vehicles-2026-11-01/ground/gen_golden.mjs --write  # regenerate
//   node docs/vehicles-2026-11-01/ground/gen_golden.mjs --check  # exit 1 if stale

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "ground-golden.json");
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

export function inputFromFrame(f) {
  const isArr = Array.isArray(f);
  const thr = isArr ? f[0] : f.throttle;
  const p = isArr ? f[1] : (f.pitch || 0);
  const r = isArr ? f[2] : (f.roll || 0);
  const y = isArr ? f[3] : (f.yaw || 0);
  const btn = isArr ? f[4] : (f.buttons || 0);
  return {
    throttle: thr / 255.0,
    pitch: stick(p),
    roll: stick(r),
    yaw: stick(y),
    steer: stick(y !== 0 ? y : r),
    buttons: btn,
    boost: (btn & BUTTON.BOOST) !== 0,
    handbrake: (btn & BUTTON.HANDBRAKE) !== 0,
    horn: (btn & BUTTON.HORN) !== 0,
    headlights: (btn & BUTTON.HEADLIGHTS) !== 0,
  };
}

// Reference ground step simulation twin matching C# GroundModel.cs
export function stepGroundReference(state, input, params, oracle, dt = DT) {
  const inp = input.throttle !== undefined ? input : inputFromFrame(input);
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
  const steerDiff = targetSteer - state.steerAngle;
  state.steerAngle += clamp(steerDiff, -maxSteerDelta, maxSteerDelta);

  // 2. Terrain query
  const terr = oracle ? oracle(state.x, state.y, state.z) : {
    z: 0.0,
    normal: [0, 0, 1],
    surface: SURFACE_FAMILIES[0],
    waterDepth: 0,
    isBridge: false,
  };
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
        // Crease slide projection: eliminate velocity into cliff face
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
        // Oblique glancing deflection
        vx -= dotN * nx;
        vy -= dotN * ny;
        state.speed *= (1.0 - p.treeGlanceScrub);
        state.heading = wrapHeading(state.heading + terr.obstacle.nudgeSign * p.treeYawNudge);
      } else {
        // Square stop
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
  state.surfaceFamily = surf.id;
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

// Try dynamic import of ground_model.js if available, falling back to reference step
let GM = null;
try {
  GM = await import("../../../scene3d/vehicle/ground_model.js");
} catch {
  // Implementation in progress
}

export const step = (st, inp, par, ora, dt) => {
  if (GM && typeof GM.step === "function") {
    return GM.step(st, inp, par, ora, dt);
  }
  return stepGroundReference(st, inp, par, ora, dt);
};

export const GROUND = { kind: "analytic-ground-v1", base: 40.0, amp: 20.0, kx: 210.0, ky: 165.0 };
export const groundElevation = (x, y) => GROUND.base + GROUND.amp * Math.sin(x / GROUND.kx) * Math.cos(y / GROUND.ky);

function seq(spans) {
  // spans: [[count, throttle, pitch, roll, yaw, buttons], ...] -> frames
  const frames = [];
  for (const [n, t, p, r, y, b] of spans) {
    for (let i = 0; i < n; i++) frames.push([t, p, r, y, b]);
  }
  return frames;
}

const X0 = 21700.5, Y0 = 3190.25;

// Scenarios: road sprint, low-speed turn, hill climb, water ford, cliff deflection
export const SEQUENCES = [
  {
    name: "road-sprint",
    oracle: (x, y) => ({
      z: 40.0,
      normal: [0, 0, 1],
      surface: SURFACE_FAMILIES[0], // Road
      waterDepth: 0.0,
      isBridge: false,
    }),
    initial: {
      x: X0, y: Y0, z: 40.0, heading: 0.0, pitch: 0.0, roll: 0.0,
      speed: 0.0, steerAngle: 0.0, mode: MODE.PARKED, surfaceFamily: 0, groundFlags: 1,
    },
    frames: seq([
      [120, 255, 0, 0, 0, 0], // sprint 0 -> 29.0 m/s in 4.0s
      [780, 255, 0, 0, 0, 0], // maintain cruise at 29.0 m/s
    ]),
  },
  {
    name: "low-speed-turn",
    oracle: (x, y) => ({
      z: 40.0,
      normal: [0, 0, 1],
      surface: SURFACE_FAMILIES[0], // Road
      waterDepth: 0.0,
      isBridge: false,
    }),
    initial: {
      x: X0 + 500.0, y: Y0, z: 40.0, heading: 0.0, pitch: 0.0, roll: 0.0,
      speed: 6.0, steerAngle: 0.0, mode: MODE.DRIVING, surfaceFamily: 0, groundFlags: 1,
    },
    frames: seq([
      [900, 15, 0, 0, 127, 0], // full right lock at ~6 m/s (40 deg, R = 2.43m)
    ]),
  },
  {
    name: "hill-climb",
    oracle: (x, y) => {
      // 35-degree incline heading North: normal.y = -sin(35°), normal.z = cos(35°)
      const slopeRad = 35.0 * Math.PI / 180.0;
      const ny = -Math.sin(slopeRad);
      const nz = Math.cos(slopeRad);
      const z = 40.0 + (y - Y0) * Math.tan(slopeRad);
      return {
        z,
        normal: [0, ny, nz],
        surface: SURFACE_FAMILIES[2], // Grass
        waterDepth: 0.0,
        isBridge: false,
      };
    },
    initial: {
      x: X0 - 300.0, y: Y0, z: 40.0, heading: 0.0, pitch: 0.0, roll: 0.0,
      speed: 2.0, steerAngle: 0.0, mode: MODE.DRIVING, surfaceFamily: 2, groundFlags: 1,
    },
    frames: seq([
      [900, 255, 0, 0, 0, 1], // Full throttle with 4WD Low-Range (button 0x01)
    ]),
  },
  {
    name: "water-ford",
    oracle: (x, y) => {
      // 0.5m water ford (depth <= 0.8m)
      return {
        z: 39.5,
        normal: [0, 0, 1],
        surface: SURFACE_FAMILIES[7], // ShallowFord
        waterDepth: 0.5,
        isBridge: false,
      };
    },
    initial: {
      x: X0, y: Y0 + 400.0, z: 39.5, heading: 0.0, pitch: 0.0, roll: 0.0,
      speed: 15.0, steerAngle: 0.0, mode: MODE.DRIVING, surfaceFamily: 7, groundFlags: 1,
    },
    frames: seq([
      [900, 255, 0, 0, 0, 0], // Fording shallow water at max ford speed (12.5 m/s)
    ]),
  },
  {
    name: "cliff-deflection",
    oracle: (x, y) => {
      // Steep cliff wall angled at 45 degrees in XY with Nz = 0.5 (< FloorZ = 0.66417415)
      // Normal points South-West (-0.612, -0.612, 0.500)
      const nx = -0.6123724;
      const ny = -0.6123724;
      const nz = 0.5;
      return {
        z: 40.0,
        normal: [nx, ny, nz],
        surface: SURFACE_FAMILIES[8], // Rock
        waterDepth: 0.0,
        isBridge: false,
      };
    },
    initial: {
      x: X0 + 800.0, y: Y0 + 800.0, z: 40.0, heading: 0.4, pitch: 0.0, roll: 0.0,
      speed: 20.0, steerAngle: 0.0, mode: MODE.DRIVING, surfaceFamily: 8, groundFlags: 1,
    },
    frames: seq([
      [900, 200, 0, 0, 0, 0], // Driving into cliff face; crease slide deflects tangentially
    ]),
  },
];

export function getOracle(name) {
  const s = SEQUENCES.find((seq) => seq.name === name);
  return s ? s.oracle : null;
}

export function run(s) {
  const st = { ...s.initial };
  const checkpoints = [];
  s.frames.forEach((fr, i) => {
    step(st, fr, PARAMS, s.oracle, DT);
    if ((i + 1) % 30 === 0) {
      checkpoints.push({ step: i + 1, state: { ...st } });
    }
  });
  return checkpoints;
}

export function buildGoldenDoc() {
  return {
    spec: "vehicles ground golden v1 — generated by gen_golden.mjs from scene3d/vehicle/ground_model.js; do not edit",
    dt: DT,
    simHz: SIM_HZ,
    params: PARAMS,
    surfaces: SURFACE_FAMILIES,
    sequences: SEQUENCES.map((s) => ({
      name: s.name,
      initial: s.initial,
      frames: s.frames,
      checkpoints: run(s),
    })),
  };
}

export function main() {
  const doc = buildGoldenDoc();
  const text = JSON.stringify(doc) + "\n";

  if (process.argv.includes("--check")) {
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== text) {
      console.error("ground-golden.json is STALE — run gen_golden.mjs --write");
      process.exit(1);
    }
    console.log("ground golden up to date");
  } else {
    // Default or --write
    writeFileSync(OUT, text);
    for (const s of doc.sequences) {
      const last = s.checkpoints[s.checkpoints.length - 1].state;
      console.log(`${s.name.padEnd(24)} final mode=${MODE_NAMES[last.mode] || last.mode} speed=${last.speed.toFixed(2)} pos=(${last.x.toFixed(2)}, ${last.y.toFixed(2)}, ${last.z.toFixed(2)})`);
    }
    console.log(`wrote ${OUT}`);
  }
}

const isMain = process.argv[1] && (process.argv[1].endsWith("gen_golden.mjs") || fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) {
  main();
}
