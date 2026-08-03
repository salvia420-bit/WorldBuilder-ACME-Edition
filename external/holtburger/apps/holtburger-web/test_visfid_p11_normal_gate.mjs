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
//   5. Quality preset table: all four presets = true since 656e1542 (2026-07-30).
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

// `three` comes from the ONE canonical locator (harness/lib/locate_three.mjs).
// This used to be a THREE_PATH-env-only lookup that exit-0'd when unset, so the
// invocation in this file's own header asserted nothing. See F2.
import { locateThree, requireThree } from "./harness/lib/locate_three.mjs";

const threePath = locateThree();
const THREE = await requireThree("Phase 1.1 normal-gate ESM test");

console.log("Phase 1.1 / Wave 2.B — procedural normal gate test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    return readFileSync(full, "utf8");
}

// Splice materials.js via the shared harness — the private stripper this
// replaced removed only `./adapter.js`, so later imports survived into the
// Function body and killed the suite. See F2.
import { spliceModule } from "./harness/lib/splice_module.mjs";
import { MATERIALS_JS_STUBS } from "./harness/lib/scene3d_stubs.mjs";

const matsSrc = loadModule("scene3d/materials.js");
const matsStubbed = spliceModule(matsSrc, {
    stubs: MATERIALS_JS_STUBS,
    label: "scene3d/materials.js",
});

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
    // 2026-08-03: low+mid were `false` until commit 656e1542 (2026-07-30)
    // flipped every preset ON, with the 1070 A/B recorded inline at
    // scene3d/quality.js:246-250 — with ?texBc7 also on, the compressed
    // textures cut enough bandwidth that everything-on measured FASTER
    // (35.2 ms / 28.4 fps vs 36.7 / 27.2). That commit updated neither this
    // test nor docs/url-flags.md, so both asserted a retired default; this
    // suite could not report it because it was silently exiting 0 without
    // THREE_PATH. Doc row corrected in the same change.
    check(
        "low preset: normalMaps=true (656e1542 default-ON)",
        PRESETS.low.normalMaps === true,
        `low.normalMaps=${PRESETS.low.normalMaps}`
    );
    check(
        "mid preset: normalMaps=true (656e1542 default-ON)",
        PRESETS.mid.normalMaps === true,
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
