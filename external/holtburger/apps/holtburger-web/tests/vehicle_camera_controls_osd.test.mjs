// tests/vehicle_camera_controls_osd.test.mjs — Comprehensive unit test suite for Milestone 4:
// Ground Camera Rig (camera_rig.js), Role-Aware Controls (controls.js), and WWII Dashboard OSD (osd.js).
//
// Run: node tests/vehicle_camera_controls_osd.test.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let fakeNowMs = 1000000;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => fakeNowMs },
  configurable: true,
  writable: true,
});

const FM = await import("../scene3d/vehicle/flight_model.js");
const CAM = await import("../scene3d/vehicle/camera_rig.js");
const CT = await import("../scene3d/vehicle/controls.js");
const OSD = await import("../scene3d/vehicle/osd.js");

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
const near = (a, b, eps = 1e-3, m = "") => assert(Math.abs(a - b) <= eps, `${m || "near"}: ${a} vs ${b} (eps ${eps})`);

function makeTestEnv() {
  const winListeners = new Map();
  const docListeners = new Map();
  const canvas = {
    tagName: "CANVAS",
    lockCalls: 0,
    requestPointerLock() {
      this.lockCalls++;
      doc.pointerLockElement = canvas;
      const fn = docListeners.get("pointerlockchange");
      if (fn) fn({ type: "pointerlockchange" });
    },
  };
  const doc = {
    activeElement: null,
    pointerLockElement: null,
    body: { tagName: "BODY" },
    querySelector: (sel) => (sel === "canvas" ? canvas : null),
    exitPointerLock() {
      this.pointerLockElement = null;
      const fn = docListeners.get("pointerlockchange");
      if (fn) fn({ type: "pointerlockchange" });
    },
    addEventListener(t, fn) { docListeners.set(t, fn); },
    removeEventListener(t) { docListeners.delete(t); },
  };
  const win = {
    document: doc,
    addEventListener(t, fn) { winListeners.set(t, fn); },
    removeEventListener(t) { winListeners.delete(t); },
    dispatch(type, props = {}) {
      const fn = winListeners.get(type);
      let prevented = false;
      if (fn) {
        fn({
          type,
          repeat: false,
          cancelable: true,
          target: canvas,
          stopImmediatePropagation() {},
          preventDefault() { prevented = true; },
          ...props,
        });
      }
      return prevented;
    },
  };
  return { win, doc, canvas };
}

function makeFakeHudDom() {
  let created = 0;
  let mutations = 0;
  const byId = new Map();
  const trackStyle = () => new Proxy({}, {
    set(target, prop, val) {
      mutations++;
      target[prop] = val;
      return true;
    },
  });
  const mkNode = (tag) => {
    created++;
    let txt = "";
    let cls = "";
    let id = "";
    const listeners = new Map();
    const n = {
      tag,
      children: [],
      attrs: {},
      style: trackStyle(),
      get id() { return id; },
      set id(v) { mutations++; id = v; if (v) byId.set(v, n); },
      get className() { return cls; },
      set className(v) { mutations++; cls = v; },
      get textContent() { return txt; },
      set textContent(v) { mutations++; txt = String(v); },
      setAttribute(k, v) { mutations++; this.attrs[k] = String(v); },
      appendChild(child) { mutations++; this.children.push(child); if (child.id) byId.set(child.id, child); return child; },
      remove() { mutations++; if (id) byId.delete(id); },
      addEventListener(evt, fn) { listeners.set(evt, fn); },
      removeEventListener(evt) { listeners.delete(evt); },
      dispatch(evt, data) { const fn = listeners.get(evt); if (fn) fn(data); },
    };
    return n;
  };
  const head = mkNode("head");
  const body = mkNode("body");
  return {
    doc: {
      head,
      body,
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => mkNode(tag),
    },
    byId,
  };
}

console.log("=== TIER 1: Feature Coverage (camera_rig.js Ground Mode) ===");

await check("T1.1 Ground Chase Framing: tight 5.4m back, 1.95m up, 7.5m lookAhead", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });
  const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: FM.MODE.PARKED };
  const stepOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  // Camera back: should be approximately -5.4m behind along y-axis (y ≈ -5.4), up ≈ 1.95m (z ≈ 1.95)
  near(stepOut.cam.pos[1], -5.4, 0.1, "chase distance back ~5.4m");
  near(stepOut.cam.pos[2], 1.95, 0.1, "chase height up ~1.95m");
  near(stepOut.cam.fov, 62.0, 0.5, "base ground chase FOV 62°");
});

await check("T1.2 Ground Chase Speed-scaled FOV: ramps smoothly 62° at rest to 68° at 29 m/s", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });
  const poseRest = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: 0 };
  const restOut = rig.step({ pose: poseRest, params: { locomotion: 2 }, dt: 1 / 60 });
  near(restOut.cam.fov, 62.0, 0.1, "rest FOV = 62°");

  // Step vehicle up to top speed 29 m/s (65 MPH)
  const poseFast = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 29.0, mode: 6 };
  let fastOut;
  for (let i = 0; i < 40; i++) {
    fastOut = rig.step({ pose: poseFast, params: { locomotion: 2 }, dt: 1 / 60 });
  }
  near(fastOut.cam.fov, 68.0, 0.2, "top speed 29 m/s FOV = 68°");
});

await check("T1.3 Ground Chase Turn Yaw-Lead: cornering shifts aim into the turn", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });
  const poseTurn = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, steer: 0.5, speed: 15, mode: 6 };
  const out = rig.step({ pose: poseTurn, controlsStatus: { steer: 0.5 }, params: { locomotion: 2 }, dt: 1 / 60 });
  assert(out.cam.h > 0, `camera yaw leads into right turn (cam.h = ${out.cam.h.toFixed(3)} rad)`);
});

await check("T1.4 Ground Chase Terrain Slope Follow & Suspension Bump Filter", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });
  // Step up a 15° slope pitch
  const slopePitch = (15 * Math.PI) / 180;
  const poseSlope = { x: 0, y: 0, z: 0, heading: 0, pitch: slopePitch, bank: 0, speed: 10, mode: 6 };
  let out;
  for (let i = 0; i < 30; i++) {
    out = rig.step({ pose: poseSlope, params: { locomotion: 2 }, dt: 1 / 60 });
  }
  assert(out.cam.p > 0.05, `camera tracks terrain pitch upward (cam.p = ${out.cam.p.toFixed(3)})`);

  // Sharp vertical bump step should be smoothed by the spring filter
  const bumpPose = { x: 0, y: 0, z: 0.35, heading: 0, pitch: 0, bank: 0, speed: 10, mode: 6 };
  const bumpOut = rig.step({ pose: bumpPose, params: { locomotion: 2 }, dt: 1 / 60 });
  assert(Number.isFinite(bumpOut.cam.pos[2]), "finite z after bump impulse");
});

await check("T1.5 Collision Jolt: triggerJolt kicks camera and decays smoothly", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });
  const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 10, mode: 6 };
  const calmOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  const baseZ = calmOut.cam.pos[2];

  // Trigger jolt
  rig.triggerJolt(1.5);
  const joltOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  assert(Math.abs(joltOut.cam.pos[2] - baseZ) > 0.05, "jolt displaced camera vertical position");

  // Step 30 frames -> jolt decays
  let decayedOut;
  for (let i = 0; i < 30; i++) {
    decayedOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  }
  near(decayedOut.cam.pos[2], baseZ, 0.05, "jolt recovered back toward calm baseline");
});

await check("T1.6 Ground Cab Mode Per-Seat Anchors (Seats 0..3)", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, initialView: "cockpit" });
  const pose = { x: 10, y: 20, z: 5, heading: 0, pitch: 0, bank: 0, speed: 0, mode: 0 };

  // Seat 0: Driver behind 3-spoke wheel [-0.38, -0.18, 1.30]
  rig.setSeatIndex(0);
  const s0 = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(s0.cam.pos[0] - pose.x, -0.38, 0.05, "Seat 0 X offset -0.38");
  near(s0.cam.pos[1] - pose.y, -0.18, 0.05, "Seat 0 Y offset -0.18");
  near(s0.cam.pos[2] - pose.z, 1.30, 0.05, "Seat 0 Z offset +1.30");
  near(s0.cam.fov, 70.0, 0.5, "Seat 0 base FOV 70°");

  // Seat 1: Front Passenger behind grab-bar [+0.38, -0.18, 1.30]
  rig.setSeatIndex(1);
  const s1 = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(s1.cam.pos[0] - pose.x, 0.38, 0.05, "Seat 1 X offset +0.38");
  near(s1.cam.pos[1] - pose.y, -0.18, 0.05, "Seat 1 Y offset -0.18");
  near(s1.cam.pos[2] - pose.z, 1.30, 0.05, "Seat 1 Z offset +1.30");

  // Seat 2: Rear Left Bench [-0.36, -0.96, 1.36]
  rig.setSeatIndex(2);
  const s2 = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(s2.cam.pos[0] - pose.x, -0.36, 0.05, "Seat 2 X offset -0.36");
  near(s2.cam.pos[1] - pose.y, -0.96, 0.05, "Seat 2 Y offset -0.96");
  near(s2.cam.pos[2] - pose.z, 1.36, 0.05, "Seat 2 Z offset +1.36");

  // Seat 3: Rear Right Bench [+0.36, -0.96, 1.36]
  rig.setSeatIndex(3);
  const s3 = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(s3.cam.pos[0] - pose.x, 0.36, 0.05, "Seat 3 X offset +0.36");
  near(s3.cam.pos[1] - pose.y, -0.96, 0.05, "Seat 3 Y offset -0.96");
  near(s3.cam.pos[2] - pose.z, 1.36, 0.05, "Seat 3 Z offset +1.36");
});

await check("T1.7 Ground Cab Mode Rear Bench Freelook Range (±155° yaw, ±65° pitch)", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, initialView: "cockpit" });
  rig.setSeatIndex(2); // Rear Left passenger
  const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: 0 };

  // Head look far over right shoulder: yaw = +2.6 rad (+149°)
  const ctrlLook = { freelook: { yaw: 2.6, pitch: 0.9 } };
  const out = rig.step({ pose, controlsStatus: ctrlLook, params: { locomotion: 2 }, dt: 1 / 60 });
  near(out.cam.h, 2.6, 0.1, "rear bench head turns unconstrained up to ±155° yaw");
  near(out.cam.p, 0.9, 0.1, "rear bench head looks up to ±65° pitch");
});

await check("T1.8 Ground Hood-Star Rally Cam Mode: [0, +0.55, +1.18], FOV 66°", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, initialView: "hood" });
  const pose = { x: 10, y: 20, z: 5, heading: 0, pitch: 0, bank: 0, speed: 0, mode: 0 };
  const out = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(out.cam.pos[0] - pose.x, 0, 0.01, "hood X centered");
  near(out.cam.pos[1] - pose.y, 0.55, 0.05, "hood forward +0.55m");
  near(out.cam.pos[2] - pose.z, 1.18, 0.05, "hood up +1.18m");
  near(out.cam.fov, 66.0, 0.1, "hood FOV 66°");
});

console.log("=== TIER 1: Feature Coverage (controls.js Driver & Passenger) ===");

await check("T1.9 Driver (Seat 0): W forward throttle, A/D steer, Space handbrake, Shift 4WD Low", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  // W throttle
  win.dispatch("keydown", { code: "KeyW" });
  win.dispatch("keydown", { code: "KeyD" });
  win.dispatch("keydown", { code: "Space" });
  win.dispatch("keydown", { code: "ShiftLeft" });
  win.dispatch("keydown", { code: "KeyV" });

  let u;
  for (let i = 0; i < 20; i++) u = c.poll(1 / 30, { speed: 10 }, { locomotion: 2, seatIndex: 0 });

  assert(u.throttle > 0.8, "W applies forward throttle");
  assert(u.steer > 0, "KeyD applies steer right");
  assert(u.handbrake === true, "Space engages handbrake");
  assert(u.boost === true, "Shift engages 4WD Low");
  assert(u.horn === true, "KeyV engages Sparton horn");
  assert(u.seatIndex === 0 && u.passenger === false, "Driver role verified");

  c.dispose();
});

await check("T1.10 Driver (Seat 0): Progressive brake on S while moving forward (> 0.5 m/s)", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  // Vehicle moving forward at 20 m/s, driver taps S
  win.dispatch("keydown", { code: "KeyS" });
  const u = c.poll(1 / 30, { speed: 20.0 }, { locomotion: 2, seatIndex: 0 });
  assert(u.handbrake === true, "S while moving forward engages brake");
  assert(u.throttle <= 0, "throttle cut while braking");

  c.dispose();
});

await check("T1.11 Driver (Seat 0): Auto-reverse on S when stationary (|v| <= 0.2 m/s)", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  // Vehicle stationary (speed = 0)
  win.dispatch("keydown", { code: "KeyS" });
  let u;
  for (let i = 0; i < 20; i++) u = c.poll(1 / 30, { speed: 0.0 }, { locomotion: 2, seatIndex: 0 });
  assert(u.throttle < -0.8, "S while stationary engages auto-reverse throttle");

  c.dispose();
});

await check("T1.12 Driver (Seat 0): Steer Speed Taper & Self-Centering", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  // Steer at 0 speed: full authority (steer ≈ 1.0)
  win.dispatch("keydown", { code: "KeyD" });
  let uZero;
  for (let i = 0; i < 20; i++) uZero = c.poll(1 / 30, { speed: 0 }, { locomotion: 2 });
  near(uZero.steer, 1.0, 0.05, "full steer at 0 speed");

  // Steer at 29 m/s (65 MPH): tapered authority (tapers by 70% to ~0.30)
  let uFast;
  for (let i = 0; i < 20; i++) uFast = c.poll(1 / 30, { speed: 29.0 }, { locomotion: 2 });
  assert(uFast.steer <= 0.35 && uFast.steer >= 0.25, `high speed steer tapered to ~0.30 (got ${uFast.steer.toFixed(3)})`);

  // Release KeyD -> self-centers rapidly to 0
  win.dispatch("keyup", { code: "KeyD" });
  let uCenter;
  for (let i = 0; i < 20; i++) uCenter = c.poll(1 / 30, { speed: 20.0 }, { locomotion: 2 });
  near(uCenter.steer, 0, 0.05, "steer self-centers cleanly to 0");

  c.dispose();
});

await check("T1.13 Key Conflict Resolution: KeyH exclusively hides HUD; KeyL toggles headlights; KeyG folds windscreen", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  const actions = [];
  c.onAction((a) => actions.push(a));

  // Press KeyH -> should emit hideHud, and NOT toggle headlights
  assert(c.status().headlights === false, "headlights initially false");
  win.dispatch("keydown", { code: "KeyH" });
  win.dispatch("keyup", { code: "KeyH" });
  assert(actions.some((a) => a.type === "hideHud"), "KeyH emitted hideHud");
  assert(c.status().headlights === false, "KeyH did NOT toggle headlights");

  // Press KeyL -> should toggle headlights on ground vehicle
  win.dispatch("keydown", { code: "KeyL" });
  win.dispatch("keyup", { code: "KeyL" });
  assert(c.status().headlights === true, "KeyL toggled headlights ON");
  assert(actions.some((a) => a.type === "headlights" && a.value === true), "headlights action emitted");

  // Press KeyG -> should emit windscreen toggle (NOT cargo)
  win.dispatch("keydown", { code: "KeyG" });
  win.dispatch("keyup", { code: "KeyG" });
  const gAction = actions.find((a) => a.type === "windscreen");
  assert(gAction && gAction.action === "toggle", "KeyG emitted windscreen toggle");
  assert(!actions.some((a) => a.type === "cargo"), "KeyG did NOT emit cargo toggle");

  c.dispose();
});

await check("T1.14 Passenger (Seats 1..3) Control Isolation: locked driving, seat swap, freelook, exit", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 1 });
  c.lock();

  const actions = [];
  c.onAction((a) => actions.push(a));

  // Passenger presses WASD / Space / Shift / KeyV / KeyL / KeyG -> driving inputs must remain zeroed
  win.dispatch("keydown", { code: "KeyW" });
  win.dispatch("keydown", { code: "KeyD" });
  win.dispatch("keydown", { code: "Space" });
  win.dispatch("keydown", { code: "ShiftLeft" });
  win.dispatch("keydown", { code: "KeyV" });
  win.dispatch("keydown", { code: "KeyL" });
  win.dispatch("keydown", { code: "KeyG" });

  const u = c.poll(1 / 30, { speed: 10 }, { locomotion: 2, seatIndex: 1 });
  assert(u.throttle === 0, "passenger throttle locked to 0");
  assert(u.steer === 0, "passenger steer locked to 0");
  assert(u.boost === false, "passenger 4WD boost locked to false");
  assert(u.handbrake === false, "passenger handbrake locked to false");
  assert(u.horn === false, "passenger horn locked to false");
  assert(u.passenger === true, "passenger flag true");
  assert(c.status().headlights === false, "passenger cannot toggle headlights");

  // Passenger presses hot-swap 1-4, camera Tab, freelook C, hide HUD H, exit X
  win.dispatch("keydown", { code: "Digit1" });
  win.dispatch("keydown", { code: "Tab" });
  win.dispatch("keydown", { code: "KeyX" });
  win.dispatch("keydown", { code: "KeyC" });

  assert(actions.some((a) => a.type === "seat" && a.seatIndex === 0), "passenger can swap to Seat 0 (Key 1)");
  assert(actions.some((a) => a.type === "camera"), "passenger can cycle camera (Tab)");
  assert(actions.some((a) => a.type === "exit"), "passenger can exit vehicle (X)");
  assert(c.status().freelook.active === true, "passenger freelook active on KeyC");

  c.dispose();
});

console.log("=== TIER 1: Feature Coverage (osd.js WWII Ground Vehicle HUD) ===");

await check("T1.15 Ground HUD Zero Flight Clutter: no flight ladder, altitude, VSI, or sights", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  osd.update({
    locomotion: 2,
    name: "Willys MB 4x4",
    speed: 15.0,
    heading: 1.2,
    seatIndex: 0,
    seats: [1, 2, 0, 0],
    surface: "ROAD",
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(!txt.includes("MSL"), "no flight MSL altitude in ground HUD");
  assert(!txt.includes("VSI"), "no flight VSI in ground HUD");
  assert(!txt.includes("STALL"), "no flight stall warning in ground HUD");
  assert(!txt.includes("PULL UP"), "no flight pull up warning in ground HUD");
  osd.dispose();
});

await check("T1.16 Ground HUD Speedometer, Gear, 4WD LOW, and RPM Readout", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  // 20 m/s = ~45 MPH (~72 km/h), 2nd gear, 4WD Low active
  osd.update({
    locomotion: 2,
    speed: 20.0,
    boost: true,
    throttle: 0.8,
    seatIndex: 0,
    seats: [1, 0, 0, 0],
    surface: "DIRT",
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(txt.includes("45 MPH"), `speedometer MPH verified: ${txt}`);
  assert(txt.includes("72 km/h"), `speedometer km/h verified: ${txt}`);
  assert(txt.includes("4WD LOW"), `4WD LOW badge verified: ${txt}`);
  assert(txt.includes("GEAR: 3") || txt.includes("GEAR: 2"), `gear readout verified: ${txt}`);
  assert(txt.includes("RPM"), `engine RPM readout verified: ${txt}`);
  assert(txt.includes("TRACTION: [DIRT]"), `surface traction badge verified: ${txt}`);

  osd.dispose();
});

await check("T1.17 Ground HUD 2x2 Crew Diagram & Status Indicators", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  // Player in Seat 0 (Driver), teammate in Seat 1, Seats 2 and 3 empty
  osd.update({
    locomotion: 2,
    speed: 0,
    seatIndex: 0,
    seats: [1001, 1002, 0, 0],
    headlights: true,
    handbrake: true,
    horn: false,
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(txt.includes("[1 Driver: You]"), `Driver marked as You: ${txt}`);
  assert(txt.includes("[2 Front Pax: Teammate]"), `Front Pax marked as Teammate: ${txt}`);
  assert(txt.includes("[3 Rear L: Empty]"), `Rear L marked as Empty: ${txt}`);
  assert(txt.includes("[4 Rear R: Empty]"), `Rear R marked as Empty: ${txt}`);
  assert(txt.includes("[LIGHTS]"), `LIGHTS status active: ${txt}`);
  assert(txt.includes("[BRAKE]"), `BRAKE status active: ${txt}`);

  osd.dispose();
});

await check("T1.18 Ground HUD Role-Aware Keybind Bar: Driver vs Passenger", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  // Driver (Seat 0)
  osd.update({ locomotion: 2, seatIndex: 0 });
  const driverTxt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(driverTxt.includes("W/S Drive/Brake"), `Driver keybind bar displayed: ${driverTxt}`);

  // Passenger (Seat 1)
  osd.update({ locomotion: 2, seatIndex: 1 });
  const paxTxt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(paxTxt.includes("1-4 Switch Seat"), `Passenger keybind bar displayed: ${paxTxt}`);
  assert(!paxTxt.includes("W/S Drive/Brake"), "Passenger keybind bar does NOT show driving controls");

  osd.dispose();
});

console.log("=== TIER 2: Boundary & Corner Cases ===");

await check("T2.1 Controls: Rapid Seat Swapping 0 -> 1 -> 2 -> 3 updates controls isolation instantly", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2 });
  c.lock();

  win.dispatch("keydown", { code: "KeyW" });

  // Seat 0 (Driver): throttle active
  c.setSeatIndex(0);
  const u0 = c.poll(1 / 30, { speed: 5 }, { locomotion: 2, seatIndex: 0 });
  assert(u0.passenger === false, "Seat 0 is Driver");

  // Immediate hot-swap to Seat 1 (Pax): driving locked
  c.setSeatIndex(1);
  const u1 = c.poll(1 / 30, { speed: 5 }, { locomotion: 2, seatIndex: 1 });
  assert(u1.passenger === true && u1.throttle === 0, "Seat 1 locked instantly");

  // Immediate hot-swap to Seat 3 (Pax): driving locked
  c.setSeatIndex(3);
  const u3 = c.poll(1 / 30, { speed: 5 }, { locomotion: 2, seatIndex: 3 });
  assert(u3.passenger === true && u3.throttle === 0, "Seat 3 locked instantly");

  // Hot-swap back to Seat 0 (Driver): driving re-enabled
  c.setSeatIndex(0);
  const u0Again = c.poll(1 / 30, { speed: 5 }, { locomotion: 2, seatIndex: 0 });
  assert(u0Again.passenger === false, "Seat 0 Driver re-enabled");

  c.dispose();
});

await check("T2.2 Controls: Zero Speed Reverse / Forward Hysteresis Boundary", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  win.dispatch("keydown", { code: "KeyS" });

  // Speed = +0.51 m/s -> brake
  const uBrake = c.poll(1 / 30, { speed: 0.51 }, { locomotion: 2 });
  assert(uBrake.handbrake === true, "braking at +0.51 m/s");

  // Speed = +0.10 m/s -> reverse
  const uRev = c.poll(1 / 30, { speed: 0.10 }, { locomotion: 2 });
  assert(uRev.throttle <= 0, "reversing at +0.10 m/s");

  c.dispose();
});

await check("T2.3 Camera Rig: Extreme Seat Index Fallback (seatIndex out of range)", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, initialView: "cockpit" });
  const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 0, mode: 0 };

  // seatIndex = 99 -> clamped to Seat 3
  rig.setSeatIndex(99);
  const outHigh = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  assert(Number.isFinite(outHigh.cam.pos[0]) && Number.isFinite(outHigh.cam.pos[2]), "safe high seatIndex");

  // seatIndex = -5 -> clamped to Seat 0
  rig.setSeatIndex(-5);
  const outLow = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(outLow.cam.pos[0], -0.38, 0.05, "clamped to Seat 0 driver offset");
});

await check("T2.4 OSD: Extreme Speed & RPM Values Clamped Cleanly", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  // Extreme speed 120 m/s (270 MPH)
  osd.update({
    locomotion: 2,
    speed: 120.0,
    rpm: 9999,
    gear: "3",
    seatIndex: 0,
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(txt.includes("MPH"), "rendered high speed cleanly");
  assert(txt.includes("RPM: 3800"), "RPM clamped to redline 3800 RPM");

  osd.dispose();
});

console.log("=== TIER 3: Cross-Feature Combinations ===");

await check("T3.1 Camera Rig + Controls: Cornering Freelook Orbit During Hard Turn", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas, locomotion: 2, seatIndex: 0 });
  c.lock();

  const rig = CAM.createPilotCameraRig({ locomotion: 2, ground: () => 0 });

  // Steer right and engage freelook
  win.dispatch("keydown", { code: "KeyD" });
  win.dispatch("keydown", { code: "KeyC" });
  win.dispatch("mousemove", { movementX: 180, movementY: -60 });

  const ctrlStatus = c.status();
  const pose = { x: 0, y: 0, z: 0, heading: 0.5, pitch: 0, bank: 0, steer: ctrlStatus.steer, speed: 12, mode: 6 };
  const out = rig.step({ pose, controlsStatus: ctrlStatus, params: { locomotion: 2 }, dt: 1 / 60 });

  assert(Number.isFinite(out.cam.h) && Number.isFinite(out.cam.p), "finite camera angles during combined steer & freelook");
  c.dispose();
});

await check("T3.2 Controls + OSD: Full 4-Player Patrol Session State Reflection", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  // 4 players seated: Player 1 (You) Driver, 2, 3, 4 Teammates
  osd.update({
    locomotion: 2,
    speed: 18.5,
    seatIndex: 0,
    seats: [1001, 1002, 1003, 1004],
    boost: true,
    surface: "SNOW",
    headlights: true,
    handbrake: false,
    horn: true,
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(txt.includes("[1 Driver: You]"), "You in Driver seat");
  assert(txt.includes("[2 Front Pax: Teammate]"), "Teammate in Pax seat");
  assert(txt.includes("[3 Rear L: Teammate]"), "Teammate in Rear L seat");
  assert(txt.includes("[4 Rear R: Teammate]"), "Teammate in Rear R seat");
  assert(txt.includes("TRACTION: [SNOW]"), "Surface SNOW recognized");
  assert(txt.includes("[HORN]"), "Horn indicator active");
  assert(txt.includes("[LIGHTS]"), "Lights indicator active");

  osd.dispose();
});

console.log("=== TIER 4: Real-World Scenarios ===");

await check("T4.1 Scenario: Convoy River Crossing (Surface FORD, Low-Range 4WD, Headlights)", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  osd.update({
    locomotion: 2,
    speed: 4.5,
    boost: true, // 4WD Low
    surface: "FORD",
    headlights: true,
    seatIndex: 0,
    seats: [501, 502, 503, 504],
  });

  const txt = byId.get(OSD.OSD_ID)?.textContent || "";
  assert(txt.includes("TRACTION: [FORD]"), "FORD traction displayed");
  assert(txt.includes("4WD LOW"), "4WD LOW displayed");
  assert(txt.includes("[LIGHTS]"), "Headlights displayed");

  osd.dispose();
});

await check("T4.2 Scenario: Passenger Sightseeing View Cycle (Cab Seat 2 -> Chase -> Hood)", () => {
  const rig = CAM.createPilotCameraRig({ locomotion: 2, initialView: "cockpit", seatIndex: 2 });
  const pose = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, bank: 0, speed: 10, mode: 6 };

  // 1. Cab mode on rear seat
  assert(rig.getView() === "cockpit", "starts in cockpit");
  const cabOut = rig.step({ pose, seatIndex: 2, params: { locomotion: 2 }, dt: 1 / 60 });
  near(cabOut.cam.pos[0], -0.36, 0.05, "rear seat X offset");

  // 2. Cycle to Hood view
  rig.cycleView();
  assert(rig.getView() === "hood", "cycled to hood");
  const hoodOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  near(hoodOut.cam.pos[1], 0.55, 0.05, "hood star Y offset");

  // 3. Cycle to Chase view
  rig.cycleView();
  assert(rig.getView() === "chase", "cycled to chase");
  const chaseOut = rig.step({ pose, params: { locomotion: 2 }, dt: 1 / 60 });
  assert(chaseOut.cam.pos[1] < -4.0, "chase distance back");
});

console.log("========================================");
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log("========================================");

if (failed > 0) {
  process.exit(1);
}
