// tests/statics_single_instance.test.mjs — the page loads ONE statics.js and
// ONE buildings.js (2026-10-18 review, STREAM-STATICS-3).
//
// scene3d/index.js imported `./statics.js?v=phase7-par` and
// `./buildings.js?v=phase-d-batch` while loop.js / cells.js / sky_dome.js /
// animated_scenery.js import the plain paths: a different specifier is a
// second module instance with its own module-level state. Every bake ran in
// index.js's instance, the plain one evaluated last and overwrote the window
// diag hooks, so `__lodCollapseDup` / `__degradePose` / `__retailDegrade` read
// 0 all session and `__staticPartAnchor` counted interior anchors only.
//   I1  importing scene3d/index.js (the unbundled page's graph) evaluates each
//       of statics.js and buildings.js once
//   I2  the window hooks read the instance the plain specifier (and so every
//       importer) gets
//
// Run from apps/holtburger-web/:  node tests/statics_single_instance.test.mjs

import assert from "node:assert/strict";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

// index.html's import map for the vendored takram modules (as tests/film_hooks.test.mjs).
const MAP = {
  "@takram/three-clouds": v("vendor/takram-three-clouds/build/index.js"),
  "@takram/three-atmosphere": v("vendor/takram/three-atmosphere.js"),
  "@takram/three-atmosphere/shaders/bruneton": v("vendor/takram/three-atmosphere-shaders-bruneton.js"),
  "@takram/three-geospatial": v("vendor/takram/three-geospatial.js"),
  "@takram/three-geospatial/shaders": v("vendor/takram/three-geospatial-shaders.js"),
  "@takram/three-geospatial-effects": v("vendor/takram/three-geospatial-effects.js"),
};
register(
  "data:text/javascript," +
    encodeURIComponent(
      `const M = ${JSON.stringify(MAP)};
      export async function resolve(spec, ctx, next) {
        if (M[spec]) return { url: M[spec], shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

globalThis.location = { search: "" };
globalThis.window = globalThis;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// Each module assigns its hook once at evaluation: count the assignments.
const sets = new Map();
for (const name of ["__lodCollapseDup", "__retailDegrade", "__degradePose", "__staticPartAnchor", "__buildingBatchStats"]) {
  let value;
  sets.set(name, 0);
  Object.defineProperty(window, name, {
    configurable: true,
    get: () => value,
    set: (x) => { sets.set(name, sets.get(name) + 1); value = x; },
  });
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${e && e.message ? e.message.split("\n")[0] : e}`);
  }
}

const quiet = { log: console.log, info: console.info, warn: console.warn };
console.log = () => {}; console.info = () => {}; console.warn = () => {};
try {
  await import("../scene3d/index.js");
} finally {
  Object.assign(console, quiet);
}
const S = await import("../scene3d/statics.js");
const B = await import("../scene3d/buildings.js");

check("I1 statics.js evaluates once", () => {
  for (const name of ["__lodCollapseDup", "__retailDegrade", "__degradePose", "__staticPartAnchor"]) {
    assert.equal(sets.get(name), 1, `${name} assigned ${sets.get(name)}x`);
  }
});
check("I1 buildings.js evaluates once", () => {
  assert.equal(sets.get("__buildingBatchStats"), 1, `assigned ${sets.get("__buildingBatchStats")}x`);
});
check("I2 the statics hooks read the instance every importer gets", () => {
  assert.equal(window.__lodCollapseDup.stats, S.lodCollapseDupStats);
  assert.equal(window.__retailDegrade.stats, S.retailDegradeStats);
  assert.equal(window.__degradePose.stats, S.degradePoseStats);
  assert.equal(window.__staticPartAnchor.stats, S.staticPartAnchorStats);
  assert.equal(window.__buildingBatchStats, B.buildingBatchStats);
});

console.log(`\nstatics single instance: ${passed} passed, ${failed} failed`);
// index.js's graph arms long timers (plugin-client waits): exit explicitly.
process.exit(failed === 0 ? 0 : 1);
