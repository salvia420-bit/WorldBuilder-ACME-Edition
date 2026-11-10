// scene3d/vehicle/controls.js — vehicle input: keyboard + mouse-aim instructor + freelook + gamepad → stick values, and the input lock.
//
// While seated the player's keys fly the vehicle, not the character: lock() takes the input funnel the same way the
// drone does (synthetic releases of held keys, then its fault slot set to "gate" when it was open) plus window
// CAPTURE listeners for the vehicle keys and canvas mouse/wheel events; restore() undoes exactly that. Never taken:
// Escape, Enter, F-keys, digits, Ctrl/Alt/Meta chords, anything while a text field has focus (chat keeps working).
//
// Keyboard (sticks are spring-loaded; the throttle is a lever that stays where it is set):
//   W / S  nose down / up        A / D  roll left / right       Q / E  rudder left / right
//   [ / ]  pitch trim down / up  \      reset pitch trim        M      toggle mouse-aim
//   C / RMB smooth freelook      R / F  throttle up / down      Shift  boost (WEP)
//   Space / LMB guns             G / MMB lightning rails        V      release the next bomb
//   L      hold to land          X      exit / bail             Tab    camera view     H  hide HUD
//
// Architectural seam: everything returned by poll(dt, flightState, params) is quantized via FM.quantizeInput BEFORE both
// client prediction and the ACE server step — so rich client-side control laws here maintain 100% bit-exact server parity.
//
// Page module: dependencies injected ({window, document, navigator, funnel, canvas}); no timers.

import { isTypingTarget } from "../drone/controls.js";
import * as FM from "./flight_model.js";

export const VEHICLE_KEY_AXES = Object.freeze({
  KeyW: ["pitch", -1],
  KeyS: ["pitch", 1],
  KeyD: ["roll", 1],
  KeyA: ["roll", -1],
  KeyE: ["yaw", 1],
  KeyQ: ["yaw", -1],
});
export const VEHICLE_KEY_ACTIONS = Object.freeze({ Tab: "camera", KeyH: "hideHud", KeyX: "exit", KeyM: "mouseAim" });
export const VEHICLE_HOLD_CODES = Object.freeze([
  "KeyR", "KeyF", "ShiftLeft", "ShiftRight", "Space", "KeyL", "KeyG", "KeyV",
  "KeyC", "BracketLeft", "BracketRight", "Backslash",
]);
/** Hold codes whose press is latched until a step has seen it (a quick tap must not fall between two steps). */
const LATCHED_CODES = Object.freeze(["KeyG", "KeyV"]);
export const VEHICLE_KEY_CODES = Object.freeze([
  ...Object.keys(VEHICLE_KEY_AXES), ...Object.keys(VEHICLE_KEY_ACTIONS), ...VEHICLE_HOLD_CODES,
]);
const CODE_SET = new Set(VEHICLE_KEY_CODES);
const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const CAPTURE = Object.freeze({ capture: true });
const CAPTURE_ACTIVE = Object.freeze({ capture: true, passive: false });

export const THROTTLE_RATE = 0.6; // lever travel per second with R / F held
export const STICK_RATE = 4.0; // keyboard sticks ramp to full in 0.25 s
export const MOUSE_SENSITIVITY = 0.0022; // rad/px for mouse-aim & freelook
export const WHEEL_THROTTLE_STEP = 0.05; // smooth throttle step per mouse wheel notch
export const FREELOOK_MAX_YAW = 2.4; // rad (±137.5°)
export const FREELOOK_MAX_PITCH = 1.1; // rad (±63°)
export const FREELOOK_TAU = 0.14; // spring-back time constant (s)
export const PITCH_TRIM_MAX = 0.65;
export const PITCH_TRIM_RATE = 0.35; // trim units per second while [ / ] held
const PAD_DEADZONE = 0.12;
const MOUSE_SPIKE_PX = 400;
const DEFAULT_MAX_BANK = Math.PI / 3;
const DEFAULT_MAX_PITCH = (25 * Math.PI) / 180;
const DEFAULT_ROLL_RATE = Math.PI / 2;
const UI_INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** Wrap an angle in radians into [-π, +π]. */
export function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d === 0 ? 0 : d;
}

/** Shortest signed angle difference `a - b` in [-π, +π]. */
export function angleDiff(a, b) {
  return wrapPi((Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0));
}

/** Gamepad stick shaping with deadzone. */
export function padAxis(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  const a = Math.min(1, Math.abs(x));
  if (a < PAD_DEADZONE) return 0;
  return Math.sign(x) * ((a - PAD_DEADZONE) / (1 - PAD_DEADZONE));
}

/**
 * @param {{window?: object, document?: object, navigator?: object, funnel?: object, canvas?: object, invertMouseY?: boolean}} [deps]
 */
export function createVehicleControls(deps = {}) {
  const win = deps.window ?? (typeof window !== "undefined" ? window : null);
  const doc = deps.document ?? (win ? win.document : null);
  const nav = deps.navigator ?? (win ? win.navigator : null);
  const ySign = deps.invertMouseY === true ? 1 : -1;

  const down = Object.create(null);
  for (const c of VEHICLE_KEY_CODES) down[c] = false;
  const latched = Object.create(null); // code → pressed since the last poll
  const actionFns = new Set();

  let locked = false;
  let listening = false;
  let docListening = false;
  let saved = null;
  let throttle = 0;
  const sticks = { pitch: 0, roll: 0, yaw: 0 };
  let padPrev = {};
  let override = null; // {until, axes} — the bench / debug drives the sticks
  let blocked = 0;

  // Trim, mouse-aim & freelook state
  let pitchTrim = 0;
  let mouseAim = false;
  let programmaticMouseAim = false;
  let pointerLockPending = false;
  let wasPointerLocked = false;
  let mouseFire = false;
  let mouseMiddleDown = false;
  let rmbDown = false;

  let aimHeading = 0;
  let aimTargetPitch = 0;
  let aimSeeded = false;
  let hasFlightState = false;
  let lastFlightHeading = 0;
  let lastFlightPitch = 0;
  let lastMaxPitch = DEFAULT_MAX_PITCH;

  let freelookYaw = 0;
  let freelookPitch = 0;

  const resolveCanvas = () => {
    if (deps.canvas) return deps.canvas;
    try {
      const q = typeof doc?.querySelector === "function" ? doc.querySelector("canvas") : null;
      if (q) return q;
    } catch (_) { /* ignore */ }
    return doc?.body ?? null;
  };

  const hasPointerLockProp = () => !!(doc && typeof doc === "object" && "pointerLockElement" in doc);

  const isPointerLocked = () => {
    const el = doc ? doc.pointerLockElement : null;
    if (!el) return false;
    const cv = resolveCanvas();
    return !cv || el === cv || el === doc?.body;
  };

  const isUiElement = (target) => {
    if (!target || typeof target !== "object") return false;
    const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
    if (UI_INTERACTIVE_TAGS.has(tag)) return true;
    try {
      if (typeof target.closest === "function" && target.closest('button,a,input,select,textarea,[role="dialog"],[aria-modal="true"]')) {
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  };

  const isCanvasTarget = (ev) => {
    const t = ev?.target ?? null;
    if (!t) return true;
    if (isUiElement(t)) return false;
    if (deps.canvas) return t === deps.canvas;
    const cv = resolveCanvas();
    if (!cv || cv === doc?.body) return true;
    return t === cv || (typeof t.tagName === "string" && t.tagName.toUpperCase() === "CANVAS");
  };

  const readFault = (f) => {
    if (typeof f.snapshot === "function") {
      const s = f.snapshot();
      return s && s.fault !== undefined && s.fault !== null ? s.fault : null;
    }
    return f._fault ?? null;
  };

  function emit(type, source) {
    for (const fn of actionFns) {
      try { fn({ type, source }); } catch (_) { /* a listener never breaks input */ }
    }
  }

  function block(ev) {
    blocked++;
    try { ev.stopImmediatePropagation?.(); } catch (_) { /* frozen */ }
    try { if (ev.cancelable !== false) ev.preventDefault?.(); } catch (_) { /* passive */ }
  }

  function requestCanvasPointerLock(evTarget) {
    const el = (evTarget && typeof evTarget.requestPointerLock === "function") ? evTarget : resolveCanvas();
    if (!el || typeof el.requestPointerLock !== "function") return false;
    try {
      pointerLockPending = true;
      const p = el.requestPointerLock();
      if (p && typeof p.then === "function") {
        p.then(
          () => { if (!locked) exitPointerLockClean(); },
          () => { pointerLockPending = false; }
        );
      }
      return true;
    } catch (_) {
      pointerLockPending = false;
      return false;
    }
  }

  function exitPointerLockClean() {
    pointerLockPending = false;
    wasPointerLocked = false;
    try {
      if (isPointerLocked() && typeof doc?.exitPointerLock === "function") {
        doc.exitPointerLock();
      }
    } catch (_) { /* ignore */ }
  }

  function setMouseAim(on, initialPose = null) {
    const next = !!on;
    mouseAim = next;
    programmaticMouseAim = next && !(initialPose === "__pointer__");
    if (!next) {
      mouseFire = false;
      return false;
    }
    if (initialPose && typeof initialPose === "object") {
      const mp = Number.isFinite(initialPose.maxPitch) && initialPose.maxPitch > 0 ? initialPose.maxPitch : lastMaxPitch;
      lastMaxPitch = mp;
      if (Number.isFinite(initialPose.heading)) {
        aimHeading = wrapPi(initialPose.heading);
        lastFlightHeading = aimHeading;
      }
      if (Number.isFinite(initialPose.pitch)) {
        aimTargetPitch = clamp(initialPose.pitch, -mp, mp);
        lastFlightPitch = aimTargetPitch;
      }
      hasFlightState = true;
      aimSeeded = true;
    } else if (hasFlightState) {
      aimHeading = wrapPi(lastFlightHeading);
      aimTargetPitch = clamp(lastFlightPitch, -lastMaxPitch, lastMaxPitch);
      aimSeeded = true;
    } else {
      aimHeading = 0;
      aimTargetPitch = 0;
      aimSeeded = false;
    }
    return true;
  }

  function onPointerLockChange() {
    if (!locked) {
      exitPointerLockClean();
      return;
    }
    if (isPointerLocked()) {
      pointerLockPending = false;
      wasPointerLocked = true;
      return;
    }
    if (wasPointerLocked || pointerLockPending) {
      wasPointerLocked = false;
      pointerLockPending = false;
      mouseAim = false;
      programmaticMouseAim = false;
      mouseFire = false;
      mouseMiddleDown = false;
    }
  }

  function onKey(ev) {
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!CODE_SET.has(code)) return;
    const typing = isTypingTarget(ev, doc);
    if (ev.type === "keyup") {
      down[code] = false;
      if (!typing) block(ev);
      return;
    }
    if (typing || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    block(ev);
    if (ev.type !== "keydown") return;
    const was = down[code];
    down[code] = true;
    if (code === "Backslash") pitchTrim = 0;
    if (!was && LATCHED_CODES.includes(code)) latched[code] = true;
    if (!was && ev.repeat !== true) {
      if (code === "KeyM") {
        const want = !mouseAim;
        setMouseAim(want, "__pointer__");
        if (want) {
          if (!isPointerLocked()) requestCanvasPointerLock(null);
        } else {
          exitPointerLockClean();
        }
      }
      if (VEHICLE_KEY_ACTIONS[code]) emit(VEHICLE_KEY_ACTIONS[code], "keyboard");
    }
  }

  function onMouseDown(ev) {
    if (!locked || !ev || isTypingTarget(ev, doc)) return;
    const btn = ev.button;
    if (btn === 2 && (isPointerLocked() || isCanvasTarget(ev))) {
      rmbDown = true;
      block(ev);
      return;
    }
    if (isPointerLocked()) {
      if (btn === 0) {
        mouseFire = true;
        block(ev);
      } else if (btn === 1) {
        mouseMiddleDown = true;
        latched.MouseMiddle = true;
        block(ev);
      }
      return;
    }
    if (btn === 0 && isCanvasTarget(ev)) {
      requestCanvasPointerLock(ev.target);
      setMouseAim(true, "__pointer__");
      block(ev);
    }
  }

  function onMouseUp(ev) {
    if (!ev) return;
    const btn = ev.button;
    if (btn === 0) mouseFire = false;
    else if (btn === 1) mouseMiddleDown = false;
    else if (btn === 2) {
      const had = rmbDown;
      rmbDown = false;
      if (locked && (had || isPointerLocked() || isCanvasTarget(ev))) block(ev);
    }
  }

  function onMouseMove(ev) {
    if (!locked || !ev) return;
    const mx = Number(ev.movementX);
    const my = Number(ev.movementY);
    const dx = Number.isFinite(mx) ? mx : 0;
    const dy = Number.isFinite(my) ? my : 0;
    if (Math.abs(dx) > MOUSE_SPIKE_PX || Math.abs(dy) > MOUSE_SPIKE_PX) return;
    if (dx === 0 && dy === 0) return;

    const freelookNow = !!(down.KeyC || rmbDown);
    if (freelookNow) {
      freelookYaw = clamp(freelookYaw + dx * MOUSE_SENSITIVITY, -FREELOOK_MAX_YAW, FREELOOK_MAX_YAW);
      freelookPitch = clamp(freelookPitch + dy * MOUSE_SENSITIVITY * ySign, -FREELOOK_MAX_PITCH, FREELOOK_MAX_PITCH);
      if (isPointerLocked() || rmbDown) block(ev);
      return;
    }

    const canSteerAim = mouseAim && (isPointerLocked() || programmaticMouseAim || !hasPointerLockProp());
    if (canSteerAim) {
      aimHeading = wrapPi(aimHeading + dx * MOUSE_SENSITIVITY);
      aimTargetPitch = clamp(aimTargetPitch + dy * MOUSE_SENSITIVITY * ySign, -lastMaxPitch, lastMaxPitch);
      if (isPointerLocked()) block(ev);
    }
  }

  function onWheel(ev) {
    if (!locked || !ev || !isPointerLocked()) return;
    const dy = Number(ev.deltaY);
    if (!Number.isFinite(dy) || dy === 0) return;
    throttle = clamp(throttle + (dy < 0 ? WHEEL_THROTTLE_STEP : -WHEEL_THROTTLE_STEP), 0, 1);
    block(ev);
  }

  function onContextMenu(ev) {
    if (!locked || !ev) return;
    if (isPointerLocked() || rmbDown || isCanvasTarget(ev)) block(ev);
  }

  function onBlur() {
    for (const c of VEHICLE_KEY_CODES) down[c] = false;
    for (const c of LATCHED_CODES) latched[c] = false;
    latched.MouseMiddle = false;
    mouseFire = false;
    mouseMiddleDown = false;
    rmbDown = false;
  }

  function lock() {
    if (locked) return { ok: true, already: true };
    saved = { funnel: null };
    const f = deps.funnel ?? (win ? win.__inputFunnel : null);
    if (f && typeof f === "object") {
      const prevFault = readFault(f);
      if (prevFault !== "throw" && typeof f.releaseHeld === "function") {
        try { f.releaseHeld("vehicle"); } catch (_) { /* best effort */ }
      }
      let didPoison = false;
      if (prevFault === null && typeof f.poison === "function") {
        f.poison("gate");
        didPoison = true;
      }
      saved.funnel = { ref: f, didPoison };
    }
    if (win && typeof win.addEventListener === "function") {
      for (const t of KEY_EVENTS) win.addEventListener(t, onKey, CAPTURE);
      win.addEventListener("mousedown", onMouseDown, CAPTURE);
      win.addEventListener("mouseup", onMouseUp, CAPTURE);
      win.addEventListener("mousemove", onMouseMove, CAPTURE);
      win.addEventListener("wheel", onWheel, CAPTURE_ACTIVE);
      win.addEventListener("contextmenu", onContextMenu, CAPTURE);
      win.addEventListener("blur", onBlur);
      listening = true;
    }
    if (doc && typeof doc.addEventListener === "function") {
      doc.addEventListener("pointerlockchange", onPointerLockChange);
      docListening = true;
    }
    locked = true;
    return { ok: true, funnel: !!(saved.funnel), listening };
  }

  function restore() {
    if (!locked) return { ok: true, wasLocked: false };
    exitPointerLockClean();
    mouseAim = false;
    programmaticMouseAim = false;
    if (listening && win) {
      for (const t of KEY_EVENTS) { try { win.removeEventListener(t, onKey, CAPTURE); } catch (_) {} }
      try { win.removeEventListener("mousedown", onMouseDown, CAPTURE); } catch (_) {}
      try { win.removeEventListener("mouseup", onMouseUp, CAPTURE); } catch (_) {}
      try { win.removeEventListener("mousemove", onMouseMove, CAPTURE); } catch (_) {}
      try { win.removeEventListener("wheel", onWheel, CAPTURE_ACTIVE); } catch (_) {}
      try { win.removeEventListener("contextmenu", onContextMenu, CAPTURE); } catch (_) {}
      try { win.removeEventListener("blur", onBlur); } catch (_) {}
      listening = false;
    }
    if (docListening && doc) {
      try { doc.removeEventListener("pointerlockchange", onPointerLockChange); } catch (_) {}
      docListening = false;
    }
    const s = saved && saved.funnel;
    if (s && s.didPoison && readFault(s.ref) === "gate" && typeof s.ref.unpoison === "function") {
      try { s.ref.unpoison(); } catch (_) { /* best effort */ }
    }
    saved = null;
    locked = false;
    onBlur();
    freelookYaw = 0;
    freelookPitch = 0;
    return { ok: true, wasLocked: true };
  }

  function readPad() {
    try {
      const pads = nav && typeof nav.getGamepads === "function" ? nav.getGamepads() : null;
      if (!pads) return null;
      for (const p of pads) if (p && p.connected && p.mapping === "standard") return p;
    } catch (_) { /* no gamepad API */ }
    return null;
  }

  /**
   * Gamepad button edges (camera, exit) only — for a phase that holds the lock but steps no vehicle (the bail-out fall:
   * Back opens the parachute). poll() reads them too.
   */
  function pollEdges() {
    const pad = readPad();
    if (!pad) return;
    const b = (i) => !!(pad.buttons && pad.buttons[i] && pad.buttons[i].pressed);
    const edges = { camera: b(3), exit: b(8) };
    for (const k of ["camera", "exit"]) if (edges[k] && !padPrev[k]) emit(k, "gamepad");
    padPrev = edges;
  }

  function activeOverride() {
    if (!override) return null;
    if (override.until > (performance?.now?.() ?? 0)) return override;
    override = null;
    return null;
  }

  /**
   * Advance the lever, pitch trim, freelook spring, stick ramps and Mouse-Aim PD attitude instructor;
   * returns the analog input for this step (quantized downstream by FM.quantizeInput).
   * @param {number} dt seconds
   * @param {object|null} [flightState]
   * @param {object|null} [params]
   * @returns {{throttle:number, pitch:number, roll:number, yaw:number, boost:boolean, fire:boolean, land:boolean, missile:boolean, bomb:boolean}}
   */
  function poll(dt, flightState = null, params = null) {
    const t = Math.max(0, Math.min(0.25, dt));
    const maxBank = Number.isFinite(params?.maxBank) && params.maxBank > 0 ? params.maxBank : DEFAULT_MAX_BANK;
    const maxPitch = Number.isFinite(params?.maxPitch) && params.maxPitch > 0 ? params.maxPitch : DEFAULT_MAX_PITCH;
    const rollRate = Number.isFinite(params?.rollRate) && params.rollRate > 0 ? params.rollRate : DEFAULT_ROLL_RATE;
    lastMaxPitch = maxPitch;

    if (flightState && typeof flightState === "object") {
      if (Number.isFinite(flightState.heading)) lastFlightHeading = wrapPi(flightState.heading);
      if (Number.isFinite(flightState.pitch)) lastFlightPitch = flightState.pitch;
      hasFlightState = true;
      if (mouseAim && !aimSeeded) {
        aimHeading = wrapPi(lastFlightHeading + aimHeading);
        aimTargetPitch = clamp(lastFlightPitch + aimTargetPitch, -maxPitch, maxPitch);
        aimSeeded = true;
      }
    }

    // Freelook spring-back toward 0 when neither KeyC nor RMB is held
    const freelookActive = !!(locked && (down.KeyC || rmbDown));
    if (!freelookActive && t > 0 && (freelookYaw !== 0 || freelookPitch !== 0)) {
      const k = Math.exp(-t / FREELOOK_TAU);
      freelookYaw = Math.abs(freelookYaw * k) < 1e-5 ? 0 : freelookYaw * k;
      freelookPitch = Math.abs(freelookPitch * k) < 1e-5 ? 0 : freelookPitch * k;
    }

    const ov = activeOverride();
    if (ov) {
      const a = ov.axes;
      if (Number.isFinite(a.throttle)) throttle = Math.max(0, Math.min(1, a.throttle));
      return {
        throttle, pitch: a.pitch ?? 0, roll: a.roll ?? 0, yaw: a.yaw ?? 0,
        boost: !!a.boost, fire: !!a.fire, land: !!a.land, missile: !!a.missile, bomb: !!a.bomb,
      };
    }

    if (down.KeyR) throttle = Math.min(1, throttle + THROTTLE_RATE * t);
    if (down.KeyF) throttle = Math.max(0, throttle - THROTTLE_RATE * t);
    if (down.Backslash) pitchTrim = 0;
    else {
      if (down.BracketLeft) pitchTrim = Math.max(-PITCH_TRIM_MAX, pitchTrim - PITCH_TRIM_RATE * t);
      if (down.BracketRight) pitchTrim = Math.min(PITCH_TRIM_MAX, pitchTrim + PITCH_TRIM_RATE * t);
    }

    for (const axis of ["pitch", "roll", "yaw"]) {
      let target = 0;
      for (const [code, [ax, sign]] of Object.entries(VEHICLE_KEY_AXES)) if (ax === axis && down[code]) target += sign;
      target = Math.max(-1, Math.min(1, target));
      const cur = sticks[axis];
      const d = target - cur;
      const m = STICK_RATE * t;
      sticks[axis] = cur + (d > m ? m : d < -m ? -m : d);
    }

    const ptrLocked = isPointerLocked();
    let fire = down.Space || (ptrLocked && mouseFire);
    let boost = down.ShiftLeft || down.ShiftRight;
    let land = down.KeyL;
    let missile = down.KeyG || latched.KeyG === true || (ptrLocked && mouseMiddleDown) || latched.MouseMiddle === true;
    let bomb = down.KeyV || latched.KeyV === true;
    latched.KeyG = false;
    latched.KeyV = false;
    latched.MouseMiddle = false;

    let { pitch, roll, yaw } = sticks;
    let padStickActive = false;
    const pad = readPad();
    if (pad) {
      const ax = pad.axes || [];
      const b = (i) => !!(pad.buttons && pad.buttons[i] && pad.buttons[i].pressed);
      const lx = padAxis(ax[0] || 0), ly = padAxis(ax[1] || 0), rx = padAxis(ax[2] || 0);
      if (lx || ly || rx) { roll = lx; pitch = ly; yaw = rx; padStickActive = true; }
      if (b(5)) throttle = Math.min(1, throttle + THROTTLE_RATE * t);
      if (b(4)) throttle = Math.max(0, throttle - THROTTLE_RATE * t);
      fire = fire || b(7);
      missile = missile || b(6);
      bomb = bomb || b(0);
      boost = boost || b(1);
      land = land || b(2);
      const edges = { camera: b(3), exit: b(8) };
      for (const [k, v] of Object.entries(edges)) {
        if (v && !padPrev[k]) emit(k, "gamepad");
      }
      padPrev = edges;
    }

    const manualPitchRoll = !!(down.KeyW || down.KeyS || down.KeyA || down.KeyD) || padStickActive;
    if (mouseAim && flightState && manualPitchRoll) {
      // Manual stick commands take priority AND sync aim target so releasing WASD smoothly holds the new attitude
      aimHeading = wrapPi(flightState.heading ?? 0);
      aimTargetPitch = clamp(flightState.pitch ?? 0, -maxPitch, maxPitch);
      aimSeeded = true;
      pitch = clamp(pitch + pitchTrim, -1, 1);
    } else if (mouseAim && flightState && flightState.mode === FM.MODE.FLIGHT && !manualPitchRoll) {
      // Mouse-Aim PD Attitude Instructor
      const dh = angleDiff(aimHeading, flightState.heading ?? 0);
      const _dp = aimTargetPitch - (flightState.pitch ?? 0);
      const effSpeed = Math.max(flightState.speed ?? 0, 25);
      const turnSpeed = Math.max(flightState.speed ?? 0, FM.MIN_TURN_SPEED);
      const maxTurnRate = (FM.GRAVITY * Math.tan(maxBank)) / effSpeed;

      // Exact rollout stopping-angle lead term prevents heading overshoot due to finite rollRate
      const curBank = Number.isFinite(flightState.bank) ? flightState.bank : 0;
      const cosBank = Math.max(0.25, Math.cos(curBank));
      const stopHeading = Math.sign(curBank) * (FM.GRAVITY / (turnSpeed * rollRate)) * (-Math.log(cosBank));
      const dhLead = dh - stopHeading * 1.25;

      const omegaDes = clamp(dhLead * 1.85, -maxTurnRate, maxTurnRate);
      const bankDes = clamp(Math.atan((omegaDes * effSpeed) / FM.GRAVITY), -maxBank, maxBank);
      roll = clamp(bankDes / maxBank, -1, 1);

      const manualYaw = !!(down.KeyQ || down.KeyE);
      if (!manualYaw) {
        yaw = clamp(dh * 1.4, -1, 1) * (Math.abs(dh) < 0.28 ? 1 : 0.35);
      }
      pitch = clamp((aimTargetPitch + _dp * 0) / maxPitch, -1, 1);
      sticks.pitch = pitch;
      sticks.roll = roll;
      sticks.yaw = yaw;
    } else {
      pitch = clamp(pitch + pitchTrim, -1, 1);
    }

    return { throttle, pitch, roll, yaw, boost, fire, land, missile, bomb };
  }

  function status() {
    const ov = activeOverride();
    const pad = readPad();
    const b = (i) => !!(pad && pad.buttons && pad.buttons[i] && pad.buttons[i].pressed);
    const ptrLocked = isPointerLocked();
    const liveBoost = ov ? !!ov.axes.boost : !!(down.ShiftLeft || down.ShiftRight || b(1));
    const liveLand = ov ? !!ov.axes.land : !!(down.KeyL || b(2));
    const liveFire = ov ? !!ov.axes.fire : !!(down.Space || (ptrLocked && mouseFire) || b(7));
    const freelookActive = !!(locked && (down.KeyC || rmbDown));
    const aimYaw = hasFlightState ? angleDiff(aimHeading, lastFlightHeading) : aimHeading;
    const aimPitch = hasFlightState ? aimTargetPitch - lastFlightPitch : aimTargetPitch;
    return {
      locked,
      throttle,
      sticks: { ...sticks },
      boost: liveBoost,
      land: liveLand,
      fire: liveFire,
      pitchTrim,
      mouseAim,
      aimOffset: { yaw: aimYaw, pitch: aimPitch },
      aimWorld: { heading: aimHeading, pitch: aimTargetPitch },
      freelook: { active: freelookActive, yaw: freelookYaw, pitch: freelookPitch },
      blocked,
      override: ov ? { ...ov.axes } : null,
    };
  }

  return {
    lock,
    restore,
    poll,
    pollEdges,
    onAction(fn) { actionFns.add(fn); return () => actionFns.delete(fn); },
    get locked() { return locked; },
    get throttle() { return throttle; },
    set throttle(v) { if (Number.isFinite(v)) throttle = Math.max(0, Math.min(1, v)); },
    get pitchTrim() { return pitchTrim; },
    set pitchTrim(v) { if (Number.isFinite(v)) pitchTrim = clamp(v, -PITCH_TRIM_MAX, PITCH_TRIM_MAX); },
    get mouseAim() { return mouseAim; },
    setMouseAim,
    /** Bench / debug: drive the analog input for `ms` (axes: throttle, pitch, roll, yaw, boost, fire, land, missile, bomb). */
    setOverride(axes, ms = 1e9) {
      const now = performance?.now?.() ?? 0;
      override = { axes: { ...(axes || {}) }, until: now + ms };
    },
    clearOverride() { override = null; },
    status,
    dispose() { const r = restore(); actionFns.clear(); return r; },
  };
}
