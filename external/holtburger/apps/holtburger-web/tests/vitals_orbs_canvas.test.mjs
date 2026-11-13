// tests/vitals_orbs_canvas.test.mjs — ?orbRender (2026-10-31): the vitals-orb
// vessel core drawn with Canvas2D (plugins/vitals-orbs.js, owner ask "make the
// orbs cheaper"). DEFAULT ON since the 1070 S2-ORB flip (2026-10-31); the
// signed-off SVG vessel is the escape, `?orbRender=svg` (or off/0/false/no).
//
// The plugin's real mount() runs here over a small fake DOM: a markup parser
// for the innerHTML the plugin writes, simple selectors (tag / .class / #id /
// descendant), a mutation LOG of every DOM write, a fake clock + rAF, and a
// recording 2D context.
//
// CONTRACT
//   [1] orbRenderMode(): svg / off / 0 / false / no (trimmed, any case) →
//       "svg" (the escape); anything else — absent, empty, canvas, on, junk —
//       → "canvas" (the default); memoized; the test seam re-reads the URL.
//   [2] the ESCAPE: a scripted session (mount, snapshot, 30 Hz ticks, a 25%
//       hit with its glare and timer, low HP + the fracture web, a vitae
//       snapshot, a pointer probe, hide / show, tab hidden / visible, unmount)
//       writes the SAME DOM log (every element, innerHTML string, attribute,
//       class, style, text, hidden flag and SVGTransform write, in order) for
//       every escape form, and its sha256 is the one the pre-change plugin
//       wrote with no flag at all (GOLDEN): `?orbRender=svg` IS the signed-off
//       vessel, byte for byte. The DEFAULT (absent, empty, junk) mounts canvas.
//   [3] canvas: same panes, heraldry, plaques and stylesheet; each core holds
//       one canvas.orb-cv (CSS 92 px) and no <svg>; no shared <defs>; per tick
//       no DOM write at all; the backing store is 92 x orbScale x zoom x DPR.
//   [4] state mapping from vitals updates: fill → the drawn surface height;
//       slosh (|Δ|/max) → a taller wave that decays; glare on damage only
//       (screen ellipse on the hbo-glare keyframe steps); low HP → the low
//       colour band, glints, heartbeat class; vitae → ceiling-capped fill and
//       the vitae layer (baked per ceiling); mana alone draws the shimmer.
//   [5] bakes: static layers baked once per backing size; a resize / DPR /
//       HUD-zoom / orbScale change re-bakes only when the size changes; the
//       low band adds one subglow variant, once.
//   [6] skipping: an idle vessel skips most cadence ticks and a skipped tick
//       issues ZERO context calls; a slosh draws every tick; drawn frames stay
//       within CV_SKIP_PX device px of the exact surface; a glare step is drawn
//       off-cadence.
//   [7] hidden: with every pane hidden nothing is drawn and the loop stops;
//       showing a pane resumes it; a hidden tab pauses it.
//   [8] pointer hit test: canvas-mode probe grid == SVG-mode probe grid.
//   [9] the JS keyframe samplers equal the stylesheet's @keyframes values.
//   [10] reduced motion: no rAF; every vitals change repaints one still frame
//       at the new level (canvas only; the SVG path is unchanged).
//
// Run:   cd apps/holtburger-web && node tests/vitals_orbs_canvas.test.mjs [--bench]
//        --bench: JS µs per tick, SVG vs canvas, plus per-tick work counts.

import { createHash } from "node:crypto";

// ── fake clock, rAF, timers ─────────────────────────────────────────────────
let NOW = 1000;
let rafQ = [];
let rafId = 0;
let timers = [];
let timerId = 0;
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafQ.push({ id, cb }); return id; };
globalThis.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((r) => r.id !== id); };
globalThis.setTimeout = (fn, ms = 0) => { const id = ++timerId; timers.push({ id, at: NOW + ms, fn, every: 0 }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
globalThis.setInterval = (fn, ms = 0) => { const id = ++timerId; timers.push({ id, at: NOW + ms, fn, every: ms || 1 }); return id; };
globalThis.clearInterval = globalThis.clearTimeout;
Object.defineProperty(globalThis, "performance", { value: { now: () => NOW }, configurable: true, writable: true });
function runTimers() {
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0];
    if (!t || t.at > NOW) return;
    if (t.every) t.at += t.every; else timers.shift();
    t.fn();
  }
}
/** Advance `n` vsyncs of `ms` each: timers, then this frame's rAF callbacks. */
function pump(n, ms = 1000 / 60) {
  for (let i = 0; i < n; i++) {
    NOW += ms;
    runTimers();
    const q = rafQ; rafQ = [];
    for (const r of q) r.cb(NOW);
  }
}

// ── fake DOM ────────────────────────────────────────────────────────────────
let LOG = [];
let nextEl = 0;
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "image", "defs", "clipPath",
  "linearGradient", "radialGradient", "stop", "pattern", "filter", "feTurbulence", "feDisplacementMap"]);
let CTX_CALLS = 0;

function makeCtx(canvas) {
  const st = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000000", strokeStyle: "#000000",
    lineWidth: 1, lineJoin: "miter", lineCap: "butt", filter: "none", imageSmoothingEnabled: true, imageSmoothingQuality: "low" };
  const log = (canvas._log = canvas._log || []);
  const ctx = { canvas };
  for (const k of Object.keys(st)) {
    Object.defineProperty(ctx, k, {
      get: () => st[k],
      set: (v) => { st[k] = v; CTX_CALLS++; if (!BENCH_QUIET) log.push(["set", k, v]); },
      enumerable: true,
    });
  }
  for (const m of ["save", "restore", "setTransform", "translate", "scale", "rotate", "clearRect", "fillRect",
    "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "arc", "ellipse", "rect", "fill", "stroke",
    "clip", "drawImage"]) {
    ctx[m] = (...a) => { CTX_CALLS++; if (!BENCH_QUIET) log.push([m, ...a]); };
  }
  const grad = (kind) => (...a) => {
    CTX_CALLS++;
    const g = { kind, args: a, stops: [], addColorStop(o, c) { this.stops.push([o, c]); } };
    if (!BENCH_QUIET) log.push(["create" + kind, g]);
    return g;
  };
  ctx.createLinearGradient = grad("Linear");
  ctx.createRadialGradient = grad("Radial");
  return ctx;
}
let BENCH_QUIET = false;

function makeStyle(el) {
  const vars = new Map();
  const base = {
    setProperty(k, v) { vars.set(k, String(v)); LOG.push(["style.set", el._id, k, String(v)]); },
    removeProperty(k) { vars.delete(k); LOG.push(["style.rm", el._id, k]); },
    getPropertyValue(k) { return vars.get(k) ?? ""; },
    _vars: vars,
  };
  return new Proxy(base, {
    get(t, k) { return k in t ? t[k] : (t["_" + String(k)] ?? ""); },
    set(t, k, v) { t["_" + String(k)] = v; LOG.push(["style", el._id, String(k), String(v)]); return true; },
  });
}

class FakeEl {
  constructor(tag, ns, quiet) {
    this._id = ++nextEl;
    this.localName = tag;
    this.tagName = tag.toUpperCase();
    this.namespaceURI = ns || (SVG_TAGS.has(tag) ? SVG_NS : "http://www.w3.org/1999/xhtml");
    this._attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this._ls = new Map();
    this.dataset = {};
    this._hidden = false;
    this._text = "";
    this.style = makeStyle(this);
    this.currentCSSZoom = 1;
    const self = this;
    this.classList = {
      _set() { return new Set((self._attrs.get("class") || "").split(/\s+/).filter(Boolean)); },
      _w(s) { self._attrs.set("class", [...s].join(" ")); },
      add(...c) { const s = this._set(); for (const x of c) s.add(x); this._w(s); LOG.push(["class+", self._id, c.join(" ")]); },
      remove(...c) { const s = this._set(); for (const x of c) s.delete(x); this._w(s); LOG.push(["class-", self._id, c.join(" ")]); },
      toggle(c, force) {
        const s = this._set(); const on = force === undefined ? !s.has(c) : !!force;
        if (on) s.add(c); else s.delete(c); this._w(s); LOG.push(["class~", self._id, c, on]); return on;
      },
      contains(c) { return this._set().has(c); },
    };
    if (tag === "canvas") { this.width = 300; this.height = 150; this._ctx = null; }
    if (this.namespaceURI === SVG_NS) {
      this.transform = { baseVal: { clear() { LOG.push(["xf.clear", self._id]); }, appendItem() { LOG.push(["xf.append", self._id]); } } };
    }
    if (!quiet) LOG.push(["create", tag, this._id]);
  }
  get id() { return this._attrs.get("id") || ""; }
  set id(v) { this._attrs.set("id", String(v)); LOG.push(["id", this._id, String(v)]); }
  get className() { return this._attrs.get("class") || ""; }
  set className(v) { this._attrs.set("class", String(v)); LOG.push(["className", this._id, String(v)]); }
  get hidden() { return this._hidden; }
  set hidden(v) { this._hidden = !!v; LOG.push(["hidden", this._id, !!v]); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); LOG.push(["text", this._id, String(v)]); }
  get isConnected() { let e = this; while (e.parentNode) e = e.parentNode; return e === DOC.documentElement; }
  set innerHTML(html) {
    LOG.push(["html", this._id, String(html)]);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    parseInto(this, String(html));
  }
  setAttribute(k, v) {
    this._attrs.set(k, String(v)); LOG.push(["attr", this._id, k, String(v)]);
    if (this.localName === "canvas" && (k === "width" || k === "height")) this[k] = Number(v);
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  removeAttribute(k) { this._attrs.delete(k); LOG.push(["attr-", this._id, k]); }
  hasAttribute(k) { return this._attrs.has(k); }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this; this.children.push(c); LOG.push(["append", this._id, c._id]); return c;
  }
  remove() {
    const p = this.parentNode;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null; LOG.push(["remove", this._id]);
  }
  addEventListener(t, fn) { if (!this._ls.has(t)) this._ls.set(t, []); this._ls.get(t).push(fn); }
  removeEventListener(t, fn) { const a = this._ls.get(t); if (a) this._ls.set(t, a.filter((f) => f !== fn)); }
  dispatchEvent(ev) { for (const fn of [...(this._ls.get(ev.type) || [])]) fn(ev); return true; }
  createSVGTransform() {
    const id = this._id;
    return { setTranslate(x, y) { LOG.push(["xf.translate", id, x, y]); } };
  }
  getContext(type) {
    if (type !== "2d" || this.localName !== "canvas") return null;
    if (!this._ctx) this._ctx = makeCtx(this);
    return this._ctx;
  }
  matches(sel) { return matchesCompound(this, sel); }
  closest(sel) { let e = this; while (e && e.localName) { if (matchesSelector(e, sel)) return e; e = e.parentNode; } return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (e) => { for (const c of e.children) { if (matchesSelector(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get childElementCount() { return this.children.length; }
  get offsetWidth() { return this._box().w; }
  get offsetHeight() { return this._box().h; }
  get offsetLeft() { return this._box().x; }
  get offsetTop() { return this._box().y; }
  // The badge's card layout (196x168 per pane), in pane px.
  _box() {
    const c = this.classList;
    if (c.contains("hbo-pane")) return this.hidden ? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: 196, h: 168 };
    if (c.contains("hbo-core")) return { x: 52, y: 38, w: 92, h: 92 };
    if (c.contains("orb-read")) return { x: 18, y: 132, w: 160, h: 36 };
    if (c.contains("fig-asheron")) return { x: 10, y: 4, w: 54, h: 116 };
    if (c.contains("fig-bael")) return { x: 124, y: 22, w: 66, h: 98 };
    if (c.contains("fig-bow")) return { x: 23, y: 88, w: 150, h: 39 };
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  // Viewport px: a pane's style.left/top are in its own (HUD-zoomed) px and
  // it carries transform: scale(--hbo-scale) from its top-left corner.
  getBoundingClientRect() {
    const z = Number(this.currentCSSZoom) || 1;
    const left = (parseFloat(this.style.left) || 0) * z, top = (parseFloat(this.style.top) || 0) * z;
    const sc = parseFloat(this.style._vars?.get("--hbo-scale")) || 0.72;
    const isPane = this.classList.contains("hbo-pane");
    const w = (isPane ? 196 * sc : 92) * z, h = (isPane ? 168 * sc : 92) * z;
    return { left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top };
  }
}

function parseInto(parent, html) {
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  const stack = [parent];
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) { if (m[5].trim()) stack[stack.length - 1]._text += m[5]; continue; }
    const [, close, tag, attrs, self] = m;
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === tag) { stack.length = i; break; }
      continue;
    }
    const top = stack[stack.length - 1];
    const el = new FakeEl(tag, tag === "svg" || top.namespaceURI === SVG_NS ? SVG_NS : null, true);
    for (const a of attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      el._attrs.set(a[1], a[2] ?? "");
      if (a[1] === "style") for (const d of (a[2] || "").split(";")) {
        const i = d.indexOf(":"); if (i > 0) el.style._vars.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
      }
      if (el.localName === "canvas" && (a[1] === "width" || a[1] === "height")) el[a[1]] = Number(a[2]);
    }
    el.parentNode = top; top.children.push(el);
    if (!self) stack.push(el);
  }
}
function matchesCompound(el, comp) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(comp);
  if (!m) return false;
  if (m[1] && el.localName !== m[1]) return false;
  for (const p of m[2].match(/[.#][\w-]+/g) || []) {
    if (p[0] === "." && !el.classList.contains(p.slice(1))) return false;
    if (p[0] === "#" && el.id !== p.slice(1)) return false;
  }
  return true;
}
function matchesSelector(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let e = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (e && e.localName && !matchesCompound(e, parts[i])) e = e.parentNode;
    if (!e || !e.localName) return false;
    e = e.parentNode;
  }
  return true;
}

const DOC = {};
function resetDom() {
  LOG = [];
  nextEl = 0;
  const html = new FakeEl("html", null, true);
  const head = new FakeEl("head", null, true);
  const body = new FakeEl("body", null, true);
  head.parentNode = html; body.parentNode = html; html.children.push(head, body);
  Object.assign(DOC, { documentElement: html, head, body });
}
let DOC_HIDDEN = false;
const docLs = new Map();
const winLs = new Map();
const on = (map) => (t, fn) => { if (!map.has(t)) map.set(t, []); map.get(t).push(fn); };
const off = (map) => (t, fn) => { const a = map.get(t); if (a) map.set(t, a.filter((f) => f !== fn)); };
const fire = (map, t, ev = {}) => { for (const fn of [...(map.get(t) || [])]) fn({ type: t, ...ev }); };
resetDom();
globalThis.document = {
  get documentElement() { return DOC.documentElement; },
  get head() { return DOC.head; },
  get body() { return DOC.body; },
  get hidden() { return DOC_HIDDEN; },
  baseURI: "http://test/app/",
  timeline: { get currentTime() { return NOW; } },
  createElement: (tag) => new FakeEl(String(tag).toLowerCase()),
  createElementNS: (ns, tag) => new FakeEl(tag, ns),
  getElementById: (id) => {
    const walk = (e) => { for (const c of e.children) { if (c.id === id) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(DOC.documentElement);
  },
  addEventListener: on(docLs),
  removeEventListener: off(docLs),
  dispatchEvent: (ev) => { fire(docLs, ev.type, { detail: ev.detail }); return true; },
};
globalThis.addEventListener = on(winLs);
globalThis.removeEventListener = off(winLs);
globalThis.innerWidth = 1920;
globalThis.innerHeight = 1080;
globalThis.devicePixelRatio = 1;
const LS = new Map();
globalThis.localStorage = { getItem: (k) => (LS.has(k) ? LS.get(k) : null), setItem: (k, v) => LS.set(k, String(v)), removeItem: (k) => LS.delete(k) };
globalThis.getComputedStyle = (el) => ({
  getPropertyValue: (n) => el.style._vars?.get(n) ?? (n === "--hbo-scale" ? "0.72" : ""),
  get pointerEvents() { return el.style.pointerEvents || "none"; },
  get backgroundImage() {
    const c = el.classList;
    const f = c.contains("fig-asheron") ? "asheron.png" : c.contains("fig-bael") ? "baelzharon-se.png" : c.contains("fig-bow") ? "composite-bow.png" : null;
    return f ? `url("http://test/app/data/orb-sprites/${f}")` : "none";
  },
});
let REDUCED = false;
const mqLs = [];
globalThis.matchMedia = (q) => ({
  media: q,
  get matches() { return /reduced-motion/.test(q) ? REDUCED : false; },
  addEventListener: (t, fn) => mqLs.push({ q, fn }),
  removeEventListener: (t, fn) => { const i = mqLs.findIndex((x) => x.fn === fn); if (i >= 0) mqLs.splice(i, 1); },
});
// Images never load unless a test says so (sprite masks / SVG bakes stay pending).
const IMAGES = [];
globalThis.Image = class { constructor() { this.onload = null; this.onerror = null; } set src(v) { this._src = v; IMAGES.push(this); } get src() { return this._src; } };
globalThis.location = { search: "" };

const O = await import("../plugins/vitals-orbs.js");
const D = await import("../ui/hud_diet.js");
D.__setHudDietSearchForTest?.("?hudDiet=off");

// ── harness ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${String(err && err.message ? err.message : err).slice(0, 400)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertEq(a, e, m) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${m}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");

/** Mount the plugin under `search` on a fresh document; returns handles. A
 *  mount a failed check left behind is torn down first, so one failure never
 *  cascades into the next check (shared layer sets are refcounted). */
let ACTIVE = null;
function mountWith(search, { client = true, reduced = false, dpr = 1 } = {}) {
  if (ACTIVE) { try { ACTIVE(); } catch (_) {} ACTIVE = null; }
  resetDom();
  rafQ = []; timers = []; IMAGES.length = 0; mqLs.length = 0;
  docLs.clear(); winLs.clear(); LS.clear();
  NOW = 1000; DOC_HIDDEN = false; REDUCED = reduced; globalThis.devicePixelRatio = dpr;
  globalThis.location = { search };
  O.__setOrbRenderForTest?.(undefined);
  O.__setOrbAnimSyncForTest?.(undefined);
  const listeners = new Map();
  const c = client ? {
    events: { on: (t, fn) => listeners.set(t, fn), off: (t) => listeners.delete(t) },
    player: { stats: { vitals: [] } },
  } : null;
  const raw = O.mount(c ? { client: c } : {});
  let done = false;
  const unmount = () => { if (done) return; done = true; ACTIVE = null; raw(); };
  ACTIVE = unmount;
  const emit = (t, detail) => listeners.get(t)?.({ detail });
  const snapshot = (vitals) => { c.player.stats.vitals = vitals; listeners.get("playerStatsUpdated")?.(); };
  const pane = (k) => document.getElementById(`hb-vitals-orb-${k}`);
  return { unmount, emit, snapshot, pane, diag: window.__diag.vitalsOrbs };
}
const V = (hp, hpMax, st, stMax, mn, mnMax, base = null) =>
  [1, hp, base ?? hpMax, hpMax, 3, st, stMax, stMax, 5, mn, mnMax, mnMax];

// The scripted flag-off session: returns the DOM log.
function svgSession(search) {
  const m = mountWith(search);
  m.snapshot(V(240, 300, 150, 200, 90, 100));
  pump(40);
  m.emit("vitalChangedHealth", { current: 165, buffedMax: 300, oldValue: 240 });  // 25% hit
  pump(30);
  m.emit("vitalChangedHealth", { current: 30, buffedMax: 300, oldValue: 165 });   // low band
  pump(90);   // glare timer fires inside this
  m.emit("vitalChangedHealth", { current: 120, buffedMax: 300, oldValue: 30 });   // heal out of low
  pump(10);
  m.snapshot(V(265, 265, 150, 200, 90, 100, 312));                               // vitae
  pump(20);
  fire(docLs, "pointermove", { clientX: 260 + 98 * 0.72, clientY: 6 + 84 * 0.72 });
  fire(docLs, "pointermove", { clientX: 5, clientY: 900 });
  m.snapshot([]);                                                                  // hidden
  pump(10);
  m.snapshot(V(200, 300, 150, 200, 90, 100));
  pump(10);
  DOC_HIDDEN = true; fire(docLs, "visibilitychange"); pump(10);
  DOC_HIDDEN = false; fire(docLs, "visibilitychange"); pump(20);
  m.unmount();
  return LOG.slice();
}

// sha256 of svgSession("") with the PRE-CHANGE plugin (HEAD 0d5b9493, before
// ?orbRender existed: the SVG vessel was the only one) = svgSession of the
// escape (`?orbRender=svg`) now. If you change the SVG vessel's markup, writes
// or timing ON PURPOSE, re-pin it from a run of this file
// (`HB_PRINT_ORB_GOLDEN=1`); the escape is the owner's signed-off look, so
// that should be a deliberate act.
const GOLDEN = "0361e6c2c57374289631622b3ae71e3aab48dc758ca74410a046222552793d74";

// ── [1] the reader ──────────────────────────────────────────────────────────
console.log("── [1] orbRenderMode ──");
check("[1] svg / off / 0 / false / no (trimmed, any case) → svg; absent / empty / canvas / on / junk → canvas; memoized", () => {
  assert(typeof O.orbRenderMode === "function" && typeof O.__setOrbRenderForTest === "function", "orbRenderMode + seam exported");
  const read = (s) => { globalThis.location = { search: s }; O.__setOrbRenderForTest(undefined); return O.orbRenderMode(); };
  for (const s of ["?orbRender=svg", "?orbRender=SVG", "?orbRender=%20Svg%20", "?orbRender=off", "?orbRender=OFF",
    "?orbRender=0", "?orbRender=false", "?orbRender=False", "?orbRender=no", "?orbRender=%20No%20", "?hudDiet=on&orbRender=svg"]) {
    assertEq(read(s), "svg", s);
  }
  for (const s of ["", "?vitalsOrbs=on", "?orbRender=", "?orbRender=canvas", "?orbRender=CANVAS", "?orbRender=on",
    "?orbRender=1", "?orbRender=true", "?orbRender=yes", "?orbRender=svg2", "?orbRender=webgl", "?orbRender=nope", "?orbRender=0ff"]) {
    assertEq(read(s), "canvas", s || "(absent)");
  }
  globalThis.location = { search: "?orbRender=svg" }; O.__setOrbRenderForTest(undefined); O.orbRenderMode();
  globalThis.location = { search: "" };
  assertEq(O.orbRenderMode(), "svg", "memoized (URL read once)");
  O.__setOrbRenderForTest("canvas");
  assertEq(O.orbRenderMode(), "canvas", "seam forces");
  O.__setOrbRenderForTest(undefined);
  assertEq(O.orbRenderMode(), "canvas", "seam undefined re-reads: the default");
});

// ── [2] the escape: the DOM log is the signed-off vessel's ─────────────────
console.log("── [2] ?orbRender=svg = the pre-flag DOM, op for op; the default is canvas ──");
const offLog = svgSession("?orbRender=svg");
if (process.env.HB_PRINT_ORB_GOLDEN) console.log(`  GOLDEN ${sha(offLog)} (${offLog.length} ops)`);
check("[2] every escape form (svg / off / 0 / false / no, any case, trimmed) writes the identical DOM log", () => {
  assert(offLog.length > 2000, `a real session (${offLog.length} ops)`);
  assert(offLog.some((e) => e[0] === "attr" && e[2] === "d"), "wave d writes logged");
  assert(offLog.some((e) => e[0] === "xf.translate"), "SVGTransform writes logged");
  assert(offLog.some((e) => e[0] === "html" && e[2].includes('class="fx"')), "the fracture web was built");
  assert(offLog.some((e) => e[0] === "class-" && e[2] === "glaring"), "the glare timer fired");
  const a = sha(offLog);
  for (const q of ["?orbRender=SVG", "?orbRender=off", "?orbRender=0", "?orbRender=FALSE", "?orbRender=%20no%20", "?vitalsOrbs=on&orbRender=svg"]) {
    assertEq(sha(svgSession(q)), a, q);
  }
});
check("[2] the flag-off log is the pre-change plugin's (golden sha256)", () => {
  assertEq(sha(offLog), GOLDEN, "sha256(?orbRender=svg DOM log) = the pre-flag plugin's");
});
check("[2] the DEFAULT (absent, empty, junk) mounts the canvas vessel, not the SVG one", () => {
  for (const q of ["", "?orbRender=", "?orbRender=bogus", "?orbRender=on", "?vitalsOrbs=on"]) {
    const m = mountWith(q);
    try {
      m.snapshot(V(150, 300, 100, 200, 50, 100));
      pump(4);
      const cv = (k) => m.pane(k).querySelector("canvas.orb-cv");
      assertEq(m.diag.renderMode?.(), "canvas", `${q || "(absent)"}: renderMode`);
      assert(cv("hp") && !m.pane("hp").querySelector("svg"), `${q || "(absent)"}: a canvas core, no <svg>`);
      assert(!document.getElementById("hb-vitals-orbs-defs"), `${q || "(absent)"}: no shared defs`);
      assert((cv("mana")._log || []).some((e) => e[0] === "clearRect"), `${q || "(absent)"}: drawn`);
    } finally { m.unmount(); }
  }
});

// ── canvas helpers ──────────────────────────────────────────────────────────
const cvOf = (m, k) => m.pane(k).querySelector("canvas.orb-cv");
/** Split one canvas's call log into draws (clearRect at 0,0 starts one). */
function draws(cv) {
  const out = [];
  for (const e of cv?._log || []) {
    if (e[0] === "clearRect" && e[1] === 0 && e[2] === 0) out.push([]);
    if (out.length) out[out.length - 1].push(e);
  }
  return out;
}
/** Interpret one draw into ops with their path points and state. */
function ops(draw) {
  const res = [];
  let st = { a: 1, op: "source-over", fill: null, stroke: null, lw: 1 };
  const stack = [];
  let pts = [], arcs = [], ells = [];
  for (const e of draw) {
    const [k] = e;
    if (k === "set") {
      if (e[1] === "globalAlpha") st.a = e[2];
      else if (e[1] === "globalCompositeOperation") st.op = e[2];
      else if (e[1] === "fillStyle") st.fill = e[2];
      else if (e[1] === "strokeStyle") st.stroke = e[2];
      else if (e[1] === "lineWidth") st.lw = e[2];
    } else if (k === "save") stack.push({ ...st });
    else if (k === "restore") st = stack.pop() || st;
    else if (k === "beginPath") { pts = []; arcs = []; ells = []; }
    else if (k === "moveTo" || k === "lineTo") pts.push([e[1], e[2]]);
    else if (k === "arc") arcs.push(e.slice(1));
    else if (k === "ellipse") ells.push(e.slice(1));
    else if (k === "fill" || k === "stroke" || k === "clip") res.push({ k, pts: pts.slice(), arcs: arcs.slice(), ells: ells.slice(), ...st, depth: stack.length });
    else if (k === "drawImage") res.push({ k, src: e[1], args: e.slice(2), ...st, depth: stack.length });
  }
  return res;
}
const lastDraw = (m, k) => { const d = draws(cvOf(m, k)); return d.length ? ops(d[d.length - 1]) : []; };
/** The wave-body fills of a draw (21 surface samples + the 2 bottom corners): back, front. */
const bodies = (o) => o.filter((x) => x.k === "fill" && x.pts.length === 23);
const ptp = (pts) => { const ys = pts.slice(0, 21).map((p) => p[1]); return Math.max(...ys) - Math.min(...ys); };
const meanY = (pts) => pts.slice(0, 21).reduce((s, p) => s + p[1], 0) / 21;
/** Which layer a drawImage source is, from its own bake log. */
function srcName(src) {
  const log = src?._log || [];
  if (log.some((e) => e[0] === "ellipse" && e[1] === 58 && e[2] === 74)) return "shimmer";
  if (log.some((e) => e[0] === "ellipse" && e[1] === 52)) return "sspec";
  if (log.some((e) => e[0] === "scale" && e[1] === 46)) return "subglow";
  if (log.some((e) => e[0] === "fillRect" && e[3] === 128 && e[4] === 260)) return "vitae";
  if (log.some((e) => e[0] === "createRadial" && e[1].args[5] === 55.5)) return "wall";
  return "other";
}

/** The geometry the renderer must pick: the canvas box is the core box, so
 *  only the SIZE matters (never the position): backing = the core's device
 *  width x the supersample (2, or 1.5 at DPR >= 1.5); s = canvas px per user
 *  unit, dev = device px per user unit. */
const SS = (dpr) => (dpr >= 1.5 ? 1.5 : 2);
function geom(_left, _top, { scale = 0.72, zoom = 1, dpr = 1 } = {}) {
  const dev = 92 * scale * zoom * dpr / 120;
  const W = Math.round(120 * dev * SS(dpr));
  return { W, H: W, s: W / 120, dev, ss: SS(dpr) };
}
const HP = [260, 6];  // the hp pane's default position
/** Layers a fresh mount bakes: wall + specular (shared by the three vessels:
 *  one size), + one subglow per vessel, + the mana shimmer. */
function expectedBakes() { return 2 + 3 + 1; }

// ── [3] flag on: the DOM ────────────────────────────────────────────────────
console.log("── [3] flag on: the canvas core ──");
check("[3] same panes / heraldry / plaques / stylesheet; one canvas per core, no <svg>, no shared defs", () => {
  const svgM = mountWith("?orbRender=svg");
  const svgPanes = ["hp", "stam", "mana"].map((k) => svgM.pane(k));
  const svgStyle = document.getElementById("hb-vitals-orbs-style").textContent;
  const svgFigs = svgPanes.map((p) => p.querySelectorAll(".fig").map((f) => f.className));
  svgM.unmount();
  const m = mountWith("?orbRender=canvas");
  assertEq(m.diag.renderMode?.(), "canvas", "diag renderMode");
  assertEq(document.getElementById("hb-vitals-orbs-style").textContent, svgStyle, "stylesheet text identical");
  assert(!document.getElementById("hb-vitals-orbs-defs"), "no shared <defs> svg");
  for (const [i, k] of ["hp", "stam", "mana"].entries()) {
    const p = m.pane(k);
    assert(p, `pane ${k}`);
    assertEq(p.querySelectorAll(".fig").map((f) => f.className), svgFigs[i], `${k} heraldry`);
    assert(p.querySelector(".orb-read .plate .v"), `${k} plaque`);
    const core = p.querySelector(".hbo-core");
    assertEq(core.querySelectorAll("svg").length, 0, `${k} core has no svg`);
    const cvs = core.querySelectorAll("canvas");
    assertEq(cvs.length, 1, `${k} one canvas`);
    assert(cvs[0].classList.contains("orb-cv") && cvs[0].getAttribute("style").includes("width:92px;height:92px"), `${k} CSS 92 px`);
  }
  m.unmount();
});
check("[3] per tick: zero DOM writes; the canvas box IS the core box; backing = device px x supersample", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(4);
  const n0 = LOG.length;
  pump(60);
  const domWrites = LOG.slice(n0).filter((e) => e[0] !== "create");  // bake canvases are created, never attached
  assertEq(domWrites, [], "no DOM write in 60 vsyncs");
  assert(draws(cvOf(m, "hp")).length > 0, "hp drew");
  const g = geom(...HP);
  assertEq([cvOf(m, "hp").width, cvOf(m, "hp").height], [g.W, g.H], "core 66.24 device px x 2 → 132x132");
  assertEq(g.W, 132, "the DPR-1 backing");
  // REGISTRATION (2026-10-31 look review): no CSS offset / size on the canvas
  // (Blink pixel-snaps a canvas box in the pane's pre-scale space; a nudged
  // canvas drifted 0.3-0.7 device px). The box is the markup's, = the core's.
  const cv = cvOf(m, "hp");
  assertEq(["position", "left", "top", "width", "height", "transform"].map((k) => cv.style[k]), ["", "", "", "", "", ""], "no CSS offset or size written");
  assert(/^display:block;width:92px;height:92px$/.test(cv.getAttribute("style")), "the core box (92x92 CSS px, like the <svg>)");
  assertEq(LOG.filter((e) => (e[0] === "style" || e[0] === "style.set") && e[1] === cv._id), [], "never restyled");
  const bodyT = draws(cv).pop().find((e) => e[0] === "setTransform" && e[1] !== 1);
  assertEq(bodyT.slice(1).map((v) => +v.toFixed(6)), [g.s, 0, 0, g.s, 0, 0].map((v) => +v.toFixed(6)), "user 0..120 → canvas 0..W");
  m.unmount();
  const m2 = mountWith("?orbRender=canvas&orbScale=1.5", { dpr: 2 });
  m2.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(4);
  assertEq(cvOf(m2, "mana").width, geom(542, 6, { scale: 1.5, dpr: 2 }).W, "orbScale 1.5 at DPR 2");
  m2.unmount();
});

// ── [4] state mapping ───────────────────────────────────────────────────────
console.log("── [4] vitals → the drawn vessel ──");
check("[4] fill: the surface sits at 120 x (1 - current/buffedMax)", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 50, 200, 90, 100));
  pump(60);
  for (const [k, f] of [["hp", 0.5], ["stam", 0.25], ["mana", 0.9]]) {
    const b = bodies(lastDraw(m, k));
    assertEq(b.length, 2, `${k}: back + front bodies`);
    const y = meanY(b[1].pts);
    assert(Math.abs(y - 120 * (1 - f)) < 1.2, `${k} surface ${y.toFixed(2)} ≈ ${120 * (1 - f)}`);
    assertEq(b[1].pts.slice(21), [[120, 128], [0, 128]].map((p) => p), `${k} closed to y=128 like the SVG path`);
  }
  m.emit("vitalChangedMana", { current: 20, buffedMax: 100, oldValue: 90 });
  pump(60);
  const y = meanY(bodies(lastDraw(m, "mana"))[1].pts);
  assert(Math.abs(y - 96) < 1.2, `mana eased to 20% (${y.toFixed(2)})`);
  m.unmount();
});
check("[4] slosh: a 25% hit raises the wave, which decays back to idle", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(240, 300, 100, 200, 50, 100));
  pump(90);
  const idle = ptp(bodies(lastDraw(m, "hp"))[1].pts);
  m.emit("vitalChangedHealth", { current: 165, buffedMax: 300, oldValue: 240 });
  assert(m.diag.state()[0].impulse > 0.9, "impulse from |Δ|/max");
  pump(4);
  const hit = ptp(bodies(lastDraw(m, "hp"))[1].pts);
  pump(240);
  const after = ptp(bodies(lastDraw(m, "hp"))[1].pts);
  assert(hit > idle * 2, `hit ${hit.toFixed(2)} > 2 x idle ${idle.toFixed(2)}`);
  assert(after < idle * 1.3, `decayed ${after.toFixed(2)}`);
  m.unmount();
});
check("[4] glare: damage only, a screen ellipse on the hbo-glare steps", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(240, 300, 100, 200, 50, 100));
  pump(10);
  const glares = (k) => draws(cvOf(m, k)).flatMap(ops).filter((o) => o.k === "fill" && o.ells.some((e) => e[2] === 30 && e[3] === 17));
  m.emit("vitalChangedHealth", { current: 290, buffedMax: 300, oldValue: 240 });  // heal
  pump(90);
  assertEq(glares("hp").length, 0, "a heal never glares");
  m.emit("vitalChangedHealth", { current: 200, buffedMax: 300, oldValue: 290 });  // hit
  pump(90);
  const g = glares("hp");
  assert(g.length >= 4, `glare drawn (${g.length})`);
  assert(g.every((o) => o.op === "screen" && o.fill === "rgba(255, 240, 220, 0.85)"), "screen, --hb-orb-glare");
  assertEq([...new Set(g.map((o) => o.a))].sort(), [0.08, 0.22, 0.44, 0.62], "the four keyframe steps");
  assertEq(glares("stam").length, 0, "only the hit vessel");
  m.unmount();
});
check("[4] low HP: the low colour band, glints + bloom, heartbeat; out of the band restores", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(30, 300, 100, 200, 50, 100));
  pump(30);
  const o = lastDraw(m, "hp");
  const front = bodies(o)[1];
  assertEq(front.fill.stops.map((s) => s[1]), ["rgba(168,26,32,1)", "rgba(168,26,32,0.92)", "rgba(60,6,9,1)"], "hp-low / hp-low-deep");
  assert(o.some((x) => x.k === "stroke" && x.stroke === "#fffaf0" && x.lw === 0.9 && x.pts.length === 8), "four glints");
  assert(o.some((x) => x.k === "fill" && x.op === "screen" && x.arcs.some((a) => a[0] === 78 && a[2] === 9)), "bloom");
  assert(m.pane("hp").querySelector(".hbo-core").classList.contains("beat"), "heartbeat on .hbo-core");
  assert(!lastDraw(m, "stam").some((x) => x.k === "stroke" && x.stroke === "#fffaf0"), "stamina unaffected");
  m.snapshot(V(240, 300, 100, 200, 50, 100));
  pump(30);
  const o2 = lastDraw(m, "hp");
  assertEq(bodies(o2)[1].fill.stops.map((s) => s[1])[0], "rgba(200,24,30,1)", "back to --hb-orb-hp");
  assert(!o2.some((x) => x.k === "stroke" && x.stroke === "#fffaf0"), "no glints");
  assert(!m.pane("hp").querySelector(".hbo-core").classList.contains("beat"), "no heartbeat");
  m.unmount();
});
check("[4] vitae: buffedMax < base caps the fill and draws the vitae layer", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(265, 265, 100, 200, 50, 100, 312));
  pump(60);
  const st = m.diag.state()[0];
  assert(Math.abs(st.ceiling - 265 / 312) < 1e-9 && Math.abs(st.target - 265 / 312) < 1e-4, "ceiling + target");
  const o = lastDraw(m, "hp");
  const vit = o.filter((x) => x.k === "drawImage" && srcName(x.src) === "vitae");
  assertEq(vit.length, 1, "one vitae layer");
  assert(vit[0].depth >= 1, "inside the circle clip");
  assert(!lastDraw(m, "stam").some((x) => x.k === "drawImage" && srcName(x.src) === "vitae"), "stamina has none");
  const vlog = vit[0].src._log;
  const g = geom(...HP);
  assert(vlog.some((e) => e[0] === "setTransform" && Math.abs(e[6] - ((120 - 120 * 265 / 312) - 18) * g.s) < 0.02), "translated to the live ceiling");
  m.unmount();
});
check("[4] mana alone draws the shimmer sprite; every vessel draws subglow + specular + wall", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(30);
  for (const k of ["hp", "stam", "mana"]) {
    const names = lastDraw(m, k).filter((x) => x.k === "drawImage").map((x) => srcName(x.src));
    assertEq(names.includes("shimmer"), k === "mana", `${k} shimmer`);
    for (const n of ["subglow", "sspec", "wall"]) assert(names.includes(n), `${k} ${n}`);
  }
  m.unmount();
});

// ── [5] bakes ───────────────────────────────────────────────────────────────
console.log("── [5] bakes ──");
// Layers this mount's vessels baked (shared layers count once, for whichever
// vessel asked first; an unmount drops the size-keyed set).
const totalBakes = (m) => (m.diag.canvasStats?.() || []).reduce((a, s) => a + s.bakes, 0);
check("[5] baked once per size; resize / DPR / HUD zoom re-bake only on a size change", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(10);
  const b0 = totalBakes(m);
  assertEq(b0, 6, "wall + sspec + subglow x3 + shimmer (one shared geometry)");
  assertEq(expectedBakes(), 6, "model agrees");
  pump(120);
  assertEq(totalBakes(m), b0, "no bake while ticking");
  fire(winLs, "resize"); pump(10);
  assertEq([totalBakes(m), cvOf(m, "hp").width], [b0, geom(...HP).W], "resize, same size: nothing");
  globalThis.devicePixelRatio = 2; fire(winLs, "resize"); pump(10);
  const b1 = b0 + expectedBakes({ dpr: 2 });
  assertEq([totalBakes(m), cvOf(m, "hp").width], [b1, geom(...HP, { dpr: 2 }).W], "DPR 2: re-baked");
  for (const k of ["hp", "stam", "mana"]) m.pane(k).currentCSSZoom = 1.25;
  fire(docLs, "hb-hud-scale-changed"); pump(10);
  assertEq([totalBakes(m), cvOf(m, "hp").width], [b1 + expectedBakes({ zoom: 1.25, dpr: 2 }), geom(...HP, { zoom: 1.25, dpr: 2 }).W],
    "HUD zoom 1.25: re-baked");
  globalThis.devicePixelRatio = 1;
  for (const k of ["hp", "stam", "mana"]) m.pane(k).currentCSSZoom = 1;
  const dprQ = mqLs.find((x) => /resolution/.test(x.q));
  assert(dprQ, "a DPR media query is watched");
  dprQ.fn(); pump(10);
  assertEq(cvOf(m, "hp").width, geom(...HP).W, "the DPR query's change re-measures");
  m.unmount();
});
check("[5] position never matters: a pane dropped at a fractional spot re-bakes nothing; layers blit 1:1", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(10);
  const b0 = totalBakes(m);
  const w0 = cvOf(m, "stam").width;
  m.pane("stam").style.left = "401.3px";
  m.pane("hp").style.top = "6.77px";
  fire(docLs, "pointerup");
  fire(winLs, "resize");
  pump(10);
  assertEq([totalBakes(m), cvOf(m, "stam").width], [b0, w0], "no re-bake, same backing");
  for (const k of ["hp", "stam", "mana"]) {
    const wall = lastDraw(m, k).find((x) => x.k === "drawImage" && srcName(x.src) === "wall");
    const t = wall.src._log.find((e) => e[0] === "setTransform");
    assertEq([t[5], t[6]], [0, 0], `${k} wall baked at the canvas origin`);
    assertEq(wall.args, [0, 0], `${k} wall blitted 1:1`);
  }
  m.unmount();
});
// 2026-10-31 look review (orchestrator, owner-delegated): the crack web read
// thinner / paler than the SVG one. Two causes, both pinned: (1) a 240 px bake
// resampled 1.8x / 3.6x down; the SVG vessel draws the web as live vectors, so
// the bake is rasterized by the SVG engine on the canvas's own pixel grid with
// the page's strokes and rules, blitted 1:1; (2) registration: see [3] (the
// canvas box is the core box) and the cascade check below.
check("[5] low HP: the crack web is rasterized on the canvas's own pixel grid with the page's strokes + rules, blitted 1:1 (DPR 1 and 2)", () => {
  const sm = mountWith("?orbRender=svg");
  sm.snapshot(V(30, 300, 100, 200, 50, 100));
  pump(10);
  const fxHtml = LOG.find((e) => e[0] === "html" && e[2].includes('class="fx"'))?.[2];
  const defsHtml = LOG.find((e) => e[0] === "html" && e[2].includes('id="hbRefract"'))?.[2];
  sm.unmount();
  assert(fxHtml && defsHtml, "the page's fracture markup + shared defs");
  const css = O.orbStyleText();
  const tok = {};
  for (const m of css.matchAll(/--(hb-orb-[\w-]+):\s*([^;]+);/g)) tok[m[1]] = m[2].trim();
  const pageRule = (cls) => new RegExp(`\\.orb \\.${cls} \\{([^}]*)\\}`).exec(css)[1]
    .replace(/var\(--([\w-]+)\)/g, (_, n) => tok[n]).replace(/\s+/g, " ").trim();
  const norm = (x) => x.replace(/\s+/g, " ").trim();
  const pageFilter = norm(/<filter id="hbRefract"[\s\S]*?<\/filter>/.exec(defsHtml)[0]);
  const widths = (html, cls) => [...html.matchAll(new RegExp(`class="${cls}" d="[^"]*" stroke-width="([\\d.]+)"`, "g"))].map((m) => +m[1]);
  const shards = (html) => [...html.matchAll(/class="fx-shard" d="([^"]+)"/g)].map((m) => m[1]);
  for (const dpr of [1, 2]) {
    O.__orbCanvasInternals.resetBitmaps();
    const m = mountWith("?orbRender=canvas", { dpr });
    try {
    m.snapshot(V(30, 300, 100, 200, 50, 100));
    pump(10);
    const g = geom(...HP, { dpr });
    const fx = IMAGES.filter((i) => decodeURIComponent(String(i.src)).includes("fx-refract"));
    assertEq(fx.length, 1, `DPR ${dpr}: one crack-web bake (hp only is low)`);
    const svg = decodeURIComponent(String(fx[0].src).slice("data:image/svg+xml,".length));
    const hdr = /^<svg [^>]*viewBox="([^"]+)" width="([^"]+)" height="([^"]+)"/.exec(svg);
    assert(hdr, "svg header");
    const [vx, vy, vw, vh] = hdr[1].split(" ").map(Number);
    assertEq([+hdr[2], +hdr[3]], [g.W, g.H], `DPR ${dpr}: rasterized at the canvas size`);
    const sx = g.W / vw, sy = g.H / vh;  // the bake's device px per user unit
    assert(Math.abs(sx - g.s) < 1e-5 && Math.abs(sy - g.s) < 1e-5, `DPR ${dpr}: bake scale ${sx} = the vessel's ${g.s}`);
    assertEq([vx, vy], [0, 0], `DPR ${dpr}: bake origin = the canvas origin`);
    assert(sx / g.dev >= 1.5 - 1e-9, `DPR ${dpr}: rasterized supersampled (${(sx / g.dev).toFixed(3)} canvas px per device px)`);
    for (const cls of ["fx-dark", "fx-refract", "fx-main"]) {
      const pw = widths(fxHtml, cls), bw = widths(svg, cls);
      assertEq(bw.length, 32, `${cls}: 32 strokes`);
      // the compositor maps the W-px canvas onto the core's 120·dev device px
      const toDev = (120 * g.dev) / g.W;
      assertEq(bw.map((x) => +(x * sx * toDev).toFixed(4)), pw.map((x) => +(x * g.dev).toFixed(4)), `DPR ${dpr} ${cls}: device stroke widths = the page's`);
      assertEq(norm(new RegExp(`\\.${cls}\\{([^}]*)\\}`).exec(svg)[1]), pageRule(cls), `${cls}: the page's rule`);
    }
    assertEq(shards(svg), shards(fxHtml), "the 7 shards");
    assertEq(norm(new RegExp(`\\.fx-shard\\{([^}]*)\\}`).exec(svg)[1]), pageRule("fx-shard"), "fx-shard: the page's rule");
    assert(/opacity: 0\.85; transform: translate\(0\.9px, 1\.1px\)/.test(svg) && /opacity: 0\.34; filter: url\(#hbRefract\)/.test(svg)
      && /\.fx-main\{fill: none; stroke: rgba\(255, 232, 208, 0\.62\)/.test(svg), "dark offset, refract filter, main colour");
    assertEq(norm(/<filter id="hbRefract"[\s\S]*?<\/filter>/.exec(svg)[0]), pageFilter, "#hbRefract = the page's");
    assert(!/fx-glint|fx-bloom/.test(svg), "glints + bloom stay live");
    for (const i of IMAGES.filter((x) => String(x.src).startsWith("data:image/svg+xml"))) i.onload();
    pump(3);
    const d = lastDraw(m, "hp");
    const fxDraw = d.filter((x) => x.k === "drawImage" && x.src?._log?.some((e) => e[0] === "drawImage" && e[1] === fx[0]));
    assertEq(fxDraw.length, 1, `DPR ${dpr}: the crack layer is drawn`);
    assertEq(fxDraw[0].args, [0, 0], "blitted 1:1 (no destination size)");
    assertEq([fxDraw[0].src.width, fxDraw[0].src.height], [g.W, g.H], "the layer IS the bake, at W x H");
    assertEq(fxDraw[0].src._log.find((e) => e[0] === "drawImage").slice(2), [0, 0, g.W, g.H], "the SVG image drawn at its own size");
    assertEq([fxDraw[0].a, fxDraw[0].op], [1, "source-over"], "opaque, normal blend (as the page's .hbo-fx)");
    } finally { m.unmount(); O.__orbCanvasInternals.resetBitmaps(); }
  }
});
// The page cascade on the crack web, pinned (the "computed style" side of the
// 2026-10-31 review): the real stylesheet is parsed into rules and matched
// against the real SVG-mode DOM, so a rule, presentation attribute or
// inherited paint property that reaches the cracks in the page but not in the
// bake fails here.
function cssRules(css) {
  let t = css.replace(/\/\*[\s\S]*?\*\//g, "");
  t = t.replace(/@(?:keyframes|media)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out = [];
  for (const m of t.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((x) => x.trim()).filter(Boolean);
    const decls = m[2].split(";").map((d) => d.trim()).filter(Boolean)
      .map((d) => { const i = d.indexOf(":"); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; });
    out.push({ sels, decls });
  }
  return out;
}
function partMatch(el, comp) {
  const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[\w-]+\]|:nth-of-type\(\d+\))*)$/.exec(comp);
  if (!m) throw new Error(`unsupported selector part "${comp}" — extend the matcher`);
  if (m[1] && m[1] !== "*" && el.localName !== m[1]) return false;
  for (const p of m[2].match(/[.#][\w-]+|\[[\w-]+\]|:nth-of-type\(\d+\)/g) || []) {
    if (p[0] === "." && !el.classList.contains(p.slice(1))) return false;
    if (p[0] === "#" && el.id !== p.slice(1)) return false;
    if (p[0] === "[" && !(p === "[hidden]" ? el.hidden : el.hasAttribute(p.slice(1, -1)))) return false;
    if (p.startsWith(":nth-of-type")) {
      const sib = el.parentNode.children.filter((c) => c.localName === el.localName);
      if (sib.indexOf(el) + 1 !== Number(/\d+/.exec(p)[0])) return false;
    }
  }
  return true;
}
function selMatch(el, sel) {
  const parts = sel.split(/\s+/);
  if (!partMatch(el, parts[parts.length - 1])) return false;
  let e = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (e && e.localName && !partMatch(e, parts[i])) e = e.parentNode;
    if (!e || !e.localName) return false;
    e = e.parentNode;
  }
  return true;
}
const INHERITED_PAINT = new Set(["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "paint-order", "visibility", "color",
  "color-interpolation", "color-interpolation-filters", "shape-rendering", "marker", "vector-effect"]);
const GROUP_PAINT = new Set(["opacity", "filter", "mix-blend-mode", "transform", "clip-path", "mask", "isolation", "backdrop-filter", "animation"]);
const PAINT_ATTRS = ["style", "fill", "stroke", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "filter", "transform",
  "clip-path", "mask", "paint-order", "vector-effect", "stroke-linecap", "stroke-linejoin", "color"];
check("[5] the page cascade gives every crack element exactly the bake's styles; nothing else reaches them", () => {
  const sm = mountWith("?orbRender=svg");
  try {
    sm.snapshot(V(30, 300, 100, 200, 50, 100));
    pump(10);
    const css = O.orbStyleText();
    const rules = cssRules(css);
    assert(rules.length > 40, `stylesheet parsed (${rules.length} rules)`);
    const tok = {};
    for (const m of css.matchAll(/--(hb-orb-[\w-]+):\s*([^;]+);/g)) tok[m[1]] = m[2].trim();
    const resolve = (v) => v.replace(/var\(--([\w-]+)\)/g, (_, n) => tok[n] ?? `var(--${n})`);
    const bake = {};
    for (const m of O.__orbCanvasInternals.fractureBakeCss().matchAll(/\.([\w-]+)\{([^}]*)\}/g)) {
      bake[m[1]] = m[2].split(";").map((d) => d.trim()).filter(Boolean).join("; ");
    }
    assertEq(Object.keys(bake), ["fx-dark", "fx-refract", "fx-main", "fx-shard"], "the bake's four passes");
    const matched = (el) => rules.filter((r) => r.sels.some((sl) => selMatch(el, sl))).flatMap((r) => r.decls);
    const pane = sm.pane("hp");
    const fx = pane.querySelectorAll("path").filter((e) => /^fx-(dark|refract|main|shard)$/.test(e.className));
    assertEq(fx.length, 32 * 3 + 7, "the 103 static crack elements");
    for (const el of fx) {
      const got = matched(el).map(([k, v]) => `${k}: ${resolve(v)}`).join("; ");
      assertEq(got, bake[el.className], `${el.className}: the page cascade = the bake's rule`);
      const attrs = [...el._attrs.keys()].sort();
      assertEq(attrs, el.className === "fx-shard" ? ["class", "d"] : ["class", "d", "stroke-width"], `${el.className}: markup attributes`);
    }
    // ancestors: up to the pane
    const chain = [];
    for (let e = fx[0].parentNode; e && e.localName; e = e.parentNode) { chain.push(e); if (e === pane) break; }
    assertEq(chain.map((e) => e.localName + "." + e.className.split(" ")[0]), ["g.fx", "g.hbo-fx", "svg.orb", "div.hbo-core", "div.hbo-pane"], "the crack web's ancestors");
    for (const e of chain) {
      const decls = matched(e).filter(([k]) => !k.startsWith("--"));
      const inherited = decls.filter(([k]) => INHERITED_PAINT.has(k));
      assertEq(inherited, [], `${e.localName}.${e.className}: no inherited paint property (the bake would not inherit it)`);
      const inSvg = e.namespaceURI === SVG_NS;
      if (inSvg) {
        assertEq(decls.filter(([k]) => GROUP_PAINT.has(k)), [], `${e.localName}.${e.className}: no group effect inside the vessel`);
        assertEq(PAINT_ATTRS.filter((a) => e.hasAttribute(a)), [], `${e.localName}.${e.className}: no paint presentation attribute`);
      }
    }
    // what the core / pane DO carry applies to the canvas too (same core box)
    const core = chain[3];
    const coreGroup = matched(core).filter(([k]) => GROUP_PAINT.has(k) || k === "contain").map(([k]) => k);
    assertEq(coreGroup.sort(), ["animation", "contain"], ".hbo-core: contain + the low-HP heartbeat, shared by both renderers");
  } finally { sm.unmount(); }
});
check("[5] the low band bakes one subglow variant, once", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(10);
  const b0 = totalBakes(m);
  m.snapshot(V(30, 300, 100, 200, 50, 100)); pump(20);
  assertEq(totalBakes(m), b0 + 1, "subglow-hp-low");
  m.snapshot(V(150, 300, 100, 200, 50, 100)); pump(20);
  m.snapshot(V(30, 300, 100, 200, 50, 100)); pump(20);
  assertEq(totalBakes(m), b0 + 1, "cached across toggles");
  m.snapshot(V(265, 265, 100, 200, 50, 100, 312)); pump(10);
  assertEq(totalBakes(m), b0 + 2, "+ the vitae layer");
  pump(30);
  assertEq(totalBakes(m), b0 + 2, "vitae layer reused at the same ceiling");
  m.snapshot(V(250, 250, 100, 200, 50, 100, 312)); pump(10);
  assertEq(totalBakes(m), b0 + 3, "re-baked for a new ceiling");
  m.unmount();
});
check("[5] the SVG bitmaps (glass, caustics) land once, bump the key and are drawn", () => {
  O.__orbCanvasInternals?.resetBitmaps();  // the bitmap cache is per page
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(10);
  const svgImgs = IMAGES.filter((i) => String(i.src).startsWith("data:image/svg+xml"));
  assertEq(svgImgs.length, 2, "glass + caustics requested once for all three vessels");
  const before = draws(cvOf(m, "stam")).length;
  for (const i of svgImgs) i.onload();
  pump(2);
  assert(draws(cvOf(m, "stam")).length > before, "a landed bitmap forces a draw");
  const imgs = lastDraw(m, "stam").filter((x) => x.k === "drawImage" && srcName(x.src) === "other");
  assertEq(imgs.map((x) => x.op), ["screen", "source-over"], "caustics (screen, in the wave clip) + glass (unclipped)");
  assertEq([imgs[0].depth, imgs[1].depth], [2, 0], "clip depth");
  const n = IMAGES.length;
  m.unmount();
  const m2 = mountWith("?orbRender=canvas&orbCaustics=off");
  m2.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(10);
  assertEq(IMAGES.filter((i) => String(i.src).startsWith("data:image/svg+xml")).length, 0, "no new SVG request on a re-mount");
  assertEq(lastDraw(m2, "stam").filter((x) => x.k === "drawImage" && srcName(x.src) === "other").map((x) => x.op), ["source-over"],
    "?orbCaustics=off: the glass only");
  m2.unmount();
  assert(n >= 2, "images seen");
});

// ── [6] skipping ────────────────────────────────────────────────────────────
console.log("── [6] tick skipping ──");
/** A bare vessel on a fake canvas + pane, with its ambient loops frozen. */
function bareVessel(kind = "stam") {
  const I = O.__orbCanvasInternals;
  assert(I && typeof I.createVessel === "function", "internals exported");
  const canvas = new FakeEl("canvas", null, true);
  const pane = new FakeEl("div", null, true);
  pane.className = "hbo-pane"; pane.style.left = "260px"; pane.style.top = "6px";
  const core = new FakeEl("div", null, true);
  core.className = "hbo-core";
  const v = I.createVessel(kind, canvas, pane, { core });
  v.freeze(0, null);  // loops at t=0, no glare: only what the test moves moves
  const o = { group: pane, level: 0.5, phase: 0, seed: 1.37, low: false, ceiling: 1, lastRise: "-42px", impulse: 0 };
  return { I, v, o, canvas };
}
check("[6] same inputs skip with ZERO context calls; > CV_SKIP_PX of motion or a discrete change draws", () => {
  const { I, v, o, canvas } = bareVessel();
  assertEq(I.skipPx, 0.125, "CV_SKIP_PX");
  assert(v.frame(o, 1.5, o.phase + o.seed, 1000), "the first frame draws");
  const calls = () => canvas._log.length;
  let c = calls();
  assertEq([v.frame(o, 1.5, o.phase + o.seed, 1033), calls() - c], [false, 0], "identical inputs: skipped, no call");
  const unit = 0.125 / v.deviceScale;  // CV_SKIP_PX (device px) in user units
  o.level = 0.5 + 0.9 * unit / 120;  // whole surface moves 0.9 x CV_SKIP_PX
  c = calls();
  assertEq([v.frame(o, 1.5, o.phase + o.seed, 1066), calls() - c], [false, 0], "sub-threshold motion: skipped");
  o.level = 0.5 + 1.1 * unit / 120;
  assertEq(v.frame(o, 1.5, o.phase + o.seed, 1100), true, "1.1 x CV_SKIP_PX: drawn");
  for (const [k, val] of [["low", true], ["ceiling", 0.8], ["lastRise", "-30px"]]) {
    const was = o[k];
    assertEq(v.frame(o, 1.5, o.phase + o.seed, 1133), false, `steady before ${k}`);
    o[k] = val;
    assertEq(v.frame(o, 1.5, o.phase + o.seed, 1166), k !== "lastRise" ? true : true, `${k} change draws`);
    o[k] = was;
    v.frame(o, 1.5, o.phase + o.seed, 1200);
  }
  o.group.hidden = true;
  c = calls();
  o.level = 0.2;
  assertEq([v.frame(o, 1.5, o.phase + o.seed, 1233), calls() - c], [false, 0], "hidden pane: no work");
});
check("[6] waves only: every tick the drawn surface is within CV_SKIP_PX of the exact one, and most ticks skip", () => {
  const { I, v, o, canvas } = bareVessel("hp");
  assert(v.frame(o, 1.6, o.phase + o.seed, 1000), "first frame draws");
  const s = v.deviceScale, tolU = 0.125 / s;
  assert(Math.abs(s - 0.552) < 1e-9 && Math.abs(v.s - 1.1) < 1e-9, `device px per unit (${s}), canvas px per unit (${v.s})`);
  const exact = new Float64Array(21);
  let drawn = 0, ticks = 0, worst = 0;
  let shown = bodies(ops(draws(canvas).pop()))[1].pts.slice(0, 21).map((p) => p[1]);
  for (let i = 0; i < 900; i++) {  // 30 s at 30 Hz, idle hp (amp 1.6)
    o.phase += (1 / 30) * 1.05;
    const ph = o.phase + o.seed;
    const n = (canvas._log || []).length;
    const did = v.frame(o, 1.6, ph, 1000 + i * 33.3);
    ticks++;
    if (did) {
      drawn++;
      const d = ops(draws(canvas).pop());
      shown = bodies(d)[1].pts.slice(0, 21).map((p) => p[1]);
    } else assertEq(canvas._log.length, n, "a skip adds no call");
    I.waveYs(exact, o.level, ph, 1.6, 2.4, 0);
    for (let j = 0; j < 21; j++) worst = Math.max(worst, Math.abs(exact[j] - shown[j]));
  }
  assert(worst <= tolU + 1e-9, `max lag ${(worst * s).toFixed(4)} device px <= 0.125`);
  assert(worst * s > 0.1, `the bound is reached (${(worst * s).toFixed(4)})`);
  assert(drawn < ticks * 0.5 && drawn > ticks * 0.15, `waves alone draw ${drawn}/${ticks}`);
});
// Live, the signed-off ambient loops (specular drift, bubbles, the mana
// shimmer) keep moving by >= CV_SKIP_PX on most ticks, so an idle vessel still
// draws most ticks (the mana one ~every tick); what is pinned is that the skip
// is real and free, and that motion is never skipped.
check("[6] live idle: skips happen and are free; a slosh draws every tick", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(60);
  const s0 = m.diag.canvasStats();
  let bad = 0;
  for (let i = 0; i < 360; i++) {  // 6 s at 60 Hz
    const l0 = cvOf(m, "stam")._log.length, d0 = m.diag.canvasStats()[1].draws;
    pump(1);
    if (m.diag.canvasStats()[1].draws === d0 && cvOf(m, "stam")._log.length !== l0) bad++;
  }
  const s1 = m.diag.canvasStats();
  let skips = 0;
  for (let i = 0; i < 3; i++) {
    const ticks = (s1[i].draws + s1[i].skips) - (s0[i].draws + s0[i].skips);
    assert(ticks >= 175 && ticks <= 182, `${s1[i].kind} ~180 cadence ticks (${ticks})`);
    skips += s1[i].skips - s0[i].skips;
  }
  assert(skips >= 5, `idle ticks skipped across the three vessels (${skips}/540)`);
  assertEq(bad, 0, "a vsync without a draw issues no context call");
  // a 30% HEAL: full slosh, no glare (a hit would add off-cadence glare checks)
  m.emit("vitalChangedStamina", { current: 160, buffedMax: 200, oldValue: 100 });
  const a = m.diag.canvasStats()[1];
  pump(30);
  const b = m.diag.canvasStats()[1];
  assert(b.draws - a.draws >= 14, `drawn while sloshing (${b.draws - a.draws})`);
  assertEq(b.skips - a.skips, 0, "no skip while sloshing");
  m.unmount();
});
check("[6] a glare step is drawn off-cadence (on the display clock)", () => {
  const m = mountWith("?orbRender=canvas&orbHz=10");
  m.snapshot(V(240, 300, 100, 200, 50, 100));
  pump(30);
  m.emit("vitalChangedHealth", { current: 200, buffedMax: 300, oldValue: 240 });
  pump(30);
  const g = draws(cvOf(m, "hp")).flatMap(ops).filter((o) => o.k === "fill" && o.ells.some((e) => e[2] === 30));
  assertEq([...new Set(g.map((o) => o.a))].sort(), [0.08, 0.22, 0.44, 0.62], "every step at 10 Hz cadence");
  m.unmount();
});

// ── [7] hidden ──────────────────────────────────────────────────────────────
console.log("── [7] hidden panes / tab ──");
check("[7] all panes hidden: no draw, the loop stops; shown: resumes; hidden tab: paused", () => {
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(20);
  assert(m.diag.running(), "running");
  m.snapshot([]);
  const n0 = CTX_CALLS;
  pump(60);
  assertEq(CTX_CALLS - n0, 0, "no context call while hidden");
  assertEq(m.diag.running(), false, "loop stopped");
  assertEq(rafQ.length, 0, "no rAF pending");
  m.snapshot(V(100, 300, 100, 200, 50, 100));
  pump(30);
  assert(m.diag.running() && CTX_CALLS > n0, "resumed on show");
  DOC_HIDDEN = true; fire(docLs, "visibilitychange");
  const n1 = CTX_CALLS;
  pump(30);
  assertEq([m.diag.running(), CTX_CALLS - n1], [false, 0], "paused with the tab");
  DOC_HIDDEN = false; fire(docLs, "visibilitychange");
  pump(10);
  assert(m.diag.running(), "resumed with the tab");
  m.unmount();
});

// ── [8] hit test ────────────────────────────────────────────────────────────
console.log("── [8] pointer hit test ──");
function probeGrid(search) {
  const m = mountWith(search);
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(4);
  const out = [];
  for (let y = 0; y < 140; y += 3) for (let x = 250; x < 700; x += 3) out.push(m.diag.hitAt(x, y).map(Number).join(""));
  const isCanvas = !!cvOf(m, "hp") && !m.pane("hp").querySelector("svg");
  m.unmount();
  return { out, isCanvas };
}
check("[8] canvas mode answers every probe exactly as the SVG mode", () => {
  const a = probeGrid("?orbRender=svg");
  const b = probeGrid("?orbRender=canvas");
  assert(b.isCanvas, "the second mount really is a canvas core");
  assertEq(b.out.length, a.out.length, "grid size");
  const hits = a.out.filter((s) => s.includes("1")).length;
  assert(hits > 200, `the grid hits art (${hits})`);
  assertEq(sha(b.out), sha(a.out), "identical answers");
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  assertEq(m.diag.hitAt(260 + 98 * 0.72, 6 + 84 * 0.72), [true, false, false], "orb centre");
  assertEq(m.diag.hitAt(260 + 53 * 0.72, 6 + 39 * 0.72), [false, false, false], "core box corner");
  m.unmount();
});

// ── [9] keyframes ───────────────────────────────────────────────────────────
console.log("── [9] the sampled keyframes are the stylesheet's ──");
function keyframes(css, name) {
  const m = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css);
  const out = {};
  for (const r of m[1].matchAll(/([\d%,\s]+)\{([^}]*)\}/g)) for (const p of r[1].split(",")) out[p.trim()] = r[2].trim();
  return out;
}
const num = (s, re) => Number(re.exec(s)[1]);
check("[9] sspec / shimmer / bub / glint / bloom / glare values match @keyframes", () => {
  const css = O.orbStyleText();
  const I = O.__orbCanvasInternals;
  assert(I && typeof I.sampleAt === "function", "internals exported");
  const sp = keyframes(css, "hbo-sspec");
  const at = (name, ms, extra) => I.sampleAt(name, ms, extra);
  assertEq(at("sspec", 0), [num(sp["0%"], /translate\((-?[\d.]+)px/), num(sp["0%"], /scaleX\(([\d.]+)\)/), num(sp["0%"], /opacity: ([\d.]+)/)], "sspec 0%");
  assertEq(at("sspec", 4500).map((v) => +v.toFixed(9)), [num(sp["50%"], /translate\((-?[\d.]+)px/), num(sp["50%"], /scaleX\(([\d.]+)\)/), num(sp["50%"], /opacity: ([\d.]+)/)], "sspec 50%");
  const sh = keyframes(css, "hbo-shimmer");
  assertEq(at("shimmer", 3750).map((v) => +v.toFixed(9)), [10, -6, num(sh["50%"], /scale\(([\d.]+)\)/), num(sh["50%"], /opacity: ([\d.]+)/)], "shimmer 50%");
  assertEq(at("shimmer", 0), [-8, 4, 1, num(sh["0%"], /opacity: ([\d.]+)/)], "shimmer 0%");
  const bu = keyframes(css, "hbo-bub");
  // bubble 0 (8.5 s, no delay), rise -40: [cx, cy, r, opacity]
  assertEq(at("bub", 0, { rise: -40 }).map((v) => +v.toFixed(9)), [26.6, 78.4, 1.47, 0], "bub 0% (scale 0.7 about the origin)");
  assertEq(+at("bub", 0.12 * 8500, { rise: -40 })[3].toFixed(9), num(bu["12%"], /opacity: ([\d.]+)/), "bub 12%");
  assertEq(+at("bub", 0.85 * 8500, { rise: -40 })[3].toFixed(9), num(bu["85%"], /opacity: ([\d.]+)/), "bub 85%");
  const b100 = at("bub", 8499.999, { rise: -40 });
  [1.05 * 38, -40 + 1.05 * 112, 1.05 * 2.1, 0].forEach((e, i) => assert(Math.abs(b100[i] - e) < 1e-3, `bub 100% [${i}] ${b100[i]} vs ${e}`));
  assert(/scale\(0\.7\)/.test(bu["0%"]) && /scale\(1\.05\)/.test(bu["100%"]) && /translateY\(var\(--rise/.test(bu["100%"]), "bub transform keyframes");
  const gl = keyframes(css, "hbo-glint");
  assertEq(at("glint", 0), [num(gl["0%"], /opacity: ([\d.]+)/)], "glint 0%");
  assertEq(+at("glint", 0.84 * 3600)[0].toFixed(9), num(gl["84%"], /opacity: ([\d.]+)/), "glint 84%");
  const bl = keyframes(css, "hbo-bloom");
  assertEq(+at("bloom", 1800)[0].toFixed(9), num(bl["50%"], /opacity: ([\d.]+)/), "bloom 50%");
  const ga = keyframes(css, "hbo-glare");
  for (const [p, v] of Object.entries(ga)) {
    if (p === "100%") continue;
    const f = parseFloat(p) / 100;
    assertEq(at("glare", f * 1150 + 0.01)[0], num(v, /opacity: ([\d.]+)/), `glare ${p}`);
  }
  assert(/steps\(1, end\)/.test(css) && /hbo-glare 1\.15s/.test(css), "glare is steps(1,end) over 1.15 s");
  assert(Math.abs(I.ease(0.5) - 0.5) < 1e-6 && Math.abs(I.ease(0.25) - 0.1291) < 1e-3, "ease-in-out = cubic-bezier(0.42, 0, 0.58, 1)");
});

// ── [10] reduced motion ─────────────────────────────────────────────────────
console.log("── [10] reduced motion ──");
check("[10] canvas: no loop; each vitals change repaints one still frame at the new level", () => {
  const m = mountWith("?orbRender=canvas", { reduced: true });
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  assertEq(rafQ.length, 0, "no rAF under reduced motion");
  const b = bodies(lastDraw(m, "hp"));
  assert(b.length === 2 && Math.abs(meanY(b[1].pts) - 60) < 2, "still frame at 50%");
  m.emit("vitalChangedHealth", { current: 60, buffedMax: 300, oldValue: 150 });
  const y = meanY(bodies(lastDraw(m, "hp"))[1].pts);
  assert(Math.abs(y - 96) < 2, `repainted at 20% (${y.toFixed(2)}), no slosh`);
  assertEq(lastDraw(m, "hp").filter((x) => x.k === "fill" && x.ells.some((e) => e[2] === 30)).length, 0, "no glare");
  assertEq(rafQ.length, 0, "still no rAF");
  m.unmount();
});

// ── --bench ─────────────────────────────────────────────────────────────────
if (process.argv.includes("--bench")) {
  console.log("── bench (JS only, fake DOM / recording context) ──");
  const run = (search, label) => {
    const m = mountWith(search);
    m.snapshot(V(150, 300, 100, 200, 50, 100));
    pump(120);
    BENCH_QUIET = true;
    const n0 = LOG.length, c0 = CTX_CALLS, s0 = m.diag.canvasStats?.();
    const N = 6000;  // vsyncs → 3000 cadence ticks
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) { NOW += 1000 / 60; const q = rafQ; rafQ = []; for (const r of q) r.cb(NOW); }
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    const ticks = m.diag.frames();
    const writes = LOG.length - n0;
    const s1 = m.diag.canvasStats?.();
    const dr = s1 ? s1.reduce((a, s, i) => a + s.draws - s0[i].draws, 0) : null;
    BENCH_QUIET = false;
    console.log(`  ${label}: ${(us / (N / 2)).toFixed(1)} µs/cadence tick (3 vessels) · DOM writes/tick ${(writes / (N / 2)).toFixed(2)}`
      + (s1 ? ` · ctx calls/tick ${((CTX_CALLS - c0) / (N / 2)).toFixed(1)} · drawn ${dr}/${3 * (N / 2)} vessel-ticks (${(100 * dr / (3 * N / 2)).toFixed(0)}%)` : ""));
    m.unmount();
    return ticks;
  };
  run("?orbRender=svg", "svg   ");
  run("?orbRender=canvas", "canvas");
  // slosh-heavy: a hit every 0.5 s on every vital
  const m = mountWith("?orbRender=canvas");
  m.snapshot(V(150, 300, 100, 200, 50, 100));
  pump(60);
  BENCH_QUIET = true;
  const c0 = CTX_CALLS; const s0 = m.diag.canvasStats();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 6000; i++) {
    if (i % 30 === 0) for (const [e, mx] of [["vitalChangedHealth", 300], ["vitalChangedStamina", 200], ["vitalChangedMana", 100]]) m.emit(e, { current: (i / 30) % 2 ? mx * 0.6 : mx * 0.4, buffedMax: mx, oldValue: (i / 30) % 2 ? mx * 0.4 : mx * 0.6 });
    NOW += 1000 / 60; const q = rafQ; rafQ = []; for (const r of q) r.cb(NOW);
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  const s1 = m.diag.canvasStats();
  const dr = s1.reduce((a, s, i) => a + s.draws - s0[i].draws, 0);
  BENCH_QUIET = false;
  console.log(`  canvas, a hit every 0.5 s: ${(us / 3000).toFixed(1)} µs/tick · ctx calls/tick ${((CTX_CALLS - c0) / 3000).toFixed(1)} · drawn ${dr}/9000 (${(100 * dr / 9000).toFixed(0)}%)`);
  m.unmount();
}

console.log(`\n===========================================================`);
console.log(`PASS: ${passed} / ${passed + failed}`);
console.log(`===========================================================`);
if (failed > 0) process.exitCode = 1;
