// tests/vehicle_experience.test.mjs — Fighter Controls + Mouse-Aim PD Instructor (controls.js),
// 3-Mode Dynamic Fighter Camera Rig (camera_rig.js), and Graphical Fighter HUD (osd.js).
//
// Run: node tests/vehicle_experience.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let fakeNowMs = 5000000;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => fakeNowMs },
  configurable: true,
  writable: true,
});

const FM = await import("../scene3d/vehicle/flight_model.js");
const CT = await import("../scene3d/vehicle/controls.js");
const CAM = await import("../scene3d/vehicle/camera_rig.js");
const OSD = await import("../scene3d/vehicle/osd.js");
const golden = JSON.parse(readFileSync(join(HERE, "../docs/vehicles-2026-11-01/flight/flight-golden.json"), "utf8"));
const PARAMS = golden.params;

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
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m || "near"}: ${a} vs ${b} (eps ${eps})`);

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

// ====================================================================================================
// 1. controls.js — live status(), pitch trim, freelook spring-back, pointer-lock & Mouse-Aim Instructor
// ====================================================================================================
console.log("E1 controls.js: live status(), pitch trim, freelook & Mouse-Aim PD instructor");

await check("status() exposes live boost (Shift), land (KeyL), and fire (Space / LMB)", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas });
  c.lock();
  assert(!c.status().boost && !c.status().land && !c.status().fire, "initially false");

  win.dispatch("keydown", { code: "ShiftLeft" });
  win.dispatch("keydown", { code: "KeyL" });
  win.dispatch("keydown", { code: "Space" });
  const st1 = c.status();
  assert(st1.boost === true && st1.land === true && st1.fire === true, `live status: ${JSON.stringify(st1)}`);

  const u = c.poll(FM.DT);
  assert(u.boost && u.land && u.fire, "poll agrees with status()");

  win.dispatch("keyup", { code: "ShiftLeft" });
  win.dispatch("keyup", { code: "KeyL" });
  win.dispatch("keyup", { code: "Space" });
  const st2 = c.status();
  assert(!st2.boost && !st2.land && !st2.fire, "cleared on keyup");
  c.dispose();
});

await check("keyboard pitch trim: [ / ] ramp within ±0.65 at 0.35/s, added to pitch, \\ resets to 0", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas });
  c.lock();

  win.dispatch("keydown", { code: "BracketRight" });
  for (let i = 0; i < 30; i++) c.poll(1 / 30); // 1.0 s -> +0.35
  near(c.status().pitchTrim, 0.35, 1e-6, "trim after 1 s");
  for (let i = 0; i < 60; i++) c.poll(1 / 30); // clamps at +0.65
  near(c.status().pitchTrim, 0.65, 1e-6, "trim clamped at +0.65");
  win.dispatch("keyup", { code: "BracketRight" });

  const uTrim = c.poll(1 / 30);
  near(uTrim.pitch, 0.65, 1e-6, "trim added into pitch command");

  win.dispatch("keydown", { code: "BracketLeft" });
  for (let i = 0; i < 120; i++) c.poll(1 / 30);
  near(c.status().pitchTrim, -0.65, 1e-6, "trim clamped at -0.65");
  win.dispatch("keyup", { code: "BracketLeft" });

  win.dispatch("keydown", { code: "Backslash" });
  win.dispatch("keyup", { code: "Backslash" });
  near(c.status().pitchTrim, 0, 1e-9, "Backslash resets trim to 0");
  near(c.poll(1 / 30).pitch, 0, 1e-9, "pitch back to 0");
  c.dispose();
});

await check("KeyC & RMB freelook route mousemove into freelookYaw/Pitch and smoothly spring back (tau = 0.14 s)", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas });
  c.lock();

  // Context menu on canvas is suppressed while locked
  assert(win.dispatch("contextmenu", { target: canvas }) === true, "contextmenu prevented");

  win.dispatch("keydown", { code: "KeyC" });
  win.dispatch("mousemove", { movementX: 250, movementY: -150 });
  const fl1 = c.status().freelook;
  assert(fl1.active === true, "freelook active while KeyC held");
  near(fl1.yaw, 250 * CT.MOUSE_SENSITIVITY, 1e-6, "freelook yaw");
  near(fl1.pitch, 150 * CT.MOUSE_SENSITIVITY, 1e-6, "freelook pitch");

  // Clamping at ±2.4 / ±1.1
  for (let i = 0; i < 10; i++) win.dispatch("mousemove", { movementX: 300, movementY: -300 });
  assert(c.status().freelook.yaw === CT.FREELOOK_MAX_YAW, "yaw clamped at 2.4");
  assert(c.status().freelook.pitch === CT.FREELOOK_MAX_PITCH, "pitch clamped at 1.1");

  // Release KeyC -> smooth exponential decay with tau = 0.14 s
  win.dispatch("keyup", { code: "KeyC" });
  assert(c.status().freelook.active === false, "inactive on release");
  c.poll(0.14);
  near(c.status().freelook.yaw, CT.FREELOOK_MAX_YAW * Math.exp(-1), 1e-3, "1*tau decay");
  for (let i = 0; i < 45; i++) c.poll(1 / 30);
  near(c.status().freelook.yaw, 0, 1e-3, "sprung back to 0");
  near(c.status().freelook.pitch, 0, 1e-3, "pitch sprung back to 0");
  c.dispose();
});

await check("pointer-lock canvas click, LMB guns, MMB missile latch, wheel throttle, and exit-lock disengage", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas });
  c.lock();

  // First click on canvas requests pointer lock & engages mouseAim without firing a stray shot
  win.dispatch("mousedown", { button: 0, target: canvas });
  win.dispatch("mouseup", { button: 0, target: canvas });
  assert(canvas.lockCalls === 1 && c.status().mouseAim === true, "pointer lock & mouseAim engaged");
  assert(c.status().fire === false, "lock-acquiring click does not fire");

  // While pointer-locked: LMB fires, MMB latches missile, wheel adjusts throttle by ±0.05
  win.dispatch("mousedown", { button: 0 });
  assert(c.status().fire === true && c.poll(FM.DT).fire === true, "LMB fires guns");
  win.dispatch("mouseup", { button: 0 });

  win.dispatch("mousedown", { button: 1 });
  win.dispatch("mouseup", { button: 1 });
  assert(c.poll(FM.DT).missile === true, "MMB tap latches missile");
  assert(c.poll(FM.DT).missile === false, "MMB latch consumed once");

  win.dispatch("wheel", { deltaY: -100 });
  win.dispatch("wheel", { deltaY: -100 });
  near(c.throttle, 0.10, 1e-9, "wheel up +0.05 per notch");
  win.dispatch("wheel", { deltaY: 100 });
  near(c.throttle, 0.05, 1e-9, "wheel down -0.05 per notch");

  // Exiting pointer lock automatically disengages mouseAim cleanly
  doc.exitPointerLock();
  assert(c.status().mouseAim === false, "mouseAim disengaged on pointerlock exit");
  c.dispose();
});

await check("Mouse-Aim PD instructor rolls smoothly into 45° heading offset & converges within quantized byte bounds without oscillation", () => {
  const { win, doc, canvas } = makeTestEnv();
  const c = CT.createVehicleControls({ window: win, document: doc, canvas });
  c.lock();
  c.throttle = 0.85;

  const targetHeading = Math.PI / 4; // +45°
  const targetPitch = 0.18;
  const s = {
    x: 20000, y: 20000, z: 300,
    heading: 0, pitch: 0, bank: 0,
    speed: 70, mode: FM.MODE.FLIGHT,
  };
  c.setMouseAim(true, { heading: targetHeading, pitch: targetPitch, maxPitch: PARAMS.maxPitch });

  let peakBank = 0;
  let maxHeading = 0;
  const headingHistory = [];

  for (let step = 0; step < 300; step++) {
    const raw = c.poll(FM.DT, s, PARAMS);
    const qFrame = FM.quantizeInput(raw);
    assert(qFrame.pitch >= -127 && qFrame.pitch <= 127, "quantized pitch byte");
    assert(qFrame.roll >= -127 && qFrame.roll <= 127, "quantized roll byte");
    assert(qFrame.yaw >= -127 && qFrame.yaw <= 127, "quantized yaw byte");

    const serverInput = FM.inputFromFrame(qFrame);
    FM.step(s, serverInput, PARAMS, PARAMS.vMax, () => 0, FM.DT);

    peakBank = Math.max(peakBank, s.bank);
    const hUnwrapped = CT.wrapPi(s.heading);
    maxHeading = Math.max(maxHeading, hUnwrapped);
    headingHistory.push(hUnwrapped);
  }

  // Must roll decisively into the right turn (> 30° bank)
  assert(peakBank > 0.55, `rolled into turn: peakBank=${peakBank.toFixed(3)} rad`);
  // Zero oscillation / no meaningful overshoot past +45°
  assert(maxHeading < targetHeading + 0.02, `no overshoot: maxHeading=${maxHeading.toFixed(4)} vs target=${targetHeading.toFixed(4)}`);

  // Converges onto target heading & pitch within FM.quantizeInput byte bounds, with wings level
  const pitchLsbBound = (1 / 127) * PARAMS.maxPitch + 1e-4;
  const headingBound = 0.01; // < 0.6°
  near(CT.angleDiff(targetHeading, s.heading), 0, headingBound, "converged on target heading");
  near(s.pitch, targetPitch, pitchLsbBound, "converged on target pitch within i8 byte bound");
  near(s.bank, 0, (1.5 / 127) * PARAMS.maxBank, "wings leveled cleanly as dh -> 0");

  // Tail of trajectory must be steady (zero limit-cycle oscillation)
  const tail = headingHistory.slice(-45);
  const tailSpread = Math.max(...tail) - Math.min(...tail);
  assert(tailSpread < 0.004, `steady non-oscillating tail: spread=${tailSpread}`);

  // Manual WASD overrides mouse-aim and syncs aimHeading/aimTargetPitch to current flight attitude
  s.heading = 1.2;
  s.pitch = -0.1;
  win.dispatch("keydown", { code: "KeyA" });
  c.poll(FM.DT, s, PARAMS);
  win.dispatch("keyup", { code: "KeyA" });
  near(c.status().aimWorld.heading, 1.2, 1e-6, "WASD synced aimHeading");
  near(c.status().aimWorld.pitch, -0.1, 1e-6, "WASD synced aimTargetPitch");
  c.dispose();
});

// ====================================================================================================
// 2. camera_rig.js — 3-mode cycle, COCKPIT_EYE z≈3.58m, chase lag & turn look-ahead, FOV, G-load, shake
// ====================================================================================================
console.log("E2 camera_rig.js: 3-mode cycle, reflector-sight eye, chase physics, G-load & deterministic shake");

await check("3-mode cycle (chase -> cockpit -> hood -> chase) & COCKPIT_EYE alignment (z ≈ 3.58 m)", () => {
  const rig = CAM.createPilotCameraRig({ ground: () => 0 });
  assert(rig.getView() === "chase", "starts in chase");
  assert(rig.cycleView() === "cockpit", "chase -> cockpit");
  assert(rig.cycleView() === "hood", "cockpit -> hood");
  assert(rig.cycleView() === "chase", "hood -> chase");

  rig.setView("cockpit");
  const seat = { x: 100, y: 200, z: 2.34, q: [1, 0, 0, 0] };
  const pose = { x: 100, y: 200.92, z: 0, heading: 0, pitch: 0, bank: 0, speed: 60, mode: FM.MODE.FLIGHT };
  const out = rig.step({ seat, pose, params: PARAMS, dt: 1 / 60 });
  near(out.cam.pos[2], 3.58, 1e-3, "cockpit eye aligned through Mk 8 reflector sight at z ≈ 3.58 m");
  near(out.cam.pos[1], 200 + CAM.COCKPIT_EYE.forward, 1e-6, "cockpit forward offset");
  near(out.cam.fov, CAM.COCKPIT_EYE.fov, 1e-3, "cockpit base FOV 76°");

  rig.setView("hood");
  const hoodOut = rig.step({ seat, pose, params: PARAMS, dt: 1 / 60 });
  near(hoodOut.cam.pos[1], 200 + CAM.HOOD_EYE.forward, 1e-6, "hood forward offset 1.28 m");
  near(hoodOut.cam.pos[2], 2.34 + CAM.HOOD_EYE.up, 1e-6, "hood up offset");
});

await check("computeGLoad: 1.0 G in level flight, 2.0 G in 60° banked turn, clamped in [-2.5, +6.0]", () => {
  const level = { heading: 0, pitch: 0, bank: 0, speed: 75, mode: FM.MODE.FLIGHT };
  const banked60 = { heading: 0, pitch: 0, bank: Math.PI / 3, speed: 75, mode: FM.MODE.FLIGHT };
  near(CAM.computeGLoad(level, level, FM.DT), 1.0, 1e-6, "1.0 G level");
  near(CAM.computeGLoad(banked60, banked60, FM.DT), 2.0, 1e-3, "2.0 G in 60° coordinated turn");

  const hardPull = { heading: 0, pitch: 0.04, bank: Math.PI / 3, speed: 95, mode: FM.MODE.FLIGHT };
  assert(CAM.computeGLoad(banked60, hardPull, FM.DT) === 6.0, "clamps at +6.0 G");
  const hardPush = { heading: 0, pitch: -0.06, bank: 0, speed: 95, mode: FM.MODE.FLIGHT };
  assert(CAM.computeGLoad(level, hardPush, FM.DT) === -2.5, "clamps at -2.5 G");
});

await check("chase mode: longitudinal WEP spring-back (+1.6..2.6 m), decel pull-in, turn look-ahead, bank coupling & speed FOV", () => {
  const rig = CAM.createPilotCameraRig({ ground: () => 0 });
  const seat = { x: 1000, y: 2000, z: 250, q: [1, 0, 0, 0] };
  const cruisePose = { x: 1000, y: 2000, z: 250, heading: 0, pitch: 0, bank: 0, speed: PARAMS.vCruise, mode: FM.MODE.FLIGHT };

  let cruiseOut;
  for (let i = 0; i < 60; i++) {
    cruiseOut = rig.step({ seat, pose: cruisePose, params: PARAMS, controlsStatus: { boost: false }, dt: 1 / 60 });
  }
  const cruiseDist = Math.hypot(seat.x - cruiseOut.cam.pos[0], seat.y - cruiseOut.cam.pos[1]);
  near(cruiseDist, CAM.DEFAULT_CHASE.back, 0.05, "16 m at steady cruise");
  near(cruiseOut.cam.fov, CAM.DEFAULT_CHASE.fov, 0.05, "70° FOV at cruise");

  // WEP / boost + high speed: pulls camera back +1.6..2.6 m and widens FOV up to +7.5°
  let wepOut;
  let speed = PARAMS.vCruise;
  for (let i = 0; i < 140; i++) {
    speed = Math.min(PARAMS.vMax, speed + PARAMS.accel / 60);
    const wepPose = { ...cruisePose, speed };
    wepOut = rig.step({ seat, pose: wepPose, params: PARAMS, controlsStatus: { boost: true }, dt: 1 / 60 });
  }
  const wepDist = Math.hypot(seat.x - wepOut.cam.pos[0], seat.y - wepOut.cam.pos[1]);
  const lagDelta = wepDist - cruiseDist;
  assert(lagDelta >= 1.6 && lagDelta <= 2.65, `WEP longitudinal pullback in +1.6..2.6 m: got +${lagDelta.toFixed(2)} m`);
  assert(wepOut.cam.fov > CAM.DEFAULT_CHASE.fov + 7.0 && wepOut.cam.fov <= CAM.DEFAULT_CHASE.fov + 7.5 + 1e-6, `WEP FOV widened: ${wepOut.cam.fov.toFixed(2)}°`);

  // Deceleration draws camera closer (< 16 m)
  let decelOut;
  for (let i = 0; i < 45; i++) {
    speed = Math.max(PARAMS.vMin, speed - PARAMS.decel / 60);
    decelOut = rig.step({ seat, pose: { ...cruisePose, speed }, params: PARAMS, controlsStatus: { boost: false }, dt: 1 / 60 });
  }
  const decelDist = Math.hypot(seat.x - decelOut.cam.pos[0], seat.y - decelOut.cam.pos[1]);
  assert(decelDist < CAM.DEFAULT_CHASE.back - 0.5, `deceleration draws closer: ${decelDist.toFixed(2)} m`);

  // Banked turn look-ahead + 0.48 * bank roll coupling
  rig.reset(0);
  let turnOut;
  const turnPose = { x: 1000, y: 2000, z: 250, heading: 0, pitch: 0, bank: Math.PI / 3, speed: 75, mode: FM.MODE.FLIGHT };
  for (let i = 0; i < 60; i++) {
    turnOut = rig.step({ seat, pose: turnPose, params: PARAMS, controlsStatus: { boost: false }, dt: 1 / 60 });
  }
  const lookLead = CT.angleDiff(turnOut.cam.h, turnPose.heading);
  assert(lookLead > 0.08, `turn look-ahead aims into right turn: +${lookLead.toFixed(3)} rad`);
  near(turnOut.cam.r, (Math.PI / 3) * 0.48, 0.02, "0.48 * bank roll coupling");
});

await check("deterministic multi-source harmonic shake (recoil, WEP, high-G buffet, explosion — zero Math.random)", () => {
  const rigA = CAM.createPilotCameraRig({ ground: () => 0 });
  const rigB = CAM.createPilotCameraRig({ ground: () => 0 });
  const seat = { x: 500, y: 500, z: 200, q: [1, 0, 0, 0] };
  const highGPose = { x: 500, y: 500, z: 200, heading: 0.4, pitch: 0.1, bank: 1.15, speed: 85, mode: FM.MODE.FLIGHT };

  const calmRig = CAM.createPilotCameraRig({ ground: () => 0 });
  const calmPose = { x: 500, y: 500, z: 200, heading: 0.4, pitch: 0.1, bank: 0, speed: 70, mode: FM.MODE.FLIGHT };
  for (let i = 0; i < 20; i++) calmRig.step({ seat, pose: calmPose, params: PARAMS, dt: 1 / 60 });
  const c1 = calmRig.step({ seat, pose: calmPose, params: PARAMS, dt: 1 / 60 });
  const c2 = calmRig.step({ seat, pose: calmPose, params: PARAMS, dt: 1 / 60 });
  near(c1.cam.pos[2], c2.cam.pos[2], 1e-6, "steady flight has zero shake jitter");

  let diffSteps = 0;
  let prevZ = null;
  for (let i = 0; i < 20; i++) {
    const a = rigA.step({
      seat, pose: highGPose, params: PARAMS,
      controlsStatus: { boost: true, fire: true },
      firing: true, explosionShake: 0.6, dt: 1 / 60,
    });
    const b = rigB.step({
      seat, pose: highGPose, params: PARAMS,
      controlsStatus: { boost: true, fire: true },
      firing: true, explosionShake: 0.6, dt: 1 / 60,
    });
    // Bit-exact deterministic agreement between two independent rig instances
    assert(a.cam.pos[0] === b.cam.pos[0] && a.cam.pos[2] === b.cam.pos[2] && a.cam.p === b.cam.p && a.cam.r === b.cam.r, "bit-exact deterministic shake");
    if (prevZ !== null && Math.abs(a.cam.pos[2] - prevZ) > 1e-4) diffSteps++;
    prevZ = a.cam.pos[2];
  }
  assert(diffSteps >= 15, `active harmonic shake across frames (${diffSteps})`);
});

// ====================================================================================================
// 3. osd.js — graphical HUD update, sights (FPM, aim, fall-line), hitmarker, corr gating & dispose
// ====================================================================================================
console.log("E3 osd.js: graphical HUD, FPM/aim/fall-line sights, hitmarker, corr gating & dispose()");

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
    };
    return n;
  };
  const head = mkNode("head");
  const body = mkNode("body");
  created = 0;
  mutations = 0;
  return {
    doc: {
      head,
      body,
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => mkNode(tag),
    },
    byId,
    stats: () => ({ created, mutations }),
  };
}

await check("full HUD update: speed km/h+kt, WEP, AGL+MSL, VSI, G-meter, attitude ladder, G-vignette, pills & debug corr gating", () => {
  const { doc, byId } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  const arms = { guns: 6, quarrels: 2400, rails: 6, missileMask: 0b111111, bombs: [2000, 1000, 1000], bombMask: 0b111 };
  osd.update({
    name: "F6F Hellcat",
    speed: 90,
    agl: 28, // < 38 m in flight without land -> PULL UP!
    msl: 108,
    heading: Math.PI / 2,
    pitch: 0.15,
    bank: -0.4,
    vsi: 13.4,
    gLoad: 4.2, // > 3.0 G -> grey-out vignette!
    throttle: 1.0,
    mode: FM.MODE.FLIGHT,
    vCap: 97,
    boost: true,
    land: false,
    mouseAim: true,
    pitchTrim: 0.12,
    corr: "corr 3 (last 0.04 m)",
    showDebug: false,
    arms,
  });

  const root = byId.get(OSD.OSD_ID);
  assert(root && root.style.display === "block", "HUD visible");
  assert(root.textContent.includes("324 km/h") && root.textContent.includes("175 kt"), `km/h + kt in ${root.textContent}`);
  assert(root.textContent.includes("WEP"), "WEP indicator active");
  assert(root.textContent.includes("28 m AGL") && root.textContent.includes("108 m MSL"), "AGL + MSL shown");
  assert(root.textContent.includes("+13 m/s"), "VSI shown");
  assert(root.textContent.includes("4.2 G"), "live G-meter shown");
  assert(root.textContent.includes("090° E"), "compass heading");
  assert(root.textContent.includes("PULL UP") && root.textContent.includes("[MOUSE AIM]") && root.textContent.includes("[TRIM]"), "status pills");
  assert(root.textContent.includes("QUARRELS 2400"), "armament line");
  assert(!root.textContent.includes("corr 3"), "debug corr hidden when showDebug is false");

  // Physiological G-vignette active above +3.0 G, and red-out below -0.7 G
  const vig = byId.get(OSD.VIGNETTE_ID);
  assert(vig && vig.style.display === "block" && Number(vig.style.opacity) > 0.2, "grey-out G-vignette active at +4.2 G");

  osd.update({
    name: "F6F Hellcat", speed: 70, agl: 120, msl: 200, heading: 0, pitch: -0.1, bank: 0,
    vsi: -7, gLoad: -1.4, throttle: 0.5, mode: FM.MODE.FLIGHT, vCap: 97,
    boost: false, land: true, corr: "corr 3 (last 0.04 m)", showDebug: true, arms,
  });
  assert(root.textContent.includes("corr 3"), "debug corr shown when showDebug is true");
  assert(root.textContent.includes("[LAND]") && !root.textContent.includes("PULL UP"), "[LAND] pill active");
  assert(vig.style.display === "block" && vig.style.background.includes("168,14,10"), "red-out vignette below -0.7 G");

  osd.dispose();
});

await check("sights(ret, pip, label, {fpm, aim}), bomb fall-line, osd.hit({damage: 48}) decay, and zero DOM mutation after dispose()", () => {
  const { doc, byId, stats } = makeFakeHudDom();
  const osd = OSD.createVehicleOsd({ document: doc });

  osd.sights(
    { x: 960, y: 500 },
    { x: 960, y: 640 },
    "2000 lb  3.8 s",
    { fpm: { x: 958, y: 525 }, aim: { x: 1020, y: 470 } }
  );

  assert(byId.get(OSD.RETICLE_ID).style.display === "block", "reticle visible");
  assert(byId.get(OSD.PIPPER_ID).style.display === "block", "pipper visible");
  assert(byId.get(OSD.PIPPER_ID).attrs["data-label"] === "2000 lb  3.8 s", "pipper label");
  assert(byId.get(OSD.FPM_ID).style.display === "block", "FPM velocity vector visible");
  assert(byId.get(OSD.AIM_ID).style.display === "block", "Mouse-Aim cursor ring visible");

  const fallLine = byId.get(OSD.FALLLINE_ID);
  assert(fallLine.style.display === "block" && fallLine.style.width === "140px", `bomb fall-line: ${fallLine.style.width}`);
  assert(fallLine.style.transform.includes("rotate(90.0deg)"), `fall-line rotation: ${fallLine.style.transform}`);

  // Hitmarker + damage pop activation & 0.35 s smooth decay
  osd.hit({ damage: 48 });
  const hitNode = byId.get(OSD.HIT_ID);
  assert(hitNode.style.display === "block" && hitNode.style.opacity === "1.00", "hitmarker activated");
  assert(hitNode.children[1].textContent === "+48", `damage pop: ${hitNode.children[1].textContent}`);

  fakeNowMs += 175; // half of 0.35 s
  osd.sights({ x: 960, y: 500 }, null, "");
  assert(hitNode.style.display === "block" && Number(hitNode.style.opacity) > 0.4 && Number(hitNode.style.opacity) < 0.6, `mid-decay opacity: ${hitNode.style.opacity}`);
  assert(fallLine.style.display === "none", "fall-line hidden when pipper off-screen");

  fakeNowMs += 200; // past 0.35 s
  osd.sights({ x: 960, y: 500 }, null, "");
  assert(hitNode.style.display === "none", "hitmarker hidden after 0.35 s");

  // Dispose and assert ZERO DOM creation or mutation afterward
  osd.dispose();
  const snap = stats();
  osd.update({ speed: 80, agl: 100, gLoad: 4.5, mode: FM.MODE.FLIGHT });
  osd.sights({ x: 500, y: 500 }, { x: 500, y: 600 }, "1000 lb", { fpm: { x: 500, y: 510 }, aim: { x: 520, y: 490 } });
  osd.hit({ damage: 99 });
  osd.prompt("Board");
  osd.toggleHidden();
  osd.hide();
  const after = stats();
  assert(after.created === snap.created && after.mutations === snap.mutations, `post-dispose created=${after.created - snap.created}, mutations=${after.mutations - snap.mutations}`);
});

// ====================================================================================================
// 4. Full-stack installVehicles integration (index.js + procedural F6F + aeroFx + audio + camera + HUD)
// ====================================================================================================
console.log("E4 installVehicles full-stack Hellcat integration");

await check("257-part Hellcat profile builds procedural F6F, wires WebAudio + AeroFX + 3-mode camera + Mouse-Aim + Hitmarker + Bailout Doppler", async () => {
  const THREE = await import("three");
  const { installVehicles } = await import("../scene3d/vehicle/index.js");

  // Lightweight recording WebAudio context for full-stack check
  let createdOscs = 0;
  let createdPanners = 0;
  const fakeParam = (v = 0) => ({
    value: v,
    setTargetAtTime(x) { this.value = x; },
    setValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; },
    exponentialRampToValueAtTime(x) { this.value = x; },
    cancelScheduledValues() {},
  });
  const mkAudioNode = () => ({
    connect() { return this; },
    disconnect() {},
  });
  const fakeCtx = {
    state: "running",
    currentTime: 1.0,
    sampleRate: 8000,
    createGain: () => ({ ...mkAudioNode(), gain: fakeParam(1) }),
    createOscillator: () => {
      createdOscs++;
      return { ...mkAudioNode(), type: "sine", frequency: fakeParam(110), detune: fakeParam(0), setPeriodicWave() {}, start() {}, stop() {}, onended: null };
    },
    createBiquadFilter: () => ({ ...mkAudioNode(), type: "lowpass", frequency: fakeParam(800), Q: fakeParam(1), gain: fakeParam(0) }),
    createWaveShaper: () => ({ ...mkAudioNode(), curve: null, oversample: "none" }),
    createPeriodicWave: (r, im) => ({ r, im }),
    createPanner: () => {
      createdPanners++;
      return { ...mkAudioNode(), panningModel: "HRTF", distanceModel: "inverse", refDistance: 18, maxDistance: 1800, rolloffFactor: 1, positionX: fakeParam(0), positionY: fakeParam(0), positionZ: fakeParam(0) };
    },
    createBuffer: (_ch, len, sr) => {
      const arr = new Float32Array(len);
      return { sampleRate: sr, length: len, getChannelData: () => arr };
    },
    createBufferSource: () => ({ ...mkAudioNode(), buffer: null, loop: false, playbackRate: fakeParam(1), start() {}, stop() {}, onended: null }),
  };
  const masterBusNode = fakeCtx.createGain();

  const { doc, byId } = makeFakeHudDom();
  const inbox = [];
  const VEH = 0x80099001;
  const LOCAL = 0x50000042;
  const worldRoot = new THREE.Group();
  const entityMap = new Map();
  const mkEnt = () => ({ root: new THREE.Group(), _filmHidden: false });
  entityMap.set(VEH, mkEnt());
  entityMap.set(LOCAL, mkEnt());

  const winListeners = new Map();
  const fakeWinObj = {
    location: { search: "?vehicles=on" },
    document: doc,
    navigator: { getGamepads: () => [] },
    innerWidth: 1280,
    innerHeight: 720,
    getLocalPlayerGuid: () => LOCAL,
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t).add(fn); },
    removeEventListener(t, fn) { winListeners.get(t)?.delete(fn); },
  };
  const live = {
    worldRoot,
    scene: worldRoot,
    camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 10000),
    audioManager: {
      getEffectBus: () => ({ ctx: fakeCtx, node: masterBusNode, sliderGain: () => 1.0 }),
      isActive: () => true,
      notifyUserGesture() {},
    },
    entityManager: {
      entityMap,
      setFilmHidden(guid, h) { const e = entityMap.get(guid); if (!e) return false; e._filmHidden = h; return true; },
      setMotion() {},
    },
    sessionHandle: {
      vehicleCapabilities() {},
      drainVehicleMessages: () => { const out = JSON.stringify(inbox); inbox.length = 0; return out; },
      terrainHeightAt: () => 10,
      setVehicleSeat() {},
      clearVehicleSeat() {},
      vehicleInput() {},
      vehicleBoard() {},
      vehicleExit() {},
    },
  };

  const api = installVehicles({ liveScene3d: live, THREE, window: fakeWinObj });

  // 50-part synthetic Hellcat profile triggers auto procedural F6F model (< 24 draw calls, 0 DAT decode)
  const parts = Array.from({ length: 50 }, (_, i) => ({ did: 0x02001888, offset: [0, i * 0.05, 2.5], rot: [1, 0, 0, 0], scale: 1 }));
  const partRoles = parts.map((_, i) => (i === 0 ? 1 : 0));
  const weapons = [
    ...[-3.05, -2.75, -2.45, 2.45, 2.75, 3.05].map((x) => ({ kind: 1, muzzle: [x, 2.0, 2.29] })),
    ...[-4.2, -3.8, -3.4, 3.4, 3.8, 4.2].map((x) => ({ kind: 2, muzzle: [x, 0.8, 2.1] })),
    { kind: 3, muzzle: [0, 0.4, 1.45] },
  ];
  const weaponExt = weapons.map((w) => (w.kind === 3 ? { massKg: 907, dragTerminal: 280 } : { convergence: 110 }));

  const cl0 = FM.toCellLocal(1000, 2000, 180);
  inbox.push(
    { type: "ack", granted: 3 },
    {
      type: "profile", vehicle: VEH, profileKey: "hellcat-demo", displayName: "F6F-5 Hellcat",
      vMin: 30, vCruise: 83, vMax: 111, accel: 8, decel: 12, maxBank: Math.PI / 3, rollRate: Math.PI / 2,
      maxPitch: (25 * Math.PI) / 180, pitchRate: Math.PI / 4, yawRate: 0.18, climbMax: 20, sinkMax: 25,
      floorAgl: 30, ceilingAgl: 450, takeoffClimb: 8, landingSpeed: 25, leadSeconds: 6,
      seats: [{ offset: [0, -0.4, 2.34] }], parts, partRoles, weapons, weaponExt,
    },
    {
      type: "state", vehicle: VEH, flags: 1, step: 100, ack: 0, mode: FM.MODE.FLIGHT,
      cell: cl0.cell, x: cl0.x, y: cl0.y, z: cl0.z, heading: 0, pitch: 0, bank: 0.9, speed: 92, vCap: 111,
      ammo: 2400, missileMask: 0x3f, bombMask: 0x1,
    },
    { type: "seat", vehicle: VEH, seat: 0, occupant: LOCAL, state: 1 }
  );

  api. status();
  live.vehicles.afterTick(16, 16);
  await new Promise((r) => setTimeout(r, 10)); // resolve async procedural template build
  fakeNowMs += 34;
  fakeCtx.currentTime += 0.034;
  live.vehicles.afterTick(50, 34);

  const st1 = api.status();
  assert(api.piloting === true, "piloting active");
  assert(st1.vehicles[0].airframe === "ready", `procedural F6F airframe ready: ${st1.vehicles[0].airframe}`);
  assert(st1.audio.live === true && st1.audio.built === true && createdOscs > 0, "R-2800 pilot WebAudio synth live");
  assert(st1.pilot.gLoad > 1.4, `banked G-load computed: ${st1.pilot.gLoad.toFixed(2)} G`);

  // View modes & Mouse-Aim API
  api.setView("cockpit");
  assert(api.status().pilot.view === "cockpit", "cockpit view");
  api.setView("hood");
  assert(api.status().pilot.view === "hood", "hood gun-cam view");
  api.setView("chase");
  assert(api.setMouseAim(true) === true && api.status().pilot.controls.mouseAim === true, "Mouse-Aim enabled via API");

  // Server weapon fire + target Hit (kind 8) -> OSD hitmarker + audio hit tick!
  inbox.push(
    { type: "fire", vehicle: VEH, mount: 0, step: 105, seed: 12345, count: 1 },
    { type: "event", vehicle: VEH, kind: 8, subject: 0x90001111, value: 64, step: 105 }
  );
  fakeNowMs += 34;
  fakeCtx.currentTime += 0.034;
  live.vehicles.afterTick(84, 34);
  const hitEl = byId.get(OSD.HIT_ID);
  assert(hitEl.style.display === "block" && hitEl.children[1].textContent === "+64", `hitmarker +64 shown on kind=8 Hit`);

  // Bailout in mid-air -> derelict Hellcat moves into 3D Doppler observer pool + freefall wind starts!
  const pannerBeforeBail = createdPanners;
  inbox.push(
    { type: "seat", vehicle: VEH, seat: 0, occupant: 0, state: 0 },
    { type: "event", vehicle: VEH, kind: 5, subject: LOCAL, cell: cl0.cell, x: cl0.x, y: cl0.y, z: cl0.z, value: 0, step: 106 }
  );
  fakeNowMs += 34;
  fakeCtx.currentTime += 0.034;
  live.vehicles.afterTick(118, 34);
  const stBail = api.status();
  assert(api.falling === true, "local player in bailout freefall");
  assert(stBail.audio.fallBuilt === true && stBail.audio.fallStarted === true, "freefall wind active");
  assert(stBail.audio.observerVoices === 1 && createdPanners > pannerBeforeBail, "derelict Hellcat active in 3D Doppler observer audio pool");

  api.dispose();
  assert(!live.vehicles && !fakeWinObj.__vehicles, "cleanly disposed");
});

console.log(`\nvehicle_experience: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
