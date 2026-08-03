// Visual-fidelity C4 — chained-onBeforeCompile program-cache-key test.
//
// Finding #3: our shader patches (detail / CSM / POM / lightClamp / AO /
// fill-depth-bias) are installed via `_chainBeforeCompile`, which mutates
// `onBeforeCompile` strings that three.js does NOT see when it builds its
// program-cache key. So two MeshStandardMaterials that differ ONLY in
// their patch composition (e.g. CSM+POM vs CSM+lightClamp) used to share
// ONE compiled WebGLProgram and render each other's shader. Batch 3 adds
// `material.customProgramCacheKey` in BOTH branches of `_chainBeforeCompile`
// so three keys the program on the actual patch set.
//
// This mirrors the loader in test_visfid_p33_csm.mjs.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/path/to/three.module.js node test_visfid_c4_program_cache_key.mjs

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
const THREE = await requireThree("C4 program-cache-key ESM test");

console.log("C4 — program-cache-key for chained onBeforeCompile (#3)");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load a module source and strip the bare `import * as THREE` line so it
// can run inside a `new Function("THREE", ...)` closure.
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src.replace(
        /^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m,
        ""
    );
    // 2026-07-28 — strip EVERY sibling-module import, not just `./adapter.js`.
    // materials.js grew `./vfx_flags.js` + `./suite_assets.js` imports after
    // this test was written, and one un-stripped `import` makes the whole
    // `new Function(...)` body a SyntaxError — the test then died on load
    // (its only symptom a stack trace, no FAIL line) and stopped guarding the
    // key. The stripped bindings are only referenced inside MaterialCache,
    // which this test never constructs.
    src = src.replace(
        /^\s*import\s+(?:[\w*\s{},]+)\s+from\s+["']\.[^"']*["'];?\s*$/gm,
        ""
    );
    return src;
}

const csmSrc = loadModule("scene3d/csm.js");
const csmFactory = new Function(
    "THREE",
    "// === csm.js ===\n" +
        csmSrc
            .replace(/^\s*export\s+function\s+/gm, "function ")
            .replace(/^\s*export\s+const\s+/gm, "const ") +
        "\n; return { setupCsm };"
);
const { setupCsm } = csmFactory(THREE);

// Fake a `?lightClamp=retail` URL so the lightClamp patch actually
// installs (the installer no-ops + leaves the shader byte-identical when
// the flag is off — see _installLightClampShaderPatch).
globalThis.window = { location: { search: "?lightClamp=retail" } };

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
    matsPatched +
        "\n; return { installCsmShaderPatch, installPomShaderPatch, installLightClampShaderPatch, applyWireVertexAOPatch, applyFillDepthBias, readLightClampRetailFlag };"
);
const {
    installCsmShaderPatch,
    installPomShaderPatch,
    installLightClampShaderPatch,
    applyWireVertexAOPatch,
    applyFillDepthBias,
    readLightClampRetailFlag,
} = matsFactory(THREE);

check(
    "lightClamp flag reads `retail` from faked URL",
    readLightClampRetailFlag() === true,
    `flag=${readLightClampRetailFlag()}`
);

// Fresh CSM bundles for the patches (lights provide shadow refs).
const scene = new THREE.Scene();
const csmState = setupCsm(scene, { sunDir: { x: 60, y: 80, z: 30 } });

// A stub height texture for POM (needs a non-null texture to install).
const stubHeight = new THREE.DataTexture(
    new Uint8Array([127, 127, 127, 255]),
    1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
);
stubHeight.name = "stub-height";
stubHeight.needsUpdate = true;

// ---- Material A: CSM + POM ----
const matA = new THREE.MeshStandardMaterial();
installCsmShaderPatch(matA, csmState);
installPomShaderPatch(matA, stubHeight, { forced: true });

// ---- Material B: CSM + lightClamp ----
const matB = new THREE.MeshStandardMaterial();
installCsmShaderPatch(matB, csmState);
installLightClampShaderPatch(matB);

check(
    "matA records csmEnabled + pomEnabled in userData",
    matA.userData?.csmEnabled === true && matA.userData?.pomEnabled === true,
    `csm=${matA.userData?.csmEnabled}, pom=${matA.userData?.pomEnabled}`
);
check(
    "matB records csmEnabled + lightClampRetail in userData",
    matB.userData?.csmEnabled === true && matB.userData?.lightClampRetail === true,
    `csm=${matB.userData?.csmEnabled}, lightClamp=${matB.userData?.lightClampRetail}`
);

// ---- Core C4 assertions ----
check(
    "matA.customProgramCacheKey is a function",
    typeof matA.customProgramCacheKey === "function",
    `typeof=${typeof matA.customProgramCacheKey}`
);
check(
    "matB.customProgramCacheKey is a function",
    typeof matB.customProgramCacheKey === "function",
    `typeof=${typeof matB.customProgramCacheKey}`
);

const keyA = matA.customProgramCacheKey();
const keyB = matB.customProgramCacheKey();
check(
    "CSM+POM and CSM+lightClamp keys DIFFER (no program collision)",
    keyA !== keyB,
    `A=${keyA}, B=${keyB}`
);
check(
    "CSM+POM key has the exact expected shape",
    keyA === "hb|d0|c1|p1|l0|a0|b0|f0|s0|k0|v",
    `keyA=${keyA}`
);
check(
    "CSM+lightClamp key has the exact expected shape",
    keyB === "hb|d0|c1|p0|l1|a0|b0|f0|s0|k0|v",
    `keyB=${keyB}`
);

// ---- Single-patch materials still get a key (both _chainBeforeCompile
//      branches install it: the FIRST patch hits the prev===proto branch,
//      a SECOND patch hits the chained branch). ----
const matSingle = new THREE.MeshStandardMaterial();
installCsmShaderPatch(matSingle, csmState);
check(
    "single CSM-only patch still installs a customProgramCacheKey",
    typeof matSingle.customProgramCacheKey === "function" &&
        matSingle.customProgramCacheKey() === "hb|d0|c1|p0|l0|a0|b0|f0|s0|k0|v",
    `key=${typeof matSingle.customProgramCacheKey === "function" ? matSingle.customProgramCacheKey() : "(none)"}`
);

// ---- Wireframe-side patches (MeshBasicMaterial path) also get a key. ----
const matAO = new THREE.MeshBasicMaterial();
applyWireVertexAOPatch(matAO);
check(
    "AO patch installs a key reflecting __aoPatched",
    typeof matAO.customProgramCacheKey === "function" &&
        matAO.customProgramCacheKey() === "hb|d0|c0|p0|l0|a1|b0|f0|s0|k0|v",
    `key=${typeof matAO.customProgramCacheKey === "function" ? matAO.customProgramCacheKey() : "(none)"}`
);

const matFill = new THREE.MeshBasicMaterial();
applyFillDepthBias(matFill);
applyWireVertexAOPatch(matFill);
check(
    "depthBias + AO compose into ONE key with both bits set",
    matFill.customProgramCacheKey() === "hb|d0|c0|p0|l0|a1|b1|f0|s0|k0|v",
    `key=${matFill.customProgramCacheKey()}`
);

// ---- lightClamp NO-OP path: flag OFF must NOT set the flag/key and must
//      leave the shipped baseline byte-identical (no patch installed). ----
globalThis.window = { location: { search: "?lightClamp=off" } };
const matsFactory2 = new Function(
    "THREE",
    matsPatched +
        "\n; return { installLightClampShaderPatch };"
);
const { installLightClampShaderPatch: installLightClampOff } =
    matsFactory2(THREE);
const matNoop = new THREE.MeshStandardMaterial();
const protoBefore = matNoop.onBeforeCompile;
installLightClampOff(matNoop);
check(
    "lightClamp flag OFF: installer is a true no-op (onBeforeCompile untouched)",
    matNoop.onBeforeCompile === protoBefore,
    `changed=${matNoop.onBeforeCompile !== protoBefore}`
);
check(
    "lightClamp flag OFF: NO OWN customProgramCacheKey installed (inherits three's baseline)",
    !Object.prototype.hasOwnProperty.call(matNoop, "customProgramCacheKey") &&
        matNoop.customProgramCacheKey() !== "hb|d0|c0|p0|l0|a0|b0|f0|s0|k0|v",
    `own=${Object.prototype.hasOwnProperty.call(matNoop, "customProgramCacheKey")}, key=${matNoop.customProgramCacheKey()}`
);
check(
    "lightClamp flag OFF: lightClampRetail flag NOT set",
    matNoop.userData?.lightClampRetail !== true,
    `flag=${matNoop.userData?.lightClampRetail}`
);

// ---- Lazy read: a patch added AFTER another sees its bit appear in the
//      SAME (lazily-read) key (closure reflects current userData). ----
const matLazy = new THREE.MeshStandardMaterial();
installCsmShaderPatch(matLazy, csmState);
const keyBeforePom = matLazy.customProgramCacheKey();
installPomShaderPatch(matLazy, stubHeight, { forced: true });
const keyAfterPom = matLazy.customProgramCacheKey();
check(
    "key is read LAZILY: adding POM after CSM flips the p bit on the existing key",
    keyBeforePom === "hb|d0|c1|p0|l0|a0|b0|f0|s0|k0|v" &&
        keyAfterPom === "hb|d0|c1|p1|l0|a0|b0|f0|s0|k0|v",
    `before=${keyBeforePom}, after=${keyAfterPom}`
);

console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} C4 program-cache-key checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} of ${passed + failed} C4 checks failed.`);
    process.exit(1);
}
