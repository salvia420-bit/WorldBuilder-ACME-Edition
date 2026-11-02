// scene3d/vehicle/controls.js — vehicle input: keyboard + gamepad → stick values, and the input lock.
//
// While seated the player's keys fly the vehicle, not the character: lock() takes the input funnel the same way the
// drone does (synthetic releases of held keys, then its fault slot set to "gate" when it was open) plus window
// CAPTURE listeners for the vehicle keys; restore() undoes exactly that. Never taken: Escape, Enter, F-keys, digits,
// Ctrl/Alt/Meta chords, anything while a text field has focus (chat keeps working).
//
// Keyboard (sticks are spring-loaded; the throttle is a lever that stays where it is set):
//   W / S  nose down / up        A / D  roll left / right       Q / E  rudder left / right
//   R / F  throttle up / down    Shift  boost                  Space  guns (six repeating crossbows)
//   G      lightning rails (one Lightning Bolt; held: the next rail every 0.3 s)   V  release the next bomb
//   L      hold to land (slow to landing speed, then descend)   X  exit (parked) — X twice in the air = bail
//   Tab    camera (chase / cockpit)   H  hide the OSD
// G and V are LATCHED: a tap shorter than one 30 Hz step still reaches the next step (the server sees the press).
// Gamepad (standard mapping): left stick roll + pitch, right stick X rudder, RT guns, LT rails, A bomb, LB/RB throttle
// down/up, B boost, X land, Y camera, Back exit/bail.
//
// Page module: dependencies injected ({window, document, navigator, funnel}); no timers.

import { isTypingTarget } from "../drone/controls.js";

export const VEHICLE_KEY_AXES = Object.freeze({
  KeyW: ["pitch", -1],
  KeyS: ["pitch", 1],
  KeyD: ["roll", 1],
  KeyA: ["roll", -1],
  KeyE: ["yaw", 1],
  KeyQ: ["yaw", -1],
});
export const VEHICLE_KEY_ACTIONS = Object.freeze({ Tab: "camera", KeyH: "hideHud", KeyX: "exit" });
export const VEHICLE_HOLD_CODES = Object.freeze(["KeyR", "KeyF", "ShiftLeft", "ShiftRight", "Space", "KeyL", "KeyG", "KeyV"]);
/** Hold codes whose press is latched until a step has seen it (a quick tap must not fall between two steps). */
const LATCHED_CODES = Object.freeze(["KeyG", "KeyV"]);
export const VEHICLE_KEY_CODES = Object.freeze([
  ...Object.keys(VEHICLE_KEY_AXES), ...Object.keys(VEHICLE_KEY_ACTIONS), ...VEHICLE_HOLD_CODES,
]);
const CODE_SET = new Set(VEHICLE_KEY_CODES);
const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const CAPTURE = Object.freeze({ capture: true });

export const THROTTLE_RATE = 0.6; // lever travel per second with R / F held
export const STICK_RATE = 4.0; // keyboard sticks ramp to full in 0.25 s
const PAD_DEADZONE = 0.12;

function shape(v) {
  const a = Math.abs(v);
  if (a < PAD_DEADZONE) return 0;
  return Math.sign(v) * ((a - PAD_DEADZONE) / (1 - PAD_DEADZONE));
}

/**
 * @param {{window?: object, document?: object, navigator?: object, funnel?: object}} [deps]
 */
export function createVehicleControls(deps = {}) {
  const win = deps.window ?? (typeof window !== "undefined" ? window : null);
  const doc = deps.document ?? (win ? win.document : null);
  const nav = deps.navigator ?? (win ? win.navigator : null);
  const down = Object.create(null);
  for (const c of VEHICLE_KEY_CODES) down[c] = false;
  const latched = Object.create(null); // code → pressed since the last poll
  const actionFns = new Set();
  let locked = false;
  let listening = false;
  let saved = null;
  let throttle = 0;
  const sticks = { pitch: 0, roll: 0, yaw: 0 };
  let padPrev = {};
  let override = null; // {until, axes} — the bench / debug drives the sticks
  let blocked = 0;

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
    try { ev.stopImmediatePropagation(); } catch (_) { /* frozen */ }
    try { if (ev.cancelable !== false) ev.preventDefault(); } catch (_) { /* passive */ }
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
    if (!was && LATCHED_CODES.includes(code)) latched[code] = true;
    if (!was && ev.repeat !== true && VEHICLE_KEY_ACTIONS[code]) emit(VEHICLE_KEY_ACTIONS[code], "keyboard");
  }

  function onBlur() {
    for (const c of VEHICLE_KEY_CODES) down[c] = false;
    for (const c of LATCHED_CODES) latched[c] = false;
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
      win.addEventListener("blur", onBlur);
      listening = true;
    }
    locked = true;
    return { ok: true, funnel: !!(saved.funnel), listening };
  }

  function restore() {
    if (!locked) return { ok: true, wasLocked: false };
    if (listening && win) {
      for (const t of KEY_EVENTS) { try { win.removeEventListener(t, onKey, CAPTURE); } catch (_) {} }
      try { win.removeEventListener("blur", onBlur); } catch (_) {}
      listening = false;
    }
    const s = saved && saved.funnel;
    if (s && s.didPoison && readFault(s.ref) === "gate" && typeof s.ref.unpoison === "function") {
      try { s.ref.unpoison(); } catch (_) { /* best effort */ }
    }
    saved = null;
    locked = false;
    onBlur();
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

  /**
   * Advance the lever and the stick ramps; returns the analog input for this step.
   * @param {number} dt seconds
   * @returns {{throttle:number, pitch:number, roll:number, yaw:number, boost:boolean, fire:boolean, land:boolean, missile:boolean, bomb:boolean}}
   */
  function poll(dt) {
    const t = Math.max(0, Math.min(0.25, dt));
    if (override && override.until > (performance?.now?.() ?? 0)) {
      const a = override.axes;
      if (Number.isFinite(a.throttle)) throttle = Math.max(0, Math.min(1, a.throttle));
      return {
        throttle, pitch: a.pitch ?? 0, roll: a.roll ?? 0, yaw: a.yaw ?? 0,
        boost: !!a.boost, fire: !!a.fire, land: !!a.land, missile: !!a.missile, bomb: !!a.bomb,
      };
    }
    override = null;
    if (down.KeyR) throttle = Math.min(1, throttle + THROTTLE_RATE * t);
    if (down.KeyF) throttle = Math.max(0, throttle - THROTTLE_RATE * t);
    for (const axis of ["pitch", "roll", "yaw"]) {
      let target = 0;
      for (const [code, [ax, sign]] of Object.entries(VEHICLE_KEY_AXES)) if (ax === axis && down[code]) target += sign;
      target = Math.max(-1, Math.min(1, target));
      const cur = sticks[axis];
      const d = target - cur;
      const m = STICK_RATE * t;
      sticks[axis] = cur + (d > m ? m : d < -m ? -m : d);
    }
    let fire = down.Space;
    let boost = down.ShiftLeft || down.ShiftRight;
    let land = down.KeyL;
    let missile = down.KeyG || latched.KeyG === true;
    let bomb = down.KeyV || latched.KeyV === true;
    latched.KeyG = false;
    latched.KeyV = false;
    let { pitch, roll, yaw } = sticks;
    const pad = readPad();
    if (pad) {
      const ax = pad.axes || [];
      const b = (i) => !!(pad.buttons && pad.buttons[i] && pad.buttons[i].pressed);
      const lx = shape(ax[0] || 0), ly = shape(ax[1] || 0), rx = shape(ax[2] || 0);
      if (lx || ly || rx) { roll = lx; pitch = ly; yaw = rx; }
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
    return { throttle, pitch, roll, yaw, boost, fire, land, missile, bomb };
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
    /** Bench / debug: drive the analog input for `ms` (axes: throttle, pitch, roll, yaw, boost, fire, land, missile, bomb). */
    setOverride(axes, ms = 1e9) {
      const now = performance?.now?.() ?? 0;
      override = { axes: { ...(axes || {}) }, until: now + ms };
    },
    clearOverride() { override = null; },
    status: () => ({ locked, throttle, sticks: { ...sticks }, blocked, override: override ? { ...override.axes } : null }),
    dispose() { const r = restore(); actionFns.clear(); return r; },
  };
}
