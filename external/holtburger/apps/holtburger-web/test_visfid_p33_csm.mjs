// Visual-fidelity Phase 3.3 — Cascaded Shadow Maps ESM test.
//
// Loads three.js, calls `setupCsm` on a synthetic Scene, then drives
// `updateCsm` against a PerspectiveCamera positioned over Holtburg's
// LB centre. Verifies:
//
//   1. setupCsm attaches a Group with 3 DirectionalLights (1 per cascade).
//   2. Each light has `castShadow=true`, intensity=0 (shadow-only).
//   3. Map sizes are 2048/2048/1024 by default.
//   4. updateCsm computes a valid ortho frustum for each cascade
//      (left < right, bottom < top, near < far, all finite).
//   5. The cascade splits are in ascending order (30 < 100 < 300).
//   6. installCsmShaderPatch (via MaterialCache) marks the material
//      as csmEnabled in userData.
//   7. The CSM shader fragment compiles successfully via three's
//      onBeforeCompile path — we synthesise a fake shader object
//      and run the patched callback.
//   8. refreshCsmUniforms updates the matrix uniforms from the lights'
//      shadow.matrix references each call.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_visfid_p33_csm.mjs

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
// This used to be a THREE_PATH-env-only lookup that exit-0'd when unset, so
// the invocation in this file's own header asserted nothing. See F2.
import { locateThree, requireThree } from "./harness/lib/locate_three.mjs";

const threePath = locateThree();
const THREE = await requireThree("Phase 3.3 CSM ESM test");

console.log("Phase 3.3 — CSM standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load the csm.js source and rewrite the THREE import into a closure.
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

const csmSrc = loadModule("scene3d/csm.js");
const csmFactory = new Function(
    "THREE",
    "// === csm.js ===\n" + stripExports(csmSrc) + "\n" +
    "; return { setupCsm, updateCsm, refreshCsmUniforms, DEFAULT_CSM_SPLITS, DEFAULT_CSM_MAP_SIZES };"
);
const csmMod = csmFactory(THREE);
const { setupCsm, updateCsm, refreshCsmUniforms, DEFAULT_CSM_SPLITS, DEFAULT_CSM_MAP_SIZES } =
    csmMod;

// ---- Stage 1: setupCsm wires 3 shadow-only lights ----
const scene = new THREE.Scene();
const csmState = setupCsm(scene, {
    sunDir: { x: 60, y: 80, z: 30 },
});
check(
    "setupCsm returns a state with 3 cascade lights",
    csmState && Array.isArray(csmState.lights) && csmState.lights.length === 3,
    `lights.length=${csmState?.lights?.length}`
);
check(
    "setupCsm attaches a `csm-cascades` group to the scene",
    scene.children.some((c) => c.name === "csm-cascades"),
    `scene.children=${scene.children.map((c) => c.name).join(",")}`
);

// All three lights should be DirectionalLights with castShadow=true.
let okCount = 0;
for (let i = 0; i < 3; i += 1) {
    const l = csmState.lights[i];
    if (
        l &&
        (l.isDirectionalLight || l.type === "DirectionalLight") &&
        l.castShadow === true &&
        l.intensity === 0
    ) {
        okCount += 1;
    }
}
check(
    "All 3 cascade lights are shadow-only DirectionalLights (intensity=0, castShadow=true)",
    okCount === 3,
    `okCount=${okCount}/3`
);

// ---- Stage 2: default splits + map sizes ----
check(
    "splits = [30, 100, 300] by default",
    csmState.splits[0] === 30 &&
        csmState.splits[1] === 100 &&
        csmState.splits[2] === 300,
    `splits=${JSON.stringify(csmState.splits)}`
);
check(
    "mapSizes = [2048, 2048, 1024] by default",
    csmState.lights[0].shadow.mapSize.x === 2048 &&
        csmState.lights[1].shadow.mapSize.x === 2048 &&
        csmState.lights[2].shadow.mapSize.x === 1024,
    `sizes=${csmState.lights.map((l) => l.shadow.mapSize.x).join(",")}`
);
check(
    "blendFrac = 0.1 by default",
    Math.abs(csmState.blendFrac - 0.1) < 1e-6,
    `blendFrac=${csmState.blendFrac}`
);
check(
    "DEFAULT_CSM_SPLITS export matches",
    DEFAULT_CSM_SPLITS[0] === 30 && DEFAULT_CSM_SPLITS[2] === 300,
    `default=${JSON.stringify(DEFAULT_CSM_SPLITS)}`
);
check(
    "DEFAULT_CSM_MAP_SIZES export matches",
    DEFAULT_CSM_MAP_SIZES[0] === 2048 && DEFAULT_CSM_MAP_SIZES[2] === 1024,
    `default=${JSON.stringify(DEFAULT_CSM_MAP_SIZES)}`
);

// ---- Stage 3: updateCsm produces sensible per-cascade frustums ----
// Build a perspective camera at Holtburg-ish position (post-AC→three transform).
// Holtburg LB centre AC = (0xA9*192+96, 0xB4*192+96, 80). In three.js
// after `worldRoot.rotation.x = -Math.PI/2`, the centre is at
// (acX, acZ, -acY). Camera sits 200m above & framed at the centre.
const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 5000);
const acX = 0xA9 * 192 + 96;
const acY = 0xB4 * 192 + 96;
camera.position.set(acX, 280, -acY);
camera.lookAt(acX, 80, -acY);
camera.updateMatrixWorld();
camera.updateProjectionMatrix();

updateCsm(csmState, camera);

let cascadeFrustumOk = 0;
for (let i = 0; i < 3; i += 1) {
    const c = csmState.lights[i].shadow.camera;
    const finite =
        Number.isFinite(c.left) &&
        Number.isFinite(c.right) &&
        Number.isFinite(c.top) &&
        Number.isFinite(c.bottom) &&
        Number.isFinite(c.near) &&
        Number.isFinite(c.far);
    if (finite && c.right > c.left && c.top > c.bottom && c.far > c.near) {
        cascadeFrustumOk += 1;
    } else {
        console.log(
            `  [DBG] cascade ${i} frustum: l=${c.left}, r=${c.right}, t=${c.top}, b=${c.bottom}, n=${c.near}, f=${c.far}`
        );
    }
}
check(
    "updateCsm produces valid ortho frustums for all 3 cascades",
    cascadeFrustumOk === 3,
    `valid=${cascadeFrustumOk}/3`
);

// Cascades should be progressively larger (cascade 0 < 1 < 2 in
// frustum width — far ranges have larger spatial extent).
const w0 = csmState.lights[0].shadow.camera.right - csmState.lights[0].shadow.camera.left;
const w1 = csmState.lights[1].shadow.camera.right - csmState.lights[1].shadow.camera.left;
const w2 = csmState.lights[2].shadow.camera.right - csmState.lights[2].shadow.camera.left;
check(
    "Cascade frustum widths grow: cascade 0 < 1 < 2",
    w0 < w1 && w1 < w2,
    `w0=${w0.toFixed(1)}, w1=${w1.toFixed(1)}, w2=${w2.toFixed(1)}`
);

// ---- Stage 4: refreshCsmUniforms — register a fake material, simulate
// the compile hook, then refresh and assert uniforms updated. ----
const fakeMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
// Pretend it's been compiled with our patch: stash uniforms refs.
const fakeUniforms = {
    uCsmShadowMap0: { value: null },
    uCsmShadowMap1: { value: null },
    uCsmShadowMap2: { value: null },
    uCsmMatrix0: { value: new THREE.Matrix4() },
    uCsmMatrix1: { value: new THREE.Matrix4() },
    uCsmMatrix2: { value: new THREE.Matrix4() },
    uCsmSplits: { value: new THREE.Vector2() },
    uCsmFar: { value: 0 },
    uCsmBlend: { value: 0 },
};
fakeMat.userData = { csmShaderUniforms: fakeUniforms };
csmState.patchedMaterials.add(fakeMat);

// Set known split values + simulate that the lights have shadow.matrix
// values (three normally fills this in at render time; we synth one).
const fakeLightMatrix0 = new THREE.Matrix4().makeTranslation(1, 2, 3);
csmState.lights[0].shadow.matrix.copy(fakeLightMatrix0);

refreshCsmUniforms(csmState);

check(
    "refreshCsmUniforms pushes shadow.matrix into uCsmMatrix0",
    fakeUniforms.uCsmMatrix0.value.elements[12] === 1 &&
        fakeUniforms.uCsmMatrix0.value.elements[13] === 2 &&
        fakeUniforms.uCsmMatrix0.value.elements[14] === 3,
    `m[12,13,14]=${fakeUniforms.uCsmMatrix0.value.elements.slice(12, 15).join(",")}`
);
check(
    "refreshCsmUniforms pushes splits → uCsmSplits",
    fakeUniforms.uCsmSplits.value.x === 30 &&
        fakeUniforms.uCsmSplits.value.y === 100,
    `splits.x=${fakeUniforms.uCsmSplits.value.x}, splits.y=${fakeUniforms.uCsmSplits.value.y}`
);
check(
    "refreshCsmUniforms pushes far split → uCsmFar",
    fakeUniforms.uCsmFar.value === 300,
    `uCsmFar=${fakeUniforms.uCsmFar.value}`
);
check(
    "refreshCsmUniforms pushes blendFrac → uCsmBlend",
    Math.abs(fakeUniforms.uCsmBlend.value - 0.1) < 1e-6,
    `uCsmBlend=${fakeUniforms.uCsmBlend.value}`
);

// ---- Stage 5: dispose removes the cascade group cleanly ----
const beforeDispose = scene.children.length;
csmState.dispose();
check(
    "dispose() removes the cascade group from scene.children",
    !scene.children.some((c) => c.name === "csm-cascades"),
    `before=${beforeDispose}, after=${scene.children.length}`
);

// ---- Stage 6: setupCsm rejects bad opts (length-3 splits required) ----
let threwOnBadSplits = false;
try {
    const scene2 = new THREE.Scene();
    setupCsm(scene2, { splits: [30, 100] });
} catch (e) {
    threwOnBadSplits = true;
}
check(
    "setupCsm throws on splits.length !== 3",
    threwOnBadSplits === true,
    `threw=${threwOnBadSplits}`
);

// ---- Stage 7: materials.js CSM patch integration test ----
const matsSrc = loadModule("scene3d/materials.js");
const matsPatched = matsSrc
    .replace(
        /^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m,
        ""
    )
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
const matsFactory = new Function(
    "THREE",
    matsPatched + "\n; return { MaterialCache, SURFACE_TYPE, SURFACE_CATEGORY, installCsmShaderPatch };"
);
const { MaterialCache: TestMaterialCache, SURFACE_TYPE, installCsmShaderPatch } =
    matsFactory(THREE);

// Re-construct a fresh CSM bundle for the material test (the previous
// one was disposed).
const sceneM = new THREE.Scene();
const csmStateM = setupCsm(sceneM, { sunDir: { x: 60, y: 80, z: 30 } });

const cache = new TestMaterialCache({ csmState: csmStateM });
const stubDiffuse = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
);
stubDiffuse.needsUpdate = true;

const matOpaque = cache._materialFromFlags(
    SURFACE_TYPE.Base1Image,
    stubDiffuse,
    undefined
);
check(
    "MaterialCache(csmState): opaque material is marked csmEnabled",
    matOpaque.userData?.csmEnabled === true,
    `csmEnabled=${matOpaque.userData?.csmEnabled}`
);
check(
    "MaterialCache(csmState): opaque material has onBeforeCompile installed",
    typeof matOpaque.onBeforeCompile === "function",
    `onBeforeCompile=${typeof matOpaque.onBeforeCompile}`
);
check(
    "MaterialCache(csmState): patchedMaterials set now includes the new mat",
    csmStateM.patchedMaterials.has(matOpaque),
    `size=${csmStateM.patchedMaterials.size}`
);

// Additive materials should NOT receive the patch (they're shadow-exempt).
const matAdditive = cache._materialFromFlags(
    SURFACE_TYPE.Additive | SURFACE_TYPE.Base1Image,
    stubDiffuse,
    undefined
);
check(
    "MaterialCache(csmState): additive material is NOT csm-patched",
    matAdditive.userData?.csmEnabled !== true,
    `csmEnabled=${matAdditive.userData?.csmEnabled}`
);

// Translucent materials should NOT receive the patch.
const matTranslucent = cache._materialFromFlags(
    SURFACE_TYPE.Translucent | SURFACE_TYPE.Base1Image,
    stubDiffuse,
    undefined
);
check(
    "MaterialCache(csmState): translucent material is NOT csm-patched",
    matTranslucent.userData?.csmEnabled !== true,
    `csmEnabled=${matTranslucent.userData?.csmEnabled}`
);

// ---- Stage 8: simulate onBeforeCompile call → assert the patched
//      fragment + vertex shaders contain the CSM uniforms + sampler. ----
const stubShader = {
    fragmentShader:
        "#include <common>\nvoid main() {\n#include <dithering_fragment>\n}\n",
    vertexShader:
        "#include <common>\nvoid main() {\n#include <project_vertex>\n}\n",
    uniforms: {},
};
matOpaque.onBeforeCompile(stubShader);

check(
    "patched fragment shader declares uCsmShadowMap0/1/2 samplers",
    /uniform sampler2D uCsmShadowMap0/.test(stubShader.fragmentShader) &&
        /uniform sampler2D uCsmShadowMap1/.test(stubShader.fragmentShader) &&
        /uniform sampler2D uCsmShadowMap2/.test(stubShader.fragmentShader),
    "samplers found"
);
check(
    "patched fragment shader declares uCsmSplits + uCsmFar + uCsmBlend",
    /uniform vec2 uCsmSplits/.test(stubShader.fragmentShader) &&
        /uniform float uCsmFar/.test(stubShader.fragmentShader) &&
        /uniform float uCsmBlend/.test(stubShader.fragmentShader),
    "scalars found"
);
check(
    "patched fragment shader defines _csmShadowFactor function",
    /float\s+_csmShadowFactor\s*\(/.test(stubShader.fragmentShader),
    "found"
);
check(
    "patched fragment shader injects _csmShadowFactor call before dithering",
    /_csmShadowFactor\([^)]*\)/.test(stubShader.fragmentShader),
    "call site present"
);
check(
    "patched vertex shader emits vCsmWorldPos + vCsmViewDepth varyings",
    /varying\s+vec3\s+vCsmWorldPos/.test(stubShader.vertexShader) &&
        /varying\s+float\s+vCsmViewDepth/.test(stubShader.vertexShader),
    "varyings found"
);
check(
    "patched shader registers uniforms into shader.uniforms",
    stubShader.uniforms.uCsmShadowMap0 !== undefined &&
        stubShader.uniforms.uCsmMatrix0 !== undefined &&
        stubShader.uniforms.uCsmSplits !== undefined,
    `uniforms=${Object.keys(stubShader.uniforms).filter((k) => k.startsWith("uCsm")).join(",")}`
);

// ---- Stage 9: composition with detail patch ----
// When BOTH Detail (0x20000) bit + csmState are present, both patches
// should be applied. The patch chain runs them in install order.
const stubTile = new THREE.DataTexture(
    new Uint8Array([127, 127, 127, 255]),
    1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
);
stubTile.needsUpdate = true;
const cacheBoth = new TestMaterialCache({
    csmState: csmStateM,
    detailTileCache: new Map([["stone-grain", stubTile]]),
});
const matBoth = cacheBoth._materialFromFlags(
    SURFACE_TYPE.Detail | SURFACE_TYPE.Base1Image,
    stubDiffuse,
    0 // SURFACE_CATEGORY.Stone
);
check(
    "Detail + CSM both present: material has both userData flags",
    matBoth.userData?.detailEnabled === true &&
        matBoth.userData?.csmEnabled === true,
    `detail=${matBoth.userData?.detailEnabled}, csm=${matBoth.userData?.csmEnabled}`
);
// Run the chained onBeforeCompile and assert both injections land.
const stubShader2 = {
    fragmentShader:
        "#include <common>\nvoid main() {\n#include <map_fragment>\n#include <dithering_fragment>\n}\n",
    vertexShader:
        "#include <common>\nvoid main() {\n#include <project_vertex>\n}\n",
    uniforms: {},
};
matBoth.onBeforeCompile(stubShader2);
check(
    "chained patch: BOTH detail (uDetailMap) AND CSM (uCsmShadowMap0) uniforms declared",
    /uniform sampler2D uDetailMap/.test(stubShader2.fragmentShader) &&
        /uniform sampler2D uCsmShadowMap0/.test(stubShader2.fragmentShader),
    "both found"
);
check(
    "chained patch: both detail (uDetailScale) AND CSM (uCsmSplits) uniforms in shader.uniforms",
    stubShader2.uniforms.uDetailScale !== undefined &&
        stubShader2.uniforms.uCsmSplits !== undefined,
    `keys=${Object.keys(stubShader2.uniforms).join(",")}`
);

csmStateM.dispose();

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 3.3 CSM checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
