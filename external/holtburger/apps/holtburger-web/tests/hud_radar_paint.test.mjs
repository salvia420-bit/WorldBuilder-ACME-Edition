// tests/hud_radar_paint.test.mjs — fps review 2026-10-19, HUD part (radar).
//
// The radar's update() runs every 25 ms and used to clear and redraw its blip
// canvas every time, standing still or not; a redrawn canvas is a fresh raster
// on the GPU process's main thread (the thread that also executes WebGL). It
// now builds `paintKey` from everything the pixels depend on and skips the
// clear + redraw when the key is unchanged.
//
// CONTRACT (the REAL radar, mounted on a fake DOM with a call-counting 2D
// context, driven through its captured rAF tick)
//   [1] the first update paints (clearRect + blip + centre marker).
//   [2] an update with identical inputs paints NOTHING (the pre-change update
//       cleared and redrew the canvas every time).
//   [3] a moved blip, a turned player, a selection change and the BlackFog2
//       blank each repaint exactly once, then settle again.
//   [4] window.__radar.paintStats() counts updates vs paints.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/hud_radar_paint.test.mjs

// ── fake DOM ────────────────────────────────────────────────────────
const ctxCalls = { clearRect: 0, fillRect: 0 };
function fakeCtx() {
  return {
    fillStyle: "",
    clearRect() { ctxCalls.clearRect += 1; },
    fillRect() { ctxCalls.fillRect += 1; },
  };
}
function fakeEl(tag) {
  const cls = new Set();
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: "",
    id: "",
    title: "",
    textContent: "",
    hidden: false,
    tabIndex: -1,
    width: 0,
    height: 0,
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: {
      add(...c) { for (const x of c) cls.add(x); },
      remove(...c) { for (const x of c) cls.delete(x); },
      toggle(c, force) { const on = force === undefined ? !cls.has(c) : !!force; if (on) cls.add(c); else cls.delete(c); return on; },
      contains(c) { return cls.has(c); },
    },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    remove() {
      const p = el.parentNode;
      if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
      el.parentNode = null;
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    hasAttribute(k) { return attrs.has(k); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120, x: 0, y: 0 }; },
    getContext() { return fakeCtx(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {}, click() {},
    setPointerCapture() {}, releasePointerCapture() {},
  };
  return el;
}

const rafQueue = [];
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.innerWidth = 1920;
globalThis.innerHeight = 1080;
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const doc = {
  createElement: (tag) => { const el = fakeEl(tag); el.ownerDocument = doc; return el; },
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  hidden: false,
};
doc.head = fakeEl("head"); doc.head.ownerDocument = doc;
doc.body = fakeEl("body"); doc.body.ownerDocument = doc;
doc.documentElement = fakeEl("html"); doc.documentElement.ownerDocument = doc;
globalThis.document = doc;

const LOCAL = 0x50000001;
const MOB = 0x80001234;
const LB = 0xA9B4001F;
let player = { landblockId: LB, x: 96, y: 96, z: 60, heading: 0.3 };
let mobPos = [LB, 110, 104, 60];
let selected = 0;
globalThis.getLocalPlayerGuid = () => LOCAL;
globalThis.__sessionHandle = {
  getLocalPlayerPose: () => ({ ...player }),
  getCurrentCellId: () => 0,
  nearbyEntityGuids: () => [MOB],
  objectPosition: (g) => (g === MOB ? mobPos.slice() : null),
  objectDescFlags: () => 0,
  objectIntProperty: (g, prop) => (prop === 133 ? 4 : prop === 1 ? 0x10 : undefined),
  objectName: () => "Drudge Skulker",
};
globalThis.liveScene3d = { entityManager: { getSelectedTarget: () => selected } };

const R = await import("../plugins/radar.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assert(cond, label) { if (!cond) throw new Error(label); }

const unmount = R.mount({});
let now = 10000;
function update() {
  const cb = rafQueue[rafQueue.length - 1];
  ctxCalls.clearRect = 0;
  ctxCalls.fillRect = 0;
  now += 30; // past UPDATE_INTERVAL_MS (25)
  cb(now);
  return { ...ctxCalls };
}

check("[1] the first update paints blip + centre", () => {
  const c = update();
  assertEq(c.clearRect, 1, "cleared once");
  assert(c.fillRect > 0, "drew pixels");
  const snap = window.__radar.snapshot();
  assertEq(snap.blips.length, 1, "one blip drawn");
});

check("[2] an unchanged update does not touch the canvas", () => {
  const c = update();
  assertEq(c, { clearRect: 0, fillRect: 0 }, "no clear, no fill");
  const again = update();
  assertEq(again, { clearRect: 0, fillRect: 0 }, "still nothing");
});

check("[3] a moved blip repaints once, then settles", () => {
  mobPos = [LB, 118, 112, 60];
  assertEq(update().clearRect, 1, "repaint on move");
  assertEq(update().clearRect, 0, "settled");
});

check("[3] a turned player repaints once, then settles", () => {
  player = { ...player, heading: player.heading + 0.4 };
  assertEq(update().clearRect, 1, "repaint on turn");
  assertEq(update().clearRect, 0, "settled");
});

check("[3] selecting the blip repaints (DrawSelected bracket), then settles", () => {
  selected = MOB;
  const c = update();
  assertEq(c.clearRect, 1, "repaint on select");
  assertEq(update().clearRect, 0, "settled");
  selected = 0;
  assertEq(update().clearRect, 1, "repaint on deselect");
});

check("[3] the BlackFog2 blank repaints to the centre marker only", () => {
  window.__radarBlank = true;
  const c = update();
  assertEq(c.clearRect, 1, "repaint on blank");
  const centreOnly = c.fillRect;
  assertEq(update().clearRect, 0, "settled while blank");
  window.__radarBlank = false;
  const back = update();
  assertEq(back.clearRect, 1, "repaint on unblank");
  assert(back.fillRect > centreOnly, "blip pixels back");
});

check("[4] paintStats counts updates vs paints", () => {
  const s = window.__radar.paintStats();
  assert(s.updates > s.paints, `updates ${s.updates} > paints ${s.paints}`);
  assert(s.paints >= 6, `paints counted (${s.paints})`);
});

try { unmount(); } catch (_) {}

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
