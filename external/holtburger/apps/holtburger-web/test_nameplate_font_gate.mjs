// Batch 27 / #27 (Option A) — standalone ESM test for the font-ready bake
// gate in `scene3d/nameplate_sprite.js`'s `getOrBakeNameplateMaterial`.
//
// The bug (#27): when an entity spawns before the AC bitmap font loads, a
// system-font CanvasTexture+SpriteMaterial was baked and cached under a
// `…|sys` key while a live Sprite held it; on first such bake the module
// scheduled `loadAcFont().then(() => disposeNameplateCache())`, which
// disposed CanvasTextures STILL HELD by live sprites and never re-baked
// the early system-font nameplates (the per-guid dedup ignores the font
// generation in the cache key).
//
// Option A fix: do NOT bake a system-font nameplate during the boot race.
// Gate the system-font bake behind `whenPrimaryFontsReady()` WITH a
// timeout fallback so that:
//   - font-not-ready  → bake DEFERS (returns null, no `…|sys` entry made),
//   - font-ready      → bake proceeds in the AC (retail) font,
//   - timeout elapses → bake proceeds in the system font (so nameplates
//     still appear if the AC font never loads).
// And the buggy "dispose live textures on font load" watch is removed.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/path/to/three.module.js node test_nameplate_font_gate.mjs
//
// Same locate-three + factory-load pattern as test_nameplate_lod_badge.mjs.
// We strip the THREE + ac_font imports and inject controllable stubs for
// getAcFont / renderAcText / whenPrimaryFontsReady, plus a minimal global
// document + a setTimeout interceptor so we can fire the timeout fallback
// deterministically without waiting the real 5 s.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
}

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        const idx = joinPath(npxRoot, dir, "node_modules/three/build/three.module.js");
        if (existsSync(idx)) return idx;
      }
    }
  } catch (_) {}
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Batch27 #27 font-gate test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/path/to/three.module.js node test_nameplate_font_gate.mjs");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("Batch 27 / #27 (Option A) — nameplate font-ready bake gate test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- minimal global DOM + setTimeout interceptor ---------------------
// The system-font bake path uses document.createElement("canvas") +
// a 2D context with measureText / fill / stroke. A plain stub suffices —
// THREE.CanvasTexture just stores the canvas as `.image` (no pixel read).
function makeCtx() {
  return {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textAlign: "",
    textBaseline: "",
    lineWidth: 0,
    lineJoin: "",
    imageSmoothingEnabled: false,
    measureText: (s) => ({ width: (s ? s.length : 0) * 18 }),
    beginPath() {},
    roundRect() {},
    fill() {},
    fillRect() {},
    strokeText() {},
    fillText() {},
    drawImage() {},
  };
}
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => makeCtx(),
  };
}
globalThis.document = {
  createElement: (tag) => (tag === "canvas" ? makeCanvas() : { tagName: tag }),
};
// Deliberately do NOT define globalThis.window — the module's
// module-load browser branches (the self-managed rAF LOD loop + the
// buff-badge setInterval subscription) are guarded by `typeof window
// !== "undefined"` and must stay dormant in this Node harness (mirrors
// test_nameplate_lod_badge.mjs). `_flushDeferredNameplates` likewise
// short-circuits on `typeof window === "undefined"`.

// Intercept setTimeout so we can capture + fire the timeout-fallback
// callback deterministically. The module only schedules ONE timeout (the
// gate-open fallback). We do NOT auto-fire it; the test fires it manually.
let _capturedTimeoutCb = null;
const _realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (cb, _ms) => {
  _capturedTimeoutCb = cb;
  return 0; // dummy handle; nothing to clear in this test
};

// ---- controllable ac_font stubs --------------------------------------
let _acFontReady = false;       // getAcFont() truthiness
let _primaryReadyResolve = null; // resolve whenPrimaryFontsReady()
let _disposeCacheAutoCalls = 0;  // sentinel: prove no auto-dispose wiring

const getAcFontStub = () => (_acFontReady ? { id: 0x40000000 } : null);
const renderAcTextStub = (text) => {
  if (!_acFontReady) return null;
  // Return a fake text canvas with positive dims so _bakeWithCanvasText
  // proceeds (it reads .width/.height only).
  return { width: Math.max(1, (text ? text.length : 1) * 16), height: 32 };
};
const whenPrimaryFontsReadyStub = () =>
  new Promise((res) => { _primaryReadyResolve = res; });

// ---- load nameplate_sprite.js via the factory pattern ----------------
const npPath = resolvePath(__dirname, "scene3d", "nameplate_sprite.js");
let src = readFileSync(npPath, "utf8");
src = src
  .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
  .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\.\/ui\/ac_font\.js["'];?\s*$/m, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+class\s+/gm, "class ");

const factory = new Function(
  "THREE",
  "getAcFont",
  "renderAcText",
  "whenPrimaryFontsReady",
  `${src}\n; return { getOrBakeNameplateMaterial, getNameplateCacheSize, disposeNameplateCache };`,
);
const { getOrBakeNameplateMaterial, getNameplateCacheSize, disposeNameplateCache } = factory(
  THREE,
  getAcFontStub,
  renderAcTextStub,
  whenPrimaryFontsReadyStub,
);

check(
  "getOrBakeNameplateMaterial + cache helpers exported",
  typeof getOrBakeNameplateMaterial === "function" &&
    typeof getNameplateCacheSize === "function" &&
    typeof disposeNameplateCache === "function",
);

// ---- Static do-not-regress checks on the source ----------------------
check(
  "source no longer wires disposeNameplateCache() to font load (#27 bug removed)",
  !/loadAcFont\s*\(\s*\)\s*[\s\S]{0,120}disposeNameplateCache/.test(src),
);
check(
  "source gates the bake behind a ready signal (whenPrimaryFontsReady)",
  /whenPrimaryFontsReady\s*\(/.test(src),
);
check(
  "source has a timeout fallback for the system-font bake gate",
  /setTimeout\s*\(/.test(src) && /_systemFontBakeAllowed/.test(src),
);

// ---- Case 1: font NOT ready, gate closed → bake DEFERS ---------------
_acFontReady = false;
const before1 = getNameplateCacheSize();
const r1 = getOrBakeNameplateMaterial("Hudriffa the Shopkeeper", "#ffffff");
check(
  "font-not-ready: bake DEFERS (returns null — no system-font nameplate created)",
  r1 === null,
  `returned=${r1 === null ? "null" : typeof r1}`,
);
check(
  "font-not-ready: NO cache entry was created (no `…|sys` texture baked)",
  getNameplateCacheSize() === before1,
  `size ${before1} → ${getNameplateCacheSize()}`,
);
// The first bake attempt must have armed the watch (scheduled a timeout
// and called whenPrimaryFontsReady).
check(
  "first bake attempt armed the font-ready watch (timeout scheduled + promise pending)",
  typeof _capturedTimeoutCb === "function" && typeof _primaryReadyResolve === "function",
  `timeoutCb=${typeof _capturedTimeoutCb}, readyResolve=${typeof _primaryReadyResolve}`,
);

// ---- Case 2: font READY → bake proceeds in the AC font ---------------
_acFontReady = true;
const r2 = getOrBakeNameplateMaterial("Hudriffa the Shopkeeper", "#ffffff");
check(
  "font-ready: bake PROCEEDS (returns an entry with texture + material)",
  !!(r2 && r2.texture && r2.material),
  `entry=${r2 ? "obj" : r2}`,
);
check(
  "font-ready: cache grew by one (AC-font entry cached)",
  getNameplateCacheSize() === before1 + 1,
  `size=${getNameplateCacheSize()}`,
);
// Same name+colour returns the SAME cached entry (the `…|ac` key).
const r2b = getOrBakeNameplateMaterial("Hudriffa the Shopkeeper", "#ffffff");
check(
  "font-ready: repeat bake reuses the cached AC entry (idempotent)",
  r2b === r2 && getNameplateCacheSize() === before1 + 1,
);

// ---- Case 3: font NEVER ready but TIMEOUT fired → system-font bake ----
_acFontReady = false;
// Fire the captured timeout-fallback callback → opens the system-font gate.
check(
  "timeout-fallback callback was captured (ready to fire)",
  typeof _capturedTimeoutCb === "function",
);
_capturedTimeoutCb();
const before3 = getNameplateCacheSize();
const r3 = getOrBakeNameplateMaterial("Foozle the Forsaken", "#e07070");
check(
  "timeout-open + font-not-ready: bake PROCEEDS in the system font (nameplates still appear)",
  !!(r3 && r3.texture && r3.material),
  `entry=${r3 ? "obj" : r3}`,
);
check(
  "timeout path: cache grew by one (a `…|sys` entry was baked)",
  getNameplateCacheSize() === before3 + 1,
  `size ${before3} → ${getNameplateCacheSize()}`,
);

// ---- Do-not-regress: resolving the ready promise must NOT auto-dispose
// any live textures. With Option A there is no dispose-on-load wiring, so
// disposing live sprites' textures can't happen. We resolve the promise
// and assert the cache (holding our two live entries) was NOT cleared.
const sizeBeforeResolve = getNameplateCacheSize();
if (_primaryReadyResolve) _primaryReadyResolve(undefined);
await new Promise((res) => _realSetTimeout(res, 0)); // let microtasks flush
check(
  "do-not-regress: font becoming ready does NOT dispose/clear live cached textures",
  getNameplateCacheSize() === sizeBeforeResolve && _disposeCacheAutoCalls === 0,
  `size ${sizeBeforeResolve} → ${getNameplateCacheSize()}`,
);

// ---- restore globals -------------------------------------------------
globalThis.setTimeout = _realSetTimeout;
delete globalThis.document;

console.log("=========================");
if (failed === 0) {
  console.log("PASS: all Batch 27 #27 font-gate checks green.");
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed.`);
  process.exit(1);
}
