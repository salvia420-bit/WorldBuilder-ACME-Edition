// Workstream Sky-D + Sky-I-B — standalone ESM test for
// `scene3d/sky_dome.js`.
//
// **Updated for Sky-I-B (2026-05-11)** — the renderer was refactored
// from the camera-parented "everything-in-the-main-scene" pattern to a
// separate-render-pass + camera-anchored Group pattern. The new
// invariants this test exercises:
//
//   1. SkyDome construction populates `skyDome.skyScene` (a separate
//      `THREE.Scene`) with a `sky_cell` Group; the gradient dome is a
//      child of `sky_cell` (NOT the main scene). The main scene is
//      passed in for indoor-flip discovery only.
//   2. `skyDome.skyCamera` is a `THREE.PerspectiveCamera` with
//      `far = SKY_CAMERA_FAR (50000)`.
//   3. `populateCelestialBodies` with a 7-entry mock skyAssets Map adds
//      6 rotator Groups to `skyCell.children` — the `0x02xxxxxx`
//      SetupModel proxy is SKIPPED per the Sky-I-A finding that retail
//      Dereth's only 0x02 SkyObject (0x02000714) is a 6cm physics-script
//      anchor, not a visible celestial.
//   4. Each rotator carries `userData.sky_object_id` so capture scripts
//      can discover them by walking the cell.
//   5. `tick(dt, camera)` anchors `skyCell.position` at `camera.position`
//      — celestial bodies move with the camera (Garry's Mod 3D-skybox
//      pattern).
//   6. With `getSkyObjectStates` reporting a per-object
//      `currentProgress` lerp parameter + `beginAngleDeg/endAngleDeg`,
//      tick sets `rotator.rotation.z` to `lerp(begin, end, progress) *
//      π/180`.
//   7. `argbToColor` helper still decodes 0xAARRGGBB → RGB unit triple.
//   8. `lerpDeg(beginDeg, endDeg, p)` is the new heading-lerp helper
//      (degrees, NOT radians — the Sky-I-A probe surfaced the unit
//      bug; the JS-side renderer now owns deg→rad conversion).
//   9. `renderSkyPass(renderer, mainCamera)` is a no-op when indoor;
//      otherwise it issues `renderer.render(skyScene, skyCamera)` after
//      `clearDepth()`.
//  10. `dispose` empties `skyObjectMeshes` + removes the dome from
//      skyCell.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_sky_dome.mjs
// or:
//   THREE_PATH=/abs/three.module.js node test_sky_dome.mjs

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
    console.log("Sky-D/Sky-I-B sky-dome ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_sky_dome.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Workstream Sky-D/Sky-I-B — sky cell standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- Load sky_dome.js + sky_assets.js + adapter.js + materials.js ----

function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    if (!existsSync(full)) {
        throw new Error(`module not found: ${full}`);
    }
    let src = readFileSync(full, "utf8");
    src = src
        .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
        .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/[^"']+["'];?\s*$/gm, "");
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

const adapterSrc = loadModule("scene3d/adapter.js");
const materialsSrc = loadModule("scene3d/materials.js");
const skyAssetsSrc = loadModule("scene3d/sky_assets.js");
const skyDomeSrc = loadModule("scene3d/sky_dome.js");

// Both `adapter.js` and `materials.js` declare `const FALLBACK_SURFACE_DID
// = 0` at module scope. Rename one for the test composite (same trick
// as the pre-Sky-I-B test).
function renameInMaterials(src) {
    return src.replace(/\bFALLBACK_SURFACE_DID\b/g, "FALLBACK_SURFACE_DID_MAT");
}

const composite =
    "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
    "// === materials.js ===\n" + stripExports(renameInMaterials(materialsSrc)) + "\n" +
    "// === sky_assets.js ===\n" + stripExports(skyAssetsSrc) + "\n" +
    "// === sky_dome.js ===\n" + stripExports(skyDomeSrc) + "\n" +
    "; return { SkyDome, __internals, MaterialCache, buildSkyObjectGroup, " +
    "resolveSkyAssets };";

const factory = new Function("THREE", "window", composite);
const windowShim = {};
const mod = factory(THREE, windowShim);
const { SkyDome, __internals, MaterialCache } = mod;

// ---- Test 1: SkyDome construction — sky scene + sky cell + dome ----

console.log("\nConstruction:");
const scene = new THREE.Scene();
const liveScene3dRef = {
    skyBackgroundColor: 0xff9cb3d9,
    skyLightingController: null,
};
let mockIndoor = false;
let mockSkyObjectStates = [];
const sessionMock = {
    isCurrentCellIndoor: () => mockIndoor,
    getSkyObjectStates: () => mockSkyObjectStates,
};
const skyDome = new SkyDome({
    scene,
    sessionHandleAccessor: () => sessionMock,
    liveScene3dRef,
});
check(
    "main scene.children NOT polluted (was 0, still 0)",
    scene.children.length === 0,
    `got ${scene.children.length} — sky cell should live in skyScene`
);
check(
    "skyDome.skyScene is a THREE.Scene",
    skyDome.skyScene instanceof THREE.Scene,
    `got ${skyDome.skyScene?.constructor?.name}`
);
check(
    "skyDome.skyScene.fog === null (sky exempt from world fog)",
    skyDome.skyScene.fog === null,
    `got ${skyDome.skyScene.fog}`
);
check(
    "skyDome.skyCamera.far === 50000 (sky-cell clipping volume)",
    Math.abs(skyDome.skyCamera.far - __internals.SKY_CAMERA_FAR) < 0.001,
    `got far=${skyDome.skyCamera.far}, expected ${__internals.SKY_CAMERA_FAR}`
);
check(
    "skyDome.skyCell is a Group named 'sky_cell'",
    skyDome.skyCell.name === "sky_cell" && skyDome.skyCell.isGroup === true,
    `got name=${skyDome.skyCell.name} isGroup=${skyDome.skyCell.isGroup}`
);
check(
    "skyDome.skyCell.rotation.x === -π/2 (AC-Z-up → three-Y-up)",
    Math.abs(skyDome.skyCell.rotation.x + Math.PI / 2) < 1e-6,
    `got ${skyDome.skyCell.rotation.x}`
);
check(
    "skyCell is a child of skyScene",
    skyDome.skyScene.children.includes(skyDome.skyCell),
    `skyScene.children.length=${skyDome.skyScene.children.length}`
);
const domeNode = skyDome.dome;
check(
    "skyDome.dome.name === 'sky_dome'",
    domeNode.name === "sky_dome",
    `got name=${domeNode.name}`
);
check(
    "dome is a child of skyCell (NOT main scene)",
    skyDome.skyCell.children.includes(domeNode) &&
        !scene.children.includes(domeNode),
    `inCell=${skyDome.skyCell.children.includes(domeNode)} ` +
        `inMainScene=${scene.children.includes(domeNode)}`
);
check(
    "dome is a THREE.Mesh",
    domeNode.isMesh === true,
    `got isMesh=${domeNode.isMesh}`
);
check(
    "dome.userData.sky_dome === true",
    domeNode.userData?.sky_dome === true,
    `got userData=${JSON.stringify(domeNode.userData)}`
);
check(
    "dome material is ShaderMaterial",
    domeNode.material instanceof THREE.ShaderMaterial,
    `got ${domeNode.material?.constructor?.name}`
);
check(
    "dome material has uHorizonColor + uZenithColor uniforms",
    "uHorizonColor" in (domeNode.material.uniforms ?? {}) &&
        "uZenithColor" in (domeNode.material.uniforms ?? {}),
    `keys=${Object.keys(domeNode.material.uniforms ?? {}).join(",")}`
);
check(
    "dome side is BackSide",
    domeNode.material.side === THREE.BackSide,
    `got side=${domeNode.material.side}`
);
check(
    "dome depthWrite is false",
    domeNode.material.depthWrite === false,
    `got depthWrite=${domeNode.material.depthWrite}`
);

// ---- Test 2: populateCelestialBodies adds rotators + skips 0x02 -----

console.log("\npopulateCelestialBodies:");

function makeBake(skyObjectId) {
    const positions = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0.5, 1, 0,
    ]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.computeBoundingSphere();
    return {
        skyObjectId,
        setupId: skyObjectId,
        prefix: (skyObjectId >>> 24) & 0xff,
        parts: [{
            partIndex: 0,
            groups: [{ geometry, surfaceDid: 0x08000048 + skyObjectId }],
            hinge: { x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 },
        }],
        surfaceDids: new Set([0x08000048 + skyObjectId]),
    };
}

const SKY_OBJECT_IDS = [
    0x010015ee, 0x010015ef, 0x01001f67, 0x01001f6a,
    0x01004c36, 0x01001348, 0x02000714,
];
const VISIBLE_IDS = SKY_OBJECT_IDS.filter((id) => (id >>> 24) !== 0x02);
const SETUP_MODEL_IDS = SKY_OBJECT_IDS.filter((id) => (id >>> 24) === 0x02);

const skyAssets = new Map();
for (const id of SKY_OBJECT_IDS) {
    skyAssets.set(id, makeBake(id));
}

const materialCache = new MaterialCache();
const added = skyDome.populateCelestialBodies(skyAssets, materialCache);
check(
    "populateCelestialBodies returns 6 (skips 1 SetupModel 0x02)",
    added === VISIBLE_IDS.length,
    `got ${added}, expected ${VISIBLE_IDS.length}`
);
check(
    "skyObjectMeshes has 6 entries",
    skyDome.skyObjectMeshes.size === VISIBLE_IDS.length,
    `got ${skyDome.skyObjectMeshes.size}`
);
check(
    "0x02000714 SetupModel was skipped (not in skyObjectMeshes)",
    SETUP_MODEL_IDS.every((id) => !skyDome.skyObjectMeshes.has(id)),
    `0x02xxx still present: ${SETUP_MODEL_IDS.filter((id) => skyDome.skyObjectMeshes.has(id)).map((id) => "0x" + id.toString(16))}`
);

// skyCell children: 1 dome + 6 rotators = 7.
check(
    "skyCell.children.length === 7 (1 dome + 6 rotators)",
    skyDome.skyCell.children.length === 7,
    `got ${skyDome.skyCell.children.length}`
);
const rotators = skyDome.skyCell.children.filter(
    (c) => c.userData?.sky_object_rotator === true
);
check(
    "6 children carry userData.sky_object_rotator === true",
    rotators.length === VISIBLE_IDS.length,
    `got ${rotators.length}`
);
check(
    "every rotator carries userData.sky_object_id",
    rotators.every((c) => typeof c.userData.sky_object_id === "number"),
    `bad: ${rotators.filter((c) => typeof c.userData.sky_object_id !== "number").length}`
);
const rotatorIdSet = new Set(rotators.map((c) => c.userData.sky_object_id));
check(
    "every visible SkyObject ID has a rotator",
    VISIBLE_IDS.every((id) => rotatorIdSet.has(id)),
    `missing: ${VISIBLE_IDS.filter((id) => !rotatorIdSet.has(id)).map((id) => "0x" + id.toString(16)).join(", ")}`
);

// Each rotator's child should be the bake group; the bake's transform
// should be identity (native vertex coords preserved).
for (const rotator of rotators) {
    const bake = rotator.userData?.bake;
    if (!bake) continue;
    check(
        `bake[0x${rotator.userData.sky_object_id.toString(16)}] transform is identity (native AC vertex coords)`,
        bake.position.x === 0 && bake.position.y === 0 && bake.position.z === 0 &&
            bake.scale.x === 1 && bake.scale.y === 1 && bake.scale.z === 1 &&
            bake.rotation.x === 0 && bake.rotation.y === 0 && bake.rotation.z === 0,
        `pos=(${bake.position.x},${bake.position.y},${bake.position.z}) ` +
            `scale=(${bake.scale.x},${bake.scale.y},${bake.scale.z})`
    );
    // Just check the first to avoid huge log spam.
    break;
}

// ---- Test 3: tick anchors skyCell at camera --------------------------

console.log("\ntick() anchors skyCell at camera:");

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
camera.position.set(42, 13, -7);

mockIndoor = false;
mockSkyObjectStates = [];
skyDome.tick(0.016, camera);

check(
    "skyCell.position === camera.position",
    skyDome.skyCell.position.x === 42 &&
        skyDome.skyCell.position.y === 13 &&
        skyDome.skyCell.position.z === -7,
    `got (${skyDome.skyCell.position.x}, ${skyDome.skyCell.position.y}, ${skyDome.skyCell.position.z})`
);
check(
    "skyCell.rotation.x stays at -π/2 (NOT yawed with camera)",
    Math.abs(skyDome.skyCell.rotation.x + Math.PI / 2) < 1e-6 &&
        skyDome.skyCell.rotation.y === 0 &&
        skyDome.skyCell.rotation.z === 0,
    `got rot=(${skyDome.skyCell.rotation.x}, ${skyDome.skyCell.rotation.y}, ${skyDome.skyCell.rotation.z})`
);

// ---- Test 4: tick applies per-rotator heading ------------------------

console.log("\ntick() with SkyObjectStates applies rotator heading:");

// Sun: progress=0.5 (midday-ish), begin=-20, end=190 → headingDeg=85 → ~1.484 rad.
// Star: progress=0.0, begin=0, end=0 (always-visible) → headingDeg=0.
mockSkyObjectStates = VISIBLE_IDS.map((id) => {
    if (id === 0x01001f67) {
        // sun-like: arc bounded
        return {
            gfxObjectId: id,
            heading: 0, pitch: 0,
            beginAngleDeg: -20, endAngleDeg: 190,
            beginTime: 0.04, endTime: 0.21,
            currentProgress: 0.5,
            texOffsetX: 0, texOffsetY: 0,
            transparent: -1, luminosity: -1, maxBright: -1,
            visible: true, properties: 0,
        };
    }
    // others: always-visible
    return {
        gfxObjectId: id,
        heading: 0, pitch: 0,
        beginAngleDeg: 0, endAngleDeg: 0,
        beginTime: 0, endTime: 0,
        currentProgress: 0,
        texOffsetX: 0, texOffsetY: 0,
        transparent: -1, luminosity: -1, maxBright: -1,
        visible: true, properties: 0,
    };
});
skyDome.tick(0.016, camera);

const sunRotator = skyDome.skyObjectMeshes.get(0x01001f67);
check(
    "sun-like SkyObject rotator.rotation.z ≈ lerp(-20,190,0.5)*π/180 = 85° in rad",
    sunRotator && Math.abs(sunRotator.rotation.z - 85 * Math.PI / 180) < 1e-4,
    `got rotation.z=${sunRotator?.rotation.z}, expected ${85 * Math.PI / 180}`
);

const staticRotator = skyDome.skyObjectMeshes.get(0x01001348);
check(
    "always-visible SkyObject rotator.rotation.z === 0",
    staticRotator && Math.abs(staticRotator.rotation.z) < 1e-9,
    `got rotation.z=${staticRotator?.rotation.z}`
);

// ---- Test 5: 0x02xxxxxx state is skipped without throwing ----------

console.log("\nticking with 0x02 SetupModel state:");

mockSkyObjectStates = [
    ...mockSkyObjectStates,
    {
        gfxObjectId: 0x02000714,
        heading: 0, pitch: 0,
        beginAngleDeg: 0, endAngleDeg: 0,
        beginTime: 0, endTime: 0, currentProgress: 0,
        texOffsetX: 0, texOffsetY: 0,
        transparent: -1, luminosity: -1, maxBright: -1,
        visible: true, properties: 0,
    },
];
let threw = false;
try {
    skyDome.tick(0.016, camera);
} catch (_) {
    threw = true;
}
check(
    "tick does NOT throw when receiving a 0x02 SetupModel state",
    !threw,
    `threw=${threw}`
);

// ---- Test 6: indoor flip short-circuits tick + renderSkyPass --------

console.log("\nIndoor flip:");

mockIndoor = true;
skyDome.tick(0.016, camera);
check(
    "indoor: _lastIsIndoor === true",
    skyDome._lastIsIndoor === true,
    `got ${skyDome._lastIsIndoor}`
);

// Mock renderer for renderSkyPass.
let renderCount = 0;
let lastSceneRendered = null;
const mockRenderer = {
    autoClear: true,
    clearDepth: () => {},
    render: (s, c) => { renderCount += 1; lastSceneRendered = s; },
};
skyDome.renderSkyPass(mockRenderer, camera);
check(
    "indoor: renderSkyPass does NOT call renderer.render",
    renderCount === 0,
    `got renderCount=${renderCount}`
);

// Flip back to outdoor.
mockIndoor = false;
skyDome.tick(0.016, camera);
skyDome.renderSkyPass(mockRenderer, camera);
check(
    "outdoor: renderSkyPass calls renderer.render(skyScene, skyCamera)",
    renderCount === 1 && lastSceneRendered === skyDome.skyScene,
    `got renderCount=${renderCount}, scene match=${lastSceneRendered === skyDome.skyScene}`
);

// ---- Test 7: argbToColor decode -------------------------------------

console.log("\nargbToColor decode:");
const c1 = __internals.argbToColor(0xff9cb3d9);
check(
    "argbToColor(0xFF9CB3D9): r ≈ 0x9C/255, g ≈ 0xB3/255, b ≈ 0xD9/255",
    Math.abs(c1.r - 0x9c / 255) < 1e-6 &&
        Math.abs(c1.g - 0xb3 / 255) < 1e-6 &&
        Math.abs(c1.b - 0xd9 / 255) < 1e-6,
    `got r=${c1.r.toFixed(3)}, g=${c1.g.toFixed(3)}, b=${c1.b.toFixed(3)}`
);

// ---- Test 8: lerpDeg helper -----------------------------------------

console.log("\nlerpDeg helper:");
check(
    "lerpDeg(-20, 190, 0.0) === -20",
    Math.abs(__internals.lerpDeg(-20, 190, 0.0) - (-20)) < 1e-9,
    `got ${__internals.lerpDeg(-20, 190, 0.0)}`
);
check(
    "lerpDeg(-20, 190, 1.0) === 190",
    Math.abs(__internals.lerpDeg(-20, 190, 1.0) - 190) < 1e-9,
    `got ${__internals.lerpDeg(-20, 190, 1.0)}`
);
check(
    "lerpDeg(-20, 190, 0.5) === 85 (sun midday heading)",
    Math.abs(__internals.lerpDeg(-20, 190, 0.5) - 85) < 1e-9,
    `got ${__internals.lerpDeg(-20, 190, 0.5)}`
);
// Sky-I-A's load-bearing case: sun at t=0.05 with begin_time=0.04,
// end_time=0.21 → progress = (0.05-0.04)/(0.21-0.04) ≈ 0.0588;
// lerpDeg(-20, 190, 0.0588) ≈ -7.65.
const sunProgressFoeDawn = (0.05 - 0.04) / (0.21 - 0.04);
const sunHeadingFoeDawn = __internals.lerpDeg(-20, 190, sunProgressFoeDawn);
check(
    "sun heading at t=0.05 lerpDeg ≈ -7.65° (Sky-I-A foredawn benchmark)",
    Math.abs(sunHeadingFoeDawn - (-7.647)) < 0.01,
    `got ${sunHeadingFoeDawn.toFixed(4)}°`
);

// ---- Test 9: idempotent re-populate ---------------------------------

console.log("\nIdempotent re-populate:");
const cellChildCountBefore = skyDome.skyCell.children.length;
const added2 = skyDome.populateCelestialBodies(skyAssets, materialCache);
check(
    "re-populate returns 6 (excludes SetupModel)",
    added2 === VISIBLE_IDS.length,
    `got ${added2}`
);
check(
    "skyCell.children count unchanged after re-populate",
    skyDome.skyCell.children.length === cellChildCountBefore,
    `was ${cellChildCountBefore}, now ${skyDome.skyCell.children.length}`
);

// ---- Test 10: dispose cleans up -------------------------------------

console.log("\nDispose:");
skyDome.dispose();
check(
    "after dispose: skyObjectMeshes is empty",
    skyDome.skyObjectMeshes.size === 0,
    `size=${skyDome.skyObjectMeshes.size}`
);

console.log("\n=========================");
console.log(`Sky-D/Sky-I-B sky_dome test: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
else process.exit(0);
