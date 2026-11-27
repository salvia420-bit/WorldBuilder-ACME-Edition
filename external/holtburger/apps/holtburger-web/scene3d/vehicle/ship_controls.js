// scene3d/vehicle/ship_controls.js — Human Helm Controller & 4-Mode Nautical Camera Rig
//
// Matches scene3d/vehicle/controls.js, camera_rig.js & pallet_jack_controller.js conventions:
//   - Acquires window.__inputFunnel lock & createCameraOwner ONLY while actively at the ship's helm
//   - NEVER steals chat/typing, open modals, Escape, Enter, F-keys, Ctrl/Alt/Meta chords, or another occupied vehicle
//   - Restore-time key drain prevents held keys from leaking into avatar walking on exit
//
// Controls:
//   W / S       Engine Order Telegraph (EOT) notch (-3 Full Astern .. 0 Stop .. +3 Full Ahead)
//   Space       All Stop (EOT = 0, zeroes lateral thrusters)
//   A / D       Helm / Rudder port / starboard (±35°, holds angle like a ship's wheel)
//   C           Center rudder (rudder = 0) & recenter freelook
//   Q / E       Parallel lateral thrusters (crab port / starboard)
//   Shift+A/D   Counter-pivot thrusters (bow/stern opposite for in-place turn)
//   M           Moor / Unmoor toggle
//   P           Toggle Autopilot / Manual Helm
//   1 / 2       Select target Berth (B1 / B2)
//   H           Ship Foghorn
//   Tab         Cycle 4-mode nautical camera (chase -> bridge -> wing -> overhead)
//   X           Exit helm
//
// Page/injected module: all browser deps injected ({window, document, funnel, liveScene3d, THREE, ...}).

import { isTypingTarget } from "../drone/controls.js";
import { cancelJumpCharge, jumpChargePending } from "../../ui/escape_action.js";
import { createCameraOwner } from "../film/runtime/camera_owner.js";
import { SHIP_SPECS, SHIP_EOT_NOTCHES, SHIP_CAMERA_MODES } from "./port_specs.js";

export const SHIP_VIEW_MODES = SHIP_CAMERA_MODES;

export const SHIP_KEY_CODES = Object.freeze([
  "KeyW", "KeyS", "Space",
  "KeyA", "KeyD", "KeyC",
  "KeyQ", "KeyE",
  "ShiftLeft", "ShiftRight",
  "KeyM", "KeyP", "Digit1", "Digit2", "KeyH", "Tab", "KeyX",
]);

const CODE_SET = new Set(SHIP_KEY_CODES);
const KEY_EVENTS = ["keydown", "keyup", "keypress"];
const CAPTURE = Object.freeze({ capture: true });
const BUBBLE = Object.freeze({ capture: false });
const MODAL_SELECTOR = '[aria-modal="true"]';

export const SHIP_MAX_RUDDER_RAD = SHIP_SPECS.maxRudderRad;
export const SHIP_MAX_RUDDER_DEG = (SHIP_MAX_RUDDER_RAD * 180.0) / Math.PI;
export const RUDDER_RATE_PER_SEC = 0.85; // full hard-over in ~1.18 s
export const THRUSTER_RATE_PER_SEC = 3.5;
export const FREELOOK_SENSITIVITY = 0.0024;
export const FREELOOK_MAX_YAW = 2.6;
export const FREELOOK_MAX_PITCH = 1.0;
export const FREELOOK_TAU = 0.16;

// Vessel anchor presets locked verbatim to SHIP_SPECS.cameraAnchors (78.0 m LOA x 14.4 m Beam)
export const SHIP_CAMERA_PRESETS = Object.freeze({
  chase: Object.freeze({
    back: SHIP_SPECS.cameraAnchors.chase.back,
    up: SHIP_SPECS.cameraAnchors.chase.up,
    lookAhead: SHIP_SPECS.cameraAnchors.chase.lookAhead,
    pitch: -0.26,
    fov: SHIP_SPECS.cameraAnchors.chase.fov,
    headingTau: 0.45,
  }),
  bridge: Object.freeze({
    localEye: Object.freeze([
      SHIP_SPECS.cameraAnchors.bridge.x,
      SHIP_SPECS.cameraAnchors.bridge.y,
      SHIP_SPECS.cameraAnchors.bridge.z,
    ]),
    pitch: -0.09,
    fov: SHIP_SPECS.cameraAnchors.bridge.fov,
  }),
  wing: Object.freeze({
    wingX: SHIP_SPECS.cameraAnchors.wingStarboard.x,
    localY: SHIP_SPECS.cameraAnchors.wingStarboard.y,
    localZ: SHIP_SPECS.cameraAnchors.wingStarboard.z,
    yawBiasRad: 0.14,
    pitch: -0.28,
    fov: SHIP_SPECS.cameraAnchors.wingStarboard.fov,
  }),
  overhead: Object.freeze({
    back: SHIP_SPECS.cameraAnchors.overhead.back,
    up: SHIP_SPECS.cameraAnchors.overhead.up,
    pitch: -1.36,
    fov: SHIP_SPECS.cameraAnchors.overhead.fov,
  }),
});

function eotNotchToThrottle(notch) {
  const n = Math.max(-3, Math.min(3, Math.round(notch || 0)));
  const found = SHIP_EOT_NOTCHES.find((e) => e.notch === n);
  return found ? found.throttle : 0.0;
}

const TWO_PI = Math.PI * 2.0;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function wrapHeading(h) {
  if (!fin(h)) return 0;
  let a = h % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

export function wrapPi(a) {
  if (!fin(a)) return 0;
  let d = a % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d === 0 ? 0 : d;
}

export function nextShipViewMode(cur) {
  const idx = SHIP_VIEW_MODES.indexOf(cur);
  return SHIP_VIEW_MODES[(idx + 1) % SHIP_VIEW_MODES.length];
}

function isVisibleConnectedModal(el, win) {
  if (!el || el.isConnected === false) return false;
  if (el.hidden === true) return false;
  try {
    if (typeof el.getAttribute === "function") {
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.getAttribute("data-open") === "0") return false;
    }
  } catch (_) {}
  if (el.dataset && el.dataset.open === "0") return false;
  if (el.style && (el.style.display === "none" || el.style.visibility === "hidden")) return false;
  try {
    const w = win ?? el.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    if (w && typeof w.getComputedStyle === "function") {
      const cs = w.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    }
  } catch (_) {}
  return true;
}

function insideModal(el, win) {
  try {
    if (!el || typeof el.closest !== "function") return false;
    const modal = el.closest(MODAL_SELECTOR);
    return modal ? isVisibleConnectedModal(modal, win) : false;
  } catch (_) {
    return false;
  }
}

function inOpenModal(ev, doc, win) {
  const w = win ?? doc?.defaultView ?? null;
  if (insideModal(ev ? ev.target : null, w)) return true;
  try {
    const el = doc ? doc.activeElement : null;
    if (el && el.isConnected !== false && insideModal(el, w)) return true;
    if (doc && typeof doc.querySelectorAll === "function") {
      const list = doc.querySelectorAll(MODAL_SELECTOR);
      if (list) {
        for (let i = 0; i < list.length; i++) {
          if (isVisibleConnectedModal(list[i], w)) return true;
        }
      }
    } else if (doc && typeof doc.querySelector === "function") {
      if (isVisibleConnectedModal(doc.querySelector(MODAL_SELECTOR), w)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function readFault(f) {
  if (!f || typeof f !== "object") return null;
  try {
    if (typeof f.snapshot === "function") {
      const s = f.snapshot();
      if (s && "fault" in s) return s.fault;
    }
    if ("_fault" in f) return f._fault;
    if ("fault" in f) return f.fault;
  } catch (_) {}
  return null;
}

/**
 * Transform ship-local coordinates [lx, ly, lz] (+X stbd, +Y bow, +Z up)
 * into AC world coordinates using compass heading, pitch (+bow up), and roll (+stbd down).
 */
export function shipLocalToWorld(pose, lx, ly, lz) {
  const px = fin(pose?.x) ? pose.x : 0;
  const py = fin(pose?.y) ? pose.y : 0;
  const pz = fin(pose?.z) ? pose.z : 0;
  const h = fin(pose?.heading) ? pose.heading : 0;
  const pitch = fin(pose?.pitch) ? pose.pitch : 0;
  const roll = fin(pose?.roll) ? pose.roll : 0;

  // 1. Roll around local +Y (+roll tips +X starboard down toward -Z)
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const x1 = lx * cr + lz * sr;
  const y1 = ly;
  const z1 = -lx * sr + lz * cr;

  // 2. Pitch around local +X (+pitch lifts +Y bow up toward +Z)
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;

  // 3. Compass heading around world +Z (0 = +Y north, +pi/2 = +X east => rotation.z = -h)
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const wx = px + x2 * ch + y2 * sh;
  const wy = py - x2 * sh + y2 * ch;
  const wz = pz + z2;

  return [wx, wy, wz];
}

/**
 * 4-Mode Nautical Camera Rig:
 *   - "chase":    Elevated stern-quartering follow camera with smooth heading lag + freelook orbit
 *   - "bridge":   Glazed wheelhouse helm POV over container deck stacks & forecastle
 *   - "wing":     Full-beam port or starboard bridge wing docking view looking down the fender line
 *   - "overhead": Tactical top-down docking view showing entire 78 m hull, fenders & STS cranes
 */
export function createShipCameraRig(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  let view = SHIP_VIEW_MODES.includes(o.initialView) ? o.initialView : "chase";
  let wingSide = o.wingSide === "port" || o.wingSide === "starboard" ? o.wingSide : "auto";
  let camHeading = null;

  function resolveWingSign(pose, berth) {
    if (wingSide === "port") return -1;
    if (wingSide === "starboard") return +1;
    // Auto-select the bridge wing facing the quay (south of berth at Site A, or explicit berth.quayY / quaySide)
    if (berth && typeof berth === "object") {
      if (berth.wingSide === "port") return -1;
      if (berth.wingSide === "starboard") return +1;
      const qx = fin(berth.quayX) ? berth.quayX : (fin(berth.x) ? berth.x : (fin(pose?.x) ? pose.x : 0));
      const qy = fin(berth.quayY) ? berth.quayY : (fin(berth.y) ? berth.y - 8 : (fin(pose?.y) ? pose.y - 8 : -8));
      const dx = qx - (fin(pose?.x) ? pose.x : 0);
      const dy = qy - (fin(pose?.y) ? pose.y : 0);
      const h = fin(pose?.heading) ? pose.heading : 0;
      // Dot with starboard unit vector [cos(h), -sin(h)]
      const stbdDot = dx * Math.cos(h) - dy * Math.sin(h);
      return stbdDot >= 0 ? +1 : -1;
    }
    // Default for Site A East-West quay (water North, quay South): heading East -> starboard faces South quay
    const h = fin(pose?.heading) ? pose.heading : Math.PI * 0.5;
    return Math.sin(h) >= 0 ? +1 : -1;
  }

  function setView(mode) {
    if (SHIP_VIEW_MODES.includes(mode)) {
      view = mode;
    }
    return view;
  }

  function cycleView() {
    return setView(nextShipViewMode(view));
  }

  function setWingSide(side) {
    if (side === "port" || side === "starboard" || side === "auto") {
      wingSide = side;
    }
    return wingSide;
  }

  function reset(heading = null) {
    camHeading = fin(heading) ? wrapHeading(heading) : null;
  }

  /**
   * Compute AC camera pose `{ pos:[x,y,z], h, p, r, fov }` for the active nautical view mode.
   */
  function step({ pose, dt = 1 / 60, controlsStatus = null, berth = null } = {}) {
    const stepDt = fin(dt) ? clamp(dt, 0, 0.25) : 0;
    const p = pose && typeof pose === "object"
      ? pose
      : { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 };

    const hdg = fin(p.heading) ? p.heading : 0;
    const pitch = fin(p.pitch) ? p.pitch : 0;
    const roll = fin(p.roll) ? p.roll : 0;
    const flYaw = fin(controlsStatus?.freelook?.yaw) ? controlsStatus.freelook.yaw : 0;
    const flPitch = fin(controlsStatus?.freelook?.pitch) ? controlsStatus.freelook.pitch : 0;

    let camPos;
    let camH;
    let camP;
    let camR = 0;
    let fov;

    if (view === "bridge") {
      const cfg = SHIP_CAMERA_PRESETS.bridge;
      camPos = shipLocalToWorld(p, cfg.localEye[0], cfg.localEye[1], cfg.localEye[2]);
      camH = wrapHeading(hdg + flYaw);
      camP = clamp(cfg.pitch + pitch * 0.8 + flPitch, -1.2, 1.0);
      camR = clamp(roll * 0.65, -0.35, 0.35);
      fov = cfg.fov;
    } else if (view === "wing") {
      const cfg = SHIP_CAMERA_PRESETS.wing;
      const sideSign = resolveWingSign(p, berth); // +1 stbd, -1 port
      camPos = shipLocalToWorld(p, sideSign * cfg.wingX, cfg.localY, cfg.localZ);
      // Look slightly inward/down along hull side and quay fenders
      camH = wrapHeading(hdg - sideSign * cfg.yawBiasRad + flYaw);
      camP = clamp(cfg.pitch + pitch * 0.5 + flPitch, -1.35, 0.65);
      camR = clamp(roll * 0.4, -0.25, 0.25);
      fov = cfg.fov;
    } else if (view === "overhead") {
      const cfg = SHIP_CAMERA_PRESETS.overhead;
      const orbH = wrapHeading(hdg + flYaw);
      const ex = (fin(p.x) ? p.x : 0) - Math.sin(orbH) * cfg.back;
      const ey = (fin(p.y) ? p.y : 0) - Math.cos(orbH) * cfg.back;
      const ez = (fin(p.z) ? p.z : 0) + cfg.up;
      camPos = [ex, ey, ez];
      camH = orbH;
      camP = clamp(cfg.pitch + flPitch * 0.25, -1.52, -0.5);
      camR = 0;
      fov = cfg.fov;
    } else {
      // "chase"
      const cfg = SHIP_CAMERA_PRESETS.chase;
      if (camHeading === null) {
        camHeading = wrapHeading(hdg);
      } else if (stepDt > 0) {
        const a = 1 - Math.exp(-stepDt / cfg.headingTau);
        camHeading = wrapHeading(camHeading + wrapPi(hdg - camHeading) * a);
      }
      const orbH = wrapHeading(camHeading + flYaw);
      const ex = (fin(p.x) ? p.x : 0) - Math.sin(orbH) * cfg.back;
      const ey = (fin(p.y) ? p.y : 0) - Math.cos(orbH) * cfg.back;
      const ez = Math.max(4.0, (fin(p.z) ? p.z : 0) + cfg.up);

      const tx = (fin(p.x) ? p.x : 0) + Math.sin(hdg) * cfg.lookAhead;
      const ty = (fin(p.y) ? p.y : 0) + Math.cos(hdg) * cfg.lookAhead;
      const tz = (fin(p.z) ? p.z : 0) + 6.5;

      const dx = tx - ex;
      const dy = ty - ey;
      const dz = tz - ez;
      const dh = Math.hypot(dx, dy);

      camPos = [ex, ey, ez];
      camH = dh > 1e-4 ? wrapHeading(Math.atan2(dx, dy)) : orbH;
      camP = clamp((dh > 1e-4 ? Math.atan2(dz, dh) : cfg.pitch) + flPitch * 0.6, -1.3, 0.7);
      camR = 0;
      fov = cfg.fov;
    }

    return {
      cam: {
        pos: camPos,
        h: camH,
        p: camP,
        r: camR,
        fov,
      },
      view,
      wingSide: view === "wing" ? (resolveWingSign(p, berth) > 0 ? "starboard" : "port") : wingSide,
    };
  }

  return {
    getView: () => view,
    setView,
    cycleView,
    getWingSide: () => wingSide,
    setWingSide,
    reset,
    step,
  };
}

/**
 * Check whether another vehicle (aircraft, jeep, semi, pallet jack) currently occupies the player.
 */
function defaultIsOtherVehicleOccupied(win) {
  try {
    const v = win?.__vehicles;
    if (!v || typeof v !== "object") return false;
    if (typeof v.palletJack?.isActive === "function" && v.palletJack.isActive()) return true;
    if (typeof v.status === "function") {
      const st = v.status();
      if (st && typeof st === "object") {
        if (st.piloting || st.seated || st.passenger || st.inVehicle) return true;
        if (st.pilot && typeof st.pilot === "object") return true;
        if (fin(st.pilotGuid) && st.pilotGuid !== 0) return true;
        if (fin(st.seatedGuid) && st.seatedGuid !== 0) return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Create the human ship helm input + camera-owner controller.
 *
 * @param {{
 *   window?: object|null,
 *   document?: object|null,
 *   funnel?: object|null,
 *   liveScene3d?: object|null,
 *   THREE?: object|null,
 *   sessionHandle?: object|null,
 *   cameraSwitcher?: object|null,
 *   cameraOwnerFactory?: Function,
 *   isOtherVehicleOccupied?: () => boolean,
 *   initialView?: string,
 * }} [deps]
 */
export function createShipControls(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const doc = d.document !== undefined ? d.document : (win ? win.document : null);
  const live = d.liveScene3d ?? null;
  const cameraOwnerFactory = typeof d.cameraOwnerFactory === "function" ? d.cameraOwnerFactory : createCameraOwner;
  const checkOtherOccupied = typeof d.isOtherVehicleOccupied === "function"
    ? d.isOtherVehicleOccupied
    : () => defaultIsOtherVehicleOccupied(win);

  const down = Object.create(null);
  for (const c of SHIP_KEY_CODES) down[c] = false;
  const drainCodes = new Set();
  const actionListeners = new Set();

  const camRig = createShipCameraRig({ initialView: d.initialView || "chase" });

  let locked = false;
  let disposed = false;
  let listening = false;
  let drainListening = false;
  let savedFunnel = null;
  let cameraOwner = null;

  // Helm state
  let eot = 0;            // integer -3..+3
  let rudder = 0;         // normalized -1..+1 (-35°..+35°)
  let bowThruster = 0;    // normalized -1..+1
  let sternThruster = 0;  // normalized -1..+1
  let selectedBerth = "B1";
  let rmbDown = false;
  let freelookYaw = 0;
  let freelookPitch = 0;
  let override = null; // { until, input }
  let blockedEvents = 0;

  function emit(evt) {
    const payload = typeof evt === "string" ? { type: evt, source: "keyboard" } : { source: "keyboard", ...evt };
    for (const fn of [...actionListeners]) {
      try { fn(payload); } catch (_) {}
    }
  }

  function block(ev) {
    blockedEvents++;
    try { ev.stopImmediatePropagation?.(); } catch (_) {}
    try { if (ev.cancelable !== false) ev.preventDefault?.(); } catch (_) {}
  }

  function clearDown() {
    for (const c of SHIP_KEY_CODES) down[c] = false;
    rmbDown = false;
  }

  function onKey(ev) {
    if (!locked || !ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!CODE_SET.has(code)) return;

    const typing = isTypingTarget(ev, doc) || inOpenModal(ev, doc, win);
    if (ev.type === "keyup") {
      down[code] = false;
      if (!typing) block(ev);
      return;
    }
    // Never steal chat, modals, or Ctrl/Alt/Meta chords (Escape/Enter/F-keys aren't in CODE_SET either)
    if (typing || ev.ctrlKey || ev.altKey || ev.metaKey) return;

    block(ev);
    if (ev.type !== "keydown") return;

    const fresh = !down[code] && ev.repeat !== true;
    down[code] = true;

    if (!fresh) return;

    if (code === "KeyW") {
      eot = clamp(eot + 1, -3, 3);
      emit({ type: "eot", eot });
    } else if (code === "KeyS") {
      eot = clamp(eot - 1, -3, 3);
      emit({ type: "eot", eot });
    } else if (code === "Space") {
      eot = 0;
      bowThruster = 0;
      sternThruster = 0;
      emit({ type: "allStop", eot: 0 });
    } else if (code === "KeyC") {
      rudder = 0;
      freelookYaw = 0;
      freelookPitch = 0;
      emit({ type: "centerRudder" });
    } else if (code === "KeyM") {
      emit({ type: "toggleMoor" });
    } else if (code === "KeyP") {
      emit({ type: "toggleAutopilot" });
    } else if (code === "Digit1") {
      selectedBerth = "B1";
      emit({ type: "selectBerth", berthId: "B1" });
    } else if (code === "Digit2") {
      selectedBerth = "B2";
      emit({ type: "selectBerth", berthId: "B2" });
    } else if (code === "KeyH") {
      emit({ type: "foghorn" });
    } else if (code === "Tab") {
      const next = camRig.cycleView();
      emit({ type: "camera", viewMode: next });
    } else if (code === "KeyX") {
      emit({ type: "exit" });
    }
  }

  function onMouseDown(ev) {
    if (!locked || !ev || isTypingTarget(ev, doc) || inOpenModal(ev, doc, win)) return;
    if (ev.button === 2) {
      rmbDown = true;
      block(ev);
    }
  }

  function onMouseUp(ev) {
    if (!ev) return;
    if (ev.button === 2) {
      const had = rmbDown;
      rmbDown = false;
      if (locked && had) block(ev);
    }
  }

  function onMouseMove(ev) {
    if (!locked || !ev || !rmbDown) return;
    const dx = fin(ev.movementX) ? ev.movementX : 0;
    const dy = fin(ev.movementY) ? ev.movementY : 0;
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
    freelookYaw = clamp(freelookYaw + dx * FREELOOK_SENSITIVITY, -FREELOOK_MAX_YAW, FREELOOK_MAX_YAW);
    freelookPitch = clamp(freelookPitch - dy * FREELOOK_SENSITIVITY, -FREELOOK_MAX_PITCH, FREELOOK_MAX_PITCH);
    block(ev);
  }

  function onContextMenu(ev) {
    if (!locked || !ev) return;
    if (rmbDown) block(ev);
  }

  function onBlur() {
    clearDown();
  }

  function onVisibility() {
    if (doc?.visibilityState === "hidden") clearDown();
  }

  function onDrainKey(ev) {
    if (!ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!drainCodes.has(code)) return;
    if (ev.type === "keyup") {
      drainCodes.delete(code);
      block(ev);
    } else if (ev.repeat === true) {
      block(ev);
    } else {
      drainCodes.delete(code);
    }
    if (drainCodes.size === 0) dropDrain();
  }

  function startDrain() {
    for (const c of SHIP_KEY_CODES) {
      if (down[c]) drainCodes.add(c);
    }
    clearDown();
    if (drainCodes.size === 0 || !win || typeof win.addEventListener !== "function") {
      drainCodes.clear();
      return;
    }
    if (drainListening) return;
    win.addEventListener("keydown", onDrainKey, CAPTURE);
    win.addEventListener("keyup", onDrainKey, CAPTURE);
    win.addEventListener("blur", dropDrain, BUBBLE);
    drainListening = true;
  }

  function dropDrain() {
    drainCodes.clear();
    if (!drainListening || !win) return;
    drainListening = false;
    try { win.removeEventListener("keydown", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("keyup", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("blur", dropDrain, BUBBLE); } catch (_) {}
  }

  function addListeners() {
    if (listening || !win || typeof win.addEventListener !== "function") return;
    for (const t of KEY_EVENTS) win.addEventListener(t, onKey, CAPTURE);
    win.addEventListener("mousedown", onMouseDown, CAPTURE);
    win.addEventListener("mouseup", onMouseUp, CAPTURE);
    win.addEventListener("mousemove", onMouseMove, CAPTURE);
    win.addEventListener("contextmenu", onContextMenu, CAPTURE);
    win.addEventListener("blur", onBlur, BUBBLE);
    doc?.addEventListener?.("visibilitychange", onVisibility, BUBBLE);
    listening = true;
  }

  function removeListeners() {
    if (!listening) return;
    listening = false;
    if (win && typeof win.removeEventListener === "function") {
      for (const t of KEY_EVENTS) { try { win.removeEventListener(t, onKey, CAPTURE); } catch (_) {} }
      try { win.removeEventListener("mousedown", onMouseDown, CAPTURE); } catch (_) {}
      try { win.removeEventListener("mouseup", onMouseUp, CAPTURE); } catch (_) {}
      try { win.removeEventListener("mousemove", onMouseMove, CAPTURE); } catch (_) {}
      try { win.removeEventListener("contextmenu", onContextMenu, CAPTURE); } catch (_) {}
      try { win.removeEventListener("blur", onBlur, BUBBLE); } catch (_) {}
    }
    try { doc?.removeEventListener?.("visibilitychange", onVisibility, BUBBLE); } catch (_) {}
  }

  function acquireCamera() {
    if (cameraOwner?.owned) return true;
    if (!live) return false;
    try {
      cameraOwner = cameraOwnerFactory({
        liveScene3d: live,
        THREE: d.THREE ?? null,
        window: win,
        sessionHandle: d.sessionHandle ?? win?.__sessionHandle ?? live.sessionHandle ?? null,
      });
      cameraOwner.own();
      return true;
    } catch (_) {
      cameraOwner = null;
      return false;
    }
  }

  function releaseCamera() {
    if (!cameraOwner) return;
    try { cameraOwner.release?.(); } catch (_) {}
    try { cameraOwner.dispose?.(); } catch (_) {}
    cameraOwner = null;
  }

  /**
   * Acquire ship helm input lock and camera ownership.
   * Refuses if disposed or another vehicle currently holds the player (unless opts.force).
   */
  function lock(opts = {}) {
    if (disposed) return { ok: false, reason: "disposed" };
    if (locked) return { ok: true, already: true, cameraOwned: Boolean(cameraOwner?.owned) };
    if (!opts.force && checkOtherOccupied()) {
      return { ok: false, reason: "other-vehicle-occupied" };
    }

    dropDrain();
    clearDown();
    savedFunnel = null;

    const f = d.funnel ?? win?.__inputFunnel ?? null;
    if (f && typeof f === "object") {
      const prevFault = readFault(f);
      if (prevFault !== "throw" && typeof f.releaseHeld === "function") {
        try { f.releaseHeld("ship"); } catch (_) {}
      }
      let didPoison = false;
      if (prevFault === null && typeof f.poison === "function") {
        try { f.poison("gate"); didPoison = true; } catch (_) {}
      }
      savedFunnel = { ref: f, didPoison };
    }

    const h = d.sessionHandle ?? win?.__sessionHandle ?? live?.sessionHandle ?? null;
    try {
      if (jumpChargePending(win, h)) cancelJumpCharge(win, h, doc);
      if (typeof win?.cancelJumpCharge === "function") win.cancelJumpCharge();
      if (typeof f?.cancelJumpCharge === "function") f.cancelJumpCharge();
    } catch (_) {}

    const cs = d.cameraSwitcher ?? live?.cameraSwitcher ?? win?.__cameraSwitcher ?? null;
    if (cs) {
      try { cs._endFollowDrag?.(); } catch (_) {}
      if (cs.keys && typeof cs.keys === "object") {
        for (const k of Object.keys(cs.keys)) cs.keys[k] = false;
      }
    }

    addListeners();
    const camOk = opts.skipCamera ? false : acquireCamera();
    if (fin(opts.initialHeading)) camRig.reset(opts.initialHeading);
    if (typeof opts.initialView === "string") camRig.setView(opts.initialView);

    locked = true;
    return { ok: true, already: false, funnel: Boolean(savedFunnel), listening, cameraOwned: camOk };
  }

  /**
   * Release ship helm lock, restore input funnel, drain held keys, and release camera ownership.
   */
  function restore() {
    if (!locked && !listening && !cameraOwner) {
      clearDown();
      return { ok: true, wasLocked: false };
    }
    removeListeners();
    startDrain();
    releaseCamera();

    const s = savedFunnel;
    if (s && s.didPoison && readFault(s.ref) === "gate" && typeof s.ref.unpoison === "function") {
      try { s.ref.unpoison(); } catch (_) {}
    }
    if (s && s.ref && typeof s.ref.releaseHeld === "function") {
      try { s.ref.releaseHeld("ship"); } catch (_) {}
    }
    savedFunnel = null;
    locked = false;
    freelookYaw = 0;
    freelookPitch = 0;
    bowThruster = 0;
    sternThruster = 0;
    override = null;
    return { ok: true, wasLocked: true };
  }

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0;
  }

  /**
   * Advance continuous helm inputs (rudder wheel, parallel/counter-pivot thrusters, freelook spring)
   * and return the normalized helm command packet for ship_kinematics.js.
   */
  function poll(dt = 1 / 60) {
    const t = fin(dt) ? clamp(dt, 0, 0.25) : 0;

    // Freelook spring-back when RMB is not held
    if (!rmbDown && t > 0 && (freelookYaw !== 0 || freelookPitch !== 0)) {
      const k = Math.exp(-t / FREELOOK_TAU);
      freelookYaw = Math.abs(freelookYaw * k) < 1e-4 ? 0 : freelookYaw * k;
      freelookPitch = Math.abs(freelookPitch * k) < 1e-4 ? 0 : freelookPitch * k;
    }

    if (override && override.until > nowMs()) {
      const a = override.input;
      if (fin(a.eotNotch)) eot = clamp(Math.round(a.eotNotch), -3, 3);
      else if (fin(a.eot)) eot = clamp(Math.round(a.eot), -3, 3);
      if (fin(a.rudder)) rudder = clamp(a.rudder, -1, 1);
      else if (fin(a.targetRudderRad)) rudder = clamp(a.targetRudderRad / SHIP_MAX_RUDDER_RAD, -1, 1);
      const ovBow = fin(a.bowThruster) ? clamp(a.bowThruster, -1, 1) : 0;
      const ovStern = fin(a.sternThruster) ? clamp(a.sternThruster, -1, 1) : 0;
      const ovThr = fin(a.throttle) ? clamp(a.throttle, -1, 1) : eotNotchToThrottle(eot);
      const rudRad = rudder * SHIP_MAX_RUDDER_RAD;
      return {
        eot,
        eotNotch: eot,
        throttle: ovThr,
        rudder,
        rudderRad: rudRad,
        targetRudderRad: rudRad,
        rudderAngleRad: rudRad,
        bowThruster: ovBow,
        sternThruster: ovStern,
        horn: Boolean(a.horn),
        selectedBerth,
        viewMode: camRig.getView(),
        freelook: { yaw: freelookYaw, pitch: freelookPitch },
      };
    }
    override = null;

    const shift = Boolean(down.ShiftLeft || down.ShiftRight);
    const aKey = Boolean(down.KeyA);
    const dKey = Boolean(down.KeyD);
    const qKey = Boolean(down.KeyQ);
    const eKey = Boolean(down.KeyE);

    // Rudder wheel (A = port -1, D = stbd +1; only when Shift is NOT held for counter-pivot)
    if (!shift && (aKey || dKey)) {
      const dir = (dKey ? 1 : 0) - (aKey ? 1 : 0);
      rudder = clamp(rudder + dir * RUDDER_RATE_PER_SEC * (t > 0 ? t : 1 / 60), -1, 1);
    }

    // Bow & Stern Thrusters:
    //   Q / E -> parallel lateral crabbing (-1 port / +1 stbd on BOTH bow & stern)
    //   Shift + A / D -> counter-pivot (bow -1/+1, stern +1/-1)
    let wantBow = 0;
    let wantStern = 0;
    if (qKey || eKey) {
      const crab = (eKey ? 1 : 0) - (qKey ? 1 : 0);
      wantBow += crab;
      wantStern += crab;
    }
    if (shift && (aKey || dKey)) {
      const piv = (dKey ? 1 : 0) - (aKey ? 1 : 0); // Shift+D rotates CW (+bow stbd, -stern port)
      wantBow += piv;
      wantStern -= piv;
    }
    wantBow = clamp(wantBow, -1, 1);
    wantStern = clamp(wantStern, -1, 1);

    const thrStep = THRUSTER_RATE_PER_SEC * (t > 0 ? t : 1 / 60);
    bowThruster += clamp(wantBow - bowThruster, -thrStep, thrStep);
    sternThruster += clamp(wantStern - sternThruster, -thrStep, thrStep);
    if (Math.abs(bowThruster) < 1e-4 && wantBow === 0) bowThruster = 0;
    if (Math.abs(sternThruster) < 1e-4 && wantStern === 0) sternThruster = 0;

    const rudRad = rudder * SHIP_MAX_RUDDER_RAD;
    return {
      eot,
      eotNotch: eot,
      throttle: eotNotchToThrottle(eot),
      rudder,
      rudderRad: rudRad,
      targetRudderRad: rudRad,
      rudderAngleRad: rudRad,
      bowThruster,
      sternThruster,
      horn: Boolean(down.KeyH),
      selectedBerth,
      viewMode: camRig.getView(),
      freelook: { yaw: freelookYaw, pitch: freelookPitch },
    };
  }

  /**
   * Step the 4-mode nautical camera rig and write it to createCameraOwner (respecting _camDebugParked).
   */
  function updateCamera(pose, dt = 1 / 60, berth = null) {
    const res = camRig.step({
      pose,
      dt,
      berth,
      controlsStatus: { freelook: { yaw: freelookYaw, pitch: freelookPitch } },
    });
    const cs = d.cameraSwitcher ?? live?.cameraSwitcher ?? null;
    if (cameraOwner?.owned && !cs?._camDebugParked) {
      try { cameraOwner.write(res.cam); } catch (_) {}
    }
    return res;
  }

  function setOverride(input, durationMs = 2000) {
    if (!input) {
      override = null;
      return;
    }
    override = {
      until: nowMs() + Math.max(50, fin(durationMs) ? durationMs : 2000),
      input: { ...input },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    restore();
    dropDrain();
    actionListeners.clear();
  }

  return {
    lock,
    engage: lock,
    restore,
    exit: restore,
    poll,
    updateCamera,
    setOverride,
    onAction(fn) {
      if (typeof fn !== "function") return () => {};
      actionListeners.add(fn);
      return () => actionListeners.delete(fn);
    },
    get locked() { return locked; },
    get disposed() { return disposed; },
    get cameraOwned() { return Boolean(cameraOwner?.owned); },
    get blockedEvents() { return blockedEvents; },
    get eot() { return eot; },
    setEot(n) { eot = clamp(Math.round(fin(n) ? n : 0), -3, 3); return eot; },
    get rudder() { return rudder; },
    setRudder(r) { rudder = clamp(fin(r) ? r : 0, -1, 1); return rudder; },
    get selectedBerth() { return selectedBerth; },
    setSelectedBerth(b) { if (b === "B1" || b === "B2") selectedBerth = b; return selectedBerth; },
    getViewMode: () => camRig.getView(),
    setViewMode: (m) => camRig.setView(m),
    cycleViewMode: () => camRig.cycleView(),
    getWingSide: () => camRig.getWingSide(),
    setWingSide: (s) => camRig.setWingSide(s),
    cameraRig: camRig,
    dispose,
  };
}
