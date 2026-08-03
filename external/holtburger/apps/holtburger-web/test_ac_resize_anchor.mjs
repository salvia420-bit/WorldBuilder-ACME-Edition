// R9 — corner/edge resizer origin-anchoring unit test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_resize_anchor.mjs
//
// `ui/ac_resize_corners.js#attachCornerResizers` and
// `ui/ac_window_position.js#attachEdgeResizers` both claim (in their own
// comments) that dragging a LEFT- or TOP-affecting handle keeps the OPPOSITE
// edge pinned:
//
//   "For left/top-affecting corners, the element origin moves so the OPPOSITE
//    corner stays pinned."   (ac_resize_corners.js, pointermove)
//   "Top/left edges also shift element.style.left/top so the OPPOSITE edge
//    stays pinned"           (ac_window_position.js, attachEdgeResizers doc)
//
// The arithmetic did the opposite. With `widthSign === -1` on the left-side
// handles, `x0 - actualDw * widthSign` evaluates to `x0 + actualDw`, i.e. the
// origin moves AWAY from the cursor by exactly the amount the box grew — so
// the pinned edge slides by 2·|dx| and the panel runs off under the pointer.
//
// Derivation (tl corner, rect.left = x0, rect.width = w0, pointer delta dx):
//   pinned right edge R = x0 + w0
//   new left  = x0 + dx          (the handle follows the cursor)
//   new width = R - (x0 + dx) = w0 - dx = w0 + widthSign*dx   ✓ (code is right)
//   actualDw  = newW - w0 = -dx
//   => new left = x0 + dx = x0 - actualDw = x0 + actualDw*widthSign
// The shipped code computed `x0 - actualDw*widthSign`.
//
// This test asserts the pinned edge stays put. It FAILS on the pre-fix code.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Minimal DOM shim ──────────────────────────────────────────────────────
function makeNode(tag = "div") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(),
    style: { cssText: "", removeProperty() {} },
    dataset: {},
    className: "",
    children: [],
    parentNode: null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, ev) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
  };
}

globalThis.document = {
  createElement: (tag) => makeNode(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
  head: makeNode("head"),
  body: makeNode("body"),
};
globalThis.window = {
  getComputedStyle: () => ({ position: "absolute" }),
  innerWidth: 1920,
  innerHeight: 1080,
};
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
globalThis.setTimeout = globalThis.setTimeout;

function makeHost(rect) {
  const el = makeNode("div");
  el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height });
  return el;
}

const { attachCornerResizers } = await import(
  "file://" + resolvePath(__dirname, "ui/ac_resize_corners.js")
);
const { attachEdgeResizers } = await import(
  "file://" + resolvePath(__dirname, "ui/ac_window_position.js")
);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}
const px = (s) => parseFloat(s);

console.log("===========================================================");
console.log("R9 — resizer origin anchoring (opposite edge stays pinned)");
console.log("===========================================================");

// ── attachCornerResizers: top-left drag ───────────────────────────────────
// Host box: left=100, top=50, 400x300 → right edge 500, bottom edge 350.
// Drag the TL corner 20 px left and 20 px up.
{
  const el = makeHost({ left: 100, top: 50, width: 400, height: 300 });
  const api = attachCornerResizers(el, { minWidth: 10, minHeight: 10 });
  const tl = api.getCorners().tl;
  tl.dispatch("pointerdown", {
    button: 0, clientX: 100, clientY: 50, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  });
  tl.dispatch("pointermove", { clientX: 80, clientY: 30, pointerId: 1 });

  const w = px(el.style.width), h = px(el.style.height);
  const l = px(el.style.left), t = px(el.style.top);
  check("tl: width grows by |dx|", w === 420, `width=${w}`);
  check("tl: height grows by |dy|", h === 320, `height=${h}`);
  check("tl: left follows the cursor (100-20=80)", l === 80, `left=${l}`);
  check("tl: top follows the cursor (50-20=30)", t === 30, `top=${t}`);
  check("tl: RIGHT edge stays pinned at 500", l + w === 500, `right=${l + w}`);
  check("tl: BOTTOM edge stays pinned at 350", t + h === 350, `bottom=${t + h}`);
  api.dispose();
}

// ── attachCornerResizers: bottom-right drag (origin must NOT move) ────────
{
  const el = makeHost({ left: 100, top: 50, width: 400, height: 300 });
  const api = attachCornerResizers(el, { minWidth: 10, minHeight: 10 });
  const br = api.getCorners().br;
  br.dispatch("pointerdown", {
    button: 0, clientX: 500, clientY: 350, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  });
  br.dispatch("pointermove", { clientX: 520, clientY: 370, pointerId: 1 });
  check("br: width grows by dx", px(el.style.width) === 420, `width=${el.style.width}`);
  check("br: height grows by dy", px(el.style.height) === 320, `height=${el.style.height}`);
  check("br: left untouched", el.style.left === undefined, `left=${el.style.left}`);
  check("br: top untouched", el.style.top === undefined, `top=${el.style.top}`);
  api.dispose();
}

// ── attachCornerResizers: bottom-left, clamped at minWidth ────────────────
// Dragging the BL corner right by 380 px would shrink the box to 20 px wide;
// minWidth=200 clamps it. The pinned RIGHT edge must still be 500 — the
// element must stop tracking the cursor once clamped.
{
  const el = makeHost({ left: 100, top: 50, width: 400, height: 300 });
  const api = attachCornerResizers(el, { minWidth: 200, minHeight: 10 });
  const bl = api.getCorners().bl;
  bl.dispatch("pointerdown", {
    button: 0, clientX: 100, clientY: 350, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  });
  bl.dispatch("pointermove", { clientX: 480, clientY: 350, pointerId: 1 });
  const w = px(el.style.width), l = px(el.style.left);
  check("bl clamp: width floors at minWidth 200", w === 200, `width=${w}`);
  check("bl clamp: RIGHT edge still pinned at 500", l + w === 500, `left=${l} right=${l + w}`);
  api.dispose();
}

// ── attachEdgeResizers: left edge ─────────────────────────────────────────
{
  const el = makeHost({ left: 100, top: 50, width: 400, height: 300 });
  const api = attachEdgeResizers(el, { edges: ["left"], minWidth: 10, minHeight: 10 });
  const left = api.getHandles().left;
  left.dispatch("pointerdown", {
    button: 0, clientX: 100, clientY: 200, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  });
  left.dispatch("pointermove", { clientX: 60, clientY: 200, pointerId: 1 });
  const w = px(el.style.width), l = px(el.style.left);
  check("left edge: width grows by 40", w === 440, `width=${w}`);
  check("left edge: left follows the cursor (60)", l === 60, `left=${l}`);
  check("left edge: RIGHT edge stays pinned at 500", l + w === 500, `right=${l + w}`);
  api.dispose();
}

// ── attachEdgeResizers: top edge ──────────────────────────────────────────
{
  const el = makeHost({ left: 100, top: 50, width: 400, height: 300 });
  const api = attachEdgeResizers(el, { edges: ["top"], minWidth: 10, minHeight: 10 });
  const top = api.getHandles().top;
  top.dispatch("pointerdown", {
    button: 0, clientX: 300, clientY: 50, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  });
  top.dispatch("pointermove", { clientX: 300, clientY: 20, pointerId: 1 });
  const h = px(el.style.height), t = px(el.style.top);
  check("top edge: height grows by 30", h === 330, `height=${h}`);
  check("top edge: top follows the cursor (20)", t === 20, `top=${t}`);
  check("top edge: BOTTOM edge stays pinned at 350", t + h === 350, `bottom=${t + h}`);
  api.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
