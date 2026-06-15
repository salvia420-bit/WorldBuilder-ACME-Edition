// Problem-A fix (2026-06-15) — headless ESM test for the fixed light POOL
// (?lightPool=on) in scene3d/lighting.js.
//
// THE BUG it guards: three.js bakes the per-type COUNT of *visible* lights into
// every lit material's shader program cache key, so flipping a source light's
// `.visible` (the legacy distance-cap and the entity SetLight hook both do this)
// changes the count and relinks every material → the multi-second freeze on a
// spell cast. The pool fix renders through a FIXED set of always-visible pool
// lights fed from permanently-`.visible=false` source carriers, so the count is
// constant forever.
//
// Asserts:
//   1. allocateLightPool: `?lightPool` config → N point + M spot pool lights
//      under the lights group, all visible + intensity 0 + non-shadowing.
//   2. THE INVARIANT — with the pool on, the number of VISIBLE point/spot lights
//      in the scene is CONSTANT (= pool size) no matter how many source lights
//      are attached (2 → 8), and every source stays `.visible=false`. This is
//      the property that makes the renderer never relink.
//   3. Feed correctness: the nearest `pointCount` sources' position/colour/
//      intensity are copied into the pool slots; unused slots are driven to 0.
//   4. Legacy parity: pool OFF → bundle.lightPool is null and the cap flips
//      source `.visible` exactly as before (byte-identical legacy path).
//   5. Sun indoor/outdoor: pool ON → tick never flips sun.visible (constant
//      directional count); it swaps sun.intensity instead (>0 → 0 → >0).
//
// Run: cd apps/holtburger-web/ && node test_light_pool.mjs
// (SKIPs cleanly if three can't be located.)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
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
  console.log("light-pool ESM test: SKIP (three not located).");
  process.exit(0);
}
const THREE = await import("file://" + threePath);

console.log("Problem-A — fixed light POOL standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load lighting.js with closure-captured THREE (mirror test_phase7_6) ----
function loadModule(relPath) {
  let src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/landblock_lru\.js["'];?\s*$/m, "");
  return src;
}
function stripExports(src) {
  return src
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}
const csmSrc = loadModule("scene3d/csm.js");
const lightingSrc = loadModule("scene3d/lighting.js");
const lbKeyOfShim =
  "const LB_KEY_MASK = 0xffff_0000 >>> 0;\n" +
  "function lbKeyOf(idOrKey) { return (idOrKey & LB_KEY_MASK) >>> 0; }\n";
const composite =
  lbKeyOfShim + "\n" +
  stripExports(csmSrc) + "\n" +
  stripExports(lightingSrc) + "\n" +
  "; return { setupSceneLighting, tickLightingForCellState, capActiveLightsByDistance, __resetLightPoolConfigForTest };";
const mod = new Function("THREE", composite)(THREE);
const {
  setupSceneLighting,
  tickLightingForCellState,
  capActiveLightsByDistance,
  __resetLightPoolConfigForTest,
} = mod;

// Helper — count VISIBLE point + spot lights currently under a group (this is
// what three.js feeds into the program cache key as the per-type count).
function countVisibleDynamicLights(group) {
  let n = 0;
  group.traverse((o) => {
    if ((o.isPointLight || o.isSpotLight) && o.visible) n += 1;
  });
  return n;
}
function makeSource(x, intensity, colorHex) {
  const l = new THREE.PointLight(colorHex, intensity, 0, 2);
  l.position.set(x, 0, 0);
  l.visible = false; // attach-site forces this in pool mode
  return l;
}

// ===================================================================
// 1. Allocation
// ===================================================================
__resetLightPoolConfigForTest({ enabled: true, pointCount: 4, spotCount: 2 });
const scene = new THREE.Scene();
const lighting = setupSceneLighting(scene, {});
const pool = lighting.lightPool;
const poolPoints = lighting.lightsGroup.children.filter(
  (c) => c.isPointLight && /lightpool-point/.test(c.name)
);
const poolSpots = lighting.lightsGroup.children.filter(
  (c) => c.isSpotLight && /lightpool-spot/.test(c.name)
);
check(
  "1a: pool allocated 4 point + 2 spot lights under the lights group",
  pool && poolPoints.length === 4 && poolSpots.length === 2,
  `point=${poolPoints.length}, spot=${poolSpots.length}`
);
check(
  "1b: every pool light is visible=true + intensity=0 + castShadow=false",
  [...poolPoints, ...poolSpots].every(
    (l) => l.visible === true && l.intensity === 0 && l.castShadow === false
  ),
  ""
);

// ===================================================================
// 2 + 3. Count invariant + feed correctness
// ===================================================================
const scene3d = {
  lighting,
  activeLights: [],
  camera: { position: { x: 0, y: 0, z: 0 } },
};
// The renderer counts ALL visible point + spot lights; the pool is 4 point +
// 2 spot, so the constant the materials compile against is 6.
const POOL_VISIBLE = 4 + 2;
const baselineVisible = countVisibleDynamicLights(lighting.lightsGroup);
check(
  "2a: with zero sources the visible dynamic-light count == pool size (4 point + 2 spot = 6)",
  baselineVisible === POOL_VISIBLE,
  `visible=${baselineVisible}`
);

// Attach 2 sources at x=0.5 (red, i=3) and x=10 (green, i=4).
const srcNear = makeSource(0.5, 3, 0xff0000);
const srcFar = makeSource(10, 4, 0x00ff00);
scene.add(srcNear);
scene.add(srcFar);
scene3d.activeLights.push(srcNear, srcFar);
capActiveLightsByDistance(scene3d);

const visAfter2 = countVisibleDynamicLights(lighting.lightsGroup);
check(
  "2b: after 2 sources the visible count is STILL 6 (constant → no relink)",
  visAfter2 === POOL_VISIBLE,
  `visible=${visAfter2}`
);
check(
  "2c: both source lights remained .visible=false (never counted)",
  srcNear.visible === false && srcFar.visible === false,
  `near=${srcNear.visible}, far=${srcFar.visible}`
);
check(
  "3a: nearest source fed into pool slot 0 (x≈0.5, i=3, red)",
  Math.abs(pool.point[0].position.x - 0.5) < 1e-6 &&
    pool.point[0].intensity === 3 &&
    Math.abs(pool.point[0].color.r - 1) < 1e-6,
  `x=${pool.point[0].position.x}, i=${pool.point[0].intensity}, r=${pool.point[0].color.r.toFixed(2)}`
);
check(
  "3b: 2nd-nearest fed into slot 1 (x=10, i=4, green)",
  Math.abs(pool.point[1].position.x - 10) < 1e-6 && pool.point[1].intensity === 4,
  `x=${pool.point[1].position.x}, i=${pool.point[1].intensity}`
);
check(
  "3c: unused pool slots (2,3) driven to intensity 0",
  pool.point[2].intensity === 0 && pool.point[3].intensity === 0,
  `i2=${pool.point[2].intensity}, i3=${pool.point[3].intensity}`
);

// Grow to 8 sources — a count delta forces a re-pick; the rendered visible
// count must NOT move (this is the whole point of the fix).
for (let i = 0; i < 6; i += 1) {
  const s = makeSource(2 + i, 2, 0x0000ff);
  scene.add(s);
  scene3d.activeLights.push(s);
}
capActiveLightsByDistance(scene3d);
const visAfter8 = countVisibleDynamicLights(lighting.lightsGroup);
check(
  "2d: after growing to 8 sources the visible count is STILL 6 (invariant holds; 6===6===6)",
  visAfter8 === POOL_VISIBLE && baselineVisible === visAfter2 && visAfter2 === visAfter8,
  `visible=${visAfter8} (baseline=${baselineVisible}, after2=${visAfter2})`
);
check(
  "2e: all 8 sources still .visible=false",
  scene3d.activeLights.every((l) => l.visible === false),
  ""
);

// ===================================================================
// 4. Legacy parity (pool OFF) — sources DO get .visible toggled
// ===================================================================
__resetLightPoolConfigForTest({ enabled: false, pointCount: 32, spotCount: 8 });
const sceneL = new THREE.Scene();
const lightingL = setupSceneLighting(sceneL, {});
check(
  "4a: pool OFF → bundle.lightPool is null (no pool allocated)",
  lightingL.lightPool === null || lightingL.lightPool === undefined,
  `lightPool=${lightingL.lightPool}`
);
const scene3dL = {
  lighting: lightingL,
  activeLights: [],
  camera: { position: { x: 0, y: 0, z: 0 } },
};
const ls1 = makeSource(1, 5, 0xffffff);
const ls2 = makeSource(2, 5, 0xffffff);
sceneL.add(ls1, ls2);
scene3dL.activeLights.push(ls1, ls2);
capActiveLightsByDistance(scene3dL);
check(
  "4b: legacy path flips source .visible=true for the top-N (byte-identical pre-fix)",
  ls1.visible === true && ls2.visible === true,
  `ls1=${ls1.visible}, ls2=${ls2.visible}`
);

// ===================================================================
// 5. Sun indoor/outdoor — pool ON never flips sun.visible
// ===================================================================
__resetLightPoolConfigForTest({ enabled: true, pointCount: 4, spotCount: 2 });
const sceneS = new THREE.Scene();
const lightingS = setupSceneLighting(sceneS, {});
const sunS = lightingS.sun;
const scene3dS = { lighting: lightingS };
let indoor = false;
const session = { isCurrentCellIndoor: () => indoor };

indoor = false;
tickLightingForCellState(scene3dS, session);
const outVis = sunS.visible;
const outInt = sunS.intensity;
indoor = true;
tickLightingForCellState(scene3dS, session);
const inVis = sunS.visible;
const inInt = sunS.intensity;
indoor = false;
tickLightingForCellState(scene3dS, session);
const reVis = sunS.visible;
const reInt = sunS.intensity;

check(
  "5a: pool ON → sun.visible stays TRUE across outdoor→indoor→outdoor (no dir-count change)",
  outVis === true && inVis === true && reVis === true,
  `out=${outVis}, in=${inVis}, re=${reVis}`
);
check(
  "5b: sun CONTRIBUTION swaps via intensity (out>0 → indoor 0 → out>0)",
  outInt > 0 && inInt === 0 && reInt > 0,
  `out=${outInt}, in=${inInt}, re=${reInt}`
);

// ---- summary --------------------------------------------------------
console.log("=========================");
console.log(`light-pool test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
