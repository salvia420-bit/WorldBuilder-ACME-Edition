// Workstream Sky-C — standalone ESM test for
// `scene3d/sky_lighting.js`. Mocks `window.__sessionHandle.getSkyState`
// to return Sky-B's verified values at t=0.25/0.50/0.75/0.99 and
// asserts:
//
//   1. Controller construction assigns `scene.fog` to a non-null
//      THREE.Fog with the default fallback color.
//   2. `_applyState` at t=0.50 (noon, dir_color=0xFFFAD797): dirLight
//      color.r ≈ 0xFA/255 = 0.98.
//   3. `_applyState` at t=0.99: ambient.r ≈ 0xC8/255 = 0.78 (purple
//      twilight from amb_color=0xFFC864FF), fog.r ≈ 0x17/255 = 0.09
//      (near-black night fog 0xFF171723).
//   4. dirLight.intensity matches state.dir_bright directly.
//   5. fog.near / fog.far match state's fog_min / fog_max.
//   6. Light position changes between t=0.25 and t=0.75 (sun moves).
//
// Additionally verifies the calibration math directly via the
// `__internals.sunPositionFromHeadingPitch` export — at noon
// (heading=90°, pitch=67.35°) the y component must be positive (sun
// above horizon). This is the "degrees vs radians" probe per the
// workstream prompt.
//
// Run from `apps/holtburger-web/`:
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_sky_lighting.mjs
// or
//   node test_sky_lighting.mjs (auto-locates `three` from npx cache).

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

// ---- locate `three` --------------------------------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  const candidates = [
    joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
  ];
  try {
    const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
    if (existsSync(npxRoot)) {
      const fs = require("node:fs");
      for (const dir of fs.readdirSync(npxRoot)) {
        candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
      }
    }
  } catch (_) {}
  for (const c of candidates) {
    const idx = joinPath(c, "build/three.module.js");
    if (existsSync(idx)) return idx;
  }
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Workstream Sky-C lighting ESM test: SKIP (three not located).");
  console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_sky_lighting.mjs`");
  process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Workstream Sky-C — sky lighting standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load sky_lighting.js with closure-captured THREE ---------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  let src = readFileSync(full, "utf8");
  src = src.replace(
    /^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m,
    ""
  );
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

const skyLightingSrc = loadModule("scene3d/sky_lighting.js");
const composite =
  "// === sky_lighting.js ===\n" +
  stripExports(skyLightingSrc) +
  "\n; return { SkyLightingController, SKY_LIGHTING_CONSTANTS, __internals };";

const factory = new Function("THREE", composite);
const mod = factory(THREE);
const { SkyLightingController, SKY_LIGHTING_CONSTANTS, __internals } = mod;

// ---- Sky-B verified state values (from workstream prompt table) -----
function makeSkyState({
  t,
  dirColorArgb,
  dirBright,
  dirHeading,
  dirPitch,
  ambColorArgb,
  ambBright,
  fogColorArgb,
  fogMin,
  fogMax,
  worldFog = 0,
  dayGroupIndex = 0,
}) {
  return {
    timeOfDayNormalized: t,
    dirColorArgb,
    dirBright,
    dirHeading,
    dirPitch,
    ambColorArgb,
    ambBright,
    fogColorArgb,
    fogMin,
    fogMax,
    worldFog,
    dayGroupIndex,
  };
}

// Sky-B's verified lerp values from the prompt's table.
const STATE_DAWN = makeSkyState({
  t: 0.25,
  dirColorArgb: 0xfffad797,
  dirBright: 1.0,
  dirHeading: 0.0, // east horizon-ish at dawn
  dirPitch: 0.0,
  ambColorArgb: 0xffd9d9ff,
  ambBright: 0.5,
  fogColorArgb: 0xff9699ad,
  fogMin: 100,
  fogMax: 600,
});
const STATE_NOON = makeSkyState({
  t: 0.5,
  dirColorArgb: 0xfffad797,
  dirBright: 1.0,
  dirHeading: 90.0, // degrees, sun due east per upstream-doc sample
  dirPitch: 67.35,
  ambColorArgb: 0xffe6e6ff,
  ambBright: 0.55,
  fogColorArgb: 0xffc3c8dc,
  fogMin: 200,
  fogMax: 800,
});
const STATE_DUSK = makeSkyState({
  t: 0.75,
  dirColorArgb: 0xfffad797,
  dirBright: 1.0,
  dirHeading: 270.0, // setting due west
  dirPitch: 5.0,
  ambColorArgb: 0xffd4d4ff,
  ambBright: 0.5,
  fogColorArgb: 0xffc6c8d0,
  fogMin: 150,
  fogMax: 700,
});
const STATE_MIDNIGHT = makeSkyState({
  t: 0.99,
  dirColorArgb: 0xffdcdcdc,
  dirBright: 0.2,
  dirHeading: 180.0,
  dirPitch: -5.0, // below horizon
  ambColorArgb: 0xffc864ff,
  ambBright: 0.3,
  fogColorArgb: 0xff171723,
  fogMin: 50,
  fogMax: 400,
});

// ---- Build mock scene + handles, instantiate controller -------------
const scene = new THREE.Scene();
const sun = new THREE.DirectionalLight(0xfff2cc, 1.0);
sun.position.set(60, 80, 30); // Phase 7.6 default
sun.target = new THREE.Object3D();
sun.target.position.set(0, 0, 0);
scene.add(sun, sun.target);
const ambient = new THREE.AmbientLight(0xfff0e0, 0.5);
scene.add(ambient);

// Mock `liveScene3d` ref so the controller can publish
// `skyBackgroundColor` on it.
const liveScene3dRef = {};

// Mock session — start out null; we'll inject real states via
// `_applyState` directly to exercise the apply path without needing
// a per-tick getSkyState driver. Also exercises the tick-path null
// short-circuit at the end.
const mockSessionState = { current: null };
const mockSession = {
  getSkyState() {
    return mockSessionState.current;
  },
  hasSkyDesc() {
    return mockSessionState.current !== null;
  },
};

const controller = new SkyLightingController({
  scene,
  sun,
  ambient,
  sessionHandleAccessor: () => mockSession,
  liveScene3dRef,
});

// ---- Assert 1: scene.fog assigned + non-null with fallback color ----
check(
  "Sky-C: controller assigns scene.fog (THREE.Fog) on construction",
  scene.fog !== null && scene.fog !== undefined &&
    (scene.fog.isFog === true || scene.fog.constructor?.name === "Fog"),
  `scene.fog=${scene.fog?.constructor?.name ?? "null"}`
);

check(
  "Sky-C: scene.fog.color initialised to fallback (0xFF9CB3D9 — sky blue)",
  scene.fog &&
    Math.abs(scene.fog.color.r - 0x9c / 255) < 1e-3 &&
    Math.abs(scene.fog.color.g - 0xb3 / 255) < 1e-3 &&
    Math.abs(scene.fog.color.b - 0xd9 / 255) < 1e-3,
  `fog.color=(${scene.fog?.color.r.toFixed(3)}, ${scene.fog?.color.g.toFixed(3)}, ${scene.fog?.color.b.toFixed(3)})`
);

check(
  "Sky-C: liveScene3dRef.skyBackgroundColor initialised to fallback fog color (0xFF9CB3D9)",
  (liveScene3dRef.skyBackgroundColor >>> 0) === 0xff9cb3d9,
  `skyBackgroundColor=0x${(liveScene3dRef.skyBackgroundColor >>> 0).toString(16)}`
);

// ---- Assert 2: noon state applied — dirColor R = 0xFA/255 ----------
controller._applyState(STATE_NOON);
check(
  "Sky-C: at t=0.50 (noon) dirLight.color.r ≈ 0.98 (0xFA/255 from 0xFFFAD797)",
  Math.abs(sun.color.r - 0xfa / 255) < 1e-3,
  `sun.color.r=${sun.color.r.toFixed(4)}, expected≈${(0xfa / 255).toFixed(4)}`
);
check(
  "Sky-C: at t=0.50 dirLight.color.g ≈ 0.84 (0xD7/255)",
  Math.abs(sun.color.g - 0xd7 / 255) < 1e-3,
  `sun.color.g=${sun.color.g.toFixed(4)}`
);
check(
  "Sky-C: at t=0.50 dirLight.color.b ≈ 0.59 (0x97/255)",
  Math.abs(sun.color.b - 0x97 / 255) < 1e-3,
  `sun.color.b=${sun.color.b.toFixed(4)}`
);

// ---- Assert 3: dir intensity matches dir_bright directly ------------
check(
  "Sky-C: dirLight.intensity matches state.dir_bright at noon (= 1.0)",
  Math.abs(sun.intensity - STATE_NOON.dirBright) < 1e-4,
  `sun.intensity=${sun.intensity}, expected=${STATE_NOON.dirBright}`
);

// ---- Assert 4: fog.near / fog.far match fog_min / fog_max ----------
check(
  "Sky-C: scene.fog.near matches state.fog_min at noon (= 200)",
  Math.abs(scene.fog.near - STATE_NOON.fogMin) < 1e-4,
  `fog.near=${scene.fog.near}, expected=${STATE_NOON.fogMin}`
);
check(
  "Sky-C: scene.fog.far matches state.fog_max at noon (= 800)",
  Math.abs(scene.fog.far - STATE_NOON.fogMax) < 1e-4,
  `fog.far=${scene.fog.far}, expected=${STATE_NOON.fogMax}`
);

// ---- Assert 5: CALIBRATION PROBE — at noon, sun y > 0 ---------------
// This is the load-bearing degrees-vs-radians test. If heading/pitch
// were interpreted as radians, sin(67.35 rad) = ~0.62 (just by luck
// since sin is periodic), but sin(90 rad) = ~0.89, and the position
// would be wildly off; specifically, the heading wraps so many times
// that the east/north components become near-arbitrary. If treated as
// degrees, sin(67.35°) ≈ 0.923 — the sun sits high above the horizon
// (sensible at noon).
const noonY = sun.position.y;
check(
  "Sky-C calibration: at t=0.50 (noon, heading=90°, pitch=67.35°), sun.y > 0 (sun above horizon)",
  noonY > 0,
  `sun.position.y=${noonY.toFixed(2)} (must be > 0 for degrees-pitch interpretation)`
);
check(
  "Sky-C calibration: at t=0.50, sun.y / |sun.position| ≈ sin(67.35°) ≈ 0.923",
  (() => {
    const len = Math.hypot(sun.position.x, sun.position.y, sun.position.z);
    if (len < 1) return false;
    const ratio = sun.position.y / len;
    return Math.abs(ratio - Math.sin((67.35 * Math.PI) / 180)) < 1e-3;
  })(),
  `sun.pos=(${sun.position.x.toFixed(2)}, ${sun.position.y.toFixed(2)}, ${sun.position.z.toFixed(2)})`
);
check(
  "Sky-C calibration: at heading=90° (due east), sun.x > 0 + sun.z ≈ 0 (sun in the east)",
  sun.position.x > 0 && Math.abs(sun.position.z) < 1e-2,
  `sun.pos=(${sun.position.x.toFixed(2)}, ${sun.position.y.toFixed(2)}, ${sun.position.z.toFixed(2)})`
);

// ---- Assert 6: midnight state — purple ambient + near-black fog -----
controller._applyState(STATE_MIDNIGHT);
check(
  "Sky-C: at t=0.99 ambient.color.r ≈ 0.78 (0xC8/255 from 0xFFC864FF — purple twilight)",
  Math.abs(ambient.color.r - 0xc8 / 255) < 1e-3,
  `ambient.color.r=${ambient.color.r.toFixed(4)}, expected≈${(0xc8 / 255).toFixed(4)}`
);
check(
  "Sky-C: at t=0.99 ambient.color.g ≈ 0.39 (0x64/255 — purple, low green)",
  Math.abs(ambient.color.g - 0x64 / 255) < 1e-3,
  `ambient.color.g=${ambient.color.g.toFixed(4)}`
);
check(
  "Sky-C: at t=0.99 ambient.color.b ≈ 1.0 (0xFF/255 — purple, full blue)",
  Math.abs(ambient.color.b - 0xff / 255) < 1e-3,
  `ambient.color.b=${ambient.color.b.toFixed(4)}`
);
check(
  "Sky-C: at t=0.99 scene.fog.color.r ≈ 0.09 (0x17/255 from 0xFF171723 — near-black night fog)",
  Math.abs(scene.fog.color.r - 0x17 / 255) < 1e-3,
  `fog.color.r=${scene.fog.color.r.toFixed(4)}, expected≈${(0x17 / 255).toFixed(4)}`
);
check(
  "Sky-C: at t=0.99 scene.fog.color.b ≈ 0.137 (0x23/255 — near-black, faint blue)",
  Math.abs(scene.fog.color.b - 0x23 / 255) < 1e-3,
  `fog.color.b=${scene.fog.color.b.toFixed(4)}`
);
check(
  "Sky-C: at t=0.99 dirLight.intensity = 0.2 (sun drops to near-zero at midnight)",
  Math.abs(sun.intensity - 0.2) < 1e-4,
  `sun.intensity=${sun.intensity}`
);

// ---- Assert 7: skyBackgroundColor sink updates per tick ------------
check(
  "Sky-C: liveScene3dRef.skyBackgroundColor updated to fog_color_argb at t=0.99 (0xFF171723)",
  (liveScene3dRef.skyBackgroundColor >>> 0) === 0xff171723,
  `skyBackgroundColor=0x${(liveScene3dRef.skyBackgroundColor >>> 0).toString(16)}`
);
check(
  "Sky-C: controller.skyBackgroundColorArgb also tracks per tick",
  (controller.skyBackgroundColorArgb >>> 0) === 0xff171723,
  `controller.skyBackgroundColorArgb=0x${(controller.skyBackgroundColorArgb >>> 0).toString(16)}`
);

// ---- Assert 8: light position differs between dawn and dusk --------
controller._applyState(STATE_DAWN);
const dawnPos = { x: sun.position.x, y: sun.position.y, z: sun.position.z };
controller._applyState(STATE_DUSK);
const duskPos = { x: sun.position.x, y: sun.position.y, z: sun.position.z };
check(
  "Sky-C: sun position changes between t=0.25 (dawn, heading=0°) and t=0.75 (dusk, heading=270°)",
  (() => {
    const dx = dawnPos.x - duskPos.x;
    const dy = dawnPos.y - duskPos.y;
    const dz = dawnPos.z - duskPos.z;
    return dx * dx + dy * dy + dz * dz > 1.0;
  })(),
  `dawnPos=(${dawnPos.x.toFixed(2)}, ${dawnPos.y.toFixed(2)}, ${dawnPos.z.toFixed(2)}), ` +
    `duskPos=(${duskPos.x.toFixed(2)}, ${duskPos.y.toFixed(2)}, ${duskPos.z.toFixed(2)})`
);
check(
  "Sky-C: dawn sun at heading=0° (due north in AC convention) → sun.z < 0 (-north)",
  // AC heading=0 (north): three.js → (0, sin(0)=0, -cos(0)=-1) → z negative.
  // Pitch=0 so y=0, only z component is non-zero.
  dawnPos.z < 0,
  `dawnPos.z=${dawnPos.z.toFixed(2)}`
);
check(
  "Sky-C: dusk sun at heading=270° (due west in AC convention) → sun.x < 0",
  duskPos.x < 0,
  `duskPos.x=${duskPos.x.toFixed(2)}`
);

// ---- Assert 9: tick() path with null session is a no-op -------------
mockSessionState.current = null;
const beforeTickColor = { r: sun.color.r, g: sun.color.g, b: sun.color.b };
const beforeTickIntensity = sun.intensity;
controller.tick(0.016);
check(
  "Sky-C: tick() with null getSkyState is a no-op (lights unchanged)",
  sun.color.r === beforeTickColor.r &&
    sun.color.g === beforeTickColor.g &&
    sun.color.b === beforeTickColor.b &&
    sun.intensity === beforeTickIntensity,
  `noChange=${sun.color.r === beforeTickColor.r}`
);
check(
  "Sky-C: tick() null-state path bumps _nullStateTickCount",
  controller._nullStateTickCount >= 1,
  `_nullStateTickCount=${controller._nullStateTickCount}`
);

// ---- Assert 10: tick() with mocked state drives lights --------------
mockSessionState.current = STATE_NOON;
const beforeIntensity = sun.intensity;
controller.tick(0.016);
check(
  "Sky-C: tick() with mocked getSkyState applies state (dirLight.intensity changes)",
  sun.intensity === STATE_NOON.dirBright,
  `sun.intensity=${sun.intensity}, beforeIntensity=${beforeIntensity}`
);
check(
  "Sky-C: tick() bumps _tickCount + sets _lastState",
  controller._tickCount >= 1 &&
    controller._lastState &&
    controller._lastState.dirColorArgb === STATE_NOON.dirColorArgb,
  `_tickCount=${controller._tickCount}, _lastState.dirColorArgb=0x${(controller._lastState?.dirColorArgb >>> 0).toString(16)}`
);

// ---- Assert 11: calibration math direct probe (no controller) ------
const noonPos = __internals.sunPositionFromHeadingPitch(90.0, 67.35, 1000);
check(
  "Sky-C direct calibration: sunPositionFromHeadingPitch(90°, 67.35°, 1000) → y > 0",
  noonPos[1] > 0,
  `result=[${noonPos.map((v) => v.toFixed(2)).join(", ")}]`
);
check(
  "Sky-C direct calibration: at noon y ≈ 923 (sin(67.35°) * 1000)",
  Math.abs(noonPos[1] - Math.sin((67.35 * Math.PI) / 180) * 1000) < 1.0,
  `y=${noonPos[1].toFixed(2)}, expected≈${(Math.sin((67.35 * Math.PI) / 180) * 1000).toFixed(2)}`
);
check(
  "Sky-C direct calibration: decodeArgb(0xFFFAD797) → [0xFF, 0xFA, 0xD7, 0x97]",
  (() => {
    const [a, r, g, b] = __internals.decodeArgb(0xfffad797);
    return a === 0xff && r === 0xfa && g === 0xd7 && b === 0x97;
  })(),
  `result=${JSON.stringify(__internals.decodeArgb(0xfffad797))}`
);

// ---- Assert 12: SKY_LIGHTING_CONSTANTS sanity check ----------------
check(
  "Sky-C: SKY_LIGHTING_CONSTANTS exposes the canonical fallback values",
  SKY_LIGHTING_CONSTANTS.DEFAULT_DIR_COLOR_ARGB === 0xfffad797 &&
    SKY_LIGHTING_CONSTANTS.DEFAULT_FOG_COLOR_ARGB === 0xff9cb3d9 &&
    SKY_LIGHTING_CONSTANTS.SUN_POSITION_DISTANCE === 1000.0,
  `constants=${JSON.stringify(SKY_LIGHTING_CONSTANTS)}`
);

// ---- Assert 13: dispose() removes scene.fog -------------------------
controller.dispose();
check(
  "Sky-C: dispose() clears scene.fog",
  scene.fog === null,
  `scene.fog=${scene.fog}`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
console.log("Calibration summary:");
console.log(`  dir_heading + dir_pitch: DEGREES (DAT-raw f32, converted via * π/180 in JS)`);
console.log(`  pitch convention: 0 → horizon, π/2 → zenith (per sky.rs:521-524)`);
console.log(`  At noon (h=90°, p=67.35°): sun.position = ${JSON.stringify(noonPos.map((v) => +v.toFixed(2)))}`);
console.log(`  At midnight (state at t=0.99):`);
console.log(`    dirLight.color  hex  = 0xDCDCDC (from 0xFFDCDCDC)`);
console.log(`    ambient.color   hex  = 0xC864FF (from 0xFFC864FF — purple twilight)`);
console.log(`    scene.fog.color hex  = 0x171723 (from 0xFF171723 — near-black night fog)`);
console.log("=========================");
if (failed === 0) {
  console.log(`PASS: ${passed}/${passed} Sky-C lighting checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
