// scene3d/drone/controls.js — Drone Deploy input: keyboard, pointer-locked mouse and
// gamepad → sticks, plus the input lock that keeps the client from also acting on
// them (scene3d/drone/SPEC.md §3.5, recipe §6.4).
//
// WHY: from the deploy click to idle the player's keys fly the drone, not the
// character. Movement keys reaching cmdInterp would send MoveToState (the cycle
// must send nothing), canvas clicks would Use objects, and key edges make camera.js
// re-issue Ready on the pilot (DV-3). So lock() takes, in order: the input funnel
// (synthetic releases of the keys it holds, then its ONE untagged fault slot set
// to "gate" — only when it was open, and never a bare poison(), which means
// "throw"), a held Space jump charge (releaseHeld skips Space: its release is
// DoJump), the follow camera's drag and keystate, and window CAPTURE listeners
// (window is first on the capture path, so they run before the funnel's
// document-capture handlers and every element / bubble listener) for the drone
// keys and for every pointer / mouse / wheel / touch / drop event on the canvas.
// restore() undoes exactly what lock() did: it un-poisons only a gate it set
// that still reads "gate", and drains the drone keys still physically held
// (their autorepeats and final keyup are swallowed; a fresh press hands the key
// back) so the funnel is never handed a press or a release it did not start.
// dispose() leaves a running drain alone: the cycle's teardown runs in the same
// tick as the T25 / abort restore, often with the key still held, and the
// drain's three window listeners remove themselves on that key's final keyup,
// a fresh press or blur.
//
// Never taken: Escape, Enter, F1–F12 (Shift+F11 reaches the manifest hotkey
// bridge), digits, Ctrl / Alt / Meta chords, any key while a text field has
// focus (chat keeps working), and Tab inside an open aria-modal dialog (its own
// focus cycling picks the answer Enter sends). Taken while locked: W/S A/D Q/E
// Space/C (sticks), Shift (boost), Tab / M / H / R (actions) — incl. KeyC
// (camera-mode toggle) and KeyM (World Map, a window-bubble listener outside
// the funnel), DV-5.
//
// Drone Deploy is DEFAULT ON since 2026-10-25 (`?drone=off`, exact match, disables it). Page module: every
// dependency is injected ({window, document, navigator, canvas, funnel,
// cameraSwitcher, settings}); the funnel is resolved at lock() time; no timers.

import { cancelJumpCharge, jumpChargePending } from "../../ui/escape_action.js";

/**
 * Keyboard axes: `code → [stick, sign]` (§3.3 Sticks: +pitch forward, +roll right,
 * +yaw right, +throttle up).
 * @type {Readonly<Record<string, ReadonlyArray<string|number>>>}
 */
export const DRONE_KEY_AXES = Object.freeze({
  KeyW: Object.freeze(["pitch", 1]),
  KeyS: Object.freeze(["pitch", -1]),
  KeyD: Object.freeze(["roll", 1]),
  KeyA: Object.freeze(["roll", -1]),
  KeyE: Object.freeze(["yaw", 1]),
  KeyQ: Object.freeze(["yaw", -1]),
  Space: Object.freeze(["throttle", 1]),
  KeyC: Object.freeze(["throttle", -1]),
});

/**
 * Keyboard actions (press edges only): `code → DRONE_ACTIONS entry`.
 * @type {Readonly<Record<string, string>>}
 */
export const DRONE_KEY_ACTIONS = Object.freeze({ Tab: "pilotView", KeyM: "mode", KeyH: "hideHud", KeyR: "returnHome" });

/** Boost keys (cine only; the craft ignores boost elsewhere). @type {ReadonlyArray<string>} */
export const DRONE_BOOST_CODES = Object.freeze(["ShiftLeft", "ShiftRight"]);

/** Every key code the lock takes: axes + actions + boost. @type {ReadonlyArray<string>} */
export const DRONE_KEY_CODES = Object.freeze([
  ...Object.keys(DRONE_KEY_AXES),
  ...Object.keys(DRONE_KEY_ACTIONS),
  ...DRONE_BOOST_CODES,
]);

/** Action types `onAction` listeners receive. @type {ReadonlyArray<string>} */
export const DRONE_ACTIONS = Object.freeze(["pilotView", "mode", "hideHud", "returnHome", "recall"]);

/** Key events taken at window capture while locked. @type {ReadonlyArray<string>} */
export const KEY_EVENTS = Object.freeze(["keydown", "keyup", "keypress"]);

/**
 * Pointer events taken at window capture while locked (canvas targets, or any
 * target while pointer-locked). `wheel` / `touch*` are registered
 * `{capture: true, passive: false}` so preventDefault works.
 * @type {ReadonlyArray<string>}
 */
export const POINTER_EVENTS = Object.freeze([
  "pointerdown", "pointerup", "pointermove", "pointercancel",
  "mousedown", "mouseup", "mousemove",
  "click", "dblclick", "auxclick", "contextmenu", "wheel",
  "touchstart", "touchmove", "touchend", "touchcancel",
  "dragover", "drop",
]);

/** Phases set by the sequence's `controlsPhase` action. @type {ReadonlyArray<string>} */
export const CONTROL_PHASES = Object.freeze(["deploy", "fly", "pilot", "stow"]);

/** Gamepad stick deadzone (|v| ≤ this reads 0). */
export const GAMEPAD_DEADZONE = 0.08;
/** Gamepad stick expo: `(1 − expo)·n + expo·n³`. */
export const GAMEPAD_EXPO = 0.3;
/** Gamepad B held this long requests `recall` (once per hold). */
export const RECALL_HOLD_MS = 800;
/** Pointer-locked mouse X → yaw (radians per px at sensitivity 1). */
export const LOOK_YAW_RAD_PER_PX = 0.0025;
/** Pointer-locked mouse Y → tilt (radians per px at sensitivity 1). */
export const LOOK_PITCH_RAD_PER_PX = 0.0020;
/** A pointermove with |movementX| or |movementY| above this is a spike and is dropped. */
export const LOOK_MAX_PX_PER_EVENT = 300;

/** Standard-mapping gamepad button indices. @type {Readonly<Record<string, number>>} */
export const PAD = Object.freeze({ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9 });

// INPUT types that do not take typed text (a focused checkbox must not park the sticks).
const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

// Flat tables for the allocation-free poll.
const AXIS_CODES = Object.freeze(Object.keys(DRONE_KEY_AXES));
const AXIS_STICK = Object.freeze(AXIS_CODES.map((c) => DRONE_KEY_AXES[c][0]));
const AXIS_SIGN = Object.freeze(AXIS_CODES.map((c) => DRONE_KEY_AXES[c][1]));
const DRONE_CODE_SET = new Set(DRONE_KEY_CODES);

const CAPTURE = Object.freeze({ capture: true });
const CAPTURE_ACTIVE = Object.freeze({ capture: true, passive: false });
const BUBBLE = Object.freeze({ capture: false });
const listenerOpts = (type) => (type === "wheel" || type.startsWith("touch") ? CAPTURE_ACTIVE : CAPTURE);

// One frozen event object per (source, type): action emission allocates nothing.
const ACTION_EVENT = Object.freeze({
  keyboard: Object.freeze(Object.fromEntries(DRONE_ACTIONS.map((t) => [t, Object.freeze({ type: t, source: "keyboard" })]))),
  gamepad: Object.freeze(Object.fromEntries(DRONE_ACTIONS.map((t) => [t, Object.freeze({ type: t, source: "gamepad" })]))),
});

/**
 * True when `el` takes typed text: TEXTAREA, contentEditable, or an INPUT whose
 * type is not button / checkbox / color / file / image / radio / range / reset /
 * submit. A SELECT takes no typed text: a settings `<select>` left focused would
 * otherwise turn the drone keys into type-ahead that changes the setting
 * mid-flight (arrows / Enter / Esc are not drone keys and still reach it).
 * @param {*} el
 * @returns {boolean}
 */
export function takesText(el) {
  if (!el || typeof el !== "object") return false;
  try {
    if (el.isContentEditable === true || el.contentEditable === "true" || el.contentEditable === "plaintext-only") return true;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    let type = el.type;
    if (typeof type !== "string" || type === "") type = typeof el.getAttribute === "function" ? el.getAttribute("type") : null;
    type = typeof type === "string" && type !== "" ? type.toLowerCase() : "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  } catch (_) {
    return false;
  }
}

/**
 * True when a text field owns this keystroke: `ev.target` takes text, or the
 * connected `doc.activeElement` does (a detached activeElement is ignored — a
 * torn-down panel input can never receive the key).
 * @param {*} ev
 * @param {*} doc
 * @returns {boolean}
 */
export function isTypingTarget(ev, doc) {
  if (takesText(ev ? ev.target : null)) return true;
  try {
    const el = doc ? doc.activeElement : null;
    if (!el || el.isConnected === false) return false;
    return takesText(el);
  } catch (_) {
    return false;
  }
}

const MODAL_SELECTOR = '[aria-modal="true"]';

function insideModal(el) {
  try {
    return !!(el && typeof el.closest === "function" && el.closest(MODAL_SELECTOR));
  } catch (_) {
    return false;
  }
}

// True when `ev.target`, or the connected `doc.activeElement`, sits inside an
// open `[aria-modal="true"]` dialog (plugins/modal-dialog.js, salvage-confirm.js
// focus OK on open; a closed one is display: none and holds no focus).
function inOpenModal(ev, doc) {
  if (insideModal(ev ? ev.target : null)) return true;
  try {
    const el = doc ? doc.activeElement : null;
    return !!el && el.isConnected !== false && insideModal(el);
  } catch (_) {
    return false;
  }
}

/**
 * Gamepad axis shaping: 0 inside the deadzone, rescaled to [0, 1] beyond it,
 * then `(1 − expo)·n + expo·n³`; sign kept; non-finite → 0. `shapeAxis(0.5) = 0.3481`.
 * @param {number} v
 * @param {number} [deadzone=0.08]
 * @param {number} [expo=0.3]
 * @returns {number} in [−1, 1]
 */
export function shapeAxis(v, deadzone = GAMEPAD_DEADZONE, expo = GAMEPAD_EXPO) {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  const dz = Number.isFinite(deadzone) ? Math.min(Math.max(deadzone, 0), 0.99) : GAMEPAD_DEADZONE;
  const e = Number.isFinite(expo) ? Math.min(Math.max(expo, 0), 1) : GAMEPAD_EXPO;
  const a = Math.min(Math.abs(x), 1);
  if (a <= dz) return 0;
  const n = (a - dz) / (1 - dz);
  const y = (1 - e) * n + e * n * n * n;
  return x < 0 ? -y : y;
}

const clamp1 = (x) => (x > 1 ? 1 : x < -1 ? -1 : x + 0); // `+ 0` turns −0 into 0

function btnPressed(buttons, i) {
  const b = buttons ? buttons[i] : null;
  if (b === null || b === undefined) return false;
  if (typeof b === "object") return b.pressed === true;
  return Number(b) > 0.5;
}

function btnValue(buttons, i) {
  const b = buttons ? buttons[i] : null;
  if (b === null || b === undefined) return 0;
  const v = typeof b === "object" ? (Number.isFinite(b.value) ? b.value : b.pressed === true ? 1 : 0) : Number(b);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Create the drone controls (SPEC §3.5). Never throws; missing deps make the
 * matching lock steps report `{ok: false, skipped}`. `dispose()` returns the
 * `restore()` result and drops every action listener; a restore drain still
 * running keeps its (at most 3) window listeners until it ends by itself.
 *
 * @param {{window?: object|null, document?: object|null, navigator?: object|null,
 *   canvas?: object|null, funnel?: object|null, cameraSwitcher?: object|null,
 *   settings?: () => ({sensitivity?: number, invertY?: boolean, gamepadLayout?: string}|null)}} [deps]
 *   `canvas` defaults to `cameraSwitcher.domElement`; `funnel` is resolved at
 *   `lock()` time as `deps.funnel ?? window.__inputFunnel`.
 * @returns {{
 *   lock: () => {ok: boolean, already: boolean, steps: object},
 *   restore: () => {ok: boolean, wasLocked: boolean, steps: object},
 *   setPhase: (phase: string) => string|null,
 *   poll: (dt: number) => {throttle: number, yaw: number, pitch: number, roll: number, gimbal: number,
 *     boost: number, lookX: number, lookY: number, zoom: number},
 *   onAction: (fn: (a: {type: string, source: string}) => void) => () => void,
 *   readonly locked: boolean, readonly pointerLocked: boolean, readonly phase: string|null,
 *   status: () => object, dispose: () => object}}
 */
export function createControls(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const doc = d.document !== undefined
    ? d.document
    : (win && win.document) || (typeof document !== "undefined" ? document : null);
  const nav = d.navigator !== undefined
    ? d.navigator
    : (win && win.navigator) || (typeof navigator !== "undefined" ? navigator : null);
  const cs = d.cameraSwitcher && typeof d.cameraSwitcher === "object" ? d.cameraSwitcher : null;
  const readSettings = () => {
    if (typeof d.settings !== "function") return null;
    try {
      const s = d.settings();
      return s && typeof s === "object" ? s : null;
    } catch (_) {
      return null;
    }
  };

  let locked = false;
  let disposed = false;
  /** @type {string|null} */
  let phase = null;
  let pointerLocked = false;
  let listening = false;
  /** @type {object|null} canvas resolved at lock() */
  let canvas = null;
  /** @type {null|{funnel: null|{ref: object, prevFault: string|null, didPoison: boolean}}} */
  let saved = null;

  // Drone codes physically down as the lock saw them (fixed keys: allocation-free reads).
  const down = Object.create(null);
  for (const c of DRONE_KEY_CODES) down[c] = false;
  const clearDown = () => { for (const c of DRONE_KEY_CODES) down[c] = false; };

  // Look / zoom accumulators (raw px and notches; scaled at poll).
  let lookPxX = 0;
  let lookPxY = 0;
  let zoomNotches = 0;
  const zeroLook = () => { lookPxX = 0; lookPxY = 0; zoomNotches = 0; };
  // 'pilot': a right-button drag on the canvas in progress (camera.js orbit).
  let pilotDrag = false;

  // Gamepad edge state.
  let padSeen = false;
  let padPrimed = false;
  let prevY = false;
  let prevView = false;
  let prevA = false;
  let prevB = false;
  let bHoldSec = 0;
  let bFired = false;
  let edgeMode = false;
  let edgeView = false;
  let edgeHome = false;
  let edgeRecall = false;
  const resetPad = () => {
    padPrimed = false;
    prevY = prevView = prevA = prevB = false;
    bHoldSec = 0;
    bFired = false;
  };

  /** @type {null|"keyboard"|"gamepad"} */
  let source = null;
  let blockedCount = 0;
  let actionCount = 0;
  let lockRequests = 0;
  let lockErrors = 0;
  let drainedCount = 0;

  // The restore-time drain: codes still physically down when the lock ended.
  const drainCodes = new Set();
  let drainListening = false;

  const actionFns = new Set();
  const sticks = { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 };
  const zeroSticks = () => {
    sticks.throttle = 0; sticks.yaw = 0; sticks.pitch = 0; sticks.roll = 0; sticks.gimbal = 0;
    sticks.boost = 0; sticks.lookX = 0; sticks.lookY = 0; sticks.zoom = 0;
  };

  const readFault = (f) => {
    if (typeof f.snapshot === "function") {
      const s = f.snapshot();
      return s && s.fault !== undefined && s.fault !== null ? s.fault : null;
    }
    return f._fault ?? null;
  };
  const funnelOf = () => {
    if (saved && saved.funnel && saved.funnel.ref) return saved.funnel.ref;
    const f = d.funnel !== undefined && d.funnel !== null ? d.funnel : (win ? win.__inputFunnel : null);
    return f && typeof f === "object" ? f : null;
  };

  /** Run one lock / restore step; a throw is recorded and the other steps still run. */
  function attempt(steps, name, fn) {
    try {
      const r = fn();
      steps[name] = r === undefined ? true : r;
    } catch (e) {
      steps[name] = { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  /** The blocker (film clean_frame's): stop, then prevent when cancelable. */
  function block(ev) {
    blockedCount += 1;
    try {
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      else if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    } catch (_) {
      /* a frozen event */
    }
    try {
      if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
    } catch (_) {
      /* passive listener */
    }
  }

  /** Stop without preventing (dragover: a prevented dragover means "drop allowed"). */
  function stopOnly(ev) {
    blockedCount += 1;
    try {
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      else if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    } catch (_) {
      /* a frozen event */
    }
  }

  function emitAction(type, src) {
    const evt = ACTION_EVENT[src][type];
    actionCount += 1;
    if (actionFns.size === 0) return;
    for (const fn of [...actionFns]) {
      try {
        fn(evt);
      } catch (_) {
        /* a throwing listener never breaks input */
      }
    }
  }

  // ---- window / document listeners (installed by lock) ----------------------

  function onKey(ev) {
    if (!ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!DRONE_CODE_SET.has(code)) return; // Escape, Enter, F-keys, digits…: the client's
    const typing = isTypingTarget(ev, doc);
    if (ev.type === "keyup") {
      down[code] = false; // tracking follows the key even while typing
      if (typing) return;
      block(ev); // never hand the funnel a release it did not start
      return;
    }
    if (typing) return;
    if (ev.ctrlKey === true || ev.altKey === true || ev.metaKey === true) return;
    // A server confirmation: Tab moves between OK / Cancel, and Enter answers the
    // focused one. Space stays ours there, so a held climb never presses OK.
    if (code === "Tab" && inOpenModal(ev, doc)) return;
    block(ev);
    if (ev.type !== "keydown") return;
    source = "keyboard";
    const wasDown = down[code];
    down[code] = true;
    if (!wasDown && ev.repeat !== true) {
      const act = DRONE_KEY_ACTIONS[code];
      if (act !== undefined) emitAction(act, "keyboard");
    }
  }

  function accumulateLook(ev) {
    const mx = Number(ev.movementX);
    const my = Number(ev.movementY);
    const x = Number.isFinite(mx) ? mx : 0;
    const y = Number.isFinite(my) ? my : 0;
    if (Math.abs(x) > LOOK_MAX_PX_PER_EVENT || Math.abs(y) > LOOK_MAX_PX_PER_EVENT) return; // spike
    lookPxX += x;
    lookPxY += y;
    if (x !== 0 || y !== 0) source = "keyboard";
  }

  function onLockRejected() {
    lockErrors += 1;
  }

  // The request's promise resolved: a grant that lands after restore() has
  // removed the pointerlockchange listener (a hard abort or the stow right
  // after the click), or outside 'fly', is given back at once.
  function onLockGranted() {
    if (!locked || phase !== "fly") exitOurPointerLock();
  }

  function requestLock() {
    const cv = canvas;
    if (!cv || typeof cv.requestPointerLock !== "function") return;
    try {
      const ae = doc ? doc.activeElement : null;
      if (ae && ae !== doc.body && typeof ae.blur === "function") ae.blur();
    } catch (_) {
      /* focus is cosmetic here */
    }
    lockRequests += 1;
    try {
      const p = cv.requestPointerLock();
      if (p && typeof p.then === "function") p.then(onLockGranted, onLockRejected);
    } catch (_) {
      lockErrors += 1;
    }
  }

  /** 'pilot': the follow camera's right-button press / drag / contextmenu pass through. */
  function pilotPassThrough(ev, onCanvas) {
    const t = ev.type;
    if ((t === "pointerdown" || t === "mousedown") && ev.button === 2 && onCanvas) {
      pilotDrag = true;
      return true;
    }
    if (t === "contextmenu" && onCanvas) return true; // camera.js prevents the menu itself
    if (!pilotDrag) return false;
    if (t === "pointermove" || t === "mousemove") {
      // A move with the right button up: the release was lost; camera.js self-heals on it.
      if (t === "mousemove" && typeof ev.buttons === "number" && (ev.buttons & 2) === 0) pilotDrag = false;
      return true;
    }
    // pointerup comes first; camera.js listens to the mouseup, which onPointer ends.
    if (t === "pointerup" && ev.button === 2) return true;
    if (t === "pointercancel") {
      pilotDrag = false;
      return true;
    }
    return false;
  }

  function onPointer(ev) {
    if (!ev) return;
    // 'pilot': the right release of the orbit drag, on the canvas or over the HUD.
    // camera.js would open the client context menu (Use / Examine / Give) on a
    // short one; ending its drag first clears its pick, and the mouseup still
    // reaches camera.js to end the drag as usual.
    if (phase === "pilot" && pilotDrag && ev.type === "mouseup" && ev.button === 2) {
      endPilotDrag();
      return;
    }
    const onCanvas = canvas !== null && ev.target === canvas;
    if (!onCanvas && !pointerLocked) return; // HUD clicks, chat, panels: not ours
    if (phase === "pilot" && pilotPassThrough(ev, onCanvas)) return;
    const t = ev.type;
    if (phase === "fly") {
      if (t === "pointermove") {
        if (pointerLocked) accumulateLook(ev);
      } else if (t === "wheel") {
        const dy = Number(ev.deltaY);
        if (Number.isFinite(dy) && dy !== 0) {
          zoomNotches += dy > 0 ? 1 : -1;
          source = "keyboard";
        }
      } else if (t === "pointerdown" && ev.button === 0 && !pointerLocked && onCanvas) {
        requestLock();
      }
    }
    if (t === "dragover") {
      stopOnly(ev);
      return;
    }
    block(ev);
  }

  function onBlur() {
    clearDown();
    zeroLook();
    pilotDrag = false;
  }

  function onVisibility() {
    if (doc && doc.visibilityState === "hidden") onBlur();
  }

  function onLockChange() {
    const el = doc ? doc.pointerLockElement : null;
    if (el && el === canvas) {
      // A grant that lands after the phase left 'fly' (Tab or a recall right
      // after the click): pilot view and the stow keep the cursor free.
      if (phase !== "fly") {
        exitOurPointerLock();
        return;
      }
      pointerLocked = true;
      return;
    }
    // Lost (Esc, focus loss, the browser): look stops, keys / gamepad keep flying.
    pointerLocked = false;
    lookPxX = 0;
    lookPxY = 0;
  }

  function onLockError() {
    lockErrors += 1;
  }

  function addListeners() {
    for (const t of KEY_EVENTS) win.addEventListener(t, onKey, CAPTURE);
    for (const t of POINTER_EVENTS) win.addEventListener(t, onPointer, listenerOpts(t));
    win.addEventListener("blur", onBlur, BUBBLE);
    if (doc && typeof doc.addEventListener === "function") {
      doc.addEventListener("visibilitychange", onVisibility, BUBBLE);
      doc.addEventListener("pointerlockchange", onLockChange, BUBBLE);
      doc.addEventListener("pointerlockerror", onLockError, BUBBLE);
    }
    listening = true;
  }

  function removeListeners() {
    if (!listening) return;
    listening = false;
    for (const t of KEY_EVENTS) { try { win.removeEventListener(t, onKey, CAPTURE); } catch (_) {} }
    for (const t of POINTER_EVENTS) { try { win.removeEventListener(t, onPointer, listenerOpts(t)); } catch (_) {} }
    try { win.removeEventListener("blur", onBlur, BUBBLE); } catch (_) {}
    if (doc && typeof doc.removeEventListener === "function") {
      try { doc.removeEventListener("visibilitychange", onVisibility, BUBBLE); } catch (_) {}
      try { doc.removeEventListener("pointerlockchange", onLockChange, BUBBLE); } catch (_) {}
      try { doc.removeEventListener("pointerlockerror", onLockError, BUBBLE); } catch (_) {}
    }
  }

  // ---- the restore-time drain ------------------------------------------------

  function onDrainKey(ev) {
    if (!ev) return;
    const code = typeof ev.code === "string" ? ev.code : "";
    if (!drainCodes.has(code)) return;
    if (ev.type === "keyup") {
      drainCodes.delete(code); // the final release: swallowed, the key is the client's again
      drainedCount += 1;
      block(ev);
    } else if (ev.repeat === true) {
      drainedCount += 1; // an autorepeat of a key the funnel never saw pressed
      block(ev);
    } else {
      drainCodes.delete(code); // a fresh press: hand the key back (the funnel sees it)
    }
    if (drainCodes.size === 0) dropDrain();
  }

  function onDrainBlur() {
    dropDrain(); // the release may happen unseen; the funnel's ledger forgets on blur too
  }

  function startDrain() {
    for (const c of DRONE_KEY_CODES) if (down[c]) drainCodes.add(c);
    clearDown();
    if (drainCodes.size === 0 || !win || typeof win.addEventListener !== "function") {
      drainCodes.clear();
      return { ok: true, keys: [] };
    }
    win.addEventListener("keydown", onDrainKey, CAPTURE);
    win.addEventListener("keyup", onDrainKey, CAPTURE);
    win.addEventListener("blur", onDrainBlur, BUBBLE);
    drainListening = true;
    return { ok: true, keys: [...drainCodes] };
  }

  function dropDrain() {
    drainCodes.clear();
    if (!drainListening) return;
    drainListening = false;
    try { win.removeEventListener("keydown", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("keyup", onDrainKey, CAPTURE); } catch (_) {}
    try { win.removeEventListener("blur", onDrainBlur, BUBBLE); } catch (_) {}
  }

  /**
   * End camera.js's follow drag: at the drag's own right release (no context
   * menu), and on leaving 'pilot' mid right-drag (its mouseup will be blocked).
   */
  function endPilotDrag() {
    if (!pilotDrag) return;
    pilotDrag = false;
    try {
      if (cs && typeof cs._endFollowDrag === "function") cs._endFollowDrag();
    } catch (_) {
      /* camera.js self-heals on the next move with the button up */
    }
  }

  function exitOurPointerLock() {
    let exited = false;
    try {
      if (doc && canvas && doc.pointerLockElement === canvas && typeof doc.exitPointerLock === "function") {
        doc.exitPointerLock();
        exited = true;
      }
    } catch (_) {
      /* the browser already dropped it */
    }
    pointerLocked = false;
    lookPxX = 0;
    lookPxY = 0;
    return exited;
  }

  // ---- public ----------------------------------------------------------------

  function lock() {
    if (disposed) return { ok: false, already: false, steps: { disposed: { ok: false, skipped: "disposed" } } };
    if (locked) return { ok: true, already: true, steps: {} };
    const steps = {};
    saved = { funnel: null };
    canvas = d.canvas ?? (cs ? cs.domElement ?? null : null) ?? null;
    dropDrain(); // a new lock owns every key again
    clearDown();
    zeroLook();
    resetPad();
    pilotDrag = false;
    pointerLocked = false;

    // 1. The funnel: synthetic releases (not Space), then the gate — only from open.
    attempt(steps, "funnel", () => {
      const f = d.funnel !== undefined && d.funnel !== null ? d.funnel : (win ? win.__inputFunnel : null);
      if (!f || typeof f !== "object") return { ok: false, skipped: "no input funnel" };
      const prevFault = readFault(f);
      let released = 0;
      if (prevFault !== "throw" && typeof f.releaseHeld === "function") {
        const r = f.releaseHeld("drone");
        released = Array.isArray(r) ? r.length : 0;
      }
      let didPoison = false;
      if (prevFault === null && typeof f.poison === "function") {
        f.poison("gate");
        didPoison = true;
      }
      saved.funnel = { ref: f, prevFault, didPoison };
      return { ok: true, prevFault, released, poisoned: didPoison, installed: f.installed === true };
    });

    // 2. A held Space charge (releaseHeld skips Space; our blockers eat its keyup). Local; sends nothing.
    attempt(steps, "jumpCharge", () => {
      if (!win) return { ok: false, skipped: "no window" };
      const h = win.__sessionHandle ?? null;
      if (!jumpChargePending(win, h)) return { ok: true, pending: false };
      return { ok: true, pending: true, cancelled: cancelJumpCharge(win, h, doc) };
    });

    // 3. Camera input: end a held right-drag, zero the keystate.
    attempt(steps, "cameraInput", () => {
      if (!cs) return { ok: false, skipped: "no cameraSwitcher" };
      if (typeof cs._endFollowDrag === "function") cs._endFollowDrag();
      if (cs.keys && typeof cs.keys === "object") for (const k of Object.keys(cs.keys)) cs.keys[k] = false;
      return true;
    });

    // 4. Window capture listeners (+ blur / visibility / pointer-lock state).
    attempt(steps, "listeners", () => {
      if (!win || typeof win.addEventListener !== "function") return { ok: false, skipped: "no window" };
      addListeners();
      return { ok: true, events: KEY_EVENTS.length + POINTER_EVENTS.length, canvas: canvas !== null };
    });

    locked = true;
    return { ok: true, already: false, steps };
  }

  function restore() {
    if (!locked) return { ok: true, wasLocked: false, steps: {} };
    const s = saved || { funnel: null };
    const steps = {};
    attempt(steps, "pointerLock", () => ({ ok: true, exited: exitOurPointerLock() }));
    attempt(steps, "listeners", () => {
      const had = listening;
      removeListeners();
      return { ok: true, removed: had };
    });
    attempt(steps, "drain", () => startDrain());
    attempt(steps, "funnel", () => {
      const f = s.funnel;
      if (!f || !f.ref) return { ok: true, skipped: "no funnel was locked" };
      if (!f.didPoison) return { ok: true, unpoisoned: false, prevFault: f.prevFault };
      if (readFault(f.ref) === "gate" && typeof f.ref.unpoison === "function") {
        f.ref.unpoison();
        return { ok: true, unpoisoned: true };
      }
      return { ok: true, unpoisoned: false, changedBy: "someone else" };
    });
    locked = false;
    phase = null;
    pilotDrag = false; // the drag's own release reaches camera.js now (listeners are gone)
    zeroLook();
    zeroSticks();
    resetPad();
    saved = null;
    return { ok: true, wasLocked: true, steps };
  }

  function setPhase(p) {
    if (typeof p !== "string" || !CONTROL_PHASES.includes(p)) return phase;
    if (p === phase) return phase;
    phase = p;
    if (p !== "fly") {
      zeroLook();
      exitOurPointerLock(); // 'pilot' / 'stow': the mouse is the follow camera's again
    }
    if (p !== "pilot") endPilotDrag();
    return phase;
  }

  function readPad() {
    if (!nav || typeof nav.getGamepads !== "function") return null;
    let list = null;
    try {
      list = nav.getGamepads();
    } catch (_) {
      list = null;
    }
    if (!list) return null;
    const n = list.length >>> 0;
    for (let i = 0; i < n; i++) {
      const g = list[i];
      if (g && g.connected !== false && g.mapping === "standard" && g.axes && g.buttons) return g;
    }
    return null;
  }

  function poll(dt) {
    const s = sticks;
    if (!locked) {
      zeroSticks();
      return s;
    }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    let pitch = 0;
    let roll = 0;
    let yaw = 0;
    let throttle = 0;
    let gimbal = 0;
    for (let i = 0; i < AXIS_CODES.length; i++) {
      if (!down[AXIS_CODES[i]]) continue;
      const st = AXIS_STICK[i];
      const sg = AXIS_SIGN[i];
      if (st === "pitch") pitch += sg;
      else if (st === "roll") roll += sg;
      else if (st === "yaw") yaw += sg;
      else throttle += sg;
    }
    let boost = down.ShiftLeft || down.ShiftRight ? 1 : 0;
    const settings = readSettings();
    const mode1 = settings !== null && settings.gamepadLayout === "mode1";

    edgeMode = edgeView = edgeHome = edgeRecall = false;
    const g = readPad();
    padSeen = g !== null;
    if (g) {
      const ax = g.axes;
      const bt = g.buttons;
      const lx = shapeAxis(ax[0]);
      const ly = shapeAxis(ax[1]);
      const rx = shapeAxis(ax[2]);
      const ry = shapeAxis(ax[3]);
      yaw += lx;
      roll += rx;
      if (mode1) {
        pitch -= ly; // left Y forward
        throttle -= ry; // right Y up
      } else {
        throttle -= ly; // mode 2: left Y up
        pitch -= ry; // right Y forward
      }
      const trig = shapeAxis(btnValue(bt, PAD.RT) - btnValue(bt, PAD.LT));
      gimbal += trig;
      const rb = btnPressed(bt, PAD.RB);
      if (rb) boost = 1;
      const y = btnPressed(bt, PAD.Y);
      const view = btnPressed(bt, PAD.VIEW);
      const a = btnPressed(bt, PAD.A);
      const b = btnPressed(bt, PAD.B);
      if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || trig !== 0 || rb || y || view || a || b) source = "gamepad";
      if (!padPrimed) {
        // First read after the lock: a button already held is not a press.
        padPrimed = true;
        prevY = y;
        prevView = view;
        prevA = a;
        prevB = b;
        bHoldSec = 0;
        bFired = b;
      } else {
        if (y && !prevY) edgeMode = true;
        if (view && !prevView) edgeView = true;
        if (a && !prevA) edgeHome = true;
        if (b) {
          if (!prevB) {
            bHoldSec = 0;
            bFired = false;
          } else {
            bHoldSec += step;
          }
          if (!bFired && bHoldSec >= RECALL_HOLD_MS / 1000 - 1e-9) {
            bFired = true;
            edgeRecall = true;
          }
        } else {
          bHoldSec = 0;
          bFired = false;
        }
        prevY = y;
        prevView = view;
        prevA = a;
        prevB = b;
      }
    } else if (padPrimed) {
      resetPad(); // the pad went away: its next appearance primes again
    }

    s.pitch = clamp1(pitch);
    s.roll = clamp1(roll);
    s.yaw = clamp1(yaw);
    s.throttle = clamp1(throttle);
    s.gimbal = clamp1(gimbal);
    s.boost = boost;
    if (phase === "fly" && pointerLocked) {
      const sens = settings !== null && Number.isFinite(settings.sensitivity) && settings.sensitivity > 0 ? settings.sensitivity : 1;
      const inv = settings !== null && settings.invertY === true ? -1 : 1;
      s.lookX = lookPxX * LOOK_YAW_RAD_PER_PX * sens + 0;
      s.lookY = -lookPxY * LOOK_PITCH_RAD_PER_PX * sens * inv + 0;
    } else {
      s.lookX = 0;
      s.lookY = 0;
    }
    s.zoom = phase === "fly" ? zoomNotches : 0;
    lookPxX = 0;
    lookPxY = 0;
    zoomNotches = 0;

    // Pad edges after the sticks are complete (a listener may run a synchronous request).
    if (edgeMode) emitAction("mode", "gamepad");
    if (edgeView) emitAction("pilotView", "gamepad");
    if (edgeHome) emitAction("returnHome", "gamepad");
    if (edgeRecall) emitAction("recall", "gamepad");
    if (!locked) zeroSticks(); // a listener restored the input
    return s;
  }

  function onAction(fn) {
    if (typeof fn !== "function" || disposed) return () => {};
    actionFns.add(fn);
    return () => {
      actionFns.delete(fn);
    };
  }

  function status() {
    const held = [];
    if (locked) {
      for (const c of DRONE_KEY_CODES) if (down[c]) held.push(c);
    } else {
      for (const c of drainCodes) held.push(c);
    }
    const f = funnelOf();
    return {
      locked,
      phase,
      pointerLocked,
      draining: drainCodes.size > 0,
      source,
      gamepad: padSeen,
      held,
      blocked: blockedCount,
      actions: actionCount,
      lockRequests,
      lockErrors,
      drained: drainedCount,
      funnelInstalled: f !== null && f.installed === true,
    };
  }

  function dispose() {
    // A running restore drain is left alone: teardown follows the T25 / abort
    // restore in the same tick, and a key held through it must not hand the
    // reopened funnel its autorepeats and an unpaired release (one MoveToState).
    // The drain removes its own listeners (final keyup, fresh press, blur).
    const r = restore();
    actionFns.clear();
    disposed = true;
    return r;
  }

  return {
    lock,
    restore,
    setPhase,
    poll,
    onAction,
    status,
    dispose,
    get locked() {
      return locked;
    },
    get pointerLocked() {
      return pointerLocked;
    },
    get phase() {
      return phase;
    },
  };
}
