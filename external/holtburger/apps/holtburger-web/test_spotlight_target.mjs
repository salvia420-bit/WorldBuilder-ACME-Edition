// B10b (likely:spotlight-target, 2026-06-07) — standalone ESM test for
// the SpotLight orientation/target wiring in lighting.js.
//
// Background: SetupModel SpotLights (cone_angle > 0) never had an aim
// direction because the wasm bridge DROPPED the LightInfo Frame
// orientation. B10b surfaces the orientation quaternion on the Rust
// `SetupLight` (qx/qy/qz/qw) and wires the JS SpotLight `.target`.
//
// CRITICAL property under test (the GUARD): the feature must stay
// DORMANT on the currently-shipped wasm pkg — where the qx/qy/qz/qw
// getters do NOT exist (reading them yields `undefined` → NaN) AND all
// shipped LightInfo descriptors have cone_angle <= 0 (→ PointLight). In
// both cases `userData.spotTargetLocal` must be `null` so no target is
// wired (byte-identical to pre-B10b behavior until a wasm-pack rebuild).
//
// Covers (via the exported `buildLightForSetupLight` + `releaseLight`):
//   1. PointLight (cone_angle == 0): spotTargetLocal === null.
//   2. SpotLight WITHOUT orientation (qx/qy/qz/qw absent → NaN): a
//      SpotLight is still built, but spotTargetLocal === null (DORMANT
//      guard — proves shipped-pkg byte-identity).
//   3. SpotLight WITH a finite orientation quaternion: spotTargetLocal
//      is set, and light.target.position is aimed one unit ahead of the
//      light along the rotated AC +Y forward axis.
//   4. releaseLight detaches an oriented SpotLight's target (parented
//      as a sibling under the same part Object3D) AND the light; it is
//      fail-soft for a SpotLight whose target was never parented.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=.../three.module.js node test_spotlight_target.mjs
//
// If three can't be located, prints SKIP and exits 0 (mirrors the other
// lighting tests).

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
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

// ---- locate `three` (same resolver as test_phase7_6_lighting.mjs) ----
function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    try {
        return require.resolve("three");
    } catch (_) {}
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("B10b spotlight-target ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=.../three.module.js node test_spotlight_target.mjs`");
    process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("B10b — SpotLight orientation/target wiring standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load lighting.js via closure-eval (strip THREE/csm/landblock_lru imports) ----
function loadSrc(rel) {
    const full = resolvePath(__dirname, rel);
    let src = readFileSync(full, "utf8");
    src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
    src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m, "");
    src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/landblock_lru\.js["'];?\s*$/m, "");
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

// lbKeyOf shim (matches landblock_lru.js's exported 16-bit-key mask).
const lbKeyOfShim =
    "const LB_KEY_MASK = 0xffff_0000 >>> 0;\n" +
    "function lbKeyOf(idOrKey) { return (idOrKey & LB_KEY_MASK) >>> 0; }\n";

const composite =
    lbKeyOfShim +
    stripExports(loadSrc("scene3d/csm.js")) + "\n" +
    stripExports(loadSrc("scene3d/lighting.js")) + "\n" +
    "; return { buildLightForSetupLight, releaseLight };";
const { buildLightForSetupLight, releaseLight } = new Function("THREE", composite)(THREE);

// =====================================================================
// Assert 1: PointLight (cone_angle == 0) carries spotTargetLocal===null.
// =====================================================================
{
    const pt = buildLightForSetupLight({
        x: 1, y: 2, z: 3,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: 5, falloff: 10, coneAngle: 0,
        qx: 0, qy: 0, qz: 0, qw: 1, // identity present, but PointLight ignores it
    });
    check(
        "B10b: cone_angle==0 → PointLight, spotTargetLocal === null (no target wiring)",
        !!pt && pt.isPointLight === true && pt.userData.spotTargetLocal === null,
        `isPointLight=${pt && pt.isPointLight}, spotTargetLocal=${pt && JSON.stringify(pt.userData.spotTargetLocal)}`
    );
}

// =====================================================================
// Assert 2 (GUARD): SpotLight WITHOUT orientation stays DORMANT.
// Simulates the currently-shipped pkg: the qx/qy/qz/qw getters are
// absent, so reading them yields undefined → +undefined === NaN.
// =====================================================================
{
    const spotNoOrient = buildLightForSetupLight({
        x: 1, y: 2, z: 3,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: 5, falloff: 10, coneAngle: 0.7,
        // qx/qy/qz/qw deliberately omitted — exactly like the shipped pkg.
    });
    const isSpot = !!spotNoOrient && spotNoOrient.isSpotLight === true;
    const dormant = !!spotNoOrient && spotNoOrient.userData.spotTargetLocal === null;
    check(
        "B10b GUARD: SpotLight without orientation → spotTargetLocal === null (dormant, shipped-pkg byte-identical)",
        isSpot && dormant,
        `isSpotLight=${isSpot}, spotTargetLocal=${spotNoOrient && JSON.stringify(spotNoOrient.userData.spotTargetLocal)}`
    );
}

// =====================================================================
// Assert 3: SpotLight WITH a finite orientation → target aimed.
// A 90° rotation about +Z (qz=sin45, qw=cos45) maps the AC forward axis
// +Y → -X. So target = lightPos + (-1, 0, 0).
// =====================================================================
{
    const s = Math.SQRT1_2; // sin(45deg) === cos(45deg)
    const spot = buildLightForSetupLight({
        x: 10, y: 20, z: 30,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: 5, falloff: 10, coneAngle: 0.7,
        qx: 0, qy: 0, qz: s, qw: s, // +90° about Z: +Y → -X
    });
    const stl = spot && spot.userData.spotTargetLocal;
    const tp = spot && spot.target && spot.target.position;
    // Expected target local = (10 + (-1), 20 + 0, 30 + 0) = (9, 20, 30).
    const okStl =
        !!stl &&
        Math.abs(stl.x - 9) < 1e-5 &&
        Math.abs(stl.y - 20) < 1e-5 &&
        Math.abs(stl.z - 30) < 1e-5;
    const okTarget =
        !!tp &&
        Math.abs(tp.x - 9) < 1e-5 &&
        Math.abs(tp.y - 20) < 1e-5 &&
        Math.abs(tp.z - 30) < 1e-5;
    check(
        "B10b: oriented SpotLight aims target one unit along rotated AC +Y (target.position === light + dir)",
        spot.isSpotLight === true && okStl && okTarget,
        `spotTargetLocal=${JSON.stringify(stl)}, target=(${tp && tp.x.toFixed(3)},${tp && tp.y.toFixed(3)},${tp && tp.z.toFixed(3)})`
    );
}

// =====================================================================
// Assert 4: releaseLight detaches an oriented SpotLight's parented
// target + the light, and is fail-soft when the target was never
// parented.
// =====================================================================
{
    const s = Math.SQRT1_2;
    const parent = new THREE.Object3D();
    const spot = buildLightForSetupLight({
        x: 0, y: 0, z: 0,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: 5, falloff: 10, coneAngle: 0.7,
        qx: 0, qy: 0, qz: s, qw: s,
    });
    // Mirror the attach loop: light + its target are siblings under the
    // same part Object3D.
    parent.add(spot);
    parent.add(spot.target);
    const scene3d = { activeLights: [spot] };
    let disposed = 0;
    const orig = spot.dispose?.bind(spot);
    spot.dispose = () => { disposed += 1; if (orig) orig(); };

    releaseLight(scene3d, spot);
    const detached =
        spot.parent === null &&
        spot.target.parent === null &&
        scene3d.activeLights.length === 0 &&
        disposed === 1;
    // Second release: target already detached → fail-soft, no throw.
    let threw = false;
    try { releaseLight(scene3d, spot); } catch (_) { threw = true; }

    // A SpotLight whose target was never parented (the shipped/dormant
    // case) must release without throwing.
    let dormantThrew = false;
    const lonelySpot = buildLightForSetupLight({
        x: 0, y: 0, z: 0, colorR: 1, colorG: 1, colorB: 1,
        intensity: 1, falloff: 5, coneAngle: 0.7,
        // no orientation → dormant; target never added to a parent
    });
    const lonelyParent = new THREE.Object3D();
    lonelyParent.add(lonelySpot);
    try { releaseLight({ activeLights: [lonelySpot] }, lonelySpot); } catch (_) { dormantThrew = true; }

    check(
        "B10b: releaseLight detaches SpotLight target + light, fail-soft on re-release + un-parented target",
        detached && !threw && !dormantThrew && lonelySpot.parent === null,
        `detached=${detached}, disposed=${disposed}, reReleaseThrew=${threw}, dormantThrew=${dormantThrew}`
    );
}

console.log("=========================");
if (failed === 0) {
    console.log(`PASS: all ${passed} checks passed.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
