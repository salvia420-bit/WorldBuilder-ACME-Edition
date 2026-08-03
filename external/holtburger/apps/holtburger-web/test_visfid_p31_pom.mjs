// Visual-fidelity Phase 3.1 — Parallax Occlusion Mapping ESM test.
//
// Verifies that `MaterialCache._materialFromFlags` correctly wires the
// POM shader patch when:
//   - quality.flags.pom is enabled (constructor: pomEnabled=true)
//   - category is Stone / Brick / Tile
//   - heightTexture is non-null
//   - normalTexture is non-null
//   - surface is not Additive / not Translucent
//
// Also checks the gating:
//   - pomEnabled=false → no patch (mid/low preset)
//   - category=Wood    → no patch (stone-only)
//   - heightTexture=null → no patch (Luminous/constant-lum surfaces)
//   - forcePom=true    → patch applies even on Wood
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_visfid_p31_pom.mjs

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
const THREE = await requireThree("Phase 3.1 POM ESM test");

console.log("Phase 3.1 — POM standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    return readFileSync(full, "utf8");
}

const matsSrc = loadModule("scene3d/materials.js");
// Strip EVERY static import (materials.js has grown vfx_flags/suite_assets/
// bc7_textures imports since the original two-replace version of this test —
// each new one broke the Function() eval identically) and de-export.
const matsPatched = matsSrc
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
// Stub the stripped imports — _materialFromFlags + installPomShaderPatch use
// only aoMapIntensityValue/materialBakeEnabled at install time; the rest are
// get()/preload()-only, which this test never exercises.
const matsStubbed =
    "const surfacePixelsToTexture = () => null;\n" +
    "const surfacePixelsToNormalTexture = () => null;\n" +
    "const surfacePixelsToHeightTexture = () => null;\n" +
    "const aoMapIntensityValue = () => 0.6;\n" +
    "const getQuality = () => null;\n" +
    "const materialBakeEnabled = () => false;\n" +
    "const SuiteAssetSource = class {};\n" +
    "const loadTexchanManifest = () => null;\n" +
    "const bc7Available = () => false;\n" +
    "const bc7TextureBytes = () => 0;\n" +
    "const upgradeMaterialToBc7 = () => false;\n" +
    matsPatched;

const matsFactory = new Function(
    "THREE",
    matsStubbed +
        "\n; return { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY, installPomShaderPatch };"
);
const { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY, installPomShaderPatch } =
    matsFactory(THREE);

// ---- Stage 1: pomEnabled=false → no patch (low/mid preset) ----
function makeStubTex(name) {
    const t = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]),
        1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    t.needsUpdate = true;
    t.name = name;
    return t;
}
function makeHeightTex(name) {
    // RedFormat in three doesn't strictly require a single-channel
    // typed buffer in this codepath (we don't render), so a simple
    // DataTexture is enough for installation-only tests.
    const t = new THREE.DataTexture(
        new Uint8Array([128]),
        1, 1, THREE.RedFormat, THREE.UnsignedByteType
    );
    t.needsUpdate = true;
    t.name = name;
    return t;
}

const diffuseTex = makeStubTex("diffuse");
const normalTex = makeStubTex("normal");
const heightTex = makeHeightTex("height");

const cacheNoPom = new MaterialCache({ pomEnabled: false });
const matNoPom = cacheNoPom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    heightTex,
);
check(
    "pomEnabled=false: no POM patch installed",
    matNoPom.userData?.pomEnabled !== true,
    `pomEnabled=${matNoPom.userData?.pomEnabled}`
);

// ---- Stage 2: pomEnabled=true + Stone + heightTex + normalTex → patch ----
const cachePom = new MaterialCache({ pomEnabled: true });
const matStone = cachePom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    heightTex,
);
check(
    "Stone + pomEnabled + height + normal: pomEnabled=true on material",
    matStone.userData?.pomEnabled === true,
    `pomEnabled=${matStone.userData?.pomEnabled}`
);
check(
    "Stone + pomEnabled: onBeforeCompile installed",
    typeof matStone.onBeforeCompile === "function",
    `onBeforeCompile=${typeof matStone.onBeforeCompile}`
);
check(
    "Stone + pomEnabled: pomUniforms recorded on userData",
    matStone.userData?.pomUniforms &&
        typeof matStone.userData.pomUniforms.steps === "number",
    `pomUniforms=${JSON.stringify(matStone.userData?.pomUniforms)}`
);

// ---- Stage 3: Brick + Tile categories also get POM ----
const matBrick = cachePom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Brick,
    normalTex,
    null,
    heightTex,
);
check(
    "Brick + pomEnabled: pomEnabled=true",
    matBrick.userData?.pomEnabled === true,
    `pomEnabled=${matBrick.userData?.pomEnabled}`
);
const matTile = cachePom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Tile,
    normalTex,
    null,
    heightTex,
);
check(
    "Tile + pomEnabled: pomEnabled=true",
    matTile.userData?.pomEnabled === true,
    `pomEnabled=${matTile.userData?.pomEnabled}`
);

// ---- Stage 4: the category gate (widened 2026-07-30) ----
// Solid architectural materials (incl. Wood/Metal — dungeon themes) APPLY;
// Cloth (painted banners must not emboss), Foliage (alpha cards) and
// fluid/organic categories still refuse.
for (const [name, cat, applies] of [
    ["Wood", SURFACE_CATEGORY.Wood, true],
    ["Metal", SURFACE_CATEGORY.Metal, true],
    ["Sand", SURFACE_CATEGORY.Sand, false],
    ["Foliage", SURFACE_CATEGORY.Foliage, false],
    ["Cloth", SURFACE_CATEGORY.Cloth, false],
]) {
    const m = cachePom._materialFromFlags(
        SURFACE_TYPE.Base1Image,
        diffuseTex,
        cat,
        normalTex,
        null,
        heightTex,
    );
    check(
        `${name} + pomEnabled: pomEnabled ${applies ? "APPLIES (solid architectural)" : "stays false (excluded category)"}`,
        (m.userData?.pomEnabled === true) === applies,
        `pomEnabled=${m.userData?.pomEnabled}`
    );
}

// ---- Stage 5: heightTex=null → no patch even on Stone ----
const matStoneNoHeight = cachePom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    null, // no heightTexture (e.g. Luminous or constant-lum surface)
);
check(
    "Stone + heightTex=null: no POM patch (empty heightmap skip)",
    matStoneNoHeight.userData?.pomEnabled !== true,
    `pomEnabled=${matStoneNoHeight.userData?.pomEnabled}`
);

// ---- Stage 6: normalTex=null → no patch (POM needs normal map) ----
const matStoneNoNormal = cachePom._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    null,
    null,
    heightTex,
);
check(
    "Stone + normalTex=null: no POM patch (POM needs normal map)",
    matStoneNoNormal.userData?.pomEnabled !== true,
    `pomEnabled=${matStoneNoNormal.userData?.pomEnabled}`
);

// ---- Stage 7: Additive / Translucent → no patch ----
const matAdditive = cachePom._materialFromFlags(
    SURFACE_TYPE.Additive | SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    heightTex,
);
check(
    "Additive + Stone: no POM patch (additive blending unaffected)",
    matAdditive.userData?.pomEnabled !== true,
    `pomEnabled=${matAdditive.userData?.pomEnabled}`
);
const matTrans = cachePom._materialFromFlags(
    SURFACE_TYPE.Translucent | SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    heightTex,
);
check(
    "Translucent + Stone: no POM patch",
    matTrans.userData?.pomEnabled !== true,
    `pomEnabled=${matTrans.userData?.pomEnabled}`
);

// ---- Stage 8: forcePom=true → POM even on an excluded category (Cloth) ----
// (Wood moved inside the widened gate 2026-07-30, so the bypass is now
// exercised with Cloth, which stays excluded.)
const cacheForce = new MaterialCache({ pomEnabled: true, forcePom: true });
const matForcedCloth = cacheForce._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Cloth,
    normalTex,
    null,
    heightTex,
);
check(
    "forcePom + Cloth: POM patch applies anyway",
    matForcedCloth.userData?.pomEnabled === true,
    `pomEnabled=${matForcedCloth.userData?.pomEnabled}`
);
check(
    "forcePom + Cloth: userData records pomForced=true",
    matForcedCloth.userData?.pomForced === true,
    `pomForced=${matForcedCloth.userData?.pomForced}`
);

// ---- Stage 9: simulate onBeforeCompile → assert shader patches injected ----
const stubShader = {
    vertexShader:
        "#include <common>\nvoid main() {\n#include <project_vertex>\n}\n",
    fragmentShader:
        "#include <common>\nvoid main() {\n#include <map_fragment>\n#include <dithering_fragment>\n}\n",
    uniforms: {},
};
matStone.onBeforeCompile(stubShader);

check(
    "patched fragment shader declares uPomMap sampler",
    /uniform sampler2D uPomMap/.test(stubShader.fragmentShader),
    "uPomMap declared"
);
check(
    "patched fragment shader declares uPomSteps / uPomDepth / uPomLodNear / uPomLodFar",
    /uniform int uPomSteps/.test(stubShader.fragmentShader) &&
        /uniform float uPomDepth/.test(stubShader.fragmentShader) &&
        /uniform float uPomLodNear/.test(stubShader.fragmentShader) &&
        /uniform float uPomLodFar/.test(stubShader.fragmentShader),
    "all four scalars present"
);
check(
    "patched fragment shader declares uPomShadowSteps + uPomShadowDarkness (self-shadow)",
    /uniform int uPomShadowSteps/.test(stubShader.fragmentShader) &&
        /uniform float uPomShadowDarkness/.test(stubShader.fragmentShader),
    "self-shadow uniforms present"
);
check(
    "patched fragment shader defines _pomPerturbedUv function",
    /vec2\s+_pomPerturbedUv\s*\(/.test(stubShader.fragmentShader),
    "function found"
);
check(
    "patched fragment shader defines _pomShadow function (self-shadow)",
    /float\s+_pomShadow\s*\(/.test(stubShader.fragmentShader),
    "self-shadow function found"
);
check(
    "patched fragment shader uses LOD ramp via smoothstep(uPomLodNear, uPomLodFar, length(vViewPosition))",
    /smoothstep\(uPomLodNear,\s*uPomLodFar,\s*length\(vViewPosition\)\)/.test(stubShader.fragmentShader),
    "LOD ramp injection"
);
// S4 fix (2026-07-30): the tangent frame moved to the FRAGMENT stage
// (getTangentFrame — the fabricated vertex-stage TBN rotated with the
// camera). The vertex shader is deliberately untouched now, and the
// self-shadow marches toward directionalLights[0], not a camera proxy.
check(
    "S4: fragment builds the tangent frame via getTangentFrame; vertex shader untouched",
    /getTangentFrame\(-vViewPosition/.test(stubShader.fragmentShader) &&
        !/vPomTangentViewDir/.test(stubShader.vertexShader) &&
        !/vPomTangentViewDir/.test(stubShader.fragmentShader),
    "fragment-stage TBN present, legacy varyings gone"
);
check(
    "S4: self-shadow marches toward the REAL sun (directionalLights[0])",
    /directionalLights\[0\]\.direction/.test(stubShader.fragmentShader),
    "real light direction used"
);
check(
    "patched shader registers uPomMap into shader.uniforms",
    stubShader.uniforms.uPomMap !== undefined &&
        stubShader.uniforms.uPomSteps !== undefined,
    `uniforms keys=${Object.keys(stubShader.uniforms).filter((k) => k.startsWith("uPom")).join(",")}`
);

// ---- Stage 10: default step count = 16 (POM_UNIFORM_DEFAULTS.steps) ----
check(
    "default POM step count = 16",
    matStone.userData?.pomUniforms?.steps === 16,
    `steps=${matStone.userData?.pomUniforms?.steps}`
);

// ---- Stage 11: ultra preset step count override = 32 ----
const cacheUltra = new MaterialCache({
    pomEnabled: true,
    pomOpts: { steps: 32 },
});
const matUltra = cacheUltra._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    diffuseTex,
    SURFACE_CATEGORY.Stone,
    normalTex,
    null,
    heightTex,
);
check(
    "ultra preset POM step count = 32",
    matUltra.userData?.pomUniforms?.steps === 32,
    `steps=${matUltra.userData?.pomUniforms?.steps}`
);

// ---- Stage 12: chained patches — POM + CSM compose cleanly ----
// (We don't construct a real csmState here — just verify that
// installPomShaderPatch's chain wires another hook before our own.)
const matBase = new THREE.MeshStandardMaterial({ color: 0xff8844 });
let prevHookCalled = false;
matBase.onBeforeCompile = function (shader) {
    prevHookCalled = true;
    shader.uniforms.uPreviousMarker = { value: 1 };
};
installPomShaderPatch(matBase, heightTex);
const stubShader3 = {
    vertexShader: "#include <common>\nvoid main() {\n#include <project_vertex>\n}\n",
    fragmentShader: "#include <common>\nvoid main() {\n#include <map_fragment>\n#include <dithering_fragment>\n}\n",
    uniforms: {},
};
matBase.onBeforeCompile(stubShader3);
check(
    "previous onBeforeCompile hook also runs (chain preserved)",
    prevHookCalled,
    "prev hook called"
);
check(
    "chained: both uPreviousMarker AND uPomMap in shader.uniforms",
    stubShader3.uniforms.uPreviousMarker !== undefined &&
        stubShader3.uniforms.uPomMap !== undefined,
    `keys=${Object.keys(stubShader3.uniforms).join(",")}`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 3.1 POM checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
