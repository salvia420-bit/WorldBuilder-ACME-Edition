// tests/hud_diet.test.mjs — R3-2 "HUD diet" + the HUD bisect flags (2026-10-31).
//
// ui/hud_diet.js reads `?hudDiet` (levers orbSync / orbLayer / radar / overlays
// / fontWrf, DEFAULT OFF) and the bisect flags `?hudPanels=off`,
// `?hudOrbs=off`, `?hudCanvases=off` (default: today's HUD). Every lever is
// pixel-neutral; the bisect flags each remove one part of what `?hud=none`
// removes.
//
// CONTRACT
//   [1] readers: parseHudDiet / parseHudOff grammar, the memoized page readers
//       and their test seam.
//   [2] bisect CSS: installHudBisect leaves the document untouched without a
//       flag; `hudPanels=off` / `hudOrbs=off` add the class + rules; the panels
//       rule is index.html's `html.no-hud` body rule minus the DOM-nameplate
//       selectors; ui/hud_scale.js installHudScale() installs it.
//   [3] radar, flags off: every 25 ms tick runs update() and a moving blip
//       repaints on every tick (today's 40 Hz); `hudDiet=off` / an unknown lever
//       / `hudCanvases=on` give the identical canvas call log.
//   [4] radar, `hudCanvases=off`: the blip canvas is display:none and gets no
//       2D calls; update() still runs.
//   [5] radar, `hudDiet=radar`: a translating blip repaints at <= 10 Hz (no two
//       paints < 100 ms apart, none deferred > 100 ms + one tick); a heading
//       change, a selection change, the BlackFog2 blank and the mouse over the
//       disk repaint on the same tick; at rest the last paint is call-for-call
//       the flag-off paint.
//   [6] orbs, `makeOrbAnimSync`: without the lever the call log is the pre-diet
//       step's, call for call (reference copied verbatim below), and
//       invalidate() is inert; with it every step samples every loop at the
//       same currentTime as the reference, light steps make no flushing call
//       (getAnimations / playState), and full steps run only at the first step,
//       after invalidate(), after a loop goes idle, after a throwing write, and
//       every ORB_SYNC_RECOLLECT_TICKS steps (which adopts a loop nobody
//       announced, with the same phase).
//   [7] orbs, `orbStyleText`: off = the pre-diet text plus nothing; orbLayer
//       appends exactly the `.hbo-core { will-change: opacity; }` rule; source
//       wiring of the levers in mount.
//   [8] selection brackets: flags off = today's per-tick writes and layout
//       reads; `hudDiet=overlays` = zero writes and zero clientWidth reads on a
//       still frame, one size read after a ResizeObserver callback, and the
//       same element state as flag-off after every tick of a scripted run.
//   [9] AC font atlas: off = getContext("2d") with no options; fontWrf =
//       { willReadFrequently: true }; identical pixels.
// The [3]-[9] diet checks fail on the pre-change code (no reader, no lever);
// the flags-off checks pin today's call pattern.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/hud_diet.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`); }
}
function assertEq(a, e, label) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assert(cond, label) { if (!cond) throw new Error(label); }

// ── fake DOM (radar + font + brackets) ───────────────────────────────────
let ctxLog = [];
function fakeCtx(canvas) {
  let fill = "";
  return {
    get fillStyle() { return fill; },
    set fillStyle(v) { fill = v; ctxLog.push(["fillStyle", v]); },
    clearRect(...a) { ctxLog.push(["clearRect", ...a]); },
    fillRect(...a) { ctxLog.push(["fillRect", ...a]); },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(img, x, y) { canvas._pixels = Array.from(img.data); canvas._put = [x, y]; },
  };
}
function fakeEl(tag) {
  const cls = new Set();
  const attrs = new Map();
  const listeners = new Map();
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
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener(t, fn) { const a = listeners.get(t); if (a) listeners.set(t, a.filter((f) => f !== fn)); },
    dispatch(t, ev) { for (const fn of listeners.get(t) || []) fn(ev); },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    hasAttribute(k) { return attrs.has(k); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120, x: 0, y: 0 }; },
    getContext(type, opts) {
      el._ctxArgs = opts === undefined ? [type] : [type, opts];
      if (!el._ctx) el._ctx = fakeCtx(el);
      return el._ctx;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {}, click() {},
    setPointerCapture() {}, releasePointerCapture() {},
  };
  return el;
}

let rafQueue = [];
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
  dispatchEvent() { return true; },
  hidden: false,
};
doc.head = fakeEl("head"); doc.head.ownerDocument = doc;
doc.body = fakeEl("body"); doc.body.ownerDocument = doc;
doc.documentElement = fakeEl("html"); doc.documentElement.ownerDocument = doc;
globalThis.document = doc;

// ── the radar's world ────────────────────────────────────────────────────
const LOCAL = 0x50000001;
const MOB = 0x80001234;
const LB = 0xA9B4001F;
let player, mobPos, selected;
let mobLeg = 0;
function resetWorld() {
  mobLeg = 0;
  player = { landblockId: LB, x: 96, y: 96, z: 60, heading: 0.3 };
  mobPos = [LB, 110, 104, 60];
  selected = 0;
  window.__radarBlank = false;
}
resetWorld();
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

const D = await import("../ui/hud_diet.js");
const R = await import("../plugins/radar.js");
const O = await import("../plugins/vitals-orbs.js");
const SB = await import("../scene3d/selection_brackets.js");
const F = await import("../ui/ac_font.js");
const HS = await import("../ui/hud_scale.js");

// ═════════════════════════════════════════════════════════════════════════
console.log("── [1] readers ──");

check("[1] parseHudDiet: absent / empty / off-forms → no lever", () => {
  for (const v of [null, undefined, "", " ", ",", "off", "OFF", "0", "false", "no", "none", " None "]) {
    assertEq(D.parseHudDiet(v), [], `=${JSON.stringify(v)}`);
  }
});
check("[1] parseHudDiet: on-forms (any case, trimmed) → every lever, canonical order", () => {
  for (const v of ["on", "ON", "1", "true", "yes", "all", " All ", "radar,on"]) {
    assertEq(D.parseHudDiet(v), [...D.HUD_DIET_LEVERS], `=${v}`);
  }
  assertEq([...D.HUD_DIET_LEVERS], ["orbSync", "orbLayer", "radar", "overlays", "fontWrf"], "lever list");
});
check("[1] parseHudDiet: lists name levers (case-insensitive, comma/space), unknowns ignored", () => {
  assertEq(D.parseHudDiet("radar"), ["radar"], "one");
  assertEq(D.parseHudDiet("RADAR, orbsync"), ["orbSync", "radar"], "canonical order, case");
  assertEq(D.parseHudDiet("fontWrf overlays"), ["overlays", "fontWrf"], "space separated");
  assertEq(D.parseHudDiet("radar,bogus,,radar"), ["radar"], "unknown + duplicate");
  assertEq(D.parseHudDiet("bogus"), [], "only unknown → none");
  assert(Object.isFrozen(D.parseHudDiet("radar")), "frozen");
});
check("[1] parseHudOff: off / 0 / false / no / none (any case, trimmed) remove; else keep", () => {
  for (const v of ["off", "Off", "0", "false", "FALSE", "no", "none", " off "]) assertEq(D.parseHudOff(v), true, `=${v}`);
  for (const v of [null, undefined, "", "on", "1", "true", "yes", "garbage"]) assertEq(D.parseHudOff(v), false, `=${v}`);
});
check("[1] page readers read the URL once (seam resets) and default off", () => {
  D.__setHudDietSearchForTest("");
  assertEq([D.hudDietLevers(), D.hudPanelsOff(), D.hudOrbsOff(), D.hudCanvasesOff()], [[], false, false, false], "absent");
  D.__setHudDietSearchForTest("?hudDiet=radar,overlays&hudPanels=off&hudOrbs=0&hudCanvases=no");
  assertEq([D.hudDietLevers(), D.hudPanelsOff(), D.hudOrbsOff(), D.hudCanvasesOff()],
    [["radar", "overlays"], true, true, true], "all set");
  assertEq([D.hudDietOn("radar"), D.hudDietOn("orbSync"), D.hudDietOn("nope")], [true, false, false], "hudDietOn");
  globalThis.location = { search: "?hudDiet=on" };
  D.__setHudDietSearchForTest(undefined);
  assertEq(D.hudDietLevers().length, 5, "window.location read");
  globalThis.location = { search: "" };
  assertEq(D.hudDietLevers().length, 5, "memoized: a later URL change is not re-read");
  D.__setHudDietSearchForTest(undefined);
  assertEq(D.hudDietLevers(), [], "re-read after the seam reset");
  delete globalThis.location;
  D.__setHudDietSearchForTest("");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [2] bisect CSS ──");

function miniDoc() {
  const byId = new Map();
  const cls = new Set();
  const head = { kids: [], appendChild(el) { head.kids.push(el); if (el.id) byId.set(el.id, el); return el; } };
  return {
    cls, head,
    documentElement: { classList: { add(c) { cls.add(c); }, contains: (c) => cls.has(c) } },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => ({ tag, id: "", textContent: "" }),
  };
}

check("[2] no bisect flag: document untouched, __hudBisect published", () => {
  D.__setHudDietSearchForTest("?hudDiet=radar");
  const d = miniDoc();
  const s = D.installHudBisect(d);
  assertEq([d.cls.size, d.head.kids.length], [0, 0], "no class, no style");
  assertEq(window.__hudBisect, { panels: false, orbs: false, canvases: false, diet: ["radar"] }, "probe");
  assertEq(s, window.__hudBisect, "return value");
  D.__setHudDietSearchForTest("?hudCanvases=off");
  const d2 = miniDoc();
  D.installHudBisect(d2);
  assertEq([d2.cls.size, d2.head.kids.length], [0, 0], "hudCanvases needs no CSS (radar.js)");
});
check("[2] hudPanels=off: class + rule = index.html's no-hud body rule without the nameplate selectors", () => {
  D.__setHudDietSearchForTest("?hudPanels=off");
  const d = miniDoc();
  D.installHudBisect(d);
  assert(d.cls.has(D.HUD_BISECT_CLASS.panels), "class");
  const css = d.head.kids[0].textContent;
  assertEq(d.head.kids[0].id, D.HUD_BISECT_STYLE_ID, "style id");
  assert(css.includes("html.hb-bisect-panels-off body > *:not(#stage) { display: none !important; }"), "body rule");
  assert(css.includes("html.hb-bisect-panels-off body .floating-panel { display: none !important; }"), "floating panel");
  assert(!/nameplate/.test(css), "no nameplate selector");
  const html = readFileSync(path.join(APP, "index.html"), "utf8");
  assert(html.includes("html.no-hud body > *:not(#stage) { display: none !important; }"), "index.html no-hud body rule unchanged (else re-copy)");
  assert(/html\.no-hud body \.floating-panel \{ display: none !important; \}/.test(html), "index.html .floating-panel rule unchanged");
  D.installHudBisect(d);
  assertEq(d.head.kids.length, 1, "idempotent");
});
check("[2] hudOrbs=off: only the three orb panes + defs", () => {
  D.__setHudDietSearchForTest("?hudOrbs=off");
  const d = miniDoc();
  D.installHudBisect(d);
  assert(d.cls.has(D.HUD_BISECT_CLASS.orbs) && !d.cls.has(D.HUD_BISECT_CLASS.panels), "orbs class only");
  const css = d.head.kids[0].textContent;
  for (const id of ["hb-vitals-orb-hp", "hb-vitals-orb-stam", "hb-vitals-orb-mana", "hb-vitals-orbs-defs"]) {
    assert(css.includes(`html.hb-bisect-orbs-off body > #${id}`), id);
  }
  assert(!css.includes("*:not(#stage)"), "no panels rule");
  const src = readFileSync(path.join(APP, "plugins/vitals-orbs.js"), "utf8");
  assert(/hp: "hb-vitals-orb-hp",\s*stam: "hb-vitals-orb-stam",\s*mana: "hb-vitals-orb-mana"/.test(src)
    && /const DEFS_ID = "hb-vitals-orbs-defs";/.test(src), "ids match plugins/vitals-orbs.js");
  assertEq(D.hudBisectCss({}), "", "no part → empty css");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [3]-[5] radar ──");

let now = 10000;
function radarTick(dt) {
  now += dt;
  let cb = null;
  for (let i = rafQueue.length - 1; i >= 0; i--) { if (rafQueue[i].name === "tick") { cb = rafQueue[i]; break; } }
  ctxLog = [];
  cb(now);
  const c = ctxLog;
  ctxLog = [];
  return c;
}
const clears = (log) => log.filter((e) => e[0] === "clearRect").length;
function lastPaint(log) {
  const i = log.map((e) => e[0]).lastIndexOf("clearRect");
  return i < 0 ? null : log.slice(i);
}
function findRadar() {
  const ov = doc.body.children.find((c) => c.id === "hb-radar");
  return { overlay: ov, canvas: ov.children.find((c) => c.className === "hb-radar-blips"),
    disk: ov.children.find((c) => c.className === "hb-radar-disk") };
}
/** Mount the real radar under `search`, run `fn`, unmount. */
function withRadar(search, fn) {
  D.__setHudDietSearchForTest(search);
  resetWorld();
  rafQueue = [];
  const unmount = R.mount({});
  try { return fn(findRadar()); } finally { unmount(); D.__setHudDietSearchForTest(""); }
}
const stats = () => window.__radar.paintStats();
// 3 m = 2 retail px per call, wrapping every 15 calls so the blip stays inside
// the 75 m range and never sits where it was 1-14 calls earlier.
const moveMob = () => { mobLeg += 1; mobPos = [LB, 110 + 3 * (mobLeg % 15), mobPos[2], 60]; };

/** The scripted world shared by the flag-off identity runs: a blip that moves
 *  every tick, then a turn, a selection, a blank, then rest. Returns the call log. */
function radarScript() {
  const log = [];
  log.push(radarTick(30));
  for (let i = 0; i < 8; i++) { moveMob(); log.push(radarTick(30)); }
  for (let i = 0; i < 3; i++) { player = { ...player, heading: player.heading + 0.2 }; log.push(radarTick(30)); }
  selected = MOB; log.push(radarTick(30));
  window.__radarBlank = true; log.push(radarTick(30));
  window.__radarBlank = false; log.push(radarTick(30));
  for (let i = 0; i < 4; i++) log.push(radarTick(30));
  return log;
}

check("[3] flags off: every 25 ms tick runs update(); a moving blip repaints every tick (40 Hz)", () => {
  withRadar("", ({ canvas }) => {
    radarTick(30);
    const s0 = stats();
    let paints = 0;
    for (let i = 0; i < 10; i++) { moveMob(); paints += clears(radarTick(30)); }
    const s1 = stats();
    assertEq([s1.updates - s0.updates, s1.paints - s0.paints, paints, s1.deferred - s0.deferred], [10, 10, 10, 0], "updates / paints / clears / deferred");
    assertEq(radarTick(10).length, 0, "the 25 ms gate is unchanged (10 ms later: nothing)");
    assertEq(canvas.style.display, undefined, "canvas display untouched");
  });
});
check("[3] flags off: hudDiet=off / unknown lever / other levers / hudCanvases=on → identical canvas call log", () => {
  const ref = withRadar("", () => radarScript());
  assert(ref.flat().length > 20, "the script paints");
  for (const s of ["?hudDiet=off", "?hudDiet=bogus", "?hudDiet=orbSync,orbLayer,overlays,fontWrf", "?hudCanvases=on", "?hudPanels=off&hudOrbs=off"]) {
    const got = withRadar(s, () => radarScript());
    assertEq(got, ref, s);
  }
});

check("[4] hudCanvases=off: canvas display:none, no 2D call, update() still runs", () => {
  withRadar("?hudCanvases=off", ({ canvas }) => {
    assertEq(canvas.style.display, "none", "hidden");
    const s0 = stats();
    const log = radarScript();
    const s1 = stats();
    assertEq(log.flat().length, 0, "no clearRect / fillRect / fillStyle");
    assertEq(s1.updates - s0.updates, log.length, "update() ran every tick");
    assertEq(s1.paints - s0.paints, 0, "no paint counted");
  });
});

check("[5] hudDiet=radar: a translating blip repaints at <= 10 Hz, never staler than 100 ms + 1 tick", () => {
  withRadar("?hudDiet=radar", () => {
    radarTick(30); // first: forced
    const s0 = stats();
    const paintAt = [];
    for (let i = 0; i < 40; i++) { moveMob(); if (clears(radarTick(30)) > 0) paintAt.push(now); }
    const s1 = stats();
    assert(paintAt.length >= 9 && paintAt.length <= 11, `~10 paints in 1.2 s (got ${paintAt.length})`);
    for (let i = 1; i < paintAt.length; i++) {
      const gap = paintAt[i] - paintAt[i - 1];
      assert(gap >= R.RADAR_DIET_MIN_MS && gap <= R.RADAR_DIET_MIN_MS + 30, `gap ${gap}`);
    }
    assert(s1.deferred - s0.deferred >= 25, `ticks deferred (${s1.deferred - s0.deferred})`);
    assertEq(s1.updates - s0.updates, paintAt.length, "a deferred tick runs no update()");
  });
});
check("[5] hudDiet=radar: turning repaints on every tick (tokens + blips at 40 Hz)", () => {
  withRadar("?hudDiet=radar", () => {
    radarTick(30);
    for (let i = 0; i < 6; i++) {
      player = { ...player, heading: player.heading + 0.1 };
      assertEq(clears(radarTick(30)), 1, `turn tick ${i}`);
    }
  });
});
check("[5] hudDiet=radar: selection, BlackFog2 blank and hover repaint/update on the same tick", () => {
  withRadar("?hudDiet=radar", ({ disk }) => {
    radarTick(30); radarTick(30);
    selected = MOB;
    assertEq(clears(radarTick(30)), 1, "select → bracket now");
    selected = 0;
    assertEq(clears(radarTick(30)), 1, "deselect now");
    window.__radarBlank = true;
    assertEq(clears(radarTick(30)), 1, "blank now");
    window.__radarBlank = false;
    assertEq(clears(radarTick(30)), 1, "unblank now");
    disk.dispatch("pointermove", { clientX: 10, clientY: 10 });
    let painted = 0;
    for (let i = 0; i < 4; i++) { moveMob(); painted += clears(radarTick(30)); }
    assertEq(painted, 4, "mouse over the disk: full rate");
    disk.dispatch("pointerleave", {});
    painted = 0;
    for (let i = 0; i < 3; i++) { moveMob(); painted += clears(radarTick(30)); }
    assert(painted <= 1, `mouse gone: throttled again (${painted})`);
  });
});
check("[5] hudDiet=radar: at rest the last paint equals the flag-off paint, call for call", () => {
  const run = (search) => withRadar(search, () => {
    const all = [];
    all.push(...radarTick(30));
    for (let i = 0; i < 5; i++) { moveMob(); all.push(...radarTick(30)); }
    selected = MOB; all.push(...radarTick(30));
    moveMob(); all.push(...radarTick(30));
    for (let i = 0; i < 6; i++) all.push(...radarTick(30)); // 180 ms of rest
    return lastPaint(all);
  });
  const off = run("");
  const on = run("?hudDiet=radar");
  assert(off && off.length > 3, "flag-off painted");
  assertEq(on, off, "same final pixels");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [6] orbs: makeOrbAnimSync ──");

O.__setOrbAnimSyncForTest(true);

function makeWorld() {
  const W = { T: 0, log: [], roots: [] };
  class Anim {
    constructor(id, { infinite = true, start = 0 } = {}) {
      this.id = id; this._start = start; this._hold = null; this._ps = "running";
      this.cancelled = false; this.throwOnce = false;
      this.effect = { getTiming: () => ({ iterations: infinite ? Infinity : 1 }) };
    }
    get currentTime() {
      W.log.push(`ct?${this.id}`);
      if (this.cancelled) return null;
      return this._ps === "paused" ? this._hold : W.T - this._start;
    }
    set currentTime(v) {
      W.log.push(`ct=${this.id}:${v}`);
      if (this.throwOnce) { this.throwOnce = false; throw new Error("set"); }
      if (this.cancelled) { this.cancelled = false; this._ps = "paused"; }
      if (this._ps === "paused") this._hold = v; else this._start = W.T - v;
    }
    get playState() { W.log.push("flush", `ps?${this.id}`); return this.cancelled ? "idle" : this._ps; }
    pause() { W.log.push(`pause ${this.id}`); if (this._ps !== "paused") { this._hold = W.T - this._start; this._ps = "paused"; } }
    play() { W.log.push(`play ${this.id}`); if (this._ps === "paused") { this._start = W.T - this._hold; this._ps = "running"; } }
    snap() {
      if (this.cancelled) return [this.id, "idle", null];
      return [this.id, this._ps, this._ps === "paused" ? this._hold : W.T - this._start];
    }
  }
  W.Anim = Anim;
  const mkRoot = (n) => ({ n, anims: [], getAnimations() { W.log.push("flush", `getAnimations ${n}`); return this.anims.filter((a) => !a.cancelled); } });
  W.roots = [mkRoot(0), mkRoot(1), mkRoot(2)];
  let id = 0;
  W.add = (r, opts) => { const a = new Anim(`a${id++}`, opts); W.roots[r].anims.push(a); return a; };
  for (let i = 0; i < 5; i++) W.add(0, { start: -1000 * i });
  for (let i = 0; i < 4; i++) W.add(1, { start: -700 * i });
  for (let i = 0; i < 4; i++) W.add(2, { start: -300 * i });
  W.add(2, { infinite: false, start: 0 }); // the finite damage glare
  W.snap = () => W.roots.flatMap((r) => r.anims.map((a) => a.snap()));
  return W;
}

// The pre-diet step (plugins/vitals-orbs.js makeOrbAnimSync, 2026-10-26 lane F,
// "reads first, then writes"), verbatim.
function makeReferenceSync(roots) {
  const _animStart = new WeakMap();
  let live = [];
  const todo = [];
  return {
    step(now) {
      todo.length = 0;
      for (const root of roots) {
        if (!root || typeof root.getAnimations !== "function") continue;
        let anims;
        try { anims = root.getAnimations({ subtree: true }); } catch (_) { continue; }
        for (const a of anims) {
          let start = _animStart.get(a);
          if (start === undefined) {
            let inf = false;
            try { inf = a.effect?.getTiming?.().iterations === Infinity; } catch (_) {}
            const ct = a.currentTime;
            if (!inf || ct == null) continue;
            start = now - Number(ct);
            _animStart.set(a, start);
          }
          let ps;
          try { ps = a.playState; } catch (_) { continue; }
          todo.push(a, start, ps);
        }
      }
      const next = [];
      for (let i = 0; i < todo.length; i += 3) {
        const a = todo[i];
        try {
          if (todo[i + 2] !== "paused") a.pause();
          a.currentTime = now - todo[i + 1];
          next.push(a);
        } catch (_) {}
      }
      todo.length = 0;
      live = next;
    },
    release(now) {
      for (const a of live) {
        try {
          const start = _animStart.get(a);
          if (start !== undefined) a.currentTime = now - start;
          a.play();
        } catch (_) {}
      }
      live = [];
    },
    get count() { return live.length; },
  };
}

const STEPS = 64;
const DT = 33; // integer ms: exact arithmetic in the twin worlds
const T_INVALIDATE = 8, T_CANCEL = 5, T_LATE = 12, T_THROW = 50, T_REBORN = 55;
/** Drive a sync through the scripted world. Returns per-step snapshots + flags. */
function runOrbScript(W, sync, { announce = true } = {}) {
  const snaps = [];
  const fullAt = [];
  let late = null;
  for (let i = 0; i < STEPS; i++) {
    W.T = 5000 + i * DT;
    if (i === T_CANCEL) W.roots[1].anims[0].cancelled = true;              // CSS cancelled a loop
    if (i === T_INVALIDATE) { W.add(0, { start: W.T }); if (announce) sync.invalidate?.(); } // `.beat` starts
    if (i === T_LATE) late = W.add(2, { start: W.T - 500 });               // a loop nobody announced
    if (i === T_THROW) W.roots[0].anims[1].throwOnce = true;               // a write throws once
    if (i === T_REBORN) { W.add(1, { start: W.T - 250 }); if (announce) sync.invalidate?.(); } // pane shown again
    const before = W.log.length;
    sync.step(W.T);
    const mine = W.log.slice(before);
    if (mine.some((e) => e.startsWith("getAnimations"))) fullAt.push(i);
    snaps.push({ i, s: W.snap(), flushes: mine.filter((e) => e === "flush").length });
  }
  W.T += DT;
  sync.release(W.T);
  return { snaps, fullAt, late, end: W.snap() };
}

check("[6] flag off: call log equals the pre-diet step, call for call; invalidate() is inert", () => {
  D.__setHudDietSearchForTest("");
  const Wr = makeWorld();
  const Wo = makeWorld();
  const ref = runOrbScript(Wr, Object.assign(makeReferenceSync(Wr.roots), { invalidate: undefined }));
  const off = runOrbScript(Wo, O.makeOrbAnimSync(Wo.roots)); // default = no lever; invalidate() called at 8 and 55
  assertEq(Wo.log, Wr.log, "identical call log");
  assertEq(off.end, ref.end, "identical end state");
  assertEq(off.fullAt.length, STEPS, "a full step every tick (today)");
  const Wx = makeWorld();
  runOrbScript(Wx, O.makeOrbAnimSync(Wx.roots, { cached: false }));
  assertEq(Wx.log, Wr.log, "explicit cached:false too");
});
check("[6] hudDiet=orbSync: same currentTime for every loop at every step; light steps flush nothing", () => {
  D.__setHudDietSearchForTest("?hudDiet=orbSync");
  const Wr = makeWorld();
  const Wc = makeWorld();
  const ref = runOrbScript(Wr, Object.assign(makeReferenceSync(Wr.roots), { invalidate() {} }));
  const got = runOrbScript(Wc, O.makeOrbAnimSync(Wc.roots)); // lever read from the URL
  const lateId = got.late.id;
  let adoptedAt = -1;
  for (let i = 0; i < STEPS; i++) {
    const a = ref.snaps[i].s;
    const b = got.snaps[i].s;
    assertEq(b.length, a.length, `step ${i} loop count`);
    for (let j = 0; j < a.length; j++) {
      if (a[j][0] === lateId && b[j][1] !== "paused") {
        assertEq(b[j][2], a[j][2], `step ${i} late loop: same currentTime on Blink's own clock`);
        continue;
      }
      if (a[j][0] === lateId && adoptedAt < 0) adoptedAt = i;
      assertEq(b[j], a[j], `step ${i} loop ${a[j][0]}`);
    }
    if (!got.fullAt.includes(i)) assertEq(got.snaps[i].flushes, 0, `light step ${i} flushes`);
  }
  assertEq(got.end, ref.end, "same state after release()");
  const N = O.ORB_SYNC_RECOLLECT_TICKS;
  assertEq(got.fullAt, [0, T_CANCEL, T_INVALIDATE, T_INVALIDATE + N, T_THROW + 1, T_REBORN], "full steps");
  assertEq(adoptedAt, T_INVALIDATE + N, "the unannounced loop is adopted by the safety net");
  assert(adoptedAt - T_LATE <= N, "within ORB_SYNC_RECOLLECT_TICKS");
  const refFlush = ref.snaps.reduce((n, s) => n + s.flushes, 0);
  const gotFlush = got.snaps.reduce((n, s) => n + s.flushes, 0);
  assert(gotFlush * 8 < refFlush, `flushing calls ${gotFlush} vs ${refFlush}`);
  D.__setHudDietSearchForTest("");
});
check("[6] hudDiet=orbSync: an un-announced pane show is still caught (idle loop / safety net)", () => {
  const Wr = makeWorld();
  const Wc = makeWorld();
  const ref = runOrbScript(Wr, Object.assign(makeReferenceSync(Wr.roots), { invalidate() {} }), { announce: false });
  const got = runOrbScript(Wc, O.makeOrbAnimSync(Wc.roots, { cached: true }), { announce: false });
  assertEq(got.end, ref.end, "same end state");
  for (let i = 0; i < STEPS; i++) {
    for (let j = 0; j < ref.snaps[i].s.length; j++) {
      assertEq(got.snaps[i].s[j][2], ref.snaps[i].s[j][2], `step ${i} loop ${j} currentTime`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [7] orbs: stylesheet + wiring ──");

check("[7] orbStyleText: off is the pre-diet text; orbLayer appends exactly one rule", () => {
  const off = O.orbStyleText();
  assertEq(O.orbStyleText({ orbLayer: false }), off, "explicit off");
  assert(!off.includes("will-change"), "no will-change without the lever");
  assert(off.includes(".hbo-pane .hbo-core {\n  position: absolute;") && off.includes("contain: layout paint style;"), "the core rule is intact");
  const on = O.orbStyleText({ orbLayer: true });
  assert(on.startsWith(off), "prefix = the off text");
  assertEq(on.slice(off.length), "\n.hbo-pane .hbo-core { will-change: opacity; }\n", "appended rule");
  assert(!on.includes("will-change: transform"), "never will-change: transform (raster translation)");
});
check("[7] source: mount reads the levers once; the driver/sync pins are unchanged", () => {
  const src = readFileSync(path.join(APP, "plugins/vitals-orbs.js"), "utf8");
  assert(/const dietSync = hudDietOn\("orbSync"\);\s*ensureStyles\(\{ orbLayer: hudDietOn\("orbLayer"\) \}\);/.test(src), "levers at mount");
  assert(/if \(dietSync && p\.hidden !== h\) changed = true;[\s\S]{0,80}if \(changed\) driver\.invalidateAnims\(\);/.test(src), "setHidden invalidates on a change, diet only");
  assert(/function applyLowState\(orb, frac, driver\) \{[\s\S]{0,200}driver\?\.invalidateAnims\?\.\(\);/.test(src), "low-HP toggle invalidates");
  assert(/const cached = opts && opts\.cached !== undefined \? !!opts\.cached : hudDietOn\("orbSync"\);/.test(src), "sync reads the lever");
  assert(/const sync = reducedMotion \? null : makeOrbAnimSync\(syncRoots\);/.test(src)
    && /createDriver\(orbs, reduced, orbHz\(\), paneList\)/.test(src), "hud_orb_anim_sync.test.mjs pins intact");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [8] selection brackets ──");

const ROs = [];
class FakeRO { constructor(cb) { this.cb = cb; ROs.push(this); } observe(el) { this.el = el; } disconnect() { this.off = true; } }
globalThis.ResizeObserver = FakeRO;

function bracketDom() {
  const writes = [];
  let reads = 0;
  const mkEl = (tag) => {
    const store = {};
    const el = {
      tagName: tag, className: "", dataset: {}, parentNode: null,
      style: new Proxy(store, {
        set(t, k, v) { writes.push([el.className.split(" ").pop(), k, v]); t[k] = v; return true; },
        get(t, k) { return k in t ? t[k] : ""; },
      }),
      _store: store,
    };
    return el;
  };
  const d = { createElement: mkEl };
  const root = mkEl("div");
  root.ownerDocument = d;
  root.kids = [];
  root.appendChild = (c) => { c.parentNode = root; root.kids.push(c); return c; };
  root.removeChild = (c) => { c.parentNode = null; };
  const canvas = {
    width: 1600, height: 1200, cw: 800, ch: 600,
    get clientWidth() { reads += 1; return this.cw; },
    get clientHeight() { reads += 1; return this.ch; },
  };
  return { root, canvas, writes, reads: () => reads };
}
const cam = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
cam.updateMatrixWorld(true);
const rig = new THREE.Object3D();
const sphere = () => ({ offset: new THREE.Vector3(0, 0, 0), radius: 1 });
function makeBrackets(search) {
  D.__setHudDietSearchForTest(search);
  const dom = bracketDom();
  const layer = new SB.SelectionBracketLayer(dom.root, dom.canvas);
  D.__setHudDietSearchForTest("");
  return { layer, dom };
}
const elState = (l) => [l._tl, l._tr, l._bl, l._br, l._arrow].map((e) => [e._store.display, e._store.transform ?? ""]);
const at = (x, y, z) => { rig.position.set(x, y, z); rig.updateMatrixWorld(true); };

check("[8] flags off: today's per-tick pattern (5 hides / 2 layout reads + 5 writes)", () => {
  const { layer, dom } = makeBrackets("");
  dom.writes.length = 0;
  layer.tick(cam);
  assertEq(dom.writes.map((w) => w[1] + "=" + w[2]), Array(5).fill("display=none"), "no target: 5 same-value hides");
  at(0, 0, -10);
  layer.setTarget(MOB, rig, sphere());
  layer.tick(cam);
  const r0 = dom.reads();
  dom.writes.length = 0;
  layer.tick(cam);
  assertEq(dom.reads() - r0, 2, "clientWidth + clientHeight every tick");
  assertEq(dom.writes.map((w) => w[1]), ["transform", "transform", "transform", "transform", "display"], "4 transforms + arrow hide");
  assertEq(layer._size, null, "no size cache");
});
check("[8] hudDiet=overlays: still frame = 0 writes, 0 layout reads; same state as flag-off every tick", () => {
  const off = makeBrackets("");
  const on = makeBrackets("?hudDiet=overlays");
  const ro = ROs[ROs.length - 1];
  assert(ro && ro.el === on.dom.canvas, "ResizeObserver on the scene canvas");
  const script = [
    () => {}, () => {},                                            // no target
    () => { at(0, 0, -10); return [MOB, rig, sphere()]; },          // select, on-screen
    () => {}, () => {}, () => {},                                   // still
    () => { at(0.5, 0, -10); },                                     // target moves
    () => { off.dom.canvas.cw = on.dom.canvas.cw = 1000; ro.cb([]); }, // resize
    () => {},
    () => { at(100, 0, -10); },                                     // off-screen (arrow)
    () => {}, () => { at(0, 0, 10); },                              // behind
    () => { at(0, 0, -10); }, () => {},                             // back on-screen
    () => [0, null, null], () => {},                                // deselect
  ];
  const perTick = [];
  for (const step of script) {
    const w0 = on.dom.writes.length, r0 = on.dom.reads(), ow0 = off.dom.writes.length;
    const sel = step();
    if (sel) { off.layer.setTarget(...sel); on.layer.setTarget(...sel); }
    off.layer.tick(cam);
    on.layer.tick(cam);
    assertEq(elState(on.layer), elState(off.layer), `element state after tick ${perTick.length}`);
    assertEq([on.layer.lastStatus, on.layer.lastRect], [off.layer.lastStatus, off.layer.lastRect], `diag after tick ${perTick.length}`);
    perTick.push({ w: on.dom.writes.length - w0, r: on.dom.reads() - r0, ow: off.dom.writes.length - ow0 });
  }
  assertEq([perTick[1].w, perTick[1].r], [0, 0], "no target, 2nd tick: nothing written");
  for (const i of [3, 4, 5]) assertEq([perTick[i].w, perTick[i].r], [0, 0], `still on-screen tick ${i}`);
  assert(perTick[5].ow === 5, "flag-off writes 5 on the same frame");
  assertEq(perTick[2].r, 2, "first on-screen tick reads the size once");
  assertEq(perTick[7].r, 2, "after the ResizeObserver callback: one size read");
  assertEq(perTick[8].r, 0, "then cached again");
  assertEq([perTick[10].w, perTick[11].w], [1, 1], "off-screen / behind again: only the arrow transform");
  assertEq(perTick[14].w, 4, "deselect: the four corners hidden once");
  assertEq(perTick[15].w, 0, "deselected and hidden: nothing written");
  on.layer.dispose();
  assert(ro.off === true, "dispose disconnects the observer");
});
check("[8] makeCanvasCssSize: live without ResizeObserver; window resize invalidates", () => {
  let n = 0;
  const c = { get clientWidth() { n += 1; return 0; }, get clientHeight() { n += 1; return 7; }, width: 33, height: 9 };
  const live = D.makeCanvasCssSize(c, {});
  assertEq([live.read().w, live.read().h, live.cached, n], [33, 7, false, 4], "fallbacks, read every time");
  const ls = new Map();
  const env = { ResizeObserver: FakeRO, addEventListener: (t, f) => ls.set(t, f), removeEventListener: (t) => ls.delete(t) };
  n = 0;
  const s = D.makeCanvasCssSize(c, env);
  s.read(); s.read(); s.read();
  assertEq(n, 2, "one read while clean");
  ls.get("resize")();
  s.read();
  assertEq(n, 4, "re-read after window resize");
  s.dispose();
  assert(!ls.has("resize"), "listener removed");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [9] AC font atlas ──");

check("[9] atlas: off = getContext('2d'); fontWrf = willReadFrequently; same pixels", () => {
  const px = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 255, 77, 77, 77, 255]);
  D.__setHudDietSearchForTest("");
  const a = F.__atlasToCanvasForTest(px, 2, 2);
  D.__setHudDietSearchForTest("?hudDiet=fontWrf");
  const b = F.__atlasToCanvasForTest(px, 2, 2);
  D.__setHudDietSearchForTest("");
  assertEq(a._ctxArgs, ["2d"], "off: no options argument");
  assertEq(b._ctxArgs, ["2d", { willReadFrequently: true }], "fontWrf");
  assertEq(b._pixels, a._pixels, "identical atlas pixels");
  assertEq(a._pixels.slice(0, 8), [255, 255, 255, 10, 255, 255, 255, 200], "mask in alpha");
});

// ═════════════════════════════════════════════════════════════════════════
console.log("── [2b] hud_scale wiring (last: it changes the HUD scale) ──");

check("[2] installHudScale() installs the bisect CSS before plugins mount", () => {
  D.__setHudDietSearchForTest("?hudPanels=off&hudOrbs=off");
  HS.installHudScale();
  assert(doc.documentElement.classList.contains(D.HUD_BISECT_CLASS.panels), "panels class on <html>");
  assert(doc.documentElement.classList.contains(D.HUD_BISECT_CLASS.orbs), "orbs class on <html>");
  const style = doc.head.children.find((c) => c.id === D.HUD_BISECT_STYLE_ID);
  assert(style && /hb-bisect-panels-off/.test(style.textContent), "bisect <style> in <head>");
  assertEq(window.__hudBisect.panels, true, "probe");
  D.__setHudDietSearchForTest("");
});

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
