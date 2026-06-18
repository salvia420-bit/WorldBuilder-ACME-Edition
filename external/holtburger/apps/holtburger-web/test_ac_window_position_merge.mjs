// R11 — `ui/ac_window_position.js` read-modify-merge unit test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_window_position_merge.mjs
//
// The CHAT window (0x10000600) has TWO writers under one localStorage key:
// persistWindowSize writes width/height; attachWindowPosition writes x/y/locked.
// Before R11 a position write emitted the window's stale (or null) width/height,
// clobbering the size the resize writer had committed. persistPosition() now
// read-modify-merges: it re-reads the CURRENT stored size and overwrites only
// x/y/locked. This test fails on the pre-R11 (clobbering) behaviour.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl = "file://" + resolvePath(__dirname, "ui/ac_window_position.js");

// ── Minimal DOM / storage stubs ───────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { dispatchEvent: () => {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

function makeElement() {
  return {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const { attachWindowPosition, WINDOW_ID } = await import(helperUrl);
const CHAT = WINDOW_ID.CHAT;           // 0x10000600
const KEY = "hb.window." + (CHAT >>> 0).toString(16);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name} — ${detail}`); }
}

console.log("===========================================================");
console.log("R11 — ac_window_position read-modify-merge");
console.log("===========================================================");

// Seed a prior position + size, then attach (returning user).
store.set(KEY, JSON.stringify({ x: 10, y: 20, locked: false, width: 400, height: 300 }));
const el = makeElement();
const api = attachWindowPosition(el, { windowId: CHAT, clampToViewport: false });

// Simulate persistWindowSize.commit() resizing the window AFTER mount: the
// stored size is now 450x350, but attachWindowPosition's local state still
// holds the mount-time 400x300.
store.set(KEY, JSON.stringify({ x: 10, y: 20, locked: false, width: 450, height: 350 }));

// A lock toggle is a position-class write — it must preserve the CURRENT size.
api.setLocked(true);
let after = JSON.parse(store.get(KEY));
check("setLocked merges current width/height (not stale 400x300)",
  after.width === 450 && after.height === 350,
  `width=${after.width}, height=${after.height}`);
check("setLocked preserves x/y", after.x === 10 && after.y === 20,
  `x=${after.x}, y=${after.y}`);
check("setLocked persisted locked=true", after.locked === true, `locked=${after.locked}`);

// resetPosition (x/y → null) must also keep the size.
store.set(KEY, JSON.stringify({ x: 99, y: 88, locked: true, width: 512, height: 288 }));
api.resetPosition();
after = JSON.parse(store.get(KEY));
check("resetPosition preserves width/height",
  after.width === 512 && after.height === 288,
  `width=${after.width}, height=${after.height}`);
check("resetPosition cleared x/y", after.x === null && after.y === null,
  `x=${after.x}, y=${after.y}`);

console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
