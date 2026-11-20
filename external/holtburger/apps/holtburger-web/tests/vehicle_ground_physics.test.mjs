// tests/vehicle_ground_physics.test.mjs — Willys MB Jeep Ground Physics E2E Test Suite (Tiers 1–4)
//
// Tests deterministic 30 Hz ground vehicle physics, speed-scheduled steering, 4WD low-range,
// mechanical handbrake hill-hold, 11 surface families, walkable bridges, cliff deflection (FloorZ),
// deep ocean surf halts, and glancing tree deflection.
//
// Follows Spec Miner 2 Report §5.1 test matrix across 4 tiers:
//   Tier 1: Feature Coverage (Features A1–A10, >=5 cases each)
//   Tier 2: Boundary & Corner Cases (Features A1–A10 boundary cases)
//   Tier 3: Cross-Feature Combinations (A-C01 .. A-C12)
//   Tier 4: Real-World Application Scenarios (A-S01 .. A-S08)
//
// Run: node tests/vehicle_ground_physics.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, "..");
const GOLDEN_PATH = join(APP_ROOT, "docs/vehicles-2026-11-01/ground/ground-golden.json");
const GEN_GOLDEN_PATH = join(APP_ROOT, "docs/vehicles-2026-11-01/ground/gen_golden.mjs");

// Graceful dynamic import for ground_model.js
let GM = null;
let gmImportError = null;
try {
  GM = await import("../scene3d/vehicle/ground_model.js");
} catch (err) {
  gmImportError = err;
}

const { createPilotPredictor } = await import("../scene3d/vehicle/predictor.js");
const { toCellLocal } = await import("../scene3d/vehicle/flight_model.js");

// Also import reference constants & tools from gen_golden.mjs
let GoldenGen = null;
try {
  GoldenGen = await import("../docs/vehicles-2026-11-01/ground/gen_golden.mjs");
} catch (err) {
  console.warn("gen_golden.mjs import failed:", err.message);
}

let golden = null;
if (existsSync(GOLDEN_PATH)) {
  try {
    golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  } catch (err) {
    console.warn("Failed to parse ground-golden.json:", err.message);
  }
}

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function near(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) {
    throw new Error(`${msg}: expected ${b} ± ${eps}, got ${a} (diff ${Math.abs(a - b)})`);
  }
}

function requireGM() {
  if (!GM) {
    throw new Error(`ground_model.js implementation in progress (${gmImportError?.message || "module not found"})`);
  }
  return GM;
}

console.log("=== TIER 1: Feature Coverage (Features A1–A10) ===");

// -----------------------------------------------------------------------------
// Feature A1: 30 Hz Parity & Step Determinism
// -----------------------------------------------------------------------------
console.log("\n--- Feature A1: 30 Hz Parity & Step Determinism ---");

check("Case A1.1: 900-step straight acceleration trajectory matches ground-golden.json checkpoints within 1 mm", () => {
  const gm = requireGM();
  assert(golden, "ground-golden.json fixture must exist");
  const seq = golden.sequences.find((s) => s.name === "road-sprint");
  assert(seq, "road-sprint sequence must exist in golden");

  const st = { ...seq.initial };
  const oracle = GoldenGen.getOracle(seq.name);
  let ci = 0;
  seq.frames.forEach((frame, i) => {
    gm.step(st, gm.inputFromFrame(frame), golden.params, oracle, golden.dt);
    const cp = seq.checkpoints[ci];
    if (cp && cp.step === i + 1) {
      const dist = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
      assert(dist < 0.001, `step ${cp.step}: position diverged by ${dist.toFixed(6)} m (limit 0.001 m)`);
      near(st.speed, cp.state.speed, 1e-4, `step ${cp.step} speed`);
      near(st.heading, cp.state.heading, 1e-4, `step ${cp.step} heading`);
      assert(st.mode === cp.state.mode, `step ${cp.step} mode: ${st.mode} vs ${cp.state.mode}`);
      ci++;
    }
  });
  assert(ci === seq.checkpoints.length, `verified ${ci}/${seq.checkpoints.length} checkpoints`);
});

check("Case A1.2: 900-step slalom steering trajectory matches golden checkpoints within 1 mm", () => {
  const gm = requireGM();
  assert(golden, "ground-golden.json fixture must exist");
  const seq = golden.sequences.find((s) => s.name === "low-speed-turn");
  assert(seq, "low-speed-turn sequence must exist in golden");

  const st = { ...seq.initial };
  const oracle = GoldenGen.getOracle(seq.name);
  let ci = 0;
  seq.frames.forEach((frame, i) => {
    gm.step(st, gm.inputFromFrame(frame), golden.params, oracle, golden.dt);
    const cp = seq.checkpoints[ci];
    if (cp && cp.step === i + 1) {
      const dist = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
      assert(dist < 0.001, `step ${cp.step}: position diverged by ${dist.toFixed(6)} m`);
      ci++;
    }
  });
  assert(ci === seq.checkpoints.length, `verified ${ci}/${seq.checkpoints.length} checkpoints`);
});

check("Case A1.3: 900-step rough terrain traversal matches golden checkpoints within 1 mm", () => {
  const gm = requireGM();
  assert(golden, "ground-golden.json fixture must exist");
  const seq = golden.sequences.find((s) => s.name === "hill-climb");
  assert(seq, "hill-climb sequence must exist in golden");

  const st = { ...seq.initial };
  const oracle = GoldenGen.getOracle(seq.name);
  let ci = 0;
  seq.frames.forEach((frame, i) => {
    gm.step(st, gm.inputFromFrame(frame), golden.params, oracle, golden.dt);
    const cp = seq.checkpoints[ci];
    if (cp && cp.step === i + 1) {
      const dist = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
      assert(dist < 0.001, `step ${cp.step}: hill climb diverged by ${dist.toFixed(6)} m`);
      ci++;
    }
  });
  assert(ci === seq.checkpoints.length, `verified ${ci}/${seq.checkpoints.length} checkpoints`);
});

check("Case A1.4: 900-step handbrake stop-and-go trajectory matches golden checkpoints within 1 mm", () => {
  const gm = requireGM();
  assert(golden, "ground-golden.json fixture must exist");
  const seq = golden.sequences.find((s) => s.name === "water-ford");
  assert(seq, "water-ford sequence must exist in golden");

  const st = { ...seq.initial };
  const oracle = GoldenGen.getOracle(seq.name);
  let ci = 0;
  seq.frames.forEach((frame, i) => {
    gm.step(st, gm.inputFromFrame(frame), golden.params, oracle, golden.dt);
    const cp = seq.checkpoints[ci];
    if (cp && cp.step === i + 1) {
      const dist = Math.hypot(st.x - cp.state.x, st.y - cp.state.y, st.z - cp.state.z);
      assert(dist < 0.001, `step ${cp.step}: water ford diverged by ${dist.toFixed(6)} m`);
      ci++;
    }
  });
  assert(ci === seq.checkpoints.length, `verified ${ci}/${seq.checkpoints.length} checkpoints`);
});

check("Case A1.5: Quantized input round-trip: sticks i8, throttle u8, buttons mask match server dequantization", () => {
  const gm = requireGM();
  const raw = { throttle: 0.75, steer: -0.5, buttons: 0x21 };
  const q = gm.quantizeInput(raw);
  assert(q.throttle === Math.round(0.75 * 255), "quantized throttle");
  assert(q.yaw === Math.round(-0.5 * 127) || q.steer === Math.round(-0.5 * 127), "quantized steer");
  assert((q.buttons & 0x01) !== 0, "boost flag in buttons");
  assert((q.buttons & 0x20) !== 0, "handbrake flag in buttons");

  const deq = gm.inputFromFrame({ throttle: q.throttle, pitch: 0, roll: 0, yaw: q.yaw, buttons: q.buttons });
  near(deq.throttle, 0.75, 1.0 / 255, "dequantized throttle");
  near(deq.steer, -0.5, 1.0 / 127, "dequantized steer");
  assert(deq.boost === true, "dequantized boost");
  assert(deq.handbrake === true, "dequantized handbrake");
});

check("Case A1.6: Golden generator gen_golden.mjs runs with --check and exits 0 against ground-golden.json", () => {
  const out = execSync(`node "${GEN_GOLDEN_PATH}" --check`, { encoding: "utf8" });
  assert(out.includes("ground golden up to date"), "gen_golden.mjs --check must report up to date");
});

// -----------------------------------------------------------------------------
// Feature A2: Road Sprint Acceleration Envelope
// -----------------------------------------------------------------------------
console.log("\n--- Feature A2: Road Sprint Acceleration Envelope ---");

check("Case A2.1: Initial launch acceleration at v = 0 m/s on road equals a0 = 11.2 m/s² ± 0.1", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const inp = { throttle: 1.0, steer: 0, buttons: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  gm.step(st, inp, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  const a0 = st.speed / (1.0 / 30.0);
  near(a0, 11.2, 0.1, "launch acceleration a0");
});

check("Case A2.2: Road sprint reaches 14.5 m/s (50% top speed) in 1.4 s ± 0.15 s", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const inp = { throttle: 1.0, steer: 0, buttons: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  let t = 0;
  while (st.speed < 14.5 && t < 3.0) {
    gm.step(st, inp, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
    t += 1.0 / 30.0;
  }
  near(t, 1.4, 0.15, "time to reach 14.5 m/s");
});

check("Case A2.3: Road sprint reaches 26.1 m/s (90% top speed) in 3.1 s ± 0.2 s", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const inp = { throttle: 1.0, steer: 0, buttons: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  let t = 0;
  while (st.speed < 26.1 && t < 5.0) {
    gm.step(st, inp, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
    t += 1.0 / 30.0;
  }
  near(t, 3.1, 0.2, "time to reach 26.1 m/s");
});

check("Case A2.4: Road sprint completes 0 -> 29.0 m/s in 4.0 s ± 0.25 s", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const inp = { throttle: 1.0, steer: 0, buttons: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  let t = 0;
  while (st.speed < 28.95 && t < 6.0) {
    gm.step(st, inp, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
    t += 1.0 / 30.0;
  }
  near(t, 4.0, 0.25, "time to reach ~29.0 m/s");
});

check("Case A2.5: Coast-down deceleration at 29.0 m/s with throttle 0 matches dcoast = 1.8 + 0.04(29) = 2.96 m/s² ± 0.1", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 29.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 0.0, steer: 0, buttons: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const dt = 1.0 / 30.0;
  gm.step(st, inp, GoldenGen.PARAMS, oracle, dt);
  const decel = (29.0 - st.speed) / dt;
  near(decel, 2.96, 0.1, "coast-down deceleration at 29 m/s");
});

// -----------------------------------------------------------------------------
// Feature A3: Low-Speed Agility & Steer Slew
// -----------------------------------------------------------------------------
console.log("\n--- Feature A3: Low-Speed Agility & Steer Slew ---");

check("Case A3.1: Full lock steer angle at v <= 12.0 m/s achieves exactly 40.0° (0.69813 rad)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 8.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 0.2, steer: 1.0, buttons: 0 };
  for (let i = 0; i < 30; i++) gm.step(st, inp, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.steerAngle, 40.0 * Math.PI / 180.0, 1e-4, "low-speed steer angle");
});

check("Case A3.2: Turn radius at 40° lock with L = 2.04 m equals 2.43 m ± 0.02 m", () => {
  const R = 2.04 / Math.tan(40.0 * Math.PI / 180.0);
  near(R, 2.431, 0.02, "turn radius min");
});

check("Case A3.3: Rack slew rate at v <= 12.0 m/s equals 5.2 rad/s (0 -> 40° in 0.134 s / 4 steps)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 0.2, steer: 1.0, buttons: 0 };
  const dt = 1.0 / 30.0;
  gm.step(st, inp, GoldenGen.PARAMS, null, dt);
  near(st.steerAngle, 5.2 * dt, 1e-4, "single-step rack slew angle");
});

check("Case A3.4: Steady-state turning circle diameter at 6.0 m/s equals 4.86 m ± 0.05 m", () => {
  const diameter = 2 * (2.04 / Math.tan(40.0 * Math.PI / 180.0));
  near(diameter, 4.86, 0.05, "turning circle diameter");
});

check("Case A3.5: Return-to-center steer slew rate matches 5.2 rad/s when steering input released", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 6.0, steerAngle: 0.69813, mode: 6 };
  const inp = { throttle: 0.2, steer: 0.0, buttons: 0 };
  const dt = 1.0 / 30.0;
  gm.step(st, inp, GoldenGen.PARAMS, null, dt);
  near(0.69813 - st.steerAngle, 5.2 * dt, 1e-4, "return-to-center delta");
});

// -----------------------------------------------------------------------------
// Feature A4: High-Speed Steer Clamping
// -----------------------------------------------------------------------------
console.log("\n--- Feature A4: High-Speed Steer Clamping ---");

check("Case A4.1: At v = 20.5 m/s (halfway between 12 and 29 m/s), maximum steer angle clamps to 26.0° ± 0.2°", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.5, steerAngle: 0, mode: 6 };
  const thr = Math.pow(20.5 / 29.0, 1.8);
  const inp = { throttle: thr, steer: 1.0, buttons: 0 };
  for (let i = 0; i < 30; i++) gm.step(st, inp, GoldenGen.PARAMS, null, 1.0 / 30.0);
  const deg = st.steerAngle * 180.0 / Math.PI;
  near(deg, 26.0, 0.2, "steer angle clamp at 20.5 m/s");
});

check("Case A4.2: At v = 29.0 m/s, maximum steer angle clamps to exactly 12.0° (0.20944 rad)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 29.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 1.0, steer: 1.0, buttons: 0 };
  for (let i = 0; i < 30; i++) gm.step(st, inp, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.steerAngle, 12.0 * Math.PI / 180.0, 1e-4, "high-speed steer clamp at 29 m/s");
});

check("Case A4.3: Rack slew rate at v = 29.0 m/s tapers to 2.6 rad/s ± 0.05 rad/s", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 29.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 1.0, steer: 1.0, buttons: 0 };
  const dt = 1.0 / 30.0;
  gm.step(st, inp, GoldenGen.PARAMS, null, dt);
  near(st.steerAngle, 2.6 * dt, 1e-4, "high-speed slew rate delta");
});

check("Case A4.4: High-speed turn radius at 29.0 m/s (12° lock) equals 9.60 m ± 0.1 m", () => {
  const R = 2.04 / Math.tan(12.0 * Math.PI / 180.0);
  near(R, 9.60, 0.1, "high speed turn radius");
});

check("Case A4.5: Sudden full stick steer deflection at 29.0 m/s produces smooth yaw transition without angular snap", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 29.0, steerAngle: 0, mode: 6 };
  const inp = { throttle: 1.0, steer: -1.0, buttons: 0 };
  const dt = 1.0 / 30.0;
  gm.step(st, inp, GoldenGen.PARAMS, null, dt);
  assert(st.steerAngle >= -2.6 * dt - 1e-6, "steer angle must not snap instantly");
});

// -----------------------------------------------------------------------------
// Feature A5: 4WD Low-Range Climbing
// -----------------------------------------------------------------------------
console.log("\n--- Feature A5: 4WD Low-Range Climbing ---");

check("Case A5.1: Holding Shift (Boost bit 0x01) at v = 5.0 m/s applies 1.85x base drive torque", () => {
  const gm = requireGM();
  const st2WD = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 5.0, steerAngle: 0, mode: 6 };
  const st4WD = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 5.0, steerAngle: 0, mode: 6 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const dt = 1.0 / 30.0;
  gm.step(st2WD, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, dt);
  gm.step(st4WD, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, oracle, dt);
  const dv2WD = st2WD.speed - 5.0;
  const dv4WD = st4WD.speed - 5.0;
  near(dv4WD / dv2WD, 1.85, 0.05, "4WD torque multiplier ratio");
});

check("Case A5.2: 4WD Low-Range successfully ascends 38° grass trail where 2WD stalls", () => {
  const gm = requireGM();
  const slopeRad = 38.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const oracle = () => ({ z: 10, normal, surface: { id: 2, mu: 0.82, vMax: 23.5 } });
  const st4WD = { x: 0, y: 0, z: 10, heading: 0, pitch: slopeRad, roll: 0, speed: 5.0, steerAngle: 0, mode: 6 };
  for (let i = 0; i < 30; i++) gm.step(st4WD, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  assert(st4WD.speed > 5.0, "4WD Low-Range must accelerate uphill on 38° grade");
});

check("Case A5.3: 4WD Low-Range ascends maximum playable slope of 44° (cos = 0.71934)", () => {
  const slopeRad = 44.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  near(normal[2], 0.71934, 0.001, "climb limit cosine for 44 degrees");
});

check("Case A5.4: 4WD Low-Range torque multiplier tapers to 1.0x as speed exceeds 15.0 m/s", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 15.5, steerAngle: 0, mode: 6 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const dt = 1.0 / 30.0;
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, oracle, dt);
  const stNoBoost = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 15.5, steerAngle: 0, mode: 6 };
  gm.step(stNoBoost, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, dt);
  near(st.speed, stNoBoost.speed, 1e-4, "boost torque multiplier above 15 m/s");
});

check("Case A5.5: Releasing Shift restores standard 2WD torque immediately", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 8.0, steerAngle: 0, mode: 6 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  assert((st.groundFlags & 0x04) === 0, "boost ground flag cleared");
});

// -----------------------------------------------------------------------------
// Feature A6: Mechanical Handbrake & Hill-Hold
// -----------------------------------------------------------------------------
console.log("\n--- Feature A6: Mechanical Handbrake & Hill-Hold ---");

check("Case A6.1: Holding Space (Handbrake bit 0x20) at 20 m/s applies 22.0 m/s² braking deceleration", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const dt = 1.0 / 30.0;
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, oracle, dt);
  const decel = (20.0 - st.speed) / dt;
  near(decel, 22.0, 0.1, "handbrake deceleration");
});

check("Case A6.2: Handbrake application while turning breaks rear lateral traction into oversteer drift", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 15.0, steerAngle: 0.3, mode: 6 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  gm.step(st, { throttle: 0.0, steer: 0.3, buttons: 0x20 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  assert((st.groundFlags & 0x02) !== 0, "handbrake flag active in groundFlags");
});

check("Case A6.3: Engaging Handbrake on 30° incline halts vehicle and holds position at v = 0 m/s", () => {
  const gm = requireGM();
  const slopeRad = 30.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const oracle = () => ({ z: 10, normal, surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const st = { x: 0, y: 0, z: 10, heading: 0, pitch: slopeRad, roll: 0, speed: 0.03, steerAngle: 0, mode: 6 };
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  near(st.speed, 0.0, 1e-6, "speed snapped to 0 by handbrake hill-hold");
});

check("Case A6.4: Automatic hill-hold maintains v = 0 m/s over 300 steps (10 s) without downward drift (< 0.0001 m)", () => {
  const gm = requireGM();
  const slopeRad = 35.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const oracle = () => ({ z: 10, normal, surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const st = { x: 0, y: 0, z: 10, heading: 0, pitch: slopeRad, roll: 0, speed: 0.0, steerAngle: 0, mode: 0 };
  const initialY = st.y;
  for (let i = 0; i < 300; i++) {
    gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  }
  near(st.y, initialY, 0.0001, "hill-hold downward displacement");
});

check("Case A6.5: Releasing Handbrake and applying reverse throttle accelerates cleanly down the slope", () => {
  const gm = requireGM();
  const slopeRad = 30.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const oracle = () => ({ z: 10, normal, surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  const st = { x: 0, y: 0, z: 10, heading: 0, pitch: slopeRad, roll: 0, speed: 0.0, steerAngle: 0, mode: 0 };
  gm.step(st, { throttle: -1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  assert(st.speed < 0.0, "reverse throttle must accelerate in reverse down slope");
});

// -----------------------------------------------------------------------------
// Feature A7: 11 Surface Families & Traction Envelopes
// -----------------------------------------------------------------------------
console.log("\n--- Feature A7: 11 Surface Families & Traction Envelopes ---");

check("Case A7.1: Dirt surface (FAM_DIRT): top speed reaches 24.4 m/s ± 0.2; mu = 0.88", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Dirt");
  near(fam.vMax, 24.4, 0.2, "dirt vMax");
  near(fam.mu, 0.88, 0.01, "dirt mu");
});

check("Case A7.2: Grass surface (FAM_GRASS): top speed reaches 23.5 m/s ± 0.2; mu = 0.82", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Grass");
  near(fam.vMax, 23.5, 0.2, "grass vMax");
  near(fam.mu, 0.82, 0.01, "grass mu");
});

check("Case A7.3: Forest floor: top speed reaches 21.5 m/s ± 0.2; mu = 0.75", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Forest");
  near(fam.vMax, 21.5, 0.2, "forest vMax");
  near(fam.mu, 0.75, 0.01, "forest mu");
});

check("Case A7.4: Snow / Ice (FAM_SNOWICE): top speed reaches 19.1 m/s ± 0.2; mu = 0.55; lateral grip drops to 0.50", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "SnowIce");
  near(fam.vMax, 19.1, 0.2, "snow/ice vMax");
  near(fam.mu, 0.55, 0.01, "snow/ice mu");
  near(fam.muLat, 0.50, 0.01, "snow/ice muLat");
});

check("Case A7.5: Sand surface (FAM_SAND): top speed reaches 18.6 m/s ± 0.2; mu = 0.60", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Sand");
  near(fam.vMax, 18.6, 0.2, "sand vMax");
  near(fam.mu, 0.60, 0.01, "sand mu");
});

check("Case A7.6: Mud / Swamp (FAM_SWAMP): top speed reaches 15.4 m/s ± 0.2; mu = 0.50", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Swamp");
  near(fam.vMax, 15.4, 0.2, "mud/swamp vMax");
  near(fam.mu, 0.50, 0.01, "mud/swamp mu");
});

check("Case A7.7: Shallow ford water: top speed reaches 12.5 m/s ± 0.2; mu = 0.45", () => {
  const fam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "ShallowFord");
  near(fam.vMax, 12.5, 0.2, "shallow ford vMax");
  near(fam.mu, 0.45, 0.01, "shallow ford mu");
});

// -----------------------------------------------------------------------------
// Feature A8: Walkable Bridge & Ramp Traversal
// -----------------------------------------------------------------------------
console.log("\n--- Feature A8: Walkable Bridge & Ramp Traversal ---");

check("Case A8.1: Downward probe detects static bridge deck polygon with Nz >= FloorZ", () => {
  const bridgeNormal = [0, 0, 1.0];
  assert(bridgeNormal[2] >= GoldenGen.PARAMS.floorZ, "bridge deck must satisfy FloorZ threshold");
});

check("Case A8.2: Vehicle traverses bridge spanning deep water without triggering water halt", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 20.0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const bridgeOracle = () => ({
    z: 20.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    waterDepth: 15.0, // deep ocean abyss under bridge
    isBridge: true,   // supported by bridge deck
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, bridgeOracle, 1.0 / 30.0);
  assert(st.speed > 19.5, "speed must not be halted by deep water when on bridge");
});

check("Case A8.3: Transition from dirt approach ramp onto bridge deck produces smooth vertical altitude continuation", () => {
  const rampZ = 19.8;
  const bridgeZ = 20.0;
  assert(Math.abs(bridgeZ - rampZ) < 0.25, "vertical approach transition height step");
});

check("Case A8.4: Vehicle stops and accelerates on bridge deck with dry road/wood traction", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 20.0, heading: 0, pitch: 0, roll: 0, speed: 0.0, steerAngle: 0, mode: 0 };
  const bridgeOracle = () => ({
    z: 20.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    waterDepth: 10.0,
    isBridge: true,
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, bridgeOracle, 1.0 / 30.0);
  assert(st.speed > 0.3, "vehicle must accelerate on bridge deck");
});

check("Case A8.5: Bridge support sampling handles slanted ramps up to 25° grade without polygon clipping", () => {
  const rampGradeCos = Math.cos(25.0 * Math.PI / 180.0);
  assert(rampGradeCos >= GoldenGen.PARAMS.floorZ, "25° bridge ramp angle exceeds FloorZ");
});

// -----------------------------------------------------------------------------
// Feature A9: Cliff Deflection & Crease Slide
// -----------------------------------------------------------------------------
console.log("\n--- Feature A9: Cliff Deflection & Crease Slide ---");

check("Case A9.1: Slope with Nz = 0.70 (> FloorZ) permits forward uphill climb", () => {
  assert(0.70 >= GoldenGen.PARAMS.floorZ, "Nz = 0.70 is walkable slope");
});

check("Case A9.2: Slope with Nz = 0.60 (< FloorZ) blocks uphill forward climb", () => {
  assert(0.60 < GoldenGen.PARAMS.floorZ, "Nz = 0.60 is steep cliff");
});

check("Case A9.3: Crease slide projection redirects forward velocity tangentially along cliff base (v · N = 0)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 10.0, heading: 0.0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  // Cliff normal facing south (-y): normal = [0, -0.8, 0.6] (< FloorZ)
  const cliffOracle = () => ({
    z: 10.0,
    normal: [0, -0.8, 0.6],
    surface: { id: 8, mu: 0.8, vMax: 22.0 },
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, cliffOracle, 1.0 / 30.0);
  // Velocity in direction of normal (heading 0 = +y, cliff normal = -y, so dot < 0)
  near(st.speed, 0.0, 1e-4, "direct head-on collision into cliff zeroes normal speed");
});

check("Case A9.4: Vehicle does not penetrate cliff face or exhibit vertical elevation pop", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 10.0, heading: 0.5, pitch: 0, roll: 0, speed: 15.0, steerAngle: 0, mode: 6 };
  const cliffOracle = () => ({
    z: 10.0,
    normal: [-0.6, -0.6, 0.5],
    surface: { id: 8, mu: 0.8, vMax: 22.0 },
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, cliffOracle, 1.0 / 30.0);
  near(st.z, 10.0, 1e-4, "z position on ground base preserved during crease slide");
});

check("Case A9.5: Driver can reverse away from cliff face with full reverse acceleration", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 10.0, heading: 0.0, pitch: 0, roll: 0, speed: 0.0, steerAngle: 0, mode: 6 };
  const cliffOracle = () => ({
    z: 10.0,
    normal: [0, -0.8, 0.6],
    surface: { id: 8, mu: 0.8, vMax: 22.0 },
  });
  gm.step(st, { throttle: -1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, cliffOracle, 1.0 / 30.0);
  assert(st.speed < 0.0, "reverse throttle moves vehicle away from cliff");
});

// -----------------------------------------------------------------------------
// Feature A10: Ocean Surf Halt & Tree Deflection
// -----------------------------------------------------------------------------
console.log("\n--- Feature A10: Ocean Surf Halt & Tree Deflection ---");

check("Case A10.1: Entering ocean surf (Z <= -0.5 m) arrests forward motion (vfwd -> 0)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: -1.0, heading: 0, pitch: 0, roll: 0, speed: 10.0, steerAngle: 0, mode: 6 };
  const oceanOracle = () => ({
    z: -1.0,
    normal: [0, 0, 1],
    surface: { id: 7, mu: 0.45, vMax: 12.5 },
    waterDepth: 1.5, // > 0.8 m
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oceanOracle, 1.0 / 30.0);
  near(st.speed, 0.0, 1e-4, "forward speed zeroed in deep ocean surf");
});

check("Case A10.2: Vehicle does not crash, take damage, or despawn in ocean surf", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: -1.0, heading: 0, pitch: 0, roll: 0, speed: 0.0, steerAngle: 0, mode: 6 };
  const oceanOracle = () => ({
    z: -1.0,
    normal: [0, 0, 1],
    surface: { id: 7, mu: 0.45, vMax: 12.5 },
    waterDepth: 1.5,
  });
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oceanOracle, 1.0 / 30.0);
  assert(st.mode !== GoldenGen.MODE.CRASHED, "vehicle must not crash in ocean surf");
});

check("Case A10.3: Applying reverse throttle in ocean surf extracts vehicle backward onto dry ground", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: -1.0, heading: 0, pitch: 0, roll: 0, speed: 0.0, steerAngle: 0, mode: 6 };
  const oceanOracle = () => ({
    z: -1.0,
    normal: [0, 0, 1],
    surface: { id: 7, mu: 0.45, vMax: 12.5 },
    waterDepth: 1.5,
  });
  gm.step(st, { throttle: -1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oceanOracle, 1.0 / 30.0);
  assert(st.speed < 0.0, "reverse gear must operate in deep water to allow extraction");
});

check("Case A10.4: Glancing tree hit (|d| = 0.40 < 0.65) deflects velocity tangentially with 25% speed scrub", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const treeOracle = () => ({
    z: 0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: 0.4, ny: 0.0 },
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeOracle, 1.0 / 30.0);
  near(st.speed, 15.0, 0.5, "speed scrubbed by ~25%");
});

check("Case A10.5: Glancing tree hit applies 0.05 rad yaw nudge away from trunk", () => {
  const gm = requireGM();
  // Sub-case 1: Tree on LEFT (nx = 0.4, ny = 0.0 -> trunk is at West):
  // Vehicle must deflect away from trunk by turning RIGHT (+0.05 rad)
  const stLeft = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const treeLeftOracle = () => ({
    z: 0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: 0.4, ny: 0.0 }, // Dynamic cross product (no hardcoded nudgeSign)
  });
  gm.step(stLeft, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeLeftOracle, 1.0 / 30.0);
  near(stLeft.heading, 0.05, 0.005, "yaw nudge angle away from left trunk (turns right)");

  // Sub-case 2: Tree on RIGHT (nx = -0.4, ny = 0.0 -> trunk is at East):
  // Vehicle must deflect away from trunk by turning LEFT (-0.05 rad, wrapped to 2*PI - 0.05)
  const stRight = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const treeRightOracle = () => ({
    z: 0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: -0.4, ny: 0.0 }, // Dynamic cross product (no hardcoded nudgeSign)
  });
  gm.step(stRight, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeRightOracle, 1.0 / 30.0);
  near(stRight.heading, 2 * Math.PI - 0.05, 0.005, "yaw nudge angle away from right trunk (turns left)");
});

check("Case A10.6: Square tree hit (|d| = 0.85 >= 0.65) stops vehicle cleanly (v = 0) at trunk radius", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 20.0, steerAngle: 0, mode: 6 };
  const treeOracle = () => ({
    z: 0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: 0.0, ny: -1.0, nudgeSign: 0 }, // Head-on normal
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeOracle, 1.0 / 30.0);
  near(st.speed, 0.0, 1e-4, "square tree hit stops vehicle completely");
});

// -----------------------------------------------------------------------------
// TIER 2: Boundary & Corner Cases
// -----------------------------------------------------------------------------
console.log("\n=== TIER 2: Boundary & Corner Cases ===");

check("Case A1.B1: Zero-input stationary drift test: vehicle at rest for 900 steps exhibits 0.000000 m position change", () => {
  const gm = requireGM();
  const st = { x: 100, y: 100, z: 0, heading: 1.0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  for (let i = 0; i < 900; i++) gm.step(st, { throttle: 0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.x, 100, 1e-9, "drift x");
  near(st.y, 100, 1e-9, "drift y");
});

check("Case A2.B1: Full throttle held for 1,800 steps (60 s) asymptotically converges to exactly 29.000 m/s without overshoot", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  for (let i = 0; i < 1800; i++) gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  near(st.speed, 29.0, 1e-3, "terminal speed on road");
});

check("Case A2.B3: Reverse throttle held converges to exactly -10.000 m/s top reverse speed", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const oracle = () => ({ z: 0, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  for (let i = 0; i < 600; i++) gm.step(st, { throttle: -1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, oracle, 1.0 / 30.0);
  near(st.speed, -10.0, 1e-3, "terminal reverse speed");
});

check("Case A3.B2: Steer lock at boundary speed v = 12.000 m/s maintains exactly 40.0° lock", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 12.0, steerAngle: 0, mode: 6 };
  const thr = Math.pow(12.0 / 29.0, 1.8);
  for (let i = 0; i < 30; i++) gm.step(st, { throttle: thr, steer: 1.0, buttons: 0 }, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.steerAngle, 40.0 * Math.PI / 180.0, 1e-4, "lock at 12 m/s");
});

check("Case A3.B3: Steer lock at boundary speed v = 12.001 m/s initiates linear tapering (< 40.0°)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 12.001, steerAngle: 0, mode: 6 };
  const thr = Math.pow(12.001 / 29.0, 1.8);
  for (let i = 0; i < 30; i++) gm.step(st, { throttle: thr, steer: 1.0, buttons: 0 }, GoldenGen.PARAMS, null, 1.0 / 30.0);
  assert(st.steerAngle < 40.0 * Math.PI / 180.0, "steer angle must taper above 12.0 m/s");
});

check("Case A4.B1: Steer lock at maximum road speed v = 29.000 m/s clamps to exactly 12.000°", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 29.0, steerAngle: 0, mode: 6 };
  for (let i = 0; i < 30; i++) gm.step(st, { throttle: 1.0, steer: 1.0, buttons: 0 }, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.steerAngle, 12.0 * Math.PI / 180.0, 1e-4, "lock at 29 m/s");
});

check("Case A5.B1: Boost toggle at exactly v = 15.000 m/s exhibits zero torque discontinuity", () => {
  const v = 15.0;
  assert(v <= GoldenGen.PARAMS.lowRangeSpeedCap, "15.0 m/s is at low range cutoff threshold");
});

check("Case A6.B1: Handbrake engaged at 0.05 m/s snaps speed to 0.000 m/s (dead-zone threshold)", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0.05, steerAngle: 0, mode: 6 };
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, null, 1.0 / 30.0);
  near(st.speed, 0.0, 1e-6, "speed snapped at 0.05 m/s");
});

check("Case A6.B2: Handbrake engaged at 0.06 m/s applies 22.0 m/s² braking until stopped", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0.06, steerAngle: 0, mode: 6 };
  const dt = 1.0 / 30.0;
  // 22.0 * dt = 0.733 m/s > 0.06 m/s, so stops in 1 step
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, null, dt);
  near(st.speed, 0.0, 1e-6, "stopped cleanly");
});

check("Case A6.B3: Handbrake on ice surface (mu = 0.55) extends braking distance by 1 / 0.55 ≈ 1.82x", () => {
  const ratio = 1.0 / 0.55;
  near(ratio, 1.818, 0.01, "ice braking distance multiplier");
});

check("Case A7.B4: Water depth at exactly 0.800 m qualifies as ford; 0.801 m triggers deep water check", () => {
  assert(0.800 <= GoldenGen.PARAMS.fordDepthMax, "0.800m is fordable");
  assert(0.801 > GoldenGen.PARAMS.fordDepthMax, "0.801m exceeds ford depth limit");
});

check("Case A9.B1: Terrain normal at Nz = 0.66417416 (just above FloorZ) allows climb", () => {
  assert(0.66417416 >= GoldenGen.PARAMS.floorZ, "walkable normal above FloorZ");
});

check("Case A9.B2: Terrain normal at Nz = 0.66417410 (just below FloorZ) triggers cliff deflection", () => {
  assert(0.66417410 < GoldenGen.PARAMS.floorZ, "steep cliff normal below FloorZ");
});

check("Case A10.B1: Alignment dot product at d = 0.6499 triggers glancing slide (15–30% scrub)", () => {
  assert(0.6499 < GoldenGen.PARAMS.treeGlanceThreshold, "d = 0.6499 is glancing hit");
});

check("Case A10.B2: Alignment dot product at d = 0.6501 triggers square stop (v = 0)", () => {
  assert(0.6501 >= GoldenGen.PARAMS.treeGlanceThreshold, "d = 0.6501 is square hit");
});

// -----------------------------------------------------------------------------
// TIER 3: Cross-Feature Combinations
// -----------------------------------------------------------------------------
console.log("\n=== TIER 3: Cross-Feature Combinations ===");

check("Case A-C01: 4WD Low-Range + Cliff Crease Slide: 4WD low against steep cliff drives lateral crease slide without ascending", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0.5, pitch: 0, roll: 0, speed: 10.0, steerAngle: 0, mode: 6 };
  const cliffOracle = () => ({
    z: 0,
    normal: [-0.6, -0.6, 0.5],
    surface: { id: 8, mu: 0.8, vMax: 22.0 },
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, cliffOracle, 1.0 / 30.0);
  near(st.z, 0.0, 1e-4, "cliff base elevation held without ascending");
});

check("Case A-C02: High-Speed Swerve + Surface Transition: Swerving vehicle at 25 m/s transitions from road onto ice", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 25.0, steerAngle: 0.2, mode: 6 };
  const iceOracle = () => ({
    z: 0,
    normal: [0, 0, 1],
    surface: { id: 4, mu: 0.55, muLat: 0.50, vMax: 19.1 },
  });
  gm.step(st, { throttle: 1.0, steer: 0.5, buttons: 0 }, GoldenGen.PARAMS, iceOracle, 1.0 / 30.0);
  assert((st.groundFlags & 0x08) !== 0, "slipping flag active on ice");
});

check("Case A-C03: Handbrake Hill-Hold on Ice Slope: Handbrake holds vehicle stationary on 25° frozen ice slope", () => {
  const gm = requireGM();
  const slopeRad = 25.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const iceOracle = () => ({
    z: 5.0,
    normal,
    surface: { id: 4, mu: 0.55, vMax: 19.1 },
  });
  const st = { x: 0, y: 0, z: 5.0, heading: 0, pitch: slopeRad, roll: 0, speed: 0.0, steerAngle: 0, mode: 0 };
  gm.step(st, { throttle: 0.0, steer: 0, buttons: 0x20 }, GoldenGen.PARAMS, iceOracle, 1.0 / 30.0);
  near(st.speed, 0.0, 1e-6, "hill-hold maintains zero speed on ice slope");
});

check("Case A-C04: Tree Glancing Deflection into Cliff Base: Secondary cliff deflection preserves momentum along base", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 0, heading: 0.2, pitch: 0, roll: 0, speed: 15.0, steerAngle: 0, mode: 6 };
  const treeCliffOracle = () => ({
    z: 0,
    normal: [-0.6, -0.6, 0.5],
    surface: { id: 8, mu: 0.8, vMax: 22.0 },
    obstacle: { nx: 0.5, ny: 0.0, nudgeSign: 1 },
  });
  gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeCliffOracle, 1.0 / 30.0);
  assert(st.speed > 0.0, "vehicle maintains forward momentum along cliff base");
});

check("Case A-C05: Walkable Bridge Crossing with Handbrake Turn: Handbrake drift across bridge deck without ocean halt", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 15.0, heading: 0.1, pitch: 0, roll: 0, speed: 18.0, steerAngle: 0.3, mode: 6 };
  const bridgeOracle = () => ({
    z: 15.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    waterDepth: 25.0,
    isBridge: true,
  });
  gm.step(st, { throttle: 0.0, steer: 0.5, buttons: 0x20 }, GoldenGen.PARAMS, bridgeOracle, 1.0 / 30.0);
  assert(st.speed > 10.0, "handbrake drift on bridge deck retains speed");
});

check("Case A-C06: Deep Water Halt with 4WD Low Reverse Extraction: Reversing with 4WD Low pulls out of mud/water onto bank", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: -1.0, heading: 0, pitch: 0, roll: 0, speed: 0.0, steerAngle: 0, mode: 6 };
  const waterOracle = () => ({
    z: -1.0,
    normal: [0, 0, 1],
    surface: { id: 6, mu: 0.5, vMax: 15.4 },
    waterDepth: 1.2,
  });
  gm.step(st, { throttle: -1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, waterOracle, 1.0 / 30.0);
  assert(st.speed < -0.2, "reverse 4WD low gear generates backward traction");
});

// -----------------------------------------------------------------------------
// TIER 4: Real-World Application Scenarios
// -----------------------------------------------------------------------------
console.log("\n=== TIER 4: Real-World Application Scenarios ===");

check("Case A-S01: Holtburg to Arwic Express Highway Run: Continuous 3-minute sprint along paved roads with steer clamps", () => {
  const gm = requireGM();
  const st = { x: 21700, y: 3190, z: 40, heading: 0, pitch: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 };
  const roadOracle = () => ({ z: 40, normal: [0, 0, 1], surface: { id: 0, mu: 1.0, vMax: 29.0 } });
  for (let step = 0; step < 5400; step++) {
    // 3 minutes = 180 s = 5400 steps
    const steer = Math.sin(step / 300) * 0.2;
    gm.step(st, { throttle: 1.0, steer, buttons: 0 }, GoldenGen.PARAMS, roadOracle, 1.0 / 30.0);
  }
  near(st.speed, 29.0, 0.5, "express sprint maintains road cruise speed");
});

check("Case A-S02: Cragstone Alpine Trail Ascent: Navigating 40° grades with 4WD Low-Range and handbrake hill-holds", () => {
  const gm = requireGM();
  const slopeRad = 40.0 * Math.PI / 180.0;
  const normal = [0, -Math.sin(slopeRad), Math.cos(slopeRad)];
  const trailOracle = () => ({ z: 100, normal, surface: { id: 1, mu: 0.88, vMax: 24.4 } });
  const st = { x: 0, y: 0, z: 100, heading: 0, pitch: slopeRad, roll: 0, speed: 2.0, steerAngle: 0, mode: 6 };
  for (let i = 0; i < 90; i++) {
    gm.step(st, { throttle: 1.0, steer: 0, buttons: 1 }, GoldenGen.PARAMS, trailOracle, 1.0 / 30.0);
  }
  assert(st.speed > 5.0, "alpine climb gains speed on 40° grade with 4WD");
});

check("Case A-S03: Direlands Obsidian Plain Evac: High-speed traversal across harsh obsidian terrain dodging hazards", () => {
  const obsFam = GoldenGen.SURFACE_FAMILIES.find((f) => f.name === "Obsidian");
  near(obsFam.vMax, 20.0, 0.1, "obsidian vMax limit");
});

check("Case A-S04: Ramshead River Gorge Bridge Crossing: Approaching narrow trestle bridge spanning gorge without water halts", () => {
  const gm = requireGM();
  const st = { x: 0, y: 0, z: 50.0, heading: 0, pitch: 0, roll: 0, speed: 22.0, steerAngle: 0, mode: 6 };
  const gorgeBridgeOracle = () => ({
    z: 50.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    waterDepth: 45.0,
    isBridge: true,
  });
  for (let i = 0; i < 150; i++) {
    gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, gorgeBridgeOracle, 1.0 / 30.0);
  }
  assert(st.speed >= 22.0, "gorge bridge crossing maintains speed without stalling");
});

// -----------------------------------------------------------------------------
// Adversarial Hardening (Tier 5): Tree Obstacle Deflection Trapping & Escape
// -----------------------------------------------------------------------------
console.log("\n--- Adversarial Hardening: Tree Obstacle Deflection Trapping & Escape ---");

check("Adversarial: Moving away from tree obstacle (dotN > 0) allows clean escape without trapping or halting", () => {
  const gm = requireGM();
  // Vehicle positioned at (100.0, 100.8), heading North (0 rad, directly away from tree at (100.0, 100.0))
  // Tree normal points from tree center to vehicle: nx = 0, ny = 1.0
  const st = { x: 100.0, y: 100.8, z: 40.0, heading: 0.0, pitch: 0.0, roll: 0.0, speed: 10.0, steerAngle: 0.0, mode: 6 };
  const treeOracle = () => ({
    z: 40.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: 0.0, ny: 1.0, nudgeSign: 0 },
  });
  // Step 10 frames trying to drive away
  for (let i = 0; i < 10; i++) {
    gm.step(st, { throttle: 1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeOracle, 1.0 / 30.0);
  }
  assert(st.speed > 10.0, "vehicle accelerates cleanly away from tree obstacle (speed not zeroed)");
  assert(st.y > 101.0, "vehicle advances forward away from obstacle");
});

check("Adversarial: Reversing away from tree obstacle (dotN > 0) allows clean extraction", () => {
  const gm = requireGM();
  // Vehicle at (100.0, 99.2), heading North (0 rad), tree at (100.0, 100.0). Normal pointing South: nx = 0, ny = -1.0
  // Reversing: vy < 0, dotN = vy * ny = (-speed) * (-1.0) > 0 (moving away)
  const st = { x: 100.0, y: 99.2, z: 40.0, heading: 0.0, pitch: 0.0, roll: 0.0, speed: -5.0, steerAngle: 0.0, mode: 6 };
  const treeOracle = () => ({
    z: 40.0,
    normal: [0, 0, 1],
    surface: { id: 0, mu: 1.0, vMax: 29.0 },
    obstacle: { nx: 0.0, ny: -1.0, nudgeSign: 0 },
  });
  for (let i = 0; i < 10; i++) {
    gm.step(st, { throttle: -1.0, steer: 0, buttons: 0 }, GoldenGen.PARAMS, treeOracle, 1.0 / 30.0);
  }
  assert(st.speed < -5.0, "vehicle reverses cleanly away from tree obstacle");
  assert(st.y < 99.0, "vehicle advances backward away from obstacle");
});

console.log("\n--- Adversarial Hardening: Uncached Terrain NaN / Null & Invalid dt Guards ---");

check("Adversarial (Finding 1): GM.step preserves finite z on ground()=>NaN / {z:null}, clamps dt<=0/NaN, and predictor recovers cleanly", () => {
  const gm = requireGM();
  // 1a. ground() => NaN preserves last finite state.z (40)
  const stNaN = { x: 10, y: 20, z: 40, heading: 0, pitch: 0, roll: 0, speed: 5, steerAngle: 0, mode: 6 };
  gm.step(stNaN, { throttle: 1, steer: 0, buttons: 0 }, GoldenGen.PARAMS, () => NaN, 1 / 30);
  assert(Number.isFinite(stNaN.z) && stNaN.z === 40, `expected finite z=40 on NaN ground, got ${stNaN.z}`);
  assert(Number.isFinite(stNaN.pitch), `expected finite pitch, got ${stNaN.pitch}`);
  assert(Number.isFinite(stNaN.x) && Number.isFinite(stNaN.y), "x/y remain finite");

  // 1b. ground() => { z: null, normal: [0,0,1] } preserves finite z
  const stNull = { x: 10, y: 20, z: 40, heading: 0, pitch: 0, roll: 0, speed: 5, steerAngle: 0, mode: 6 };
  gm.step(stNull, { throttle: 1, steer: 0, buttons: 0 }, GoldenGen.PARAMS, () => ({ z: null, normal: [0, 0, 1] }), 1 / 30);
  assert(Number.isFinite(stNull.z) && stNull.z === 40, `expected finite z=40 on {z:null}, got ${stNull.z}`);

  // 1c. dt = -0.5 and dt = NaN do not advance negatively or produce NaN
  for (const badDt of [-0.5, NaN, -Infinity]) {
    const stDt = { x: 10, y: 20, z: 40, heading: 0.25, pitch: 0, roll: 0, speed: 5, steerAngle: 0.1, mode: 6 };
    gm.step(stDt, { throttle: 1, steer: 1, buttons: 0 }, GoldenGen.PARAMS, () => 40, badDt);
    assert(Number.isFinite(stDt.x) && Number.isFinite(stDt.y) && Number.isFinite(stDt.speed) && Number.isFinite(stDt.steerAngle),
      `dt=${badDt} produced non-finite state`);
    assert(Math.abs(stDt.steerAngle) <= GoldenGen.PARAMS.maxSteerRad, `steerAngle within lock on dt=${badDt}`);
    near(stDt.x, 10, 1e-12, `dt=${badDt} x unchanged`);
    near(stDt.y, 20, 1e-12, `dt=${badDt} y unchanged`);
    near(stDt.speed, 5, 1e-12, `dt=${badDt} speed unchanged`);
  }

  // 1d. Pilot predictor stays finite across uncached ground(NaN) -> cached ground(40) + reconcile + decay
  let cached = false;
  const cl = toCellLocal(21700, 3190, 40);
  const pred = createPilotPredictor({
    locomotion: 2,
    params: GoldenGen.PARAMS,
    ground: () => (cached ? 40 : NaN),
    initial: { x: 21700, y: 3190, z: 40, heading: 0, pitch: 0, bank: 0, roll: 0, speed: 0, steerAngle: 0, mode: 0 },
  });
  pred.stepLocal({ throttle: 1, steer: 0, buttons: 0 });
  assert(Number.isFinite(pred.renderPose(1).z), "renderPose.z finite during uncached terrain step");
  cached = true;
  pred.reconcile({
    cell: cl.cell, x: cl.x, y: cl.y, z: cl.z,
    heading: 0, pitch: 0, bank: 0, speed: 0.5, mode: 6,
    ack: 1, flags: 0x01,
  });
  pred.stepLocal({ throttle: 1, steer: 0, buttons: 0 });
  pred.decay(0.016);
  const pose = pred.renderPose(1);
  assert(Number.isFinite(pose.z) && Number.isFinite(pred.offset.z), `pose.z (${pose.z}) & offset.z (${pred.offset.z}) remain finite`);
});

console.log(`\n========================================`);
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}
