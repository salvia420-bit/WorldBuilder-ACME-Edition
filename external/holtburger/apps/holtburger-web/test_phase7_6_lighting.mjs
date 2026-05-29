// Phase 7.6 — standalone ESM test for `scene3d/lighting.js`. Loads
// three.js, calls `setupSceneLighting` on a synthetic Scene, then
// drives `tickLightingForCellState` against a mocked sessionHandle
// that flips isCurrentCellIndoor between true / false. Verifies:
//
//   1. scene.children grew by one (the lights Group).
//   2. The group contains a DirectionalLight + AmbientLight (+
//      optional HemisphereLight) with the expected colour / intensity
//      defaults.
//   3. castShadow defaults to false (Phase 7.6 ships without
//      shadows; the shadow camera frustum is only sized when
//      `castShadow: true` is opted in).
//   4. tickLightingForCellState with mock isCurrentCellIndoor=false
//      leaves sun.visible === true + ambient.intensity === 0.5.
//   5. tickLightingForCellState with mock isCurrentCellIndoor=true
//      flips sun.visible to false + raises ambient.intensity to 0.7.
//   6. Flipping back to outdoor restores the original state.
//   7. attachSetupModelLights (Phase 7.6.1, follow-on #1) is callable
//      + returns the new summary shape; with no real wasm exports
//      passed in, it short-circuits to `wasmExportMissing: true`.
//      Also: capping logic — synthetic 100-light test → 32 visible.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_phase7_6_lighting.mjs
//
// If three can't be located, the test prints SKIP and exits 0 (the
// smoke regex check is the mandatory floor).

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
    console.log("Phase 7.6 lighting ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_phase7_6_lighting.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Phase 7.6 — lighting standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load lighting.js with closure-captured THREE -------------------
// scene3d/lighting.js imports `* as THREE from "three"` and (Phase 3.3)
// `{ setupCsm, updateCsm, refreshCsmUniforms } from "./csm.js"`. We
// rewrite both imports to closure-captured references and concatenate
// csm.js's source ahead of lighting.js so the call sites resolve.
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src.replace(
        /^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m,
        ""
    );
    // Strip relative `./csm.js` import (Phase 3.3); the csm.js source is
    // prepended to the composite so the imported names are already in
    // scope.
    src = src.replace(
        /^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m,
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

const csmSrc = loadModule("scene3d/csm.js");
const lightingSrc = loadModule("scene3d/lighting.js");
const composite =
    "// === csm.js ===\n" + stripExports(csmSrc) + "\n" +
    "// === lighting.js ===\n" + stripExports(lightingSrc) + "\n" +
    "; return { setupSceneLighting, tickLightingForCellState, attachSetupModelLights, buildLightForSetupLight, LIGHTING_CONSTANTS };";

const factory = new Function("THREE", composite);
const lightingMod = factory(THREE);
const {
    setupSceneLighting,
    tickLightingForCellState,
    attachSetupModelLights,
    buildLightForSetupLight,
    LIGHTING_CONSTANTS,
} = lightingMod;

// ---- Build a scene + call setupSceneLighting ----------------------
const scene = new THREE.Scene();
const beforeCount = scene.children.length;

const lighting = setupSceneLighting(scene, { sceneSize: 600 });

const { sun, ambient, hemisphere, lightsGroup } = lighting;

// ---- Assert 1: scene.children gained the lights group ------------
check(
    "Phase 7.6: setupSceneLighting attaches a Group to the scene",
    scene.children.length === beforeCount + 1 && scene.children.includes(lightsGroup),
    `before=${beforeCount}, after=${scene.children.length}, includesGroup=${scene.children.includes(lightsGroup)}`
);

// ---- Assert 2: lightsGroup contains DirectionalLight + AmbientLight (+ Hemisphere) ---
const dirLights = lightsGroup.children.filter(
    (c) => c.isDirectionalLight || c.type === "DirectionalLight"
);
const ambLights = lightsGroup.children.filter(
    (c) => c.isAmbientLight || c.type === "AmbientLight"
);
const hemiLights = lightsGroup.children.filter(
    (c) => c.isHemisphereLight || c.type === "HemisphereLight"
);
check(
    "Phase 7.6: lightsGroup has DirectionalLight + AmbientLight + HemisphereLight",
    dirLights.length === 1 && ambLights.length === 1 && hemiLights.length === 1,
    `dir=${dirLights.length}, amb=${ambLights.length}, hemi=${hemiLights.length}, total=${lightsGroup.children.length}`
);

// ---- Assert 3: sun handle is the returned DirectionalLight ----------
check(
    "Phase 7.6: lighting.sun === the DirectionalLight",
    sun === dirLights[0] && (sun.isDirectionalLight === true || sun.type === "DirectionalLight"),
    `sun.type=${sun.type}, sun.isDirectionalLight=${sun.isDirectionalLight}`
);

// ---- Assert 4: sun.intensity > 0 + position non-zero --------------
const sunPosLen = Math.hypot(sun.position.x, sun.position.y, sun.position.z);
check(
    "Phase 7.6: sun has intensity > 0 + non-zero position",
    sun.intensity > 0 && sunPosLen > 0,
    `intensity=${sun.intensity}, posLen=${sunPosLen.toFixed(2)}`
);

// ---- Assert 5: castShadow defaults to false --------------------
check(
    "Phase 7.6: castShadow defaults to false (no shadow pass in 7.6)",
    sun.castShadow === false,
    `castShadow=${sun.castShadow}`
);

// ---- Assert 6: ambient.intensity is the outdoor baseline (0.5) ------
check(
    "Phase 7.6: ambient.intensity = 0.5 (outdoor baseline) at construction",
    Math.abs(ambient.intensity - LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR) < 1e-4,
    `intensity=${ambient.intensity}, expected=${LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR}`
);

// ---- Build a mock scene3d shape + sessionHandle ---------------------
let mockIsIndoor = false;
const mockSession = {
    isCurrentCellIndoor() { return mockIsIndoor; },
};
const scene3d = { lighting };

// ---- Assert 7: outdoor tick leaves sun.visible === true ---------
mockIsIndoor = false;
sun.visible = true; // baseline
ambient.intensity = LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR;
tickLightingForCellState(scene3d, mockSession);
check(
    "Phase 7.6: tick with isCurrentCellIndoor=false → sun.visible=true + ambient=0.5",
    sun.visible === true &&
        Math.abs(ambient.intensity - LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR) < 1e-4,
    `sunVisible=${sun.visible}, ambient=${ambient.intensity}`
);

// ---- Assert 8: indoor tick flips sun.visible to false + raises ambient ---
mockIsIndoor = true;
tickLightingForCellState(scene3d, mockSession);
check(
    "Phase 7.6: tick with isCurrentCellIndoor=true → sun.visible=false + ambient=0.7",
    sun.visible === false &&
        Math.abs(ambient.intensity - LIGHTING_CONSTANTS.AMBIENT_INTENSITY_INDOOR) < 1e-4,
    `sunVisible=${sun.visible}, ambient=${ambient.intensity}`
);

// ---- Assert 9: flipping back to outdoor restores state ---------
mockIsIndoor = false;
tickLightingForCellState(scene3d, mockSession);
check(
    "Phase 7.6: flipping back to outdoor restores sun.visible=true + ambient=0.5",
    sun.visible === true &&
        Math.abs(ambient.intensity - LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR) < 1e-4,
    `sunVisible=${sun.visible}, ambient=${ambient.intensity}`
);

// ---- Assert 10: attachSetupModelLights (Phase 7.6.1) — no wasm export → short-circuits ---
const noExportResult = await attachSetupModelLights(
    { activeLights: [], buildingsGroup: new THREE.Group(), staticsGroup: new THREE.Group() },
    {}
);
check(
    "Phase 7.6.1: attachSetupModelLights with no wasmExports → wasmExportMissing: true, lightCount: 0",
    noExportResult &&
        noExportResult.lightCount === 0 &&
        noExportResult.wasmExportMissing === true,
    `result=${JSON.stringify(noExportResult)}`
);

// ---- Assert 10b: attachSetupModelLights returns the new summary shape ---
const mockWasm = {
    async fetchSetupModelLights() {
        // Synthetic empty bundle — `partCount === 0` is the
        // "no lights" signal the JS reads.
        return { partCount: 0, takeLights: () => [] };
    },
};
// Build a synth scene3d with one building placement carrying modelId 0x02000099.
const synthBuildings = new THREE.Group();
const placement = new THREE.Group();
placement.userData = { modelId: 0x02000099, partGroups: [] };
const part0 = new THREE.Group();
part0.name = "part-0";
part0.userData = { partIndex: 0 };
placement.add(part0);
placement.userData.partGroups.push(part0);
synthBuildings.add(placement);
const synthScene = {
    activeLights: [],
    buildingsGroup: synthBuildings,
    staticsGroup: new THREE.Group(),
};
const realRunResult = await attachSetupModelLights(synthScene, mockWasm);
check(
    "Phase 7.6.1: attachSetupModelLights walks scene + returns summary shape",
    realRunResult &&
        realRunResult.wasmExportMissing === false &&
        realRunResult.modelsScanned === 1 &&
        realRunResult.lightCount === 0 &&
        realRunResult.noLightModels === 1,
    `result=${JSON.stringify(realRunResult)}`
);

// ---- Assert 10c: 100-light cap stress test → 32 visible after tick ---
const capScene = {
    activeLights: [],
    cameraSwitcher: { activeCamera: { position: { x: 0, y: 0, z: 0 } } },
    lighting: scene3d.lighting, // reuse
};
const capGroup = new THREE.Group();
for (let i = 0; i < 100; i += 1) {
    const pl = new THREE.PointLight(0xffffff, 1.0, 10.0);
    pl.position.set(i + 1, 0, 0);
    capGroup.add(pl);
    capScene.activeLights.push(pl);
}
capGroup.updateMatrixWorld(true);
tickLightingForCellState(capScene, mockSession);
let visCount = 0;
let hiddenCount = 0;
for (const pl of capGroup.children) {
    if (pl.visible) visCount += 1; else hiddenCount += 1;
}
check(
    "Phase 7.6.1: 100-light cap test → 32 visible / 68 hidden (MAX_ACTIVE_LIGHTS=32)",
    visCount === 32 && hiddenCount === 68,
    `visible=${visCount}, hidden=${hiddenCount}`
);
check(
    "Phase 7.6.1: cap test — closest light visible, farthest hidden",
    capGroup.children[0].visible === true && capGroup.children[99].visible === false,
    `closest=${capGroup.children[0].visible}, farthest=${capGroup.children[99].visible}`
);

// ---- Assert 11: missing sessionHandle is a no-op (no throw) -----
const beforeVis = sun.visible;
const beforeAmb = ambient.intensity;
tickLightingForCellState(scene3d, null); // null sessionHandle
tickLightingForCellState(scene3d, undefined); // undefined
tickLightingForCellState(scene3d, {}); // empty object — no isCurrentCellIndoor
check(
    "Phase 7.6: missing/empty sessionHandle is a no-op (capture-friendly)",
    sun.visible === beforeVis && Math.abs(ambient.intensity - beforeAmb) < 1e-4,
    `vis=${sun.visible}/${beforeVis}, amb=${ambient.intensity}/${beforeAmb}`
);

// ---- Assert 12: throwing isCurrentCellIndoor is a no-op (no throw) ----
const throwingSession = {
    isCurrentCellIndoor() { throw new Error("synthetic throw"); },
};
let threw = false;
try {
    tickLightingForCellState(scene3d, throwingSession);
} catch (e) {
    threw = true;
}
check(
    "Phase 7.6: throwing isCurrentCellIndoor() is swallowed (no kill)",
    threw === false,
    `threw=${threw}`
);

// ---- Assert 13: castShadow opt-in works ---------------------------
const scene2 = new THREE.Scene();
const lighting2 = setupSceneLighting(scene2, { castShadow: true, sceneSize: 600 });
check(
    "Phase 7.6: castShadow: true + sceneSize sizes the shadow camera frustum",
    lighting2.sun.castShadow === true &&
        lighting2.sun.shadow.camera.right === 600 &&
        lighting2.sun.shadow.camera.left === -600,
    `castShadow=${lighting2.sun.castShadow}, frustumR=${lighting2.sun.shadow.camera.right}, frustumL=${lighting2.sun.shadow.camera.left}`
);
lighting2.dispose();

// ---- Assert 14: dispose removes lightsGroup from scene ---------
lighting.dispose();
check(
    "Phase 7.6: dispose() removes lightsGroup from scene.children",
    !scene.children.includes(lightsGroup),
    `still includes? ${scene.children.includes(lightsGroup)}`
);

// ---- Wave R2.A (2026-05-28) — entity-light constructor + toggle -----
// buildLightForSetupLight is the public entry point entities.js reuses for
// SetLight (hook 25) entity-attached lights. It must share the static path's
// PointLight/SpotLight selection + intensity/falloff/color math.

// Assert R2.A-1: cone_angle == 0 → PointLight.
const ptLight = buildLightForSetupLight({
    partIndex: 0, x: 1, y: 2, z: 3,
    colorR: 1, colorG: 0.6, colorB: 0.2,
    intensity: 3, falloff: 12, coneAngle: 0,
});
check(
    "R2.A: buildLightForSetupLight(cone_angle=0) → PointLight at the SetupLight origin",
    ptLight && ptLight.isPointLight === true &&
        ptLight.position.x === 1 && ptLight.position.y === 2 && ptLight.position.z === 3 &&
        Math.abs(ptLight.intensity - 3) < 1e-6 && ptLight.distance === 12,
    `isPointLight=${ptLight?.isPointLight}, pos=(${ptLight?.position.x},${ptLight?.position.y},${ptLight?.position.z}), intensity=${ptLight?.intensity}, distance=${ptLight?.distance}`
);

// Assert R2.A-2: cone_angle > 0 → SpotLight.
const spotLight = buildLightForSetupLight({
    partIndex: 1, x: 0, y: 0, z: 0,
    colorR: 0.2, colorG: 0.4, colorB: 1,
    intensity: 2, falloff: 20, coneAngle: 0.7,
});
check(
    "R2.A: buildLightForSetupLight(cone_angle>0) → SpotLight with that half-angle",
    spotLight && spotLight.isSpotLight === true && Math.abs(spotLight.angle - 0.7) < 1e-6,
    `isSpotLight=${spotLight?.isSpotLight}, angle=${spotLight?.angle}`
);

// Assert R2.A-3: off→on toggle. entities.js starts entity lights OFF
// (intensity 0 / visible false) with the authored intensity stashed on
// `userData.__setupIntensity`, then the SetLight hook restores it. Mirror
// that exact dance here to lock the toggle contract.
const authoredIntensity = ptLight.intensity;
ptLight.userData = ptLight.userData || {};
ptLight.userData.__setupIntensity = authoredIntensity;
ptLight.intensity = 0;
ptLight.visible = false;
// SetLight lightsOn=1 → restore.
{
    const authored = Number.isFinite(ptLight.userData.__setupIntensity)
        ? ptLight.userData.__setupIntensity
        : ptLight.intensity;
    ptLight.intensity = authored;
    ptLight.visible = true;
}
const onOk = ptLight.intensity === authoredIntensity && ptLight.visible === true;
// SetLight lightsOn=0 → off.
ptLight.intensity = 0;
ptLight.visible = false;
const offOk = ptLight.intensity === 0 && ptLight.visible === false;
check(
    "R2.A: SetLight toggle restores authored intensity on, zeroes it off",
    onOk && offOk,
    `onOk=${onOk}, offOk=${offOk}, restored=${authoredIntensity}`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
console.log("Resolved intensities:");
console.log(`  AMBIENT_INTENSITY_OUTDOOR = ${LIGHTING_CONSTANTS.AMBIENT_INTENSITY_OUTDOOR}`);
console.log(`  AMBIENT_INTENSITY_INDOOR  = ${LIGHTING_CONSTANTS.AMBIENT_INTENSITY_INDOOR}`);
console.log(`  sun.position              = (${sun.position.x.toFixed(1)}, ${sun.position.y.toFixed(1)}, ${sun.position.z.toFixed(1)})`);
console.log(`  sun.intensity             = ${sun.intensity}`);
console.log(`  hemisphere.intensity      = ${hemisphere ? hemisphere.intensity : "(disabled)"}`);
console.log(`  per-SetupModel lights:    Phase 7.6.1 attach + cap implemented (MAX_ACTIVE_LIGHTS=${LIGHTING_CONSTANTS.MAX_ACTIVE_LIGHTS})`);
console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 7.6 lighting checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
