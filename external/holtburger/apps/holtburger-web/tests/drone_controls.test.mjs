// tests/drone_controls.test.mjs
//
// WHY (2026-10-24). Drone Deploy (scene3d/drone/SPEC.md, `?drone=on`, DEFAULT
// OFF) hands the player's keyboard, mouse and gamepad to the drone from the
// deploy click to idle. scene3d/drone/controls.js must (SPEC §3.5, recipe §6.4):
// map W/S A/D Q/E Space/C Shift to sticks and Tab/M/H/R to actions; leave
// Escape, Enter, F-keys (Shift+F11 = the manifest hotkey), digits, Ctrl/Alt/Meta
// chords and every key typed into a text field to the client; take the funnel
// exactly once (releaseHeld('drone') then poison('gate') only from open, never
// a bare poison()) and give back only the gate it set; block every canvas
// pointer / mouse / wheel / touch / drop event (dragover stopped, never
// prevented); request pointer lock only in the 'fly' phase and give back a
// grant that lands after restore(); let the follow camera's right-button drag
// through in 'pilot' but end it at its release (no client context menu); pass
// Tab inside an open aria-modal dialog; treat a focused SELECT as no text field
// (no type-ahead); shape and map the gamepad (mode 2 / mode 1, edges, hold-B
// recall); drain the keys still held at restore, also across dispose() (the
// drain removes itself); and leave no other listener behind. This suite
// EXECUTES the real module against fake window / document / funnel / camera
// switcher / navigator objects that count every listener by target, type and
// capture flag.
//
// Run from apps/holtburger-web/: node tests/drone_controls.test.mjs

import assert from "node:assert/strict";

const C = await import("../scene3d/drone/controls.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);

const unhandled = [];
process.on("unhandledRejection", (r) => { unhandled.push(r); });

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeFunnel(fault = null, installed = true) {
  const calls = [];
  return {
    _fault: fault,
    installed,
    calls,
    releaseHeld(reason) { calls.push(["releaseHeld", reason]); return ["w"]; },
    poison(mode = "throw") { calls.push(["poison", mode]); this._fault = mode === "gate" ? "gate" : "throw"; return this._fault; },
    unpoison() { calls.push(["unpoison"]); this._fault = null; return true; },
    snapshot() { return { fault: this._fault, installed: this.installed }; },
  };
}

function makePad() {
  return {
    id: "fake pad",
    connected: true,
    mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}
const press = (pad, i, on = true, value = undefined) => {
  pad.buttons[i] = { pressed: on, value: value ?? (on ? 1 : 0) };
};

function makeEnv({ fault = null, installed = true, funnelOnWindow = true, withFunnelDep = false } = {}) {
  const listeners = [];
  const capOf = (o) => (typeof o === "boolean" ? o : !!(o && o.capture));
  const target = (name) => ({
    addEventListener(type, fn, o) {
      listeners.push({ target: name, type, fn, capture: capOf(o), passive: o && typeof o === "object" ? o.passive : undefined });
    },
    removeEventListener(type, fn, o) {
      const c = capOf(o);
      const i = listeners.findIndex((l) => l.target === name && l.type === type && l.fn === fn && l.capture === c);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  const win = target("window");
  const doc = target("document");
  const mkEl = (tagName, extra = {}) => ({
    tagName, isConnected: true, blurred: 0,
    blur() { this.blurred += 1; if (doc.activeElement === this) doc.activeElement = doc.body; },
    ...extra,
  });
  doc.body = mkEl("BODY");
  doc.activeElement = doc.body;
  doc.pointerLockElement = null;
  doc.visibilityState = "visible";
  doc.exits = 0;
  const fireDoc = (type) => {
    for (const l of listeners.filter((x) => x.target === "document" && x.type === type)) l.fn({ type, target: doc });
  };
  doc.exitPointerLock = () => {
    doc.exits += 1;
    doc.pointerLockElement = null;
    fireDoc("pointerlockchange");
  };
  const canvas = mkEl("CANVAS", {
    requests: 0,
    lockMode: "none", // none | grant | reject | throw | deferred
    /** 'deferred': the browser's grant, by hand — sets the lock element, fires the change, resolves. */
    grantLater: null,
    requestPointerLock() {
      this.requests += 1;
      if (this.lockMode === "reject") return Promise.reject(new Error("denied"));
      if (this.lockMode === "throw") throw new Error("no pointer lock");
      if (this.lockMode === "grant") {
        doc.pointerLockElement = canvas;
        fireDoc("pointerlockchange");
      }
      if (this.lockMode === "deferred") {
        return new Promise((resolve) => {
          this.grantLater = () => {
            doc.pointerLockElement = canvas; // Pointer Lock 2.0: the element is set before the promise resolves
            fireDoc("pointerlockchange");
            resolve();
          };
        });
      }
      return undefined;
    },
  });
  const hud = mkEl("DIV");
  const funnel = makeFunnel(fault, installed);
  if (funnelOnWindow) win.__inputFunnel = funnel;
  const cs = {
    keys: { w: true, s: false, a: true, d: true, q: false, e: true, shift: true },
    endDrag: 0,
    _endFollowDrag() { this.endDrag += 1; },
    domElement: canvas,
  };
  const pads = [null];
  const nav = { getGamepads: () => pads };
  let settings = { sensitivity: 1, invertY: false, gamepadLayout: "mode2" };

  const makeEvent = (type, init = {}) => ({
    type,
    cancelable: init.cancelable !== false,
    stopped: false,
    prevented: false,
    target: init.target ?? doc.body,
    code: init.code,
    key: init.key,
    repeat: init.repeat === true,
    ctrlKey: init.ctrlKey === true,
    altKey: init.altKey === true,
    metaKey: init.metaKey === true,
    shiftKey: init.shiftKey === true,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
    movementX: init.movementX ?? 0,
    movementY: init.movementY ?? 0,
    deltaY: init.deltaY ?? 0,
    stopImmediatePropagation() { this.stopped = true; },
    stopPropagation() { this.stopped = true; },
    preventDefault() { if (this.cancelable) this.prevented = true; },
  });
  /** Window capture listeners in order, then (unless stopped) the window bubble ones. */
  const dispatch = (type, init) => {
    const ev = makeEvent(type, init);
    for (const l of listeners.filter((x) => x.target === "window" && x.type === type && x.capture)) {
      if (ev.stopped) break;
      l.fn(ev);
    }
    if (!ev.stopped) for (const l of listeners.filter((x) => x.target === "window" && x.type === type && !x.capture)) l.fn(ev);
    return ev;
  };
  const key = (code, init = {}) => dispatch("keydown", { code, ...init });
  const keyUp = (code, init = {}) => dispatch("keyup", { code, ...init });
  const onCanvas = (type, init = {}) => dispatch(type, { target: canvas, ...init });

  const deps = {
    window: win, document: doc, navigator: nav, cameraSwitcher: cs,
    settings: () => settings,
    ...(withFunnelDep ? { funnel } : {}),
  };
  return {
    win, doc, canvas, hud, funnel, cs, pads, nav, listeners, deps, dispatch, key, keyUp, onCanvas, fireDoc,
    setSettings(s) { settings = { ...settings, ...s }; },
    count: (target) => listeners.filter((l) => !target || l.target === target).length,
  };
}

const passedThrough = (ev) => ev.stopped === false && ev.prevented === false;
const takenEv = (ev) => ev.stopped === true && ev.prevented === true;
const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

/** An element with a parent chain and Element.closest for `[name="value"]` selectors. */
function mkNode(tagName, { parent = null, attrs = {} } = {}) {
  return {
    tagName, parentElement: parent, isConnected: true, attrs,
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    closest(sel) {
      const m = /^\[([a-z-]+)="([^"]*)"\]$/.exec(sel);
      if (!m) throw new Error(`fake closest: unsupported selector ${sel}`);
      for (let n = this; n; n = n.parentElement) if (n.getAttribute(m[1]) === m[2]) return n;
      return null;
    },
    blur() {},
  };
}

// ---------------------------------------------------------------------------
// constants + pure helpers
// ---------------------------------------------------------------------------

check("constants: key tables, action list, event lists, phases, tuning, PAD", () => {
  assert.deepEqual(C.DRONE_KEY_AXES, {
    KeyW: ["pitch", 1], KeyS: ["pitch", -1], KeyD: ["roll", 1], KeyA: ["roll", -1],
    KeyE: ["yaw", 1], KeyQ: ["yaw", -1], Space: ["throttle", 1], KeyC: ["throttle", -1],
  });
  assert.deepEqual(C.DRONE_KEY_ACTIONS, { Tab: "pilotView", KeyM: "mode", KeyH: "hideHud", KeyR: "returnHome" });
  assert.deepEqual(C.DRONE_BOOST_CODES, ["ShiftLeft", "ShiftRight"]);
  assert.deepEqual([...C.DRONE_KEY_CODES].sort(), [
    "KeyA", "KeyC", "KeyD", "KeyE", "KeyH", "KeyM", "KeyQ", "KeyR", "KeyS", "KeyW", "ShiftLeft", "ShiftRight", "Space", "Tab",
  ]);
  assert.deepEqual(C.DRONE_ACTIONS, ["pilotView", "mode", "hideHud", "returnHome", "recall"]);
  assert.deepEqual(C.KEY_EVENTS, ["keydown", "keyup", "keypress"]);
  assert.deepEqual(C.POINTER_EVENTS, [
    "pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "mousemove",
    "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "touchcancel",
    "dragover", "drop",
  ]);
  assert.deepEqual(C.CONTROL_PHASES, ["deploy", "fly", "pilot", "stow"]);
  assert.equal(C.GAMEPAD_DEADZONE, 0.08);
  assert.equal(C.GAMEPAD_EXPO, 0.3);
  assert.equal(C.RECALL_HOLD_MS, 800);
  assert.equal(C.LOOK_YAW_RAD_PER_PX, 0.0025);
  assert.equal(C.LOOK_PITCH_RAD_PER_PX, 0.002);
  assert.equal(C.LOOK_MAX_PX_PER_EVENT, 300);
  assert.deepEqual(C.PAD, { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9 });
  for (const k of ["DRONE_KEY_AXES", "DRONE_KEY_ACTIONS", "DRONE_BOOST_CODES", "DRONE_KEY_CODES", "DRONE_ACTIONS", "KEY_EVENTS", "POINTER_EVENTS", "CONTROL_PHASES", "PAD"]) {
    assert.ok(Object.isFrozen(C[k]), `${k} frozen`);
  }
  assert.ok(Object.isFrozen(C.DRONE_KEY_AXES.KeyW));
});

check("takesText / isTypingTarget: text fields yes, buttons / checkboxes / selects no, detached activeElement ignored", () => {
  for (const type of [undefined, "", "text", "search", "email", "password", "number", "TEXT"]) {
    assert.equal(C.takesText({ tagName: "INPUT", type }), true, `input type ${type}`);
  }
  for (const type of ["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit", "CHECKBOX"]) {
    assert.equal(C.takesText({ tagName: "INPUT", type }), false, `input type ${type}`);
  }
  assert.equal(C.takesText({ tagName: "input", getAttribute: (k) => (k === "type" ? "checkbox" : null) }), false, "type attribute fallback");
  assert.equal(C.takesText({ tagName: "TEXTAREA" }), true);
  assert.equal(C.takesText({ tagName: "SELECT" }), false, "a select takes no typed text (no type-ahead mid-flight)");
  assert.equal(C.takesText({ tagName: "select" }), false);
  assert.equal(C.takesText({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(C.takesText({ tagName: "DIV" }), false);
  assert.equal(C.takesText({ tagName: "BUTTON" }), false);
  assert.equal(C.takesText(null), false);
  assert.equal(C.takesText("INPUT"), false);
  const input = { tagName: "INPUT", type: "text", isConnected: true };
  const doc = { activeElement: input };
  assert.equal(C.isTypingTarget({ target: { tagName: "BODY" } }, doc), true, "a connected focused text field");
  input.isConnected = false;
  assert.equal(C.isTypingTarget({ target: { tagName: "BODY" } }, doc), false, "detached activeElement ignored");
  assert.equal(C.isTypingTarget({ target: { tagName: "TEXTAREA" } }, null), true, "the event target alone");
  assert.equal(C.isTypingTarget(null, null), false);
  assert.equal(C.isTypingTarget({ target: { tagName: "BODY" } }, { activeElement: { tagName: "INPUT", type: "checkbox", isConnected: true } }), false, "a focused checkbox is not typing");
});

check("shapeAxis: deadzone 0.08, expo 0.3 (0.08 → 0, 0.5 → 0.3481, 1 → 1, NaN → 0), sign kept", () => {
  assert.equal(C.shapeAxis(0.08), 0);
  assert.equal(C.shapeAxis(-0.08), 0);
  assert.equal(C.shapeAxis(0), 0);
  near(C.shapeAxis(0.5), 0.3481, 5e-5, "0.5");
  near(C.shapeAxis(-0.5), -0.3481, 5e-5, "−0.5");
  assert.equal(C.shapeAxis(1), 1);
  assert.equal(C.shapeAxis(-1), -1);
  assert.equal(C.shapeAxis(1.7), 1, "over-range clamps");
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "x"]) assert.equal(C.shapeAxis(bad), 0, String(bad));
  // monotonic outside the deadzone
  let prev = 0;
  for (let v = 0.09; v <= 1; v += 0.01) {
    const s = C.shapeAxis(v);
    assert.ok(s >= prev, `monotonic at ${v}`);
    prev = s;
  }
});

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------

check("keys → sticks: W/S pitch, D/A roll, E/Q yaw, Space/C throttle, Shift boost; opposites cancel", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const s0 = c.poll(1 / 60);
  assert.deepEqual({ ...s0 }, { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 });
  const cases = [
    ["KeyW", "pitch", 1], ["KeyS", "pitch", -1], ["KeyD", "roll", 1], ["KeyA", "roll", -1],
    ["KeyE", "yaw", 1], ["KeyQ", "yaw", -1], ["Space", "throttle", 1], ["KeyC", "throttle", -1],
  ];
  for (const [code, axis, sign] of cases) {
    const ev = E.key(code);
    assert.ok(takenEv(ev), `${code} keydown taken`);
    const s = c.poll(1 / 60);
    assert.equal(s[axis], sign, `${code} → ${axis}`);
    for (const other of ["throttle", "yaw", "pitch", "roll"]) if (other !== axis) assert.equal(s[other], 0, `${code}: ${other} stays 0`);
    assert.ok(takenEv(E.keyUp(code)), `${code} keyup taken`);
    assert.equal(c.poll(1 / 60)[axis], 0, `${code} released`);
  }
  E.key("KeyW");
  E.key("KeyS");
  assert.equal(c.poll(1 / 60).pitch, 0, "W + S cancel");
  E.keyUp("KeyS");
  assert.equal(c.poll(1 / 60).pitch, 1);
  E.keyUp("KeyW");
  for (const code of ["ShiftLeft", "ShiftRight"]) {
    assert.ok(takenEv(E.key(code, { shiftKey: true })));
    assert.equal(c.poll(1 / 60).boost, 1, `${code} boost`);
    E.keyUp(code);
    assert.equal(c.poll(1 / 60).boost, 0);
  }
  // Shift + W: boost and forward together (Shift is not a chord modifier here)
  E.key("ShiftLeft", { shiftKey: true });
  E.key("KeyW", { shiftKey: true });
  const sw = c.poll(1 / 60);
  assert.equal(sw.boost, 1);
  assert.equal(sw.pitch, 1);
  // a key held keeps producing its stick across polls, repeats included
  E.key("KeyW", { shiftKey: true, repeat: true });
  assert.equal(c.poll(1 / 60).pitch, 1);
  assert.equal(c.status().source, "keyboard");
  c.dispose();
});

check("typing: a focused text INPUT gets the keys (untouched, no sticks); a focused checkbox does not", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const chat = { tagName: "INPUT", type: "text", isConnected: true, blur() {} };
  E.doc.activeElement = chat;
  for (const code of ["KeyW", "KeyM", "Space", "Tab", "ShiftLeft"]) {
    assert.ok(passedThrough(E.key(code, { target: chat })), `${code} typed into chat`);
    assert.ok(passedThrough(E.dispatch("keypress", { code, target: chat })), `${code} keypress typed`);
  }
  const s = c.poll(1 / 60);
  assert.equal(s.pitch, 0);
  assert.equal(s.throttle, 0);
  assert.equal(s.boost, 0);
  assert.ok(passedThrough(E.keyUp("KeyW", { target: chat })), "keyup while typing passes");
  // activeElement alone (target = body) still counts as typing
  assert.ok(passedThrough(E.key("KeyD")), "focused chat, target body");
  // a checkbox left focused by a settings click must NOT park the sticks
  const box = { tagName: "INPUT", type: "checkbox", isConnected: true, blur() {} };
  E.doc.activeElement = box;
  const ev = E.key("KeyW", { target: box });
  assert.ok(takenEv(ev), "W with a checkbox focused is the drone's");
  assert.ok(takenEv(E.key("Space", { target: box })), "Space never toggles the checkbox");
  assert.equal(c.poll(1 / 60).pitch, 1);
  // a key pressed for the drone, then the chat takes focus: its release still clears the stick
  E.doc.activeElement = chat;
  assert.ok(passedThrough(E.keyUp("KeyW", { target: chat })));
  assert.equal(c.poll(1 / 60).pitch, 0, "tracking follows the release even while typing");
  c.dispose();
});

check("a settings <select> left focused mid-flight: drone keys stay the drone's (no type-ahead into the setting, no Space popup); arrows / Enter / Escape reach it", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  const got = [];
  c.onAction((a) => got.push(a.type));
  c.lock();
  c.setPhase("fly");
  const sel = { tagName: "SELECT", isConnected: true, blur() {} }; // "Flight mode", closed on the same option
  E.doc.activeElement = sel;
  for (const code of ["KeyW", "KeyA", "KeyD", "KeyC", "Space"]) {
    assert.ok(takenEv(E.key(code, { target: sel })), `${code} keydown taken (would type-ahead)`);
    assert.ok(takenEv(E.dispatch("keypress", { code, target: sel })), `${code} keypress taken`);
  }
  const s = c.poll(1 / 60);
  assert.equal(s.pitch, 1, "W flies");
  assert.equal(s.roll, 0, "A + D cancel");
  assert.equal(s.throttle, 0, "Space + C cancel");
  for (const code of ["KeyW", "KeyA", "KeyD", "KeyC", "Space"]) assert.ok(takenEv(E.keyUp(code, { target: sel })), `${code} keyup taken`);
  assert.ok(takenEv(E.key("KeyM", { target: sel })), "a tap of M is not lost");
  E.keyUp("KeyM", { target: sel });
  assert.deepEqual(got, ["mode"]);
  for (const code of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Home", "End"]) {
    assert.ok(passedThrough(E.key(code, { target: sel })), `${code} reaches the select`);
  }
  c.dispose();
});

check("Tab inside an open aria-modal dialog (a server confirmation) is the dialog's focus cycling, never pilotView; Space and the other drone keys stay taken there; outside one Tab is pilotView again", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  const got = [];
  c.onAction((a) => got.push(a.type));
  c.lock();
  c.setPhase("fly");
  // plugins/modal-dialog.js: #hb-modal-dialog (role alertdialog, aria-modal true) focuses OK on open
  const dialog = mkNode("DIV", { attrs: { id: "hb-modal-dialog", role: "alertdialog", "aria-modal": "true" } });
  const row = mkNode("DIV", { parent: dialog });
  const ok = mkNode("BUTTON", { parent: row });
  E.doc.activeElement = ok;
  assert.ok(passedThrough(E.key("Tab", { target: ok })), "Tab reaches the dialog (it moves focus to Cancel)");
  assert.ok(takenEv(E.keyUp("Tab", { target: ok })), "its keyup stays ours (the gated funnel never saw the press)");
  assert.ok(passedThrough(E.key("Tab", { target: ok, shiftKey: true })), "Shift+Tab too");
  E.keyUp("Tab", { target: ok, shiftKey: true });
  assert.ok(passedThrough(E.key("Tab", { target: E.doc.body })), "focus inside the dialog, target body");
  E.keyUp("Tab");
  E.doc.activeElement = E.doc.body;
  assert.ok(passedThrough(E.key("Tab", { target: ok })), "the target inside the dialog, focus on the body");
  E.keyUp("Tab", { target: ok });
  E.doc.activeElement = ok;
  assert.deepEqual(got, [], "no pilot-view toggle");
  assert.deepEqual(c.status().held, [], "a passed Tab is not tracked (nothing to drain)");
  // Space on the focused OK stays ours: a held climb never presses OK
  assert.ok(takenEv(E.key("Space", { target: ok })), "Space keydown taken");
  assert.ok(takenEv(E.keyUp("Space", { target: ok })), "Space keyup taken");
  assert.ok(takenEv(E.key("KeyW", { target: ok })), "W keeps flying");
  assert.equal(c.poll(1 / 60).pitch, 1);
  E.keyUp("KeyW", { target: ok });
  assert.ok(takenEv(E.key("KeyR", { target: ok })), "R still recalls");
  E.keyUp("KeyR", { target: ok });
  assert.deepEqual(got, ["returnHome"]);
  // Enter / Escape answer the dialog (never drone keys)
  assert.ok(passedThrough(E.key("Enter", { target: ok })));
  assert.ok(passedThrough(E.key("Escape", { target: ok })));
  // the dialog closed: focus back on the body, a detached button, or no closest() at all → Tab is the drone's
  E.doc.activeElement = E.doc.body;
  assert.ok(takenEv(E.key("Tab")), "no dialog: Tab taken");
  E.keyUp("Tab");
  ok.isConnected = false;
  E.doc.activeElement = ok;
  assert.ok(takenEv(E.key("Tab")), "a detached focused button is ignored");
  E.keyUp("Tab");
  E.doc.activeElement = { tagName: "BUTTON", isConnected: true, closest() { throw new Error("broken DOM"); } };
  assert.ok(takenEv(E.key("Tab")), "a throwing closest() reads as no dialog");
  E.keyUp("Tab");
  assert.deepEqual(got, ["returnHome", "pilotView", "pilotView", "pilotView"]);
  // a non-modal panel (no aria-modal) does not count
  const panel = mkNode("DIV", { attrs: { role: "dialog" } });
  const btn = mkNode("BUTTON", { parent: panel });
  E.doc.activeElement = btn;
  assert.ok(takenEv(E.key("Tab", { target: btn })), "a plain panel button: Tab is the drone's");
  c.dispose();
});

check("never taken: Escape, Enter, F1–F12, Shift+F11, digits, Ctrl / Alt / Meta chords", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const free = [
    ["Escape"], ["Enter"], ["NumpadEnter"], ["F1"], ["F11"], ["F12"], ["F11", { shiftKey: true }],
    ["Digit1"], ["Digit0"], ["Numpad3"], ["Backquote"], ["KeyT"], ["KeyZ"],
    ["KeyW", { ctrlKey: true }], ["KeyS", { metaKey: true }], ["KeyA", { altKey: true }], ["Tab", { altKey: true }],
    ["KeyR", { ctrlKey: true }], ["KeyM", { ctrlKey: true, shiftKey: true }],
  ];
  for (const [code, init] of free) {
    assert.ok(passedThrough(E.key(code, init)), `${code} ${JSON.stringify(init ?? {})} passes`);
  }
  const s = c.poll(1 / 60);
  assert.equal(s.pitch, 0);
  assert.equal(s.roll, 0);
  assert.equal(c.status().actions, 0, "no action from a chord");
  c.dispose();
});

check("a drone keyup the lock never saw pressed is still blocked (never hand the funnel a release it did not start)", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  assert.ok(takenEv(E.keyUp("KeyW")), "KeyW keyup without a press");
  assert.ok(takenEv(E.keyUp("ShiftLeft")));
  assert.ok(takenEv(E.keyUp("KeyW", { ctrlKey: true })), "even with a modifier held");
  assert.ok(passedThrough(E.keyUp("KeyX")), "a non-drone key's release is the client's");
  c.dispose();
});

check("onAction: Tab / M / H / R press edges (no repeats, no held re-fire), frozen {type, source}; a throwing listener never breaks input", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  const got = [];
  const off1 = c.onAction(() => { throw new Error("listener bug"); });
  c.onAction((a) => got.push(a));
  c.lock();
  c.setPhase("fly");
  const evTab = E.key("Tab");
  assert.ok(takenEv(evTab), "Tab taken (no focus move) even when a listener throws");
  E.key("Tab", { repeat: true });
  E.key("Tab", { repeat: true });
  E.keyUp("Tab");
  E.key("KeyM");
  E.key("KeyM"); // a second keydown without a keyup (no repeat flag) is not a new edge
  E.keyUp("KeyM");
  E.key("KeyH");
  E.keyUp("KeyH");
  E.key("KeyR");
  E.keyUp("KeyR");
  E.key("Tab");
  assert.deepEqual(got.map((a) => a.type), ["pilotView", "mode", "hideHud", "returnHome", "pilotView"]);
  assert.ok(got.every((a) => a.source === "keyboard"));
  assert.ok(Object.isFrozen(got[0]));
  assert.deepEqual({ ...got[0] }, { type: "pilotView", source: "keyboard" });
  off1();
  const before = got.length;
  E.keyUp("Tab");
  E.key("KeyR");
  assert.equal(got.length, before + 1);
  assert.equal(c.status().actions, 6);
  // an action key never moves a stick
  const s = c.poll(1 / 60);
  assert.equal(s.pitch + s.roll + s.yaw + s.throttle, 0);
  c.dispose();
  // a listener registered on a disposed instance is a no-op unsubscribe
  assert.equal(typeof c.onAction(() => {}), "function");
});

// ---------------------------------------------------------------------------
// gamepad
// ---------------------------------------------------------------------------

check("gamepad mode 2 / mode 1 mapping through navigator.getGamepads (standard mapping only), summed with keys and clamped", () => {
  const E = makeEnv();
  const pad = makePad();
  E.pads[0] = { ...makePad(), mapping: "" }; // a non-standard pad is ignored
  E.pads.push(pad);
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const S = C.shapeAxis(0.5);
  pad.axes = [0.5, -1, 1, -0.5]; // left X right, left Y up, right X right, right Y forward
  let s = c.poll(1 / 60);
  near(s.yaw, S, 1e-12, "mode2 yaw = left X");
  near(s.throttle, 1, 1e-12, "mode2 throttle = left Y (up +)");
  near(s.roll, 1, 1e-12, "mode2 roll = right X");
  near(s.pitch, S, 1e-12, "mode2 pitch = right Y (forward +)");
  assert.equal(c.status().gamepad, true);
  assert.equal(c.status().source, "gamepad");
  E.setSettings({ gamepadLayout: "mode1" });
  s = c.poll(1 / 60);
  near(s.pitch, 1, 1e-12, "mode1 pitch = left Y");
  near(s.throttle, S, 1e-12, "mode1 throttle = right Y");
  near(s.yaw, S, 1e-12, "mode1 yaw still left X");
  near(s.roll, 1, 1e-12, "mode1 roll still right X");
  E.setSettings({ gamepadLayout: "mode2" });
  // deadzone: tiny stick noise reads 0
  pad.axes = [0.05, -0.07, 0.08, 0.02];
  s = c.poll(1 / 60);
  assert.deepEqual([s.yaw, s.throttle, s.roll, s.pitch], [0, 0, 0, 0]);
  // triggers → gimbal (RT +, LT −), RB → boost
  pad.axes = [0, 0, 0, 0];
  press(pad, C.PAD.LT, true, 0.25);
  press(pad, C.PAD.RT, true, 0.75);
  press(pad, C.PAD.RB);
  s = c.poll(1 / 60);
  near(s.gimbal, S, 1e-12, "gimbal = shape(RT − LT)");
  assert.equal(s.boost, 1);
  press(pad, C.PAD.RT, false);
  press(pad, C.PAD.LT, true, 1);
  press(pad, C.PAD.RB, false);
  s = c.poll(1 / 60);
  assert.equal(s.gimbal, -1);
  assert.equal(s.boost, 0);
  // keyboard + gamepad sum, clamped to [−1, 1]
  press(pad, C.PAD.LT, false);
  pad.axes = [0, 0, 0, -1]; // right Y full forward
  E.key("KeyW");
  s = c.poll(1 / 60);
  assert.equal(s.pitch, 1, "W + full forward clamps at 1");
  E.key("KeyS");
  s = c.poll(1 / 60);
  near(s.pitch, 1, 1e-12, "W + S cancel, the pad still pushes");
  pad.axes = [0, 0, 0, 1]; // full back
  E.keyUp("KeyS");
  s = c.poll(1 / 60);
  assert.equal(s.pitch, 0, "W forward + pad back = 0");
  E.keyUp("KeyW");
  // the pad disconnects
  E.pads.length = 1;
  E.pads[0] = null;
  s = c.poll(1 / 60);
  assert.equal(s.pitch, 0);
  assert.equal(c.status().gamepad, false);
  c.dispose();
});

check("gamepad edges: Y → mode, View → pilotView, A → returnHome, once per press; a button held at lock is not a press", () => {
  const E = makeEnv();
  const pad = makePad();
  E.pads[0] = pad;
  const c = C.createControls(E.deps);
  const got = [];
  c.onAction((a) => got.push(`${a.type}/${a.source}`));
  press(pad, C.PAD.Y); // already held when the lock starts
  c.lock();
  c.setPhase("fly");
  c.poll(1 / 60);
  c.poll(1 / 60);
  assert.deepEqual(got, [], "held through the lock: no edge");
  press(pad, C.PAD.Y, false);
  c.poll(1 / 60);
  press(pad, C.PAD.Y);
  c.poll(1 / 60);
  c.poll(1 / 60);
  press(pad, C.PAD.VIEW);
  c.poll(1 / 60);
  press(pad, C.PAD.VIEW, false);
  press(pad, C.PAD.A);
  c.poll(1 / 60);
  c.poll(1 / 60);
  press(pad, C.PAD.A, false);
  c.poll(1 / 60);
  press(pad, C.PAD.A);
  c.poll(1 / 60);
  assert.deepEqual(got, ["mode/gamepad", "pilotView/gamepad", "returnHome/gamepad", "returnHome/gamepad"]);
  // X / LB / MENU do nothing
  press(pad, C.PAD.X);
  press(pad, C.PAD.LB);
  press(pad, C.PAD.MENU);
  c.poll(1 / 60);
  assert.equal(got.length, 4);
  c.dispose();
});

check("gamepad hold-B: recall once at ≥ 800 ms of hold (dt 0.1 and 1/60), again only after a release", () => {
  for (const dt of [0.1, 1 / 60]) {
    const E = makeEnv();
    const pad = makePad();
    E.pads[0] = pad;
    const c = C.createControls(E.deps);
    const got = [];
    c.onAction((a) => got.push(a.type));
    c.lock();
    c.setPhase("fly");
    c.poll(dt); // prime with B up
    press(pad, C.PAD.B);
    let t = 0;
    let firedAt = null;
    c.poll(dt); // the press is seen: held 0
    for (let i = 0; i < 400 && firedAt === null; i++) {
      c.poll(dt);
      t += dt;
      if (got.length) firedAt = t;
    }
    assert.ok(firedAt !== null, `dt ${dt}: fired`);
    assert.ok(firedAt >= 0.8 - 1e-9 && firedAt < 0.8 + dt + 1e-9, `dt ${dt}: fired at ${firedAt}`);
    for (let i = 0; i < 120; i++) c.poll(dt);
    assert.deepEqual(got, ["recall"], `dt ${dt}: once per hold`);
    press(pad, C.PAD.B, false);
    c.poll(dt);
    press(pad, C.PAD.B);
    for (let i = 0; i < Math.round(0.5 / dt); i++) c.poll(dt);
    assert.equal(got.length, 1, `dt ${dt}: a short second hold does not fire yet`);
    for (let i = 0; i < Math.round(0.5 / dt); i++) c.poll(dt);
    assert.deepEqual(got, ["recall", "recall"], `dt ${dt}: a new hold fires again`);
    c.dispose();
  }
});

check("a gamepad edge whose listener restores the input synchronously: that poll returns zero sticks", () => {
  const E = makeEnv();
  const pad = makePad();
  E.pads[0] = pad;
  const c = C.createControls(E.deps);
  c.onAction(() => c.restore());
  c.lock();
  c.setPhase("fly");
  c.poll(1 / 60);
  pad.axes = [0, -1, 0, 0];
  press(pad, C.PAD.A);
  const s = c.poll(1 / 60);
  assert.equal(c.locked, false);
  assert.equal(s.throttle, 0);
  c.dispose();
});

// ---------------------------------------------------------------------------
// lock / restore
// ---------------------------------------------------------------------------

check("lock(): releaseHeld('drone') then poison('gate'); Space charge cancelled; cs.keys zeroed + _endFollowDrag; capture listeners; idempotent", () => {
  const E = makeEnv();
  E.win.__jumpChargeActive = true;
  const handle = { aborts: 0, jumpChargeLevel: () => 0.4, jumpChargeAbort() { this.aborts += 1; } };
  E.win.__sessionHandle = handle;
  const c = C.createControls(E.deps);
  assert.equal(E.count(), 0, "nothing at create");
  assert.deepEqual(E.funnel.calls, [], "funnel untouched at create");
  const r = c.lock();
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.deepEqual(E.funnel.calls, [["releaseHeld", "drone"], ["poison", "gate"]]);
  assert.equal(E.funnel._fault, "gate");
  assert.equal(r.steps.funnel.ok, true);
  assert.equal(r.steps.funnel.prevFault, null);
  assert.equal(r.steps.funnel.released, 1);
  assert.equal(r.steps.funnel.poisoned, true);
  assert.equal(r.steps.jumpCharge.pending, true);
  assert.equal(r.steps.jumpCharge.cancelled, true);
  assert.equal(E.win.__jumpChargeActive, false);
  assert.equal(handle.aborts, 1, "jumpChargeAbort (local; sends nothing)");
  assert.equal(E.cs.endDrag, 1);
  assert.ok(Object.values(E.cs.keys).every((v) => v === false), "camera keystate zeroed");
  for (const t of C.KEY_EVENTS) {
    const l = E.listeners.filter((x) => x.target === "window" && x.type === t);
    assert.equal(l.length, 1, `${t} once`);
    assert.equal(l[0].capture, true, `${t} capture`);
  }
  for (const t of C.POINTER_EVENTS) {
    const l = E.listeners.filter((x) => x.target === "window" && x.type === t);
    assert.equal(l.length, 1, `${t} once`);
    assert.equal(l[0].capture, true, `${t} capture`);
    if (t === "wheel" || t.startsWith("touch")) assert.equal(l[0].passive, false, `${t} passive:false`);
  }
  assert.equal(E.listeners.filter((x) => x.target === "window" && x.type === "blur").length, 1);
  for (const t of ["visibilitychange", "pointerlockchange", "pointerlockerror"]) {
    assert.equal(E.listeners.filter((x) => x.target === "document" && x.type === t).length, 1, `document ${t}`);
  }
  const n = E.count();
  assert.equal(n, C.KEY_EVENTS.length + C.POINTER_EVENTS.length + 1 + 3);
  const again = c.lock();
  assert.equal(again.already, true);
  assert.equal(E.count(), n, "no duplicate listeners");
  assert.equal(E.funnel.calls.length, 2, "no second release / poison");
  assert.equal(c.locked, true);
  assert.equal(JSON.stringify(r) !== undefined, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "steps JSON-safe");
  c.dispose();
});

check("restore(): un-poisons only its own gate that still reads 'gate'; a pre-existing 'throw' / 'gate' or a changed fault is left", () => {
  // own gate → unpoison
  {
    const E = makeEnv();
    const c = C.createControls(E.deps);
    c.lock();
    const r = c.restore();
    assert.equal(r.wasLocked, true);
    assert.deepEqual(E.funnel.calls, [["releaseHeld", "drone"], ["poison", "gate"], ["unpoison"]]);
    assert.equal(E.funnel._fault, null);
    assert.deepEqual(c.restore(), { ok: true, wasLocked: false, steps: {} }, "idempotent");
  }
  // a pre-existing 'throw' is neither released through nor cleared
  {
    const E = makeEnv({ fault: "throw" });
    const c = C.createControls(E.deps);
    const r = c.lock();
    assert.deepEqual(E.funnel.calls, [], "no releaseHeld (it would throw), no poison");
    assert.equal(r.steps.funnel.prevFault, "throw");
    c.restore();
    assert.deepEqual(E.funnel.calls, []);
    assert.equal(E.funnel._fault, "throw");
  }
  // someone else's gate (set before the lock) stays
  {
    const E = makeEnv({ fault: "gate" });
    const c = C.createControls(E.deps);
    c.lock();
    assert.deepEqual(E.funnel.calls, [["releaseHeld", "drone"]], "released, not re-poisoned");
    c.restore();
    assert.equal(E.funnel._fault, "gate", "their gate is left");
    assert.equal(E.funnel.calls.some((x) => x[0] === "unpoison"), false);
  }
  // our gate replaced by someone's 'throw' → left
  {
    const E = makeEnv();
    const c = C.createControls(E.deps);
    c.lock();
    E.funnel._fault = "throw";
    c.restore();
    assert.equal(E.funnel._fault, "throw");
    assert.equal(E.funnel.calls.some((x) => x[0] === "unpoison"), false);
  }
  // our gate cleared by someone else → nothing to undo
  {
    const E = makeEnv();
    const c = C.createControls(E.deps);
    c.lock();
    E.funnel._fault = null;
    c.restore();
    assert.equal(E.funnel.calls.some((x) => x[0] === "unpoison"), false);
  }
  // a funnel without snapshot(): the fallback read of `_fault` (read only, never written by us)
  {
    const E = makeEnv();
    delete E.funnel.snapshot;
    const c = C.createControls(E.deps);
    c.lock();
    assert.equal(E.funnel._fault, "gate");
    c.restore();
    assert.equal(E.funnel._fault, null);
  }
});

check("the funnel is resolved at lock() time (deps.funnel ?? window.__inputFunnel); funnelInstalled reported; a missing funnel is a skipped step", () => {
  const E = makeEnv({ funnelOnWindow: false });
  const c = C.createControls(E.deps);
  const late = makeFunnel(null, false);
  E.win.__inputFunnel = late; // published after create (index.html top level vs the drone module)
  const r = c.lock();
  assert.deepEqual(late.calls, [["releaseHeld", "drone"], ["poison", "gate"]]);
  assert.equal(c.status().funnelInstalled, false, "?inputFunnelV2=off: not installed");
  c.restore();
  assert.equal(late._fault, null);
  assert.equal(r.steps.listeners.ok, true);
  // deps.funnel wins over the window global
  const E2 = makeEnv({ withFunnelDep: true });
  const other = makeFunnel();
  E2.win.__inputFunnel = other;
  const c2 = C.createControls(E2.deps);
  c2.lock();
  assert.equal(E2.funnel._fault, "gate");
  assert.deepEqual(other.calls, []);
  assert.equal(c2.status().funnelInstalled, true);
  c2.dispose();
  // no funnel anywhere: the step is skipped, the rest still run
  const E3 = makeEnv({ funnelOnWindow: false });
  const c3 = C.createControls(E3.deps);
  const r3 = c3.lock();
  assert.equal(r3.steps.funnel.ok, false);
  assert.ok(r3.steps.funnel.skipped);
  assert.equal(r3.steps.listeners.ok, true);
  assert.equal(E3.cs.endDrag, 1);
  c3.dispose();
  // no window / document / camera at all: lock never throws
  const c4 = C.createControls({ window: null, document: null, navigator: null });
  const r4 = c4.lock();
  assert.equal(r4.ok, true);
  assert.equal(r4.steps.listeners.ok, false);
  assert.equal(r4.steps.cameraInput.ok, false);
  assert.equal(c4.restore().wasLocked, true);
});

check("restore() removes every listener it added (window + document, by type and capture flag)", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.key("KeyX");
  c.restore();
  assert.equal(E.count(), 0, `left: ${JSON.stringify(E.listeners.map((l) => `${l.target}:${l.type}:${l.capture}`))}`);
  // a second cycle on the same instance is clean too
  c.lock();
  assert.ok(E.count() > 0);
  c.dispose();
  assert.equal(E.count(), 0);
  // and once disposed, lock() refuses
  const r = c.lock();
  assert.equal(r.ok, false);
  assert.equal(E.count(), 0);
});

check("keys held at restore are drained: autorepeat + final keyup swallowed, a fresh press hands back, then the drain listeners are gone", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.key("KeyW");
  E.key("ShiftLeft", { shiftKey: true });
  E.key("KeyA");
  E.keyUp("KeyA");
  c.restore();
  let st = c.status();
  assert.equal(st.draining, true);
  assert.deepEqual(st.held.sort(), ["KeyW", "ShiftLeft"]);
  assert.equal(E.funnel._fault, null, "the gate is open while draining");
  assert.ok(E.count() > 0, "drain listeners installed");
  assert.ok(takenEv(E.key("KeyW", { repeat: true })), "W autorepeat swallowed");
  assert.ok(takenEv(E.key("KeyW", { repeat: true })));
  assert.ok(passedThrough(E.key("KeyA")), "a key not held at restore is the client's");
  assert.ok(passedThrough(E.key("ShiftLeft", { shiftKey: true })), "a fresh Shift press hands the key back");
  assert.ok(passedThrough(E.keyUp("ShiftLeft")), "…and its release then goes to the client");
  assert.ok(takenEv(E.keyUp("KeyW")), "W's final keyup swallowed");
  st = c.status();
  assert.equal(st.draining, false);
  assert.deepEqual(st.held, []);
  assert.equal(st.drained, 3, "two repeats + one final keyup");
  assert.equal(E.count(), 0, "drain listeners gone");
  assert.ok(passedThrough(E.key("KeyW")), "the next W is the client's");
  // a blur during the drain drops it (the release may happen unseen)
  c.lock();
  E.key("KeyD");
  c.restore();
  assert.ok(E.count() > 0);
  E.dispatch("blur", {});
  assert.equal(E.count(), 0);
  assert.equal(c.status().draining, false);
  // dispose() keeps a pending drain: it ends by itself
  c.lock();
  E.key("KeyQ");
  c.dispose();
  assert.equal(E.count(), 3, "the drain's window capture keydown / keyup + bubble blur");
  assert.equal(c.status().draining, true);
  assert.ok(takenEv(E.key("KeyQ", { repeat: true })), "an autorepeat is still swallowed after dispose");
  assert.ok(takenEv(E.keyUp("KeyQ")), "…and the final keyup");
  assert.equal(E.count(), 0, "then the drain listeners are gone");
  assert.equal(c.status().draining, false);
  assert.ok(passedThrough(E.key("KeyQ")), "the next Q is the client's");
});

check("T25 / abort order — restore() with KeyW held, then dispose() in the same tick: W's autorepeats and its release never reach the reopened funnel, then no listener is left and a fresh press is the client's; a re-deploy works while the old drain runs", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  const got = [];
  c.onAction((a) => got.push(a.type));
  c.lock();
  c.setPhase("fly");
  E.key("KeyW"); // held through the stow, to walk away
  E.key("KeyR"); // recall pressed and still down
  const rr = c.restore(); // the inputRestore executor
  assert.deepEqual([...rr.steps.drain.keys].sort(), ["KeyR", "KeyW"]);
  assert.equal(rr.steps.funnel.unpoisoned, true, "our gate is given back (index.js reads steps.funnel.unpoisoned)");
  const d = c.dispose(); // teardown, same tick
  assert.equal(d.wasLocked, false, "already restored");
  assert.equal(E.funnel._fault, null, "the funnel is open again");
  assert.equal(E.count(), 3, "only the drain is left");
  for (let i = 0; i < 4; i++) assert.ok(takenEv(E.key("KeyW", { repeat: true })), "a W autorepeat is blocked (no run in place)");
  assert.ok(passedThrough(E.key("KeyR")), "a fresh R press is the client's");
  assert.deepEqual(got, ["returnHome"], "only the recall press while locked; no drone action after dispose");
  assert.equal(E.count(), 3, "W still drains");
  assert.ok(takenEv(E.keyUp("KeyW")), "W's release is swallowed (no unpaired release → no MoveToState)");
  assert.equal(E.count(), 0, "the drain removed itself");
  assert.equal(c.status().draining, false);
  assert.ok(passedThrough(E.key("KeyW")), "a fresh W press reaches the client at once");
  assert.ok(passedThrough(E.keyUp("KeyW")));
  assert.equal(c.lock().ok, false, "a disposed instance stays disposed");
  // a blur ends a drain left by dispose() too
  {
    const E1 = makeEnv();
    const c1 = C.createControls(E1.deps);
    c1.lock();
    E1.key("KeyS");
    c1.dispose();
    assert.equal(E1.count(), 3);
    E1.dispatch("blur", {});
    assert.equal(E1.count(), 0, "blur drops the drain (the release may happen unseen)");
  }
  // the re-deploy: a new controls locks while the old instance still drains W
  const E2 = makeEnv();
  const old = C.createControls(E2.deps);
  old.lock();
  old.setPhase("fly");
  E2.key("KeyW");
  old.restore();
  old.dispose();
  assert.equal(E2.count(), 3);
  const c2 = C.createControls(E2.deps);
  const got2 = [];
  c2.onAction((a) => got2.push(a.type));
  assert.equal(c2.lock().ok, true);
  c2.setPhase("fly");
  const lockedCount = C.KEY_EVENTS.length + C.POINTER_EVENTS.length + 1 + 3;
  assert.equal(E2.count(), 3 + lockedCount);
  assert.equal(E2.funnel._fault, "gate", "the new cycle gates the funnel again");
  assert.ok(takenEv(E2.key("KeyW", { repeat: true })), "the old W autorepeat is swallowed");
  assert.equal(c2.poll(1 / 60).pitch, 0, "a key held since the last cycle flies nothing until pressed again");
  assert.ok(takenEv(E2.key("KeyD")), "other keys fly the new cycle");
  assert.equal(c2.poll(1 / 60).roll, 1);
  E2.key("KeyM");
  assert.deepEqual(got2, ["mode"]);
  assert.ok(takenEv(E2.keyUp("KeyW")), "the old drain swallows W's release");
  assert.equal(E2.count(), lockedCount, "the old drain is gone; the new lock is intact");
  assert.ok(takenEv(E2.key("KeyW")), "a fresh W is the new cycle's");
  assert.equal(c2.poll(1 / 60).pitch, 1);
  for (const code of ["KeyW", "KeyD", "KeyM"]) E2.keyUp(code);
  c2.dispose();
  assert.equal(E2.count(), 0, "nothing held at the second teardown: no listener at all");
  assert.equal(E2.funnel._fault, null);
});

check("blur and a hidden tab zero held keys and look (the craft holds; nothing sticks)", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(c.pointerLocked, true);
  E.key("KeyW");
  E.key("Space");
  E.onCanvas("pointermove", { movementX: 40, movementY: 10 });
  E.dispatch("blur", {});
  let s = c.poll(1 / 60);
  assert.equal(s.pitch, 0);
  assert.equal(s.throttle, 0);
  assert.equal(s.lookX, 0);
  assert.equal(s.lookY, 0);
  E.key("KeyD");
  E.onCanvas("pointermove", { movementX: 40 });
  E.doc.visibilityState = "hidden";
  E.fireDoc("visibilitychange");
  s = c.poll(1 / 60);
  assert.equal(s.roll, 0);
  assert.equal(s.lookX, 0);
  E.doc.visibilityState = "visible";
  E.fireDoc("visibilitychange");
  E.key("KeyD", { repeat: true }); // still physically held after the tab comes back
  assert.equal(c.poll(1 / 60).roll, 1, "a held key re-syncs from its autorepeat (no action edge)");
  c.dispose();
});

// ---------------------------------------------------------------------------
// pointer: phases, lock, look, zoom, pass-through
// ---------------------------------------------------------------------------

check("'fly': a canvas pointerdown blurs focus and requests pointer lock (a rejected promise is caught); the click itself is blocked", async () => {
  const E = makeEnv();
  E.canvas.lockMode = "reject";
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const box = { tagName: "INPUT", type: "checkbox", isConnected: true, blurred: 0, blur() { this.blurred += 1; E.doc.activeElement = E.doc.body; } };
  E.doc.activeElement = box;
  const ev = E.onCanvas("pointerdown", { button: 0 });
  assert.ok(takenEv(ev), "no picking / Use from the click");
  assert.equal(box.blurred, 1, "focused element blurred");
  assert.equal(E.canvas.requests, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.status().lockErrors, 1, "rejection counted, not thrown");
  assert.equal(unhandled.length, 0, "no unhandled rejection");
  assert.equal(c.pointerLocked, false);
  // a throwing requestPointerLock is caught too
  E.canvas.lockMode = "throw";
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(c.status().lockErrors, 2);
  assert.equal(c.status().lockRequests, 2);
  // a right / middle press never requests the lock; a HUD press is not ours at all
  E.onCanvas("pointerdown", { button: 2 });
  E.onCanvas("pointerdown", { button: 1 });
  assert.equal(E.canvas.requests, 2);
  const hudEv = E.dispatch("pointerdown", { button: 0, target: E.hud });
  assert.ok(passedThrough(hudEv), "HUD clicks are the client's");
  assert.equal(E.canvas.requests, 2);
  // pointerlockerror counts
  E.fireDoc("pointerlockerror");
  assert.equal(c.status().lockErrors, 3);
  c.dispose();
});

check("'fly' look: movementX/Y while locked → lookX = px·0.0025·sens, lookY = −py·0.0020·sens (invertY flips); spikes > 300 px dropped; per-poll", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.onCanvas("pointermove", { movementX: 50, movementY: 50 });
  assert.equal(c.poll(1 / 60).lookX, 0, "no look before the pointer is locked");
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(c.pointerLocked, true);
  assert.equal(c.status().pointerLocked, true);
  E.onCanvas("pointermove", { movementX: 60, movementY: -20 });
  E.onCanvas("pointermove", { movementX: 40, movementY: -30 });
  let s = c.poll(1 / 60);
  near(s.lookX, 100 * 0.0025, 1e-12, "lookX");
  near(s.lookY, 50 * 0.002, 1e-12, "lookY (mouse up = tilt up)");
  s = c.poll(1 / 60);
  assert.equal(s.lookX, 0, "accumulated since the last poll only");
  assert.equal(s.lookY, 0);
  E.setSettings({ sensitivity: 2, invertY: true });
  E.onCanvas("pointermove", { movementX: -10, movementY: 25 });
  s = c.poll(1 / 60);
  near(s.lookX, -10 * 0.0025 * 2, 1e-12, "sensitivity");
  near(s.lookY, 25 * 0.002 * 2, 1e-12, "invertY: mouse down = tilt up");
  E.setSettings({ sensitivity: 1, invertY: false });
  E.onCanvas("pointermove", { movementX: 301, movementY: 0 });
  E.onCanvas("pointermove", { movementX: 0, movementY: -400 });
  E.onCanvas("pointermove", { movementX: 300, movementY: 0 });
  s = c.poll(1 / 60);
  near(s.lookX, 300 * 0.0025, 1e-12, "spikes dropped, 300 kept");
  assert.equal(s.lookY, 0);
  // the moves themselves are blocked (no hover picking)
  assert.ok(takenEv(E.onCanvas("pointermove", { movementX: 1 })));
  assert.ok(takenEv(E.onCanvas("mousemove", { movementX: 1 })));
  c.poll(1 / 60);
  assert.equal(c.status().source, "keyboard");
  c.dispose();
});

check("'fly' wheel → zoom notches (deltaY > 0 → +1 = wider), per poll; blocked; never outside 'fly'", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  assert.ok(takenEv(E.onCanvas("wheel", { deltaY: 120 })));
  let s = c.poll(1 / 60);
  assert.equal(s.zoom, 1);
  E.onCanvas("wheel", { deltaY: -3 });
  E.onCanvas("wheel", { deltaY: -100 });
  E.onCanvas("wheel", { deltaY: 0 });
  s = c.poll(1 / 60);
  assert.equal(s.zoom, -2);
  assert.equal(c.poll(1 / 60).zoom, 0);
  for (const p of ["deploy", "pilot", "stow"]) {
    c.setPhase(p);
    assert.ok(takenEv(E.onCanvas("wheel", { deltaY: 120 })), `${p}: blocked`);
    assert.equal(c.poll(1 / 60).zoom, 0, `${p}: no zoom`);
  }
  c.dispose();
});

check("'deploy' / 'stow' never request pointer lock; canvas presses / clicks / dblclick / contextmenu / touch / drop are blocked", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  c.lock();
  assert.equal(c.phase, null);
  for (const p of [null, "deploy", "stow"]) {
    if (p) c.setPhase(p);
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "drop", "pointercancel"]) {
      assert.ok(takenEv(E.onCanvas(t, { button: 0 })), `${p}: ${t} blocked`);
    }
    assert.ok(takenEv(E.onCanvas("pointerdown", { button: 2 })), `${p}: right press blocked (no camera drag)`);
  }
  assert.equal(E.canvas.requests, 0, "no pointer-lock request outside 'fly'");
  // a canvas event that is not cancelable is still stopped
  const nc = E.onCanvas("touchmove", { cancelable: false });
  assert.equal(nc.stopped, true);
  assert.equal(nc.prevented, false);
  c.dispose();
});

check("dragover on the canvas is stopped but NOT prevented (a prevented dragover means 'drop allowed'); drop is blocked", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  const dov = E.onCanvas("dragover");
  assert.equal(dov.stopped, true);
  assert.equal(dov.prevented, false);
  assert.ok(takenEv(E.onCanvas("drop")));
  assert.ok(passedThrough(E.dispatch("dragover", { target: E.hud })), "an inventory drag over the HUD is the client's");
  c.dispose();
});

check("'pilot': exits our pointer lock; the right-button press / drag / contextmenu pass to camera.js; everything else on the canvas stays blocked", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(c.pointerLocked, true);
  c.setPhase("pilot");
  assert.equal(E.doc.exits, 1, "exitPointerLock");
  assert.equal(c.pointerLocked, false);
  assert.equal(E.doc.pointerLockElement, null);
  // the follow camera's orbit drag (camera.js: canvas mousedown/contextmenu + document mousemove/mouseup)
  assert.ok(passedThrough(E.onCanvas("pointerdown", { button: 2, buttons: 2 })), "right pointerdown (not prevented: compat mousedown still fires)");
  assert.ok(passedThrough(E.onCanvas("mousedown", { button: 2, buttons: 2 })), "right mousedown");
  assert.ok(passedThrough(E.onCanvas("pointermove", { buttons: 2 })), "drag pointermove");
  assert.ok(passedThrough(E.onCanvas("mousemove", { buttons: 2 })), "drag mousemove");
  assert.ok(passedThrough(E.dispatch("mousemove", { buttons: 2, target: E.hud })), "drag over the HUD");
  assert.ok(passedThrough(E.onCanvas("pointerup", { button: 2 })), "right pointerup");
  assert.ok(passedThrough(E.onCanvas("mouseup", { button: 2 })), "right mouseup");
  assert.ok(passedThrough(E.onCanvas("contextmenu", { button: 2 })), "contextmenu (camera.js prevents the menu)");
  // the drag is over: hover, the left button, wheel and double-click are blocked again
  assert.ok(takenEv(E.onCanvas("mousemove", { buttons: 0 })), "hover after the drag");
  assert.ok(takenEv(E.onCanvas("pointerdown", { button: 0 })), "left press");
  assert.ok(takenEv(E.onCanvas("click", { button: 0 })));
  assert.ok(takenEv(E.onCanvas("dblclick", { button: 0 })));
  assert.ok(takenEv(E.onCanvas("wheel", { deltaY: 100 })));
  assert.equal(E.canvas.requests, 1, "no lock request in pilot view");
  // a lost right release: the move with the button up passes once (camera.js self-heals), then hover is blocked
  E.onCanvas("mousedown", { button: 2, buttons: 2 });
  assert.ok(passedThrough(E.onCanvas("mousemove", { buttons: 0 })), "the self-heal move");
  assert.ok(takenEv(E.onCanvas("mousemove", { buttons: 0 })));
  // the keys keep flying in pilot view (the craft holds anyway)
  E.key("KeyW");
  assert.equal(c.poll(1 / 60).pitch, 1);
  assert.equal(c.poll(1 / 60).lookX, 0);
  // back to 'fly': the right press is blocked again
  c.setPhase("fly");
  assert.ok(takenEv(E.onCanvas("pointerdown", { button: 2 })));
  assert.ok(takenEv(E.onCanvas("contextmenu", { button: 2 })));
  // Tab back to the goggles MID right-drag: its mouseup will be blocked, so camera.js's drag is ended now
  c.setPhase("pilot");
  const before = E.cs.endDrag;
  E.onCanvas("mousedown", { button: 2, buttons: 2 });
  c.setPhase("fly");
  assert.equal(E.cs.endDrag, before + 1, "_endFollowDrag on leaving pilot mid-drag");
  c.setPhase("pilot");
  c.setPhase("stow");
  assert.equal(E.cs.endDrag, before + 1, "no drag, no call");
  c.dispose();
});

check("'pilot': the orbit drag's right release ends camera.js's drag first (a short right-click opens no context menu), on the canvas or over the HUD; the release still passes; drags keep orbiting", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  c.setPhase("pilot");
  const n0 = E.cs.endDrag;
  // a short right-click on an NPC: camera.js picked it at mousedown and would open the menu at mouseup
  assert.ok(passedThrough(E.onCanvas("pointerdown", { button: 2, buttons: 2 })));
  assert.ok(passedThrough(E.onCanvas("mousedown", { button: 2, buttons: 2 })));
  assert.ok(passedThrough(E.onCanvas("pointerup", { button: 2 })));
  assert.equal(E.cs.endDrag, n0, "not before the mouseup");
  assert.ok(passedThrough(E.onCanvas("mouseup", { button: 2 })), "the mouseup still reaches camera.js (it ends the drag)");
  assert.equal(E.cs.endDrag, n0 + 1, "_endFollowDrag ran first: camera.js's pick is cleared, no menu");
  assert.ok(passedThrough(E.onCanvas("contextmenu", { button: 2 })), "contextmenu (camera.js prevents the browser menu)");
  assert.ok(takenEv(E.onCanvas("mousemove", { buttons: 0 })), "the drag is over: hover blocked again");
  // released over the HUD (the pointer slid off the canvas)
  E.onCanvas("pointerdown", { button: 2, buttons: 2 });
  E.onCanvas("mousedown", { button: 2, buttons: 2 });
  assert.ok(passedThrough(E.dispatch("pointerup", { button: 2, target: E.hud })));
  assert.ok(passedThrough(E.dispatch("mouseup", { button: 2, target: E.hud })), "a HUD release passes");
  assert.equal(E.cs.endDrag, n0 + 2, "…and opens no menu either");
  // a long orbit drag: its moves pass (camera.js turns on them), its release ends it the same way
  E.onCanvas("mousedown", { button: 2, buttons: 2 });
  for (let i = 0; i < 5; i++) {
    assert.ok(passedThrough(E.onCanvas("pointermove", { buttons: 2 })));
    assert.ok(passedThrough(E.onCanvas("mousemove", { buttons: 2 })));
  }
  assert.ok(passedThrough(E.dispatch("mousemove", { buttons: 2, target: E.hud })));
  assert.equal(E.cs.endDrag, n0 + 2, "no call mid-drag");
  assert.ok(passedThrough(E.onCanvas("mouseup", { button: 2 })));
  assert.equal(E.cs.endDrag, n0 + 3);
  // no drag in progress, another button, or another phase: nothing to end
  assert.ok(passedThrough(E.dispatch("mouseup", { button: 2, target: E.hud })), "a stray HUD release is the client's");
  assert.ok(takenEv(E.onCanvas("mouseup", { button: 2 })), "a canvas right release without a drag stays blocked");
  E.onCanvas("mousedown", { button: 2, buttons: 2 });
  assert.ok(takenEv(E.onCanvas("mouseup", { button: 0 })), "a left release mid-drag stays blocked");
  assert.equal(E.cs.endDrag, n0 + 3);
  c.setPhase("fly"); // Tab back mid-drag: ended once on leaving 'pilot'
  assert.equal(E.cs.endDrag, n0 + 4);
  assert.ok(takenEv(E.onCanvas("mouseup", { button: 2 })), "'fly': the right release is blocked");
  assert.equal(E.cs.endDrag, n0 + 4);
  c.dispose();
});

check("pointer-lock loss (Esc / focus / the browser) zeroes look while keys keep producing sticks; the next 'fly' canvas pointerdown re-requests", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(E.canvas.requests, 1);
  E.key("KeyW");
  E.key("KeyE");
  E.onCanvas("pointermove", { movementX: 80, movementY: 80 });
  // the browser drops the lock (Esc is the client's key; the browser exits pointer lock on it)
  E.doc.pointerLockElement = null;
  E.fireDoc("pointerlockchange");
  assert.equal(c.pointerLocked, false);
  assert.equal(c.locked, true, "the input lock stays");
  const s = c.poll(1 / 60);
  assert.equal(s.lookX, 0, "look zeroed");
  assert.equal(s.lookY, 0);
  assert.equal(s.pitch, 1, "keys keep flying");
  assert.equal(s.yaw, 1);
  // movement while unlocked is a normal cursor: no look
  E.onCanvas("pointermove", { movementX: 50 });
  assert.equal(c.poll(1 / 60).lookX, 0);
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(E.canvas.requests, 2, "re-requested");
  assert.equal(c.pointerLocked, true);
  // a lock change to some other element is not ours
  E.doc.pointerLockElement = E.hud;
  E.fireDoc("pointerlockchange");
  assert.equal(c.pointerLocked, false);
  c.dispose();
});

check("a pointer-lock grant that lands after the phase left 'fly' (Tab / a recall right after the click) is given back at once", () => {
  const E = makeEnv(); // lockMode 'none': the request stays pending, the grant is delivered by hand below
  const c = C.createControls(E.deps);
  c.lock();
  c.setPhase("fly");
  E.onCanvas("pointerdown", { button: 0 });
  assert.equal(E.canvas.requests, 1);
  for (const p of ["pilot", "stow", "deploy"]) {
    c.setPhase(p);
    const exits = E.doc.exits;
    E.doc.pointerLockElement = E.canvas; // the late grant
    E.fireDoc("pointerlockchange");
    assert.equal(E.doc.exits, exits + 1, `${p}: exitPointerLock`);
    assert.equal(E.doc.pointerLockElement, null, `${p}: the cursor is free again`);
    assert.equal(c.pointerLocked, false, `${p}: not pointer-locked`);
    E.onCanvas("pointermove", { movementX: 50 });
    assert.equal(c.poll(1 / 60).lookX, 0, `${p}: no look`);
  }
  // in 'fly' the same grant is kept
  c.setPhase("fly");
  E.doc.pointerLockElement = E.canvas;
  E.fireDoc("pointerlockchange");
  assert.equal(c.pointerLocked, true, "'fly' keeps its lock");
  c.dispose();
});

check("a pointer-lock grant that lands after restore() / dispose() (no pointerlockchange listener left) is given back through the request's promise; in 'fly' it is kept", async () => {
  for (const end of ["restore", "dispose"]) {
    const E = makeEnv();
    E.canvas.lockMode = "deferred";
    const c = C.createControls(E.deps);
    c.lock();
    c.setPhase("fly");
    E.onCanvas("pointerdown", { button: 0 });
    assert.equal(E.canvas.requests, 1);
    c[end](); // a hard abort / the stow within the request-to-grant latency
    assert.equal(E.listeners.filter((l) => l.type === "pointerlockchange").length, 0, `${end}: the change listener is gone`);
    E.canvas.grantLater();
    await microtasks();
    assert.equal(E.doc.exits, 1, `${end}: exitPointerLock`);
    assert.equal(E.doc.pointerLockElement, null, `${end}: the cursor is free (the follow camera's right-drag works)`);
    assert.equal(c.pointerLocked, false);
  }
  // still locked in 'fly': the grant is the one the click asked for
  {
    const E = makeEnv();
    E.canvas.lockMode = "deferred";
    const c = C.createControls(E.deps);
    c.lock();
    c.setPhase("fly");
    E.onCanvas("pointerdown", { button: 0 });
    E.canvas.grantLater();
    await microtasks();
    assert.equal(E.doc.exits, 0, "kept");
    assert.equal(c.pointerLocked, true);
    assert.equal(E.doc.pointerLockElement, E.canvas);
    c.dispose();
    assert.equal(E.doc.exits, 1, "dispose exits our lock");
  }
  // in 'pilot' (Tab right after the click): given back once by the change listener; the promise finds it gone
  {
    const E = makeEnv();
    E.canvas.lockMode = "deferred";
    const c = C.createControls(E.deps);
    c.lock();
    c.setPhase("fly");
    E.onCanvas("pointerdown", { button: 0 });
    c.setPhase("pilot");
    E.canvas.grantLater();
    await microtasks();
    assert.equal(E.doc.exits, 1, "exactly one exit");
    assert.equal(E.doc.pointerLockElement, null);
    c.dispose();
  }
  // a lock someone else holds when the promise resolves is never exited
  {
    const E = makeEnv();
    E.canvas.lockMode = "deferred";
    const c = C.createControls(E.deps);
    c.lock();
    c.setPhase("fly");
    E.onCanvas("pointerdown", { button: 0 });
    c.restore();
    E.canvas.grantLater();
    E.doc.pointerLockElement = E.hud; // another element took the lock before the promise settled
    await microtasks();
    assert.equal(E.doc.exits, 0);
    assert.equal(E.doc.pointerLockElement, E.hud);
  }
  assert.equal(unhandled.length, 0, "no unhandled rejection");
});

check("restore() exits OUR pointer lock (not someone else's); setPhase validates; poll is all-zero and allocation-stable while unlocked", () => {
  const E = makeEnv();
  E.canvas.lockMode = "grant";
  const c = C.createControls(E.deps);
  const s0 = c.poll(1 / 60);
  assert.equal(c.setPhase("bogus"), null, "unknown phase → unchanged");
  assert.equal(c.setPhase("fly"), "fly");
  c.lock();
  E.onCanvas("pointerdown", { button: 0 });
  E.key("KeyW");
  const s1 = c.poll(1 / 60);
  assert.equal(s1, s0, "the same reused Sticks object");
  assert.equal(s1.pitch, 1);
  c.restore();
  assert.equal(E.doc.exits, 1);
  assert.equal(c.pointerLocked, false);
  assert.equal(c.phase, null);
  const s2 = c.poll(1 / 60);
  assert.equal(s2, s0);
  assert.deepEqual({ ...s2 }, { throttle: 0, yaw: 0, pitch: 0, roll: 0, gimbal: 0, boost: 0, lookX: 0, lookY: 0, zoom: 0 }, "all zero while unlocked");
  // someone else's pointer lock is left alone
  const E2 = makeEnv();
  const c2 = C.createControls(E2.deps);
  c2.lock();
  E2.doc.pointerLockElement = E2.hud;
  c2.setPhase("pilot");
  c2.restore();
  assert.equal(E2.doc.exits, 0);
  assert.equal(E2.doc.pointerLockElement, E2.hud);
});

check("status(): every SPEC field, JSON-safe; dispose() returns the restore result, drops action listeners and leaves only the self-removing drain", () => {
  const E = makeEnv();
  const c = C.createControls(E.deps);
  const got = [];
  c.onAction((a) => got.push(a.type));
  let st = c.status();
  assert.deepEqual(Object.keys(st).sort(), [
    "actions", "blocked", "draining", "drained", "funnelInstalled", "gamepad", "held", "lockErrors", "lockRequests", "locked", "phase", "pointerLocked", "source",
  ].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  assert.equal(st.locked, false);
  assert.equal(st.phase, null);
  assert.equal(st.source, null);
  c.lock();
  c.setPhase("fly");
  E.key("KeyW");
  E.key("KeyR");
  st = c.status();
  assert.equal(st.locked, true);
  assert.equal(st.phase, "fly");
  assert.deepEqual(st.held.sort(), ["KeyR", "KeyW"]);
  assert.ok(st.blocked >= 2);
  assert.equal(st.actions, 1);
  assert.equal(st.funnelInstalled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  const r = c.dispose();
  assert.equal(r.ok, true);
  assert.equal(r.wasLocked, true);
  assert.equal(E.funnel._fault, null);
  assert.equal(E.count(), 3, "W and R are still down: only their drain is left");
  st = c.status();
  assert.equal(st.locked, false);
  assert.equal(st.draining, true);
  assert.deepEqual(st.held.sort(), ["KeyR", "KeyW"]);
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  assert.ok(passedThrough(E.key("KeyR")), "a fresh R press is the client's");
  assert.deepEqual(got, ["returnHome"], "no action listener after dispose");
  assert.ok(takenEv(E.keyUp("KeyW")), "W's release is swallowed");
  assert.equal(E.count(), 0, "no listener once the held keys are up");
  const r2 = c.dispose();
  assert.equal(r2.wasLocked, false, "idempotent");
  assert.equal(E.count(), 0);
});

// ---------------------------------------------------------------------------

for (const p of pending) await p();
console.log(`\ndrone_controls: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
