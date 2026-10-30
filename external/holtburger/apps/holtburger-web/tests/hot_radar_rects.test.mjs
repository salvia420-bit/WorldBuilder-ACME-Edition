// tests/hot_radar_rects.test.mjs — lane F hot spots (2026-10-26), direct HUD
// fix: plugins/radar.js paints each blip's pixel set as merged rects.
//
// CLAIM: the radar canvas holds exactly the same pixels after every repaint
// as with the shipped per-pixel fillRect loop, with fewer canvas calls.
//
//   [1] blipRects() on every shipped pixel set (seven blip shapes, the
//       selection bracket, the centre plus) and ~3,000 random sets covers
//       exactly the set's pixels, each once (rasterized at k = 1..4 with an
//       ALPHA colour over a random background, so a double fill would show);
//       sets with a repeated pixel (incl. 0 / -0), odd length or non-integer
//       offsets return null (→ the per-pixel loop).
//   [2] the REAL radar, two module instances on fake DOMs whose 2D contexts
//       rasterize every call: the per-pixel arm (test seam) and the merged
//       arm, fed the same world (many overlapping blips of every shape, a
//       selection, dimmed far-z blips, the BlackFog2 blank, a backing-scale
//       change), have identical canvases after every update; the merged arm
//       issues fewer fillRect calls; every rect lands on the integer grid.
//
// Run:   cd apps/holtburger-web && node tests/hot_radar_rects.test.mjs

// ── rasterizing 2D context (integer-aligned rects only) ──────────────────────
function parseColor(c) {
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(`colour ${c}`);
}
function rasterCtx(sizeOf) {
  const st = { buf: null, w: 0, fills: 0, offGrid: 0 };
  const ensure = () => { const w = sizeOf(); if (!st.buf || st.w !== w) { st.w = w; st.buf = new Float64Array(w * w * 4); } };
  return {
    st,
    fillStyle: "#000000",
    clearRect(x, y, w, h) { ensure(); st.buf.fill(0); },
    fillRect(x, y, w, h) {
      ensure();
      st.fills += 1;
      if (![x, y, w, h].every(Number.isInteger)) { st.offGrid += 1; return; }
      const [r, g, b, a] = parseColor(this.fillStyle);
      for (let py = Math.max(0, y); py < Math.min(st.w, y + h); py++) {
        for (let px = Math.max(0, x); px < Math.min(st.w, x + w); px++) {
          const o = (py * st.w + px) * 4, B = st.buf;
          B[o] = r * a + B[o] * (1 - a); B[o + 1] = g * a + B[o + 1] * (1 - a);
          B[o + 2] = b * a + B[o + 2] * (1 - a); B[o + 3] = a + B[o + 3] * (1 - a);
        }
      }
    },
  };
}

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── fake DOM (as tests/hud_radar_paint.test.mjs) ─────────────────────────────
let canvasCtxs = [];
function fakeEl(tag) {
  const cls = new Set(), attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(), children: [], parentNode: null, className: "", id: "", title: "",
    textContent: "", hidden: false, tabIndex: -1, width: 0, height: 0,
    style: { setProperty() {}, removeProperty() {} }, dataset: {},
    classList: { add(...c) { for (const x of c) cls.add(x); }, remove(...c) { for (const x of c) cls.delete(x); },
      toggle(c, f) { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; }, contains(c) { return cls.has(c); } },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    remove() { const p = el.parentNode; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); } el.parentNode = null; },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); }, getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); }, hasAttribute(k) { return attrs.has(k); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120, x: 0, y: 0 }; },
    getContext() { const c = rasterCtx(() => el.width || 1); canvasCtxs.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
    focus() {}, blur() {}, click() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
  return el;
}
let rafQueue = [];
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.innerWidth = 1920; globalThis.innerHeight = 1080; globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const doc = { createElement: (t) => { const e = fakeEl(t); e.ownerDocument = doc; return e; }, getElementById: () => null,
  addEventListener() {}, removeEventListener() {}, hidden: false };
doc.head = fakeEl("head"); doc.body = fakeEl("body"); doc.documentElement = fakeEl("html");
globalThis.document = doc;

// World: the local player and a crowd of blips around it.
const LOCAL = 0x50000001, LB = 0xA9B4001F;
let player = { landblockId: LB, x: 96, y: 96, z: 60, heading: 0.3 };
const r0 = rng(99);
const mobs = Array.from({ length: 70 }, (_, i) => ({
  guid: 0x80001000 + i,
  pos: [LB, 96 + (r0() - 0.5) * 120, 96 + (r0() - 0.5) * 120, 60 + (r0() < 0.3 ? 20 : 0)],
  odf: [0, 0x8, 0x20, 0x4000000, 0x2000000][i % 5],   // player / PK / PKLite flags → X, HOLLOW, …
}));
let selected = 0;
globalThis.getLocalPlayerGuid = () => LOCAL;
globalThis.__sessionHandle = {
  getLocalPlayerPose: () => ({ ...player }),
  getCurrentCellId: () => 0,
  nearbyEntityGuids: () => mobs.map((m) => m.guid),
  objectPosition: (g) => { const m = mobs.find((x) => x.guid === g); return m ? m.pos.slice() : null; },
  objectDescFlags: (g) => { const m = mobs.find((x) => x.guid === g); return m ? m.odf : 0x8; },
  objectIntProperty: (g, prop) => (prop === 133 ? 4 : prop === 1 ? 0x10 : undefined),
  objectInstanceIdProperty: () => 0,
  objectName: () => "Drudge",
};
globalThis.liveScene3d = { entityManager: { getSelectedTarget: () => selected } };

const _warn = console.warn;
let radarWarned = 0;
console.warn = (...a) => { if (String(a[0]).includes("[radar]")) radarWarned += 1; _warn(...a); };
const Rref = await import("../plugins/radar.js?ref");
const Rnew = await import("../plugins/radar.js?new");
Rref.__setRadarMergeRectsForTest(false);
Rnew.__setRadarMergeRectsForTest(true);

// ── [1] unit: blipRects covers each pixel exactly once ───────────────────────
function rasterOffsets(offsets, x, y, k, color, bgSeed, merged) {
  const W = 40 * k;
  const ctx = rasterCtx(() => W);
  ctx.clearRect(0, 0, W, W);
  const rb = rng(bgSeed);
  ctx.fillStyle = "rgba(10,20,30,0.5)";
  for (let i = 0; i < 30; i++) ctx.fillRect(((rb() * 40) | 0) * k, ((rb() * 40) | 0) * k, k * 3, k * 2);
  ctx.fillStyle = color;
  const rects = merged ? Rnew.blipRects(offsets) : null;
  if (merged && rects) for (let j = 0; j < rects.length; j += 4) ctx.fillRect((x + rects[j]) * k, (y + rects[j + 1]) * k, rects[j + 2] * k, rects[j + 3] * k);
  else for (let j = 0; j < offsets.length; j += 2) ctx.fillRect((x + offsets[j]) * k, (y + offsets[j + 1]) * k, k, k);
  return { buf: ctx.st.buf, fills: ctx.st.fills };
}
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const shipped = [1, 2, 3, 4, 5, 6, 7].map((s) => [`shape ${s}`, Rnew.blipPixels(s)]).concat([["SELECTED", Rnew.SELECTED_PIXELS], ["CENTRE", Rnew.CENTRE_PIXELS]]);
check("[1a] every shipped pixel set: merged rects paint the same pixels (k 1..4, alpha colour)", () => {
  for (const [name, off] of shipped) {
    assert(Rnew.blipRects(off) !== null, `${name} should merge`);
    for (let k = 1; k <= 4; k++) for (const [x, y] of [[10, 10], [0, 3], [37, 38]]) {
      const a = rasterOffsets(off, x, y, k, "rgba(200,40,90,0.6)", k * 7 + x, false);
      const b = rasterOffsets(off, x, y, k, "rgba(200,40,90,0.6)", k * 7 + x, true);
      assert(same(a.buf, b.buf), `${name} k=${k} at ${x},${y}`);
    }
  }
  const calls = shipped.map(([n, o]) => `${n}: ${o.length / 2}→${Rnew.blipRects(o).length / 4}`).join(", ");
  console.log(`      fillRect calls per set: ${calls}`);
});
check("[1b] ~3,000 random sets: same pixels when merged; null for repeats / odd / non-integer", () => {
  const r = rng(2026);
  let merged = 0, refused = 0;
  for (let t = 0; t < 3000; t++) {
    const n = 1 + ((r() * 14) | 0);
    const off = [];
    for (let i = 0; i < n; i++) off.push(((r() * 9) | 0) - 4, ((r() * 9) | 0) - 4);
    const kind = r();
    if (kind < 0.05) off.push(off[0], off[1]);                       // a repeated pixel
    else if (kind < 0.08) { off.push(0, 0); off.push(-0, 0); }        // 0 and -0: the same pixel
    else if (kind < 0.10) off.push(1);                                // odd length
    else if (kind < 0.12) off[0] += 0.5;                              // off the grid
    const rects = Rnew.blipRects(off);
    const keys = new Set();
    let dup = false;
    for (let j = 0; j + 1 < off.length; j += 2) { const kk = `${off[j] + 0},${off[j + 1] + 0}`; if (keys.has(kk)) dup = true; keys.add(kk); }
    const bad = (off.length & 1) === 1 || dup || off.some((v) => !Number.isInteger(v));
    if (bad) { assert(rects === null, `set ${t} must refuse (${JSON.stringify(off)})`); refused++; continue; }
    assert(rects !== null, `set ${t} should merge`);
    merged++;
    const k = 1 + (t % 3);
    const a = rasterOffsets(off, 12, 15, k, "rgba(30,200,60,0.55)", t, false);
    const b = rasterOffsets(off, 12, 15, k, "rgba(30,200,60,0.55)", t, true);
    assert(same(a.buf, b.buf), `set ${t} ${JSON.stringify(off)}`);
  }
  console.log(`      ${merged} merged, ${refused} refused`);
});

// ── [2] integration: the real radar, per-pixel arm vs merged arm ─────────────
function mountArm(R) {
  canvasCtxs = [];
  rafQueue = [];
  const unmount = R.mount({});
  const ctxs = canvasCtxs.slice();
  const queue = rafQueue;
  return { R, unmount, ctx: ctxs[ctxs.length - 1], queue };
}
const A = mountArm(Rref);
const B = mountArm(Rnew);
let now = 10000;
function tickArm(arm) {
  rafQueue = arm.queue;
  const cb = arm.queue[arm.queue.length - 1];
  cb(now);
}
let diff = null, updates = 0, fillsA = 0, fillsB = 0;
const r1 = rng(5);
for (let f = 0; f < 120 && !diff; f++) {
  now += 30;
  for (const m of mobs) if (r1() < 0.5) { m.pos[1] += (r1() - 0.5) * 3; m.pos[2] += (r1() - 0.5) * 3; }
  player = { ...player, heading: player.heading + (f % 9 === 0 ? 0.25 : 0), x: player.x + (f % 4 === 0 ? 0.7 : 0) };
  selected = f % 17 < 6 ? mobs[f % mobs.length].guid : 0;
  window.__radarBlank = f % 23 >= 20;
  devicePixelRatio = f >= 60 ? 2 : 1;                                   // backing scale k 1 → 2
  window.dispatchEvent?.({ type: "resize" });
  const fa0 = A.ctx.st.fills, fb0 = B.ctx.st.fills;
  tickArm(A); tickArm(B);
  fillsA += A.ctx.st.fills - fa0; fillsB += B.ctx.st.fills - fb0;
  updates++;
  if (!A.ctx.st.buf || !B.ctx.st.buf) continue;
  if (!same(A.ctx.st.buf, B.ctx.st.buf)) diff = `update ${f}`;
}
check(`[2a] the real radar: identical canvases after each of ${updates} updates`, () => {
  assert(radarWarned === 0, "the radar's update threw (see the warning above)");
  assert(!diff, diff);
});
check("[2b] merged arm issues fewer fillRect calls; all on the integer grid", () => {
  assert(fillsB < fillsA, `merged ${fillsB} vs per-pixel ${fillsA}`);
  assert(A.ctx.st.offGrid === 0 && B.ctx.st.offGrid === 0, `off-grid fills ${A.ctx.st.offGrid} / ${B.ctx.st.offGrid}`);
  console.log(`      fillRect calls over the run: per-pixel ${fillsA} → merged ${fillsB} (${(100 * (1 - fillsB / fillsA)).toFixed(0)}% fewer)`);
});
try { A.unmount(); B.unmount(); } catch (_) {}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
