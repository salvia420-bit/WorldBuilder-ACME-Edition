// R9 — `<ac-text>` must not spin when its font never loads.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_font_render_retry.mjs
//
// `ui/ac_font.js` AcTextElement._render ended with:
//
//     const runtime = getAcFont(opts.fontId ?? UI_FONT_ID);
//     if (!runtime) {
//       loadAcFont(opts.fontId ?? UI_FONT_ID).then(() => this._render());
//       return;
//     }
//
// `loadAcFont` resolves WITHOUT ever awaiting when the font is unavailable:
//   * `if (!wasm?.fetch_font) { runtimes.set(fontId, null); return null; }` is a
//     synchronous early return inside an `async` function, and
//   * once that null is in `runtimes`, `const cached = runtimes.get(fontId);
//     if (cached !== undefined) return cached;` short-circuits every later call.
//
// So `.then(() => this._render())` re-enters `_render`, which calls
// `loadAcFont` again, which resolves in the SAME microtask drain — an
// unbounded microtask chain. Microtasks are drained to exhaustion before the
// event loop advances, so nothing else ever runs again: the tab is frozen, not
// merely busy. Reachable on any page where `window.__hbWasm.fetch_font` is not
// yet present when the first `<ac-text>` upgrades (registerAcText defers the
// customElements.define to a setTimeout, so already-mounted plugin labels all
// upgrade at once).
//
// The circuit breaker below is what keeps THIS TEST from hanging; the shipped
// code has no such breaker.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Minimal DOM shim, just enough to instantiate the custom element ───────
let definedCtor = null;
globalThis.HTMLElement = class {
  constructor() {
    this.style = {};
    this._attrs = new Map();
    this.childNodes = [];
    this.children = [];
    this.textContent = "";
    this.isConnected = true;
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  hasAttribute(n) { return this._attrs.has(n); }
  removeAttribute(n) { this._attrs.delete(n); }
  appendChild(c) { this.childNodes.push(c); return c; }
};
globalThis.MutationObserver = class {
  observe() {} disconnect() {}
  constructor(cb) { this._cb = cb; }
};
globalThis.customElements = {
  _defs: new Map(),
  define(name, ctor) { this._defs.set(name, ctor); definedCtor = ctor; },
  get(name) { return this._defs.get(name); },
};
globalThis.document = {
  createElement: () => ({ style: {}, getContext: () => null, width: 0, height: 0 }),
};
globalThis.Node = { TEXT_NODE: 3 };
// NO `fetch_font` on the wasm bridge — the exact "font never loads" condition.
globalThis.window = { __hbWasm: {} };

const mod = await import("file://" + resolvePath(__dirname, "ui/ac_font.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R9 — <ac-text> render retry is bounded when the font is absent");
console.log("===========================================================");

// registerAcText defers customElements.define into a setTimeout(0).
mod.registerAcText();
await new Promise((r) => setTimeout(r, 0));

check("ac-text custom element registered", typeof definedCtor === "function",
  `definedCtor=${typeof definedCtor}`);

const el = new definedCtor();
el.textContent = "Hello";

// Circuit breaker: count _render entries and hard-stop at 50 so an unbounded
// microtask chain surfaces as a failed assertion instead of a hung process.
const proto = Object.getPrototypeOf(el);
const origRender = proto._render;
const BREAKER = 50;
let renderCalls = 0;
el._render = function patchedRender() {
  renderCalls += 1;
  if (renderCalls > BREAKER) return; // stop the runaway so the test can report
  return origRender.call(this);
};

el.connectedCallback();

// Drain: a macrotask turn only runs once the microtask queue is EMPTY, so
// reaching this line at all means the chain terminated (or the breaker fired).
await new Promise((r) => setTimeout(r, 0));
await new Promise((r) => setTimeout(r, 0));

check(
  "_render did not spin (<= 4 calls, breaker is 50)",
  renderCalls <= 4,
  `renderCalls=${renderCalls}${renderCalls > BREAKER ? " (CIRCUIT BREAKER TRIPPED — unbounded retry)" : ""}`,
);

// And the recovery contract still holds: once a font genuinely lands, the
// element must re-render. addFontLoadListener is the durable signal.
let notified = 0;
const unsub = mod.addFontLoadListener(() => { notified += 1; });
check("addFontLoadListener returns an unsubscribe fn", typeof unsub === "function");
unsub();
check("unsubscribed listener stops firing", notified === 0, `notified=${notified}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
