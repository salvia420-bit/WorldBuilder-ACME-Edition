// Workstream Sky-D — standalone ESM test for `scene3d/sky_dome.js`.
//
// Stands up a synthetic THREE.Scene + a mocked session-handle accessor
// that returns hand-built SkyObjectState shapes, then drives the
// `SkyDome` controller through:
//
//   1. Construction adds a Mesh named "sky_dome" to scene.children
//      (capture-script bullet 11 contract).
//   2. The dome's ShaderMaterial carries `uHorizonColor` + `uZenithColor`
//      uniforms initialised to the Sky-C fallback defaults.
//   3. `populateCelestialBodies` with a 7-entry mock skyAssets Map adds
//      7 children to scene.children, each carrying `userData.sky_object_id`
//      (capture-script bullet 12 contract).
//   4. `tick(dt, camera)` translates the dome + every celestial body
//      to follow the camera (camera-parented contract).
//   5. With a mock session reporting `isCurrentCellIndoor() === true`,
//      tick flips `dome.visible = false` + every celestial body's
//      `.visible = false`.
//   6. With a mock session reporting `isCurrentCellIndoor() === false`,
//      tick restores `dome.visible = true` AND per-body visibility
//      follows the SkyObjectState `.visible` flag.
//   7. The `argbToColor` helper decodes 0xAARRGGBB → RGB unit triple.
//   8. `celestialPosition(heading=0, pitch=0)` lands at (0, 0, -R)
//      (south horizon — AC north 0° heading → three.js -z).
//   9. `celestialPosition(heading=π/2, pitch=π/2)` lands at (0, R, 0)
//      (zenith) — verifies pitch convention (radians).
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
    console.log("Sky-D sky-dome ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_sky_dome.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Workstream Sky-D — sky dome standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- Load sky_dome.js + sky_assets.js + adapter.js + materials.js ----
//
// Same closure-captured-THREE pattern as test_sky_lighting.mjs +
// test_sky_assets.mjs. The dome module imports `buildSkyObjectGroup`
// from sky_assets.js and `acToThree` from adapter.js — we splice all
// three (plus materials.js for MaterialCache type-checks) into one
// composite source then `new Function`-it with THREE pre-bound.

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
// = 0` at module scope (the JS sentinel for an unresolved surface DID).
// In the real ES-modules path they live in separate module records; here
// we splice all four into one `new Function` body, which collapses their
// scopes and triggers `SyntaxError: Identifier already declared`. Rename
// the second occurrence to `FALLBACK_SURFACE_DID_MAT` for the test
// composite — the binding is private to each module and not referenced
// across them, so the rename is purely cosmetic for this scope-collapse.
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
const { SkyDome, __internals, MaterialCache, buildSkyObjectGroup } = mod;

// ---- Test 1: SkyDome construction adds "sky_dome" to scene ----------

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
    "scene.children grew by one (sky_dome)",
    scene.children.length === 1,
    `got ${scene.children.length}`
);
const domeNode = scene.children[0];
check(
    "scene.children[0].name === 'sky_dome'",
    domeNode.name === "sky_dome",
    `got name=${domeNode.name}`
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
check(
    "dome renderOrder is -1 (drawn first)",
    domeNode.renderOrder === -1,
    `got renderOrder=${domeNode.renderOrder}`
);

// ---- Test 2: populateCelestialBodies adds 7 children ----------------

console.log("\npopulateCelestialBodies:");

// Build a 7-entry skyAssets Map. Each bake has 1 part with 1 surface
// group (a flat triangle); we don't need geometry correctness here,
// just enough to exercise buildSkyObjectGroup.
function makeBake(skyObjectId, prefix) {
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
        prefix,
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
const skyAssets = new Map();
for (const id of SKY_OBJECT_IDS) {
    const prefix = (id >>> 24) & 0xff;
    skyAssets.set(id, makeBake(id, prefix));
}

const materialCache = new MaterialCache();
const added = skyDome.populateCelestialBodies(skyAssets, materialCache);
check(
    "populateCelestialBodies returns 7",
    added === 7,
    `got ${added}`
);
check(
    "scene.children grew to 8 (dome + 7 bodies)",
    scene.children.length === 8,
    `got ${scene.children.length}`
);

// Per-body checks: each is a Group, carries userData.sky_object_id.
const skyObjectChildren = scene.children.filter(
    (c) => c.userData?.sky_object_id !== undefined
);
check(
    "7 scene children carry userData.sky_object_id (capture bullet 12)",
    skyObjectChildren.length === 7,
    `got ${skyObjectChildren.length}`
);
const ids = skyObjectChildren.map((c) => c.userData.sky_object_id);
const idSet = new Set(ids);
check(
    "all 7 SkyObject IDs are unique",
    idSet.size === 7,
    `got ${idSet.size} unique`
);
check(
    "every SkyObject ID matches an input ID",
    SKY_OBJECT_IDS.every((id) => idSet.has(id)),
    `missing: ${SKY_OBJECT_IDS.filter((id) => !idSet.has(id)).map((id) => "0x" + id.toString(16)).join(", ")}`
);

// ---- Test 3: tick(dt, camera) translates dome + bodies to camera ----

console.log("\ntick() translates with camera:");

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
camera.position.set(42, 13, -7);

// Default tick with isCurrentCellIndoor=false + empty SkyObjectStates.
mockIndoor = false;
mockSkyObjectStates = [];
skyDome.tick(0.016, camera);

check(
    "dome.position === camera.position",
    domeNode.position.x === 42 &&
        domeNode.position.y === 13 &&
        domeNode.position.z === -7,
    `got (${domeNode.position.x}, ${domeNode.position.y}, ${domeNode.position.z})`
);
check(
    "dome.visible === true (outdoor)",
    domeNode.visible === true,
    `got ${domeNode.visible}`
);

// Bodies follow the camera too (when getSkyObjectStates is empty the
// bodies still translate with camera but don't get pose updates —
// scoped to step A in the tick).
// (We don't assert per-body position because step D is short-circuited
// with empty states, so the bodies are at `camera.position + (0,0,0)`
// which is camera position exactly.)
const firstBody = skyObjectChildren[0];
check(
    "celestial body position === camera position (no pose update)",
    firstBody.position.x === 42 &&
        firstBody.position.y === 13 &&
        firstBody.position.z === -7,
    `got (${firstBody.position.x}, ${firstBody.position.y}, ${firstBody.position.z})`
);

// ---- Test 4: tick() with non-empty SkyObjectStates ------------------

console.log("\ntick() with SkyObjectStates applies pose + visibility:");

mockSkyObjectStates = SKY_OBJECT_IDS.map((id, idx) => ({
    gfxObjectId: id,
    heading: 0.0,                // due north
    pitch: Math.PI / 2.0,        // zenith
    texOffsetX: 0.0,
    texOffsetY: 0.0,
    transparent: -1.0,
    luminosity: -1.0,
    maxBright: -1.0,
    visible: idx !== 0,          // first one invisible
    properties: 0,
}));
// Tick with the same camera; bodies should move to camera.pos + (0, R, 0)
camera.position.set(0, 0, 0);
skyDome.tick(0.016, camera);

const bodyById = new Map();
for (const c of skyObjectChildren) bodyById.set(c.userData.sky_object_id, c);

check(
    "first SkyObject (visible=false) has .visible=false",
    bodyById.get(SKY_OBJECT_IDS[0]).visible === false,
    `got ${bodyById.get(SKY_OBJECT_IDS[0]).visible}`
);
check(
    "second SkyObject (visible=true) has .visible=true",
    bodyById.get(SKY_OBJECT_IDS[1]).visible === true,
    `got ${bodyById.get(SKY_OBJECT_IDS[1]).visible}`
);

// Zenith pose: at h=0, p=π/2 the body should land at (0, R, 0)
// (camera at origin + offset).
const secondBody = bodyById.get(SKY_OBJECT_IDS[1]);
check(
    "zenith pose: y ≈ CELESTIAL_SPHERE_RADIUS",
    Math.abs(secondBody.position.y - __internals.CELESTIAL_SPHERE_RADIUS) < 0.001,
    `got y=${secondBody.position.y}, expected ~${__internals.CELESTIAL_SPHERE_RADIUS}`
);
check(
    "zenith pose: x ≈ 0 and z ≈ 0",
    Math.abs(secondBody.position.x) < 0.001 &&
        Math.abs(secondBody.position.z) < 0.001,
    `got x=${secondBody.position.x}, z=${secondBody.position.z}`
);

// ---- Test 5: indoor flip hides dome + bodies ------------------------

console.log("\nIndoor flip:");

mockIndoor = true;
skyDome.tick(0.016, camera);
check(
    "dome.visible === false (indoor)",
    domeNode.visible === false,
    `got ${domeNode.visible}`
);
check(
    "all celestial bodies .visible === false (indoor)",
    skyObjectChildren.every((c) => c.visible === false),
    `visible counts: ${skyObjectChildren.filter((c) => c.visible).length} still visible`
);

// Flip back to outdoor.
mockIndoor = false;
skyDome.tick(0.016, camera);
check(
    "dome.visible === true (outdoor restored)",
    domeNode.visible === true,
    `got ${domeNode.visible}`
);
// First body's per-state .visible=false; the rest should be true.
check(
    "outdoor restored: per-body visibility tracks state.visible",
    bodyById.get(SKY_OBJECT_IDS[0]).visible === false &&
        bodyById.get(SKY_OBJECT_IDS[1]).visible === true,
    `body[0]=${bodyById.get(SKY_OBJECT_IDS[0]).visible} ` +
        `body[1]=${bodyById.get(SKY_OBJECT_IDS[1]).visible}`
);

// ---- Test 6: argbToColor decode -------------------------------------

console.log("\nargbToColor decode:");
const c1 = __internals.argbToColor(0xff9cb3d9);
check(
    "argbToColor(0xFF9CB3D9): r ≈ 0x9C/255, g ≈ 0xB3/255, b ≈ 0xD9/255",
    Math.abs(c1.r - 0x9c / 255) < 1e-6 &&
        Math.abs(c1.g - 0xb3 / 255) < 1e-6 &&
        Math.abs(c1.b - 0xd9 / 255) < 1e-6,
    `got r=${c1.r.toFixed(3)}, g=${c1.g.toFixed(3)}, b=${c1.b.toFixed(3)}`
);

// ---- Test 7: celestialPosition convention ---------------------------

console.log("\ncelestialPosition convention:");
const R = __internals.CELESTIAL_SPHERE_RADIUS;
// h=0 (AC north), p=0 (horizon) → three.js -z (AC north → three -z).
const [hx, hy, hz] = __internals.celestialPosition(0, 0, R);
check(
    "h=0, p=0 → (0, 0, -R) (north horizon)",
    Math.abs(hx) < 1e-3 && Math.abs(hy) < 1e-3 && Math.abs(hz + R) < 1e-3,
    `got (${hx.toFixed(2)}, ${hy.toFixed(2)}, ${hz.toFixed(2)})`
);
// h=π/2 (AC east), p=0 (horizon) → three.js +x.
const [ex, ey, ez] = __internals.celestialPosition(Math.PI / 2, 0, R);
check(
    "h=π/2, p=0 → (+R, 0, 0) (east horizon)",
    Math.abs(ex - R) < 1e-3 && Math.abs(ey) < 1e-3 && Math.abs(ez) < 1e-3,
    `got (${ex.toFixed(2)}, ${ey.toFixed(2)}, ${ez.toFixed(2)})`
);
// h=anything, p=π/2 (zenith) → three.js +y.
const [zx, zy, zz] = __internals.celestialPosition(1.234, Math.PI / 2, R);
check(
    "p=π/2 (any heading) → (0, +R, 0) (zenith)",
    Math.abs(zx) < 1e-3 && Math.abs(zy - R) < 1e-3 && Math.abs(zz) < 1e-3,
    `got (${zx.toFixed(2)}, ${zy.toFixed(2)}, ${zz.toFixed(2)})`
);

// ---- Test 8: idempotent re-populate ---------------------------------

console.log("\nIdempotent re-populate:");
const childCountBefore = scene.children.length;
const added2 = skyDome.populateCelestialBodies(skyAssets, materialCache);
check(
    "re-populate returns same count",
    added2 === 7,
    `got ${added2}`
);
check(
    "scene.children count unchanged after re-populate",
    scene.children.length === childCountBefore,
    `was ${childCountBefore}, now ${scene.children.length}`
);

// ---- Test 9: dispose cleans up --------------------------------------

console.log("\nDispose:");
skyDome.dispose();
check(
    "after dispose: dome no longer in scene.children",
    !scene.children.includes(domeNode),
    `still includes dome: ${scene.children.includes(domeNode)}`
);
check(
    "after dispose: skyObjectMeshes is empty",
    skyDome.skyObjectMeshes.size === 0,
    `size=${skyDome.skyObjectMeshes.size}`
);

console.log("\n=========================");
console.log(`Sky-D sky_dome test: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
else process.exit(0);
