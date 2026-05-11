// Workstream Sky-E — sky-asset resolver standalone test.
//
// Mocks the wasm exports (`fetchBuildingPlacement`,
// `fetch_surfaces_pixels`) so the JS-side `resolveSkyAssets` flow can
// be exercised without a live ACE session.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_sky_assets.mjs
//
// THREE resolution + module-load dance mirrors
// `test_phase7_4b_entity_pipeline.mjs`.
//
// What this exercises:
//   1. resolveSkyAssets with the 7 retail Dereth SkyObject IDs.
//   2. All 7 IDs resolve (1 SetupModel + 6 GfxObjs).
//   3. The SetupModel (0x02000714) reports the correct prefix and a
//      single-part (its retail part is 0x010001EC).
//   4. Surface DID dedup works across multi-surface SkyObjects.
//   5. Idempotency: second call with same IDs is a no-op (no extra
//      fetchBuildingPlacement / fetch_surfaces_pixels calls).
//   6. buildSkyObjectGroup produces a Group with correct topology.

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
    console.log("Sky-E sky-assets ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_sky_assets.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Sky-E — sky_assets standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Patch + load modules with THREE pre-bound (same pattern as 7.4b).
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

const adapterSrc = loadModule("scene3d/adapter.js");
const materialsSrc = loadModule("scene3d/materials.js");
const skyAssetsSrc = loadModule("scene3d/sky_assets.js");

function stripExports(src) {
    return src
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const composite =
    "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
    "// === materials.js ===\n" + stripExports(materialsSrc) + "\n" +
    "// === sky_assets.js ===\n" + stripExports(skyAssetsSrc) + "\n" +
    "; return { resolveSkyAssets, buildSkyObjectGroup, MaterialCache, meshToGeometryGroups };";

const factory = new Function("THREE", "window", composite);
// The sky_assets resolver guards `window` access with `typeof window`;
// pass a minimal shim so the `window.liveScene3d.skyAssets` mirror
// path is exercised exactly as it runs in the browser.
const windowShim = {};
const factoryEnv = factory(THREE, windowShim);
const { resolveSkyAssets, buildSkyObjectGroup } = factoryEnv;

// ---- Mock wasm exports ----------------------------------------------

// The 7 retail Dereth SkyObject IDs from Sky-A's diagnostic dump
// (DayGroup[0] "Sunny" of Region 0x13000000).
const SKY_IDS = {
    BASE_SHELL_1:    0x010015EE,  // GfxObj, 4 surfaces (R8G8B8)
    BASE_SHELL_2:    0x010015EF,  // GfxObj, 1 surface (A8R8G8B8, Translucent)
    SUN:             0x01001F67,  // GfxObj, 1 surface (Index16)
    MOON:            0x01001F6A,  // GfxObj, 2 surfaces (Index16 + R8G8B8)
    CLOUD_BAND:      0x01004C36,  // GfxObj, 1 surface (A8R8G8B8, Translucent, tex_velocity)
    STARS:           0x01001348,  // GfxObj, 1 surface (R8G8B8, Translucent+Additive)
    PHYSICS_MOON:    0x02000714,  // SetupModel, 1 part 0x010001EC (Index16)
};
const RETAIL_IDS = Object.values(SKY_IDS);

// Surface DIDs each SkyObject references (from the dump).
const SURFACES_PER_SKY_ID = new Map([
    [SKY_IDS.BASE_SHELL_1,    [0x08000048, 0x08000049, 0x0800004A, 0x0800004B]],
    [SKY_IDS.BASE_SHELL_2,    [0x0800004D]],
    [SKY_IDS.SUN,             [0x080000D2]],
    [SKY_IDS.MOON,            [0x080000D6, 0x080000D7]],
    [SKY_IDS.CLOUD_BAND,      [0x080000D4]],
    [SKY_IDS.STARS,           [0x080000D1]],
    [SKY_IDS.PHYSICS_MOON,    [0x08000015]],
]);

let buildingPlacementCalls = 0;
let surfacesPixelsCalls = 0;
let surfacesPixelsTotalDids = 0;

function makePartMesh(surfaceDids) {
    // Synthesise a ModelMesh-shaped object the meshToGeometryGroups
    // adapter consumes. One triangle per surface, surfaceIndex maps
    // 1:1 to surfaceDids index.
    const n = surfaceDids.length;
    const positions = new Float32Array(n * 9);
    const uvs = new Float32Array(n * 6);
    const normals = new Float32Array(n * 3);
    const surfaceIndices = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
        // tri: (i, 0, 0)-(i+0.5, 0, 0)-(i+0.25, 0.5, 0)
        positions.set([
            i, 0, 0,
            i + 0.5, 0, 0,
            i + 0.25, 0.5, 0,
        ], i * 9);
        uvs.set([0, 0, 1, 0, 0.5, 1], i * 6);
        normals.set([0, 0, 1], i * 3);
        surfaceIndices[i] = i;
    }
    return {
        triCount: n,
        positions,
        uvs,
        normals,
        surfaceIndices,
        surfaces: new Uint32Array(surfaceDids),
        free: () => {},
    };
}

const mockWasmExports = {
    async fetchBuildingPlacement(modelId) {
        buildingPlacementCalls += 1;
        const id = modelId >>> 0;
        const surfaces = SURFACES_PER_SKY_ID.get(id);
        if (!surfaces) {
            throw new Error(`fetchBuildingPlacement: unknown id 0x${id.toString(16)}`);
        }
        // For 0x02 SetupModel the wasm returns N parts (here 1).
        // For 0x01 GfxObj it returns a single-element vec.
        // The mock keeps both paths uniform.
        const partMeshes = [makePartMesh(surfaces)];
        const hinges = partMeshes.map(() => ({
            x: 0, y: 0, z: 0,
            qw: 1, qx: 0, qy: 0, qz: 0,
            free: () => {},
        }));
        return {
            setupId: id,
            partCount: partMeshes.length,
            takePartMeshes() {
                const out = partMeshes.splice(0);
                return out;
            },
            takePartHingeFrames() {
                const out = hinges.splice(0);
                return out;
            },
            free: () => {},
        };
    },
    async fetch_surfaces_pixels(surfaceDids) {
        surfacesPixelsCalls += 1;
        surfacesPixelsTotalDids += surfaceDids.length;
        const out = [];
        for (let i = 0; i < surfaceDids.length; i += 1) {
            // Tiny 2x2 RGBA8 (red, for visibility). surfaceType=0 →
            // opaque/diffuse default material.
            const px = new Uint8Array(2 * 2 * 4);
            for (let p = 0; p < 4; p += 1) {
                px[p * 4 + 0] = 0xFF;
                px[p * 4 + 1] = 0x00;
                px[p * 4 + 2] = 0x00;
                px[p * 4 + 3] = 0xFF;
            }
            out.push({
                pixels: px,
                width: 2,
                height: 2,
                surfaceType: 0,
                free: () => {},
            });
        }
        return out;
    },
};

// ---- Test runner ----------------------------------------------------
const scene3d = { materialCache: null, skyAssets: null };

console.log("\nFirst-pass resolve (7 retail SkyObjects):");
const summary = await resolveSkyAssets(scene3d, RETAIL_IDS, mockWasmExports);

check(
    "all 7 SkyObjects resolved",
    summary.resolved === 7,
    `got resolved=${summary.resolved}`
);
check(
    "no failures",
    summary.failed === 0,
    `got failed=${summary.failed}`
);
check(
    "1 SetupModel (0x02000714)",
    summary.setupModelCount === 1,
    `got setupModelCount=${summary.setupModelCount}`
);
check(
    "10 unique surface DIDs",
    summary.uniqueSurfaceCount === 10,
    `got uniqueSurfaceCount=${summary.uniqueSurfaceCount}`
);
check(
    "skyAssets stashed on scene3d",
    scene3d.skyAssets instanceof Map && scene3d.skyAssets.size === 7,
    `got Map.size=${scene3d.skyAssets?.size}`
);
check(
    "skyAssets mirrored to window.liveScene3d",
    windowShim.liveScene3d?.skyAssets === scene3d.skyAssets,
    "window mirror missing or wrong"
);
check(
    "fetchBuildingPlacement called 7 times",
    buildingPlacementCalls === 7,
    `got buildingPlacementCalls=${buildingPlacementCalls}`
);

// Per-SkyObject assertions.
const moonBake = scene3d.skyAssets.get(SKY_IDS.MOON);
check(
    "moon (0x01001F6A) prefix=0x01",
    moonBake?.prefix === 0x01,
    `got prefix=0x${moonBake?.prefix?.toString(16)}`
);
check(
    "moon has 1 part with 2 surface groups",
    moonBake?.parts.length === 1 && moonBake.parts[0].groups.length === 2,
    `parts=${moonBake?.parts.length} groups=${moonBake?.parts[0]?.groups.length}`
);

const physMoonBake = scene3d.skyAssets.get(SKY_IDS.PHYSICS_MOON);
check(
    "physics moon (0x02000714) prefix=0x02",
    physMoonBake?.prefix === 0x02,
    `got prefix=0x${physMoonBake?.prefix?.toString(16)}`
);
check(
    "physics moon resolves to 1 part (0x010001EC)",
    physMoonBake?.parts.length === 1,
    `got parts=${physMoonBake?.parts.length}`
);
check(
    "physics moon part has 1 surface group",
    physMoonBake?.parts[0]?.groups.length === 1,
    `got groups=${physMoonBake?.parts[0]?.groups.length}`
);

const baseShell1 = scene3d.skyAssets.get(SKY_IDS.BASE_SHELL_1);
check(
    "base shell 1 has 1 part with 4 surface groups",
    baseShell1?.parts[0]?.groups.length === 4,
    `got groups=${baseShell1?.parts[0]?.groups.length}`
);
check(
    "base shell 1 surfaceDids set has 4 entries",
    baseShell1?.surfaceDids.size === 4,
    `got size=${baseShell1?.surfaceDids.size}`
);

// Idempotent second call: should not trigger new wasm fetches.
console.log("\nIdempotent second call:");
const callsBefore = buildingPlacementCalls;
const pxBefore = surfacesPixelsCalls;
const summary2 = await resolveSkyAssets(scene3d, RETAIL_IDS, mockWasmExports);
check(
    "second call returns same resolved count",
    summary2.resolved === 7,
    `got resolved=${summary2.resolved}`
);
check(
    "no extra fetchBuildingPlacement calls (idempotent)",
    buildingPlacementCalls === callsBefore,
    `was=${callsBefore} now=${buildingPlacementCalls}`
);
check(
    "no extra fetch_surfaces_pixels calls (idempotent)",
    surfacesPixelsCalls === pxBefore,
    `was=${pxBefore} now=${surfacesPixelsCalls}`
);

// buildSkyObjectGroup topology test.
console.log("\nbuildSkyObjectGroup topology:");
const moonGroup = buildSkyObjectGroup(moonBake, scene3d.materialCache);
check(
    "moon Group name = sky-01001f6a",
    moonGroup.name === "sky-01001f6a",
    `got ${moonGroup.name}`
);
check(
    "moon Group has 1 part child (hinge wrapper)",
    moonGroup.children.length === 1,
    `got ${moonGroup.children.length}`
);
check(
    "moon part wrapper has 2 surface mesh children",
    moonGroup.children[0].children.length === 2,
    `got ${moonGroup.children[0].children.length}`
);
check(
    "moon userData.partGroups.length === 1",
    moonGroup.userData.partGroups.length === 1,
    `got ${moonGroup.userData.partGroups.length}`
);

// Forced rebuild bumps fetch counts.
console.log("\nForced rebuild:");
const callsBeforeForce = buildingPlacementCalls;
const summary3 = await resolveSkyAssets(scene3d, RETAIL_IDS, mockWasmExports, { force: true });
check(
    "force:true triggers new fetchBuildingPlacement calls",
    buildingPlacementCalls === callsBeforeForce + 7,
    `expected ${callsBeforeForce + 7}, got ${buildingPlacementCalls}`
);

// Edge case: skyObjectId 0 (PhatSDK sentinel "no mesh") is filtered out.
console.log("\nEdge cases:");
const scene3dZero = { materialCache: null, skyAssets: null };
const callsBeforeZero = buildingPlacementCalls;
const summary4 = await resolveSkyAssets(scene3dZero, [0, 0, 0], mockWasmExports);
check(
    "id=0 sentinel filtered out (no fetch)",
    buildingPlacementCalls === callsBeforeZero,
    `expected no extra calls, got ${buildingPlacementCalls - callsBeforeZero}`
);
check(
    "empty input → resolved=0",
    summary4.resolved === 0,
    `got resolved=${summary4.resolved}`
);

// Empty wasmExports throws sensibly.
let threwOnMissingExports = false;
try {
    await resolveSkyAssets({}, [SKY_IDS.SUN], {});
} catch (e) {
    threwOnMissingExports = /fetchBuildingPlacement|fetch_surfaces_pixels/.test(
        String(e?.message ?? "")
    );
}
check("missing wasm exports throws", threwOnMissingExports);

console.log(`\n=========================`);
console.log(`Sky-E sky_assets test: passed=${passed} failed=${failed}`);
console.log(`   buildingPlacementCalls=${buildingPlacementCalls}`);
console.log(`   surfacesPixelsCalls=${surfacesPixelsCalls}`);
console.log(`   surfacesPixelsTotalDids=${surfacesPixelsTotalDids}`);
process.exit(failed === 0 ? 0 : 1);
