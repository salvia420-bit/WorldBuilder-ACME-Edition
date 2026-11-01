// tests/vehicle_flight.test.mjs — holtburger vehicles (?vehicles=on, DEFAULT OFF): the JS flight model, the pilot
// predictor and the tracer RNG (docs/vehicles-2026-11-01/DESIGN.md §4.4, §6.2, §7).
//
//   V1  golden trajectories: scene3d/vehicle/flight_model.js reproduces flight-golden.json EXACTLY (the C# server
//       model, ACE.Server.Tests/Vehicles/FlightModelParityTests.cs, must agree with the same file within 1 mm).
//   V2  wire quantization: u8 throttle / i8 sticks / buttons, -128 clamps to -1 (server-identical).
//   V3  frame helpers: orientation forward = (sin h, cos h), cell/local round trip, outdoor cell numbering.
//   V4  predictor: a perfect server (same inputs) never corrects; a server that substituted one input corrects by
//       less than one step's divergence and converges on the server's trajectory; acks far behind adopt.
//   V5  observer track interpolates between snapshots.
//   V6  tracer spread replay matches the golden xorshift / SpreadOffset samples (shared with C#).
//   V7  boarding / exit hop (board_hop.js): ends exactly at the seat, arcs above the straight line, duration clamps,
//       heading short-way interpolation, the quaternion heading inverts FM.orientation, the URL flag.
//   V8  parachute canopy (chute.js): geometry sizes / extents, opening and collapse curves, the URL flag.
//
// Run: node tests/vehicle_flight.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FM = await import("../scene3d/vehicle/flight_model.js");
const P = await import("../scene3d/vehicle/predictor.js");
const W = await import("../scene3d/vehicle/weapons.js");
const F = await import("../scene3d/vehicle/fall_model.js");
const H = await import("../scene3d/vehicle/board_hop.js");
const C = await import("../scene3d/vehicle/chute.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(HERE, "../docs/vehicles-2026-11-01/flight/flight-golden.json"), "utf8"));

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
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
function near(a, b, eps, m) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`); }

const G = golden.ground;
const ground = (x, y) => G.base + G.amp * Math.sin(x / G.kx) * Math.cos(y / G.ky);

console.log("V1 golden trajectories");
for (const s of golden.sequences) {
  check(`${s.name}: ${s.frames.length} steps reproduce every checkpoint exactly`, () => {
    const st = { ...s.initial };
    let ci = 0;
    s.frames.forEach(([throttle, pitch, roll, yaw, buttons], i) => {
      FM.step(st, FM.inputFromFrame({ throttle, pitch, roll, yaw, buttons }), golden.params, golden.vCap, ground, golden.dt);
      const cp = s.checkpoints[ci];
      if (cp && cp.step === i + 1) {
        for (const k of ["x", "y", "z", "heading", "pitch", "bank", "speed", "mode"]) {
          if (st[k] !== cp.state[k]) throw new Error(`step ${i + 1} ${k}: ${st[k]} !== ${cp.state[k]}`);
        }
        ci++;
      }
    });
    assert(ci === s.checkpoints.length, `checked ${ci}/${s.checkpoints.length}`);
  });
}
check("the golden covers takeoff, landing, crash and the envelope", () => {
  const finals = Object.fromEntries(golden.sequences.map((s) => [s.name, s.checkpoints.at(-1).state.mode]));
  assert(finals["land"] === FM.MODE.PARKED, "land ends parked");
  assert(finals["derelict-crash"] === FM.MODE.CRASHED, "derelict ends crashed");
  assert(finals["takeoff-climb-turns"] === FM.MODE.FLIGHT, "takeoff ends in flight");
  const env = golden.sequences.find((s) => s.name === "envelope-floor-ceiling");
  for (const cp of env.checkpoints) {
    const agl = cp.state.z - ground(cp.state.x, cp.state.y);
    assert(agl >= golden.params.floorAgl - 1e-9 && agl <= golden.params.ceilingAgl + 1e-9, `agl ${agl} out of envelope at ${cp.step}`);
  }
});

console.log("V2 quantization");
check("throttle u8, sticks i8, buttons", () => {
  const q = FM.quantizeInput({ throttle: 0.5, pitch: -1, roll: 1, yaw: 0.25, boost: true, fire: true, land: false });
  assert(q.throttle === 128 && q.pitch === -127 && q.roll === 127 && q.yaw === 32 && q.buttons === 3, JSON.stringify(q));
  const u = FM.inputFromFrame({ throttle: 255, pitch: -128, roll: 127, yaw: 0, buttons: 4 });
  assert(u.throttle === 1 && u.pitch === -1 && u.roll === 1 && u.land && !u.fire, JSON.stringify(u));
});

console.log("V3 frame helpers");
check("orientation: forward = (sin h, cos h, 0) level; pitch raises the nose", () => {
  for (const h of [0, 0.5, 2, 4, 6]) {
    const f = FM.rotate(FM.orientation(h, 0, 0), [0, 1, 0]);
    near(f[0], Math.sin(h), 1e-12, "fx"); near(f[1], Math.cos(h), 1e-12, "fy"); near(f[2], 0, 1e-12, "fz");
  }
  const f = FM.rotate(FM.orientation(0, 0.3, 0), [0, 1, 0]);
  near(f[2], Math.sin(0.3), 1e-12, "nose up");
  const r = FM.rotate(FM.orientation(0, 0, 0.4), [1, 0, 0]);
  near(r[2], -Math.sin(0.4), 1e-12, "right wing down for positive bank");
});
check("cell/local round trip and outdoor cell numbering", () => {
  const cl = FM.toCellLocal(169 * 192 + 84.5, 180 * 192 + 7.25, 94);
  assert(cl.cell === 0xa9b40019 >>> 0 || (cl.cell >>> 16) === 0xa9b4, `cell ${cl.cell.toString(16)}`);
  assert((cl.cell & 0xffff) === 3 * 8 + 0 + 1, `outdoor cell ${(cl.cell & 0xffff)}`);
  const g = FM.toGlobal(cl.cell, cl.x, cl.y, cl.z);
  near(g[0], 169 * 192 + 84.5, 1e-3, "x"); near(g[1], 180 * 192 + 7.25, 1e-3, "y");
});

console.log("V4 predictor");
function serverMsgFrom(state, ack, vCap = 69, flags = 1) {
  const cl = FM.toCellLocal(state.x, state.y, state.z);
  return { type: "state", vehicle: 1, step: ack, ack, cell: cl.cell, x: Math.fround(cl.x), y: Math.fround(cl.y), z: Math.fround(cl.z),
    heading: Math.fround(state.heading), pitch: Math.fround(state.pitch), bank: Math.fround(state.bank), speed: Math.fround(state.speed),
    vCap, ammo: 200, mode: state.mode, flags };
}
const PARAMS = golden.params;
const init = { x: 21700.5, y: 3190.25, z: ground(21700.5, 3190.25) + 80, heading: 1, pitch: 0, bank: 0, speed: 60, mode: FM.MODE.FLIGHT };
check("a perfect server never forces a correction beyond wire rounding", () => {
  const pr = P.createPilotPredictor({ params: PARAMS, ground, initial: init, vCap: 69 });
  const srv = { ...init };
  const inputs = [];
  for (let i = 0; i < 120; i++) inputs.push({ throttle: 0.7, pitch: Math.sin(i / 20) * 0.5, roll: Math.cos(i / 15), yaw: 0, boost: false, fire: false, land: false });
  let maxErr = 0;
  inputs.forEach((raw, i) => {
    const f = pr.stepLocal(raw);
    FM.step(srv, FM.inputFromFrame(f), PARAMS, 69, ground, FM.DT);
    if (i % 3 === 2) {
      const r = pr.reconcile(serverMsgFrom(srv, f.seq));
      if (Number.isFinite(r.error)) maxErr = Math.max(maxErr, r.error);
    }
  });
  assert(maxErr < 0.01, `max error ${maxErr} m (f32 wire rounding only)`);
});
check("a substituted server input is corrected and the prediction converges on the server", () => {
  const pr = P.createPilotPredictor({ params: PARAMS, ground, initial: init, vCap: 69 });
  const srv = { ...init };
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const raw = { throttle: 1, pitch: 0, roll: i < 30 ? 0 : 1, yaw: 0 };
    frames.push(pr.stepLocal(raw));
  }
  // the server substitutes the previous input for seq 31 (late packet): roll 0 instead of 1
  for (const f of frames) {
    const use = f.seq === 31 ? { ...frames[29], seq: 31 } : f;
    FM.step(srv, FM.inputFromFrame(use), PARAMS, 69, ground, FM.DT);
    if (f.seq === 45) {
      const r = pr.reconcile(serverMsgFrom(srv, 45, 69, 3));
      assert(r.corrected, "corrected");
      assert(r.error > 0 && r.error < 2.5, `correction ${r.error} m`);
    }
  }
  const s = pr.state;
  near(s.x, srv.x, 0.05, "x converged"); near(s.y, srv.y, 0.05, "y converged"); near(s.heading, srv.heading, 1e-4, "heading");
  assert(Math.hypot(pr.offset.x, pr.offset.y, pr.offset.z) > 0, "the visual offset carries the jump");
  pr.decay(1.0);
  assert(Math.hypot(pr.offset.x, pr.offset.y, pr.offset.z) < 0.01, "offset decays");
});
check("an ack far behind the history adopts the server state", () => {
  const pr = P.createPilotPredictor({ params: PARAMS, ground, initial: init, vCap: 69, startSeq: 5000 });
  for (let i = 0; i < 10; i++) pr.stepLocal({ throttle: 1 });
  const far = { ...init, x: init.x + 500 };
  pr.reconcile(serverMsgFrom(far, 10));
  near(pr.state.x, init.x + 500, 0.01, "adopted");
});
check("recentFrames: newest first, at most 3", () => {
  const pr = P.createPilotPredictor({ params: PARAMS, ground, initial: init, vCap: 69, startSeq: 7 });
  for (let i = 0; i < 5; i++) pr.stepLocal({ throttle: i / 4 });
  const fr = pr.recentFrames(3);
  assert(fr.length === 3 && fr[0].seq === 11 && fr[1].seq === 10 && fr[2].seq === 9, JSON.stringify(fr.map((f) => f.seq)));
});

console.log("V5 observer track");
check("interpolates 120 ms behind on the server step timeline", () => {
  const tr = P.createObserverTrack();
  const a = { ...init }, b = { ...init, x: init.x + 30 };
  tr.push(serverMsgFrom(a, 300), 100.0);
  tr.push(serverMsgFrom(b, 303), 100.1);
  const pose = tr.pose(100.1 + P.OBSERVER_DELAY_S - 0.05);
  assert(pose.x > a.x && pose.x < b.x, `between: ${pose.x - a.x}`);
});

console.log("V5b bail-out fall");
check("fall model reproduces the golden (terminal speed, chute sink and glide)", () => {
  const g = golden.fall;
  const f = { ...g.initial };
  let ci = 0;
  for (let i = 1; i <= g.steps; i++) {
    if (i === g.chuteAtStep) f.chute = true;
    F.stepFall(f, FM.DT);
    const cp = g.checkpoints[ci];
    if (cp && cp.step === i) {
      for (const k of ["x", "y", "z", "vx", "vy", "vz"]) if (f[k] !== cp.state[k]) throw new Error(`step ${i} ${k}: ${f[k]} !== ${cp.state[k]}`);
      ci++;
    }
  }
  const before = g.checkpoints.find((c) => c.step === 250).state, after = g.checkpoints.at(-1).state;
  near(before.vz, -F.FALL.TERMINAL, 1e-9, "terminal speed before the chute");
  near(after.vz, -F.FALL.CHUTE_SINK, 1e-9, "chute sink");
  near(Math.hypot(after.vx, after.vy), F.FALL.CHUTE_GLIDE, 1e-6, "chute glide");
});

console.log("V6 tracer spread replay");
check("xorshift32 and SpreadOffset match the shared golden samples", () => {
  for (const [inp, out] of golden.spread.xorshift) assert(W.xorshift32(inp) === out, `${inp} → ${W.xorshift32(inp)} !== ${out}`);
  const offs = W.spreadOffsets(golden.spread.seed, golden.spread.offsets.length, golden.spread.spread);
  offs.forEach((o, i) => {
    near(o.dRight, golden.spread.offsets[i].dRight, 0, `dRight ${i}`);
    near(o.dUp, golden.spread.offsets[i].dUp, 0, `dUp ${i}`);
    assert(Math.hypot(o.dRight, o.dUp) <= golden.spread.spread + 1e-12, "inside the cone");
  });
});

console.log("V7 boarding / exit hop");
check("the hop starts at the rig, ends exactly at the seat and arcs above the straight line", () => {
  const from = { x: 10, y: 20, z: 94 }, to = { x: 13, y: 26, z: 99.75 };
  const a = H.hopPoint(from, to, 0), b = H.hopPoint(from, to, 1), m = H.hopPoint(from, to, 0.5);
  for (const k of ["x", "y", "z"]) { near(a[k], from[k], 1e-12, `start ${k}`); near(b[k], to[k], 1e-12, `end ${k}`); }
  assert(m.z > (from.z + to.z) / 2 + 0.5, `mid-hop arc ${m.z}`);
  near(H.hopPoint(from, to, 7).z, to.z, 1e-12, "u clamps at 1");
});
check("duration grows with distance and clamps", () => {
  near(H.hopDuration(0), H.HOP.minSec, 1e-12, "min");
  near(H.hopDuration(1e6), H.HOP.maxSec, 1e-12, "max");
  assert(H.hopDuration(6) > H.hopDuration(1), "monotone");
});
check("heading goes the short way and the quaternion heading inverts FM.orientation", () => {
  near(H.hopHeading(3.0, -3.0, 1), -3.0 + 2 * Math.PI, 1e-12, "wraps through pi");
  for (const h of [0, 0.7, 2.5, -1.9, Math.PI - 0.01]) near(H.headingOfQuat(FM.orientation(h, 0, 0)), h, 1e-9, `heading ${h}`);
});
check("?vehicleBoardAnim=off is the only way off", () => {
  assert(H.boardAnimEnabled("") && H.boardAnimEnabled("?vehicleBoardAnim=1") && !H.boardAnimEnabled("?vehicleBoardAnim=off"), "flag");
});

console.log("V8 parachute canopy");
check("canopy geometry: gored dome over the harness, rim at `rise`, apex at rise + height", () => {
  const g = C.canopyGeometry();
  const tris = C.CANOPY.gores * (2 * C.CANOPY.rings - 1);
  assert(g.positions.length === tris * 9 && g.colors.length === g.positions.length, `dome ${g.positions.length}`);
  assert(g.lines.length === C.CANOPY.lines * 6, "shroud lines");
  let zmin = Infinity, zmax = -Infinity, rmax = 0;
  for (let i = 0; i < g.positions.length; i += 3) {
    zmin = Math.min(zmin, g.positions[i + 2]); zmax = Math.max(zmax, g.positions[i + 2]);
    rmax = Math.max(rmax, Math.hypot(g.positions[i], g.positions[i + 1]));
  }
  near(zmin, C.CANOPY.rise, 1e-5, "rim height"); near(zmax, C.CANOPY.rise + C.CANOPY.height, 1e-5, "apex");
  near(rmax, C.CANOPY.radius, 1e-5, "rim radius");
});
check("the canopy opens (0.15 → 1) and collapses (0 → 1) on their clocks", () => {
  near(C.openScale(0), 0.15, 1e-12, "closed"); near(C.openScale(C.CANOPY.openSec), 1, 1e-12, "open"); near(C.openScale(99), 1, 1e-12, "stays open");
  assert(C.openScale(0.2) < C.openScale(0.4), "monotone");
  near(C.collapseProgress(0), 0, 1e-12, "start"); near(C.collapseProgress(C.CANOPY.collapseSec), 1, 1e-12, "gone");
  assert(C.chuteEnabled("") && !C.chuteEnabled("?vehicleChute=off"), "flag");
});

console.log(`\nvehicle_flight: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
