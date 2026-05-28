// === Wave 2.B — procedural normals (2026-05-28) ===
//
// Visual-fidelity Phase 1.1 — procedural normal map gate test.
//
// Phase 1.1 (Sobel-X height-to-normal) shipped 2026-05-13. Wave 2.B
// closes the deferred visibility-blocker: the `normalMaps` quality
// preset flag (and the matching Graphics settings UI toggle) was
// catalogued but never consumed. This test pins down:
//
//   1. Default: `MaterialCache()` with no `normalMapsEnabled` opt →
//      `normalMap` is wired (back-compat for legacy callers + tests).
//   2. `normalMapsEnabled: true` → normal map wired, `normalScale` set.
//   3. `normalMapsEnabled: false` → normal map dropped, no scale set.
//   4. Per-category `normalScale` fallback chain:
//      explicit override > category default > 0.8 baseline.
//   5. Quality preset table: `low`+`mid` = false, `high`+`ultra` = true.
//   6. Luminous surfaces never get a normal map regardless of gate
//      (emissive + bump shading would look wrong).
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_visfid_p11_normal_gate.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("Phase 1.1 normal-gate ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_visfid_p11_normal_gate.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Phase 1.1 / Wave 2.B — procedural normal gate test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    return readFileSync(full, "utf8");
}

const matsSrc = loadModule("scene3d/materials.js");
const matsPatched = matsSrc
    .replace(
        /^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m,
        ""
    )
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
const matsStubbed =
    "const surfacePixelsToTexture = () => null;\n" +
    "const surfacePixelsToNormalTexture = () => null;\n" +
    "const surfacePixelsToHeightTexture = () => null;\n" +
    matsPatched;

const matsFactory = new Function(
    "THREE",
    matsStubbed +
        "\n; return { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY };"
);
const { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY } = matsFactory(THREE);

function makeStubTex(name) {
    const t = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]),
        1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    t.needsUpdate = true;
    t.name = name;
    return t;
}

const diffuseTex = makeStubTex("diffuse");
const normalTex = makeStubTex("normal");

// ---- Group 1: gate defaults ----------------------------------------
console.log("\nGroup 1: gate defaults");
{
    const cacheDefault = new MaterialCache();
    check(
        "default ctor: normalMapsEnabled=true (back-compat)",
        cacheDefault.normalMapsEnabled === true,
        `normalMapsEnabled=${cacheDefault.normalMapsEnabled}`
    );

    const cacheExplicitFalse = new MaterialCache({ normalMapsEnabled: false });
    check(
        "explicit false: normalMapsEnabled=false",
        cacheExplicitFalse.normalMapsEnabled === false,
        `normalMapsEnabled=${cacheExplicitFalse.normalMapsEnabled}`
    );

    const cacheExplicitTrue = new MaterialCache({ normalMapsEnabled: true });
    check(
        "explicit true: normalMapsEnabled=true",
        cacheExplicitTrue.normalMapsEnabled === true,
        `normalMapsEnabled=${cacheExplicitTrue.normalMapsEnabled}`
    );
}

// ---- Group 2: gate wiring through _materialFromFlags ----------------
console.log("\nGroup 2: gate wiring through _materialFromFlags");
{
    const cacheOn = new MaterialCache({ normalMapsEnabled: true });
    const matOn = cacheOn._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Stone,
        normalTex,
        null,
        null,
    );
    check(
        "gate=on Stone: normalMap wired",
        matOn.normalMap === normalTex,
        `normalMap=${matOn.normalMap === normalTex ? "wired" : "null"}`
    );
    check(
        "gate=on Stone: normalScaleEffective recorded",
        typeof matOn.userData?.normalScaleEffective === "number",
        `normalScaleEffective=${matOn.userData?.normalScaleEffective}`
    );

    const cacheOff = new MaterialCache({ normalMapsEnabled: false });
    const matOff = cacheOff._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Stone,
        normalTex,
        null,
        null,
    );
    check(
        "gate=off Stone: normalMap dropped",
        matOff.normalMap === null,
        `normalMap=${matOff.normalMap ? "wired" : "null"}`
    );
    check(
        "gate=off Stone: no normalScaleEffective stored",
        typeof matOff.userData?.normalScaleEffective !== "number",
        `normalScaleEffective=${matOff.userData?.normalScaleEffective}`
    );
}

// ---- Group 3: per-category normalScale fallback chain ----------------
console.log("\nGroup 3: per-category normalScale fallback chain");
{
    const cache = new MaterialCache({ normalMapsEnabled: true });

    // Per-DID override beats category default.
    const matExplicit = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Stone,
        normalTex,
        { roughness: undefined, normalScale: 1.7 },
        null,
    );
    check(
        "override 1.7 beats Stone category default",
        Math.abs(matExplicit.normalScale.x - 1.7) < 1e-6,
        `normalScale.x=${matExplicit.normalScale.x}`
    );
    check(
        "override path: normalScaleOverride mirrored on userData",
        matExplicit.userData?.normalScaleOverride === 1.7,
        `normalScaleOverride=${matExplicit.userData?.normalScaleOverride}`
    );

    // No override → category default (Brick = 1.1).
    const matBrick = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Brick,
        normalTex,
        null,
        null,
    );
    check(
        "Brick category default normalScale=1.1",
        Math.abs(matBrick.normalScale.x - 1.1) < 1e-6,
        `normalScale.x=${matBrick.normalScale.x}`
    );

    // No override + Foliage → 0.5.
    const matFoliage = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Foliage,
        normalTex,
        null,
        null,
    );
    check(
        "Foliage category default normalScale=0.5",
        Math.abs(matFoliage.normalScale.x - 0.5) < 1e-6,
        `normalScale.x=${matFoliage.normalScale.x}`
    );

    // No override + Water (not in CATEGORY_NORMAL_SCALE_DEFAULTS) → 0.8.
    const matWater = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        SURFACE_CATEGORY.Water,
        normalTex,
        null,
        null,
    );
    check(
        "Water (no category entry) baseline normalScale=0.8",
        Math.abs(matWater.normalScale.x - 0.8) < 1e-6,
        `normalScale.x=${matWater.normalScale.x}`
    );

    // Unset category → 0.8.
    const matNoCat = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        undefined,
        normalTex,
        null,
        null,
    );
    check(
        "no category baseline normalScale=0.8",
        Math.abs(matNoCat.normalScale.x - 0.8) < 1e-6,
        `normalScale.x=${matNoCat.normalScale.x}`
    );
}

// ---- Group 4: Luminous never gets normal even when gate=on ----------
console.log("\nGroup 4: Luminous bypass");
{
    const cache = new MaterialCache({ normalMapsEnabled: true });
    const matLum = cache._materialFromFlags(
        SURFACE_TYPE.Base1Image | SURFACE_TYPE.Luminous,
        diffuseTex,
        SURFACE_CATEGORY.Stone,
        normalTex,
        null,
        null,
    );
    check(
        "Luminous + gate=on: normalMap still dropped (emissive override)",
        matLum.normalMap === null,
        `normalMap=${matLum.normalMap ? "wired" : "null"}`
    );
}

// ---- Group 5: quality preset table ----------------------------------
console.log("\nGroup 5: quality preset table");
{
    const qualityUrl =
        "file://" + resolvePath(__dirname, "scene3d/quality.js");
    const { PRESETS } = await import(qualityUrl);
    check(
        "low preset: normalMaps=false",
        PRESETS.low.normalMaps === false,
        `low.normalMaps=${PRESETS.low.normalMaps}`
    );
    check(
        "mid preset: normalMaps=false",
        PRESETS.mid.normalMaps === false,
        `mid.normalMaps=${PRESETS.mid.normalMaps}`
    );
    check(
        "high preset: normalMaps=true",
        PRESETS.high.normalMaps === true,
        `high.normalMaps=${PRESETS.high.normalMaps}`
    );
    check(
        "ultra preset: normalMaps=true",
        PRESETS.ultra.normalMaps === true,
        `ultra.normalMaps=${PRESETS.ultra.normalMaps}`
    );
}

console.log("=========================");
console.log(`passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
