// tests/hud_map_marks.test.mjs — fps review 2026-10-19, HUD part (compact map).
//
// The compact map's tick runs every animation frame. It used to rewrite every
// marker's transform / display / title / data-kind / opacity / is-stale on
// every frame, standing still or not — style work for Blink and, for a layer
// that changes, a re-raster on the GPU process's main thread (the thread that
// also executes WebGL). The marker writes now go through markStyle / markTitle
// / markKind / markStale, which write only a value that differs from the one
// last written.
//
// CONTRACT
//   [1] markStyle / markTitle / markKind / markStale write once per distinct
//       value and report whether they wrote.
//   [2] the REAL compact view, mounted on a write-counting fake DOM: a second
//       tick with an unchanged pose writes NOTHING to the player / heading /
//       house / pin markers (the pre-change tick rewrote them every frame).
//   [3] a moved player rewrites the player transform only; a turned player
//       rewrites the heading transform only.
//   [4] losing the fix hides the player once, and only once.
//   [5] source: the tick no longer writes marker styles directly.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/hud_map_marks.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── write-counting fake DOM ─────────────────────────────────────────
const ALL = [];
function fakeEl(tag) {
  const cls = new Set();
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    writes: [],
    className: "",
    id: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    prepend(c) { c.parentNode = el; el.children.unshift(c); return c; },
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
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {},
  };
  el.style = new Proxy({ setProperty() {}, removeProperty() {} }, {
    set(t, k, v) { t[k] = v; el.writes.push(`style.${String(k)}`); return true; },
  });
  el.dataset = new Proxy({}, {
    set(t, k, v) { t[k] = v; el.writes.push(`data.${String(k)}`); return true; },
  });
  el.classList = {
    add(...c) { for (const x of c) cls.add(x); el.writes.push("class.add"); },
    remove(...c) { for (const x of c) cls.delete(x); el.writes.push("class.remove"); },
    toggle(c, force) {
      el.writes.push(`class.toggle.${c}`);
      const on = force === undefined ? !cls.has(c) : !!force;
      if (on) cls.add(c); else cls.delete(c);
      return on;
    },
    contains(c) { return cls.has(c); },
  };
  let title = "";
  Object.defineProperty(el, "title", {
    get() { return title; },
    set(v) { title = v; el.writes.push("title"); },
  });
  ALL.push(el);
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
globalThis.document = {
  createElement: (tag) => fakeEl(tag),
  getElementById: () => null,
  head: fakeEl("head"),
  body: fakeEl("body"),
  documentElement: fakeEl("html"),
  addEventListener() {}, removeEventListener() {},
  hidden: false,
};
for (const el of ALL) el.ownerDocument = globalThis.document;
const _create = globalThis.document.createElement;
globalThis.document.createElement = (tag) => { const el = _create(tag); el.ownerDocument = globalThis.document; return el; };

const M = await import("../plugins/map-panel.js");
const { markStyle, markTitle, markKind, markStale } = M;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assert(cond, label) { if (!cond) throw new Error(label); }

check("[1] mark* helpers write once per distinct value", () => {
  const el = fakeEl("div");
  assertEq(markStyle(el, "display", "block"), true, "first display write");
  assertEq(markStyle(el, "display", "block"), false, "same display skipped");
  assertEq(markStyle(el, "display", "none"), true, "changed display written");
  assertEq(markStyle(el, "transform", "translate(1.00px, 2.00px)"), true, "transform");
  assertEq(markStyle(el, "transform", "translate(1.00px, 2.00px)"), false, "same transform skipped");
  assertEq(markTitle(el, "Your house"), true, "title");
  assertEq(markTitle(el, "Your house"), false, "same title skipped");
  assertEq(markKind(el, "fellow"), true, "kind");
  assertEq(markKind(el, "fellow"), false, "same kind skipped");
  assertEq(markKind(el, "alleg"), true, "changed kind");
  assertEq(markStale(el, true), true, "stale on");
  assertEq(markStale(el, true), false, "stale on again skipped");
  assertEq(markStale(el, false), true, "stale off");
  assertEq(el.style.display, "none", "live display value");
  assertEq(el.dataset.kind, "alleg", "live kind value");
  assertEq(el.classList.contains("is-stale"), false, "live class state");
  assertEq(el.writes.length, 8, "exactly the 8 changing writes reached the element");
});

// ── the real compact view ───────────────────────────────────────────
let pose = { landblockId: 0xA9B4001F, x: 96, y: 96, z: 60, heading: 1.0 };
let havePose = true;
globalThis.__sessionHandle = {
  getLocalPlayerPose: () => (havePose ? { ...pose } : null),
  getCurrentCellId: () => 0,
};
const parent = fakeEl("div");
const unmount = M.view.mount(parent);
const byClass = (c) => ALL.find((e) => e.className === c);
const player = byClass("hb-map-mark hb-map-player");
const heading = byClass("hb-map-heading");
const house = byClass("hb-map-mark hb-map-house");
const pin = byClass("hb-map-mark hb-map-pin");
const markers = [player, heading, house, pin];
let now = 1000;
function runTick() {
  const cb = rafQueue[rafQueue.length - 1];
  for (const m of markers) m.writes.length = 0;
  now += 100; // past sampleFix's 10 ms memo
  cb(now);
}

check("[2] mounted: the four marker elements exist", () => {
  for (const [n, e] of [["player", player], ["heading", heading], ["house", house], ["pin", pin]]) {
    assert(e, `${n} marker element found`);
  }
});

check("[2] first tick places the markers, an unchanged second tick writes nothing", () => {
  runTick();
  assert(player.writes.includes("style.transform"), "player placed on tick 1");
  assert(player.writes.includes("style.display"), "player shown on tick 1");
  assert(heading.writes.includes("style.transform"), "heading set on tick 1");
  assertEq(house.writes, ["style.display"], "house hidden once (no house data)");
  assertEq(pin.writes, ["style.display"], "pin hidden once (no waypoint)");
  runTick();
  for (const [n, e] of [["player", player], ["heading", heading], ["house", house], ["pin", pin]]) {
    assertEq(e.writes, [], `${n} untouched on an unchanged tick`);
  }
});

check("[3] a move rewrites only the player transform; a turn only the heading", () => {
  pose = { ...pose, x: pose.x + 40 };
  runTick();
  assertEq(player.writes, ["style.transform"], "player transform only");
  assertEq(heading.writes, [], "heading untouched by a pure move");
  pose = { ...pose, heading: pose.heading + 0.5 };
  runTick();
  assertEq(heading.writes, ["style.transform"], "heading transform only");
  assertEq(player.writes, [], "player untouched by a pure turn");
});

check("[4] losing the fix hides the player once, and only once", () => {
  havePose = false;
  runTick();
  assert(player.writes.includes("style.display"), "hidden on the first fixless tick");
  assertEq(player.style.display, "none", "player display none");
  runTick();
  assertEq(player.writes, [], "no re-hide on the next fixless tick");
  havePose = true;
});

check("[5] source: the compact tick writes marker styles only through mark*", () => {
  const src = readFileSync(path.join(APP, "plugins/map-panel.js"), "utf8");
  const m = src.match(/const tick = \(now\) => \{([\s\S]*?)\n  \};\n  raf = requestAnimationFrame\(tick\);/);
  assert(m, "compact tick found");
  const body = m[1];
  assert(!/(playerEl|headingEl|houseEl|pinEl|el)\.style\.\w+\s*=/.test(body), "no direct marker style writes");
  assert(!/houseEl\.title\s*=/.test(body), "no direct house title write");
  assert(!/el\.dataset\.kind\s*=/.test(body), "no direct roster kind write");
  assert(!/playerEl\.classList\.toggle/.test(body), "no direct is-stale toggle");
});

try { unmount(); } catch (_) {}

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
