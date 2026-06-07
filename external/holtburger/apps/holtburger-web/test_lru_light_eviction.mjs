// B10 (#6 + #16, 2026-06-07) — standalone ESM test for the SetupModel
// light eviction path + sRGB light-color decode.
//
// Covers:
//   1. lighting.js exports `releaseLight` and it is fail-soft +
//      idempotent (release a light not in activeLights / already
//      detached is a no-op; a second release does not throw).
//   2. The landblock LRU splices/detaches/disposes per-LB SetupModel
//      lights on eviction: attach two `__lbKey`-tagged lights into a
//      mock scene3d.activeLights, `track(lbKey, {lights})`, then
//      `evict(lbKey)` → activeLights empties, each light.parent === null,
//      each light.dispose() fired, and entries no longer has the key.
//      A second LB's lights are untouched by evicting the first.
//   3. #16 sRGB decode: `buildLightForSetupLight` with (0.5,0.5,0.5)
//      yields a light whose color.r ≈ 0.214 (NOT 0.5 — the channels are
//      authored in sRGB and decoded to linear); (1,1,1) → (1,1,1).
//      Guards that THREE.ColorManagement.enabled === true (the decode
//      only happens with management on, which is three's default).
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=.../three.module.js node test_lru_light_eviction.mjs
//
// If three can't be located, prints SKIP and exits 0 (mirrors the
// other lighting tests).

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
    console.log("B10 LRU-light-eviction ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=.../three.module.js node test_lru_light_eviction.mjs`");
    process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("B10 — SetupModel light eviction + sRGB color standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load lighting.js via closure-eval (strip THREE/csm/landblock_lru imports) ----
function loadLightingSrc() {
    const full = resolvePath(__dirname, "scene3d/lighting.js");
    let src = readFileSync(full, "utf8");
    src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
    src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/csm\.js["'];?\s*$/m, "");
    src = src.replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/landblock_lru\.js["'];?\s*$/m, "");
    return src;
}
function loadCsmSrc() {
    const full = resolvePath(__dirname, "scene3d/csm.js");
    let src = readFileSync(full, "utf8");
    src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
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
    stripExports(loadCsmSrc()) + "\n" +
    stripExports(loadLightingSrc()) + "\n" +
    "; return { buildLightForSetupLight, releaseLight };";
const lightingMod = new Function("THREE", composite)(THREE);
const { buildLightForSetupLight, releaseLight } = lightingMod;

// ---- load the REAL landblock_lru.js (zero-import leaf → direct ESM) ----
const lruMod = await import("file://" + resolvePath(__dirname, "scene3d/landblock_lru.js"));
const { LandblockLRU } = lruMod;

// =====================================================================
// Assert 1: releaseLight exported.
// =====================================================================
check(
    "B10 #6: lighting.js exports releaseLight",
    typeof releaseLight === "function",
    `typeof=${typeof releaseLight}`
);

// =====================================================================
// Assert 2: releaseLight is fail-soft + idempotent.
// =====================================================================
{
    const parent = new THREE.Object3D();
    const light = new THREE.PointLight(0xffffff, 1, 10);
    parent.add(light);
    const scene3d = { activeLights: [light] };
    let disposeCalls = 0;
    const origDispose = light.dispose?.bind(light);
    light.dispose = () => { disposeCalls += 1; if (origDispose) origDispose(); };

    releaseLight(scene3d, light);
    const firstOk =
        scene3d.activeLights.length === 0 &&
        light.parent === null &&
        disposeCalls === 1;
    // Second release: already spliced + detached. Must not throw, must
    // not blow up activeLights.
    let threw = false;
    try { releaseLight(scene3d, light); } catch (_) { threw = true; }
    // null light / null scene3d are no-ops.
    let nullThrew = false;
    try { releaseLight(null, null); releaseLight(scene3d, null); } catch (_) { nullThrew = true; }

    check(
        "B10 #6: releaseLight splices+detaches+disposes once, idempotent + fail-soft on null",
        firstOk && !threw && scene3d.activeLights.length === 0 && !nullThrew,
        `firstOk=${firstOk}, disposeCalls=${disposeCalls}, secondThrew=${threw}, nullThrew=${nullThrew}`
    );
}

// =====================================================================
// Assert 3: LRU evict splices/detaches/disposes a LB's tracked lights.
// =====================================================================
{
    const lbKeyA = (0xa9b40000) >>> 0;
    const lbKeyB = (0xa9b50000) >>> 0;

    // Mock scene3d: a worldRoot parent for the lights + an activeLights
    // array. No terrain/buildings/etc. groups — eviction tolerates their
    // absence (every section guards `if (s.x?.children)`).
    const parentA = new THREE.Object3D();
    const parentB = new THREE.Object3D();
    const activeLights = [];
    const scene3d = { activeLights };

    function makeLight(parent, lbKey) {
        const l = new THREE.PointLight(0xffaa55, 50, 12);
        l.userData = { __lbKey: lbKey, fromSetupModelLight: true };
        parent.add(l);
        activeLights.push(l);
        let disposed = 0;
        const orig = l.dispose?.bind(l);
        l.dispose = () => { disposed += 1; if (orig) orig(); };
        l.__disposedCount = () => disposed;
        return l;
    }

    const a1 = makeLight(parentA, lbKeyA);
    const a2 = makeLight(parentA, lbKeyA);
    const b1 = makeLight(parentB, lbKeyB);

    const lru = new LandblockLRU({
        scene3d,
        maxResident: 64,
        getCurrentLbId: () => null,
    });
    lru.track(lbKeyA, { lights: [a1, a2] });
    lru.track(lbKeyB, { lights: [b1] });

    // Evict A only.
    const ok = lru.evict(lbKeyA);

    const aGone =
        ok === true &&
        activeLights.indexOf(a1) === -1 &&
        activeLights.indexOf(a2) === -1 &&
        a1.parent === null &&
        a2.parent === null &&
        a1.__disposedCount() === 1 &&
        a2.__disposedCount() === 1 &&
        !lru.entries.has(lbKeyA);
    // B untouched.
    const bAlive =
        activeLights.indexOf(b1) !== -1 &&
        b1.parent === parentB &&
        b1.__disposedCount() === 0 &&
        lru.entries.has(lbKeyB);

    check(
        "B10 #6: evict(lbKeyA) splices+detaches+disposes A's lights, drops the key",
        aGone,
        `evictRet=${ok}, activeLen=${activeLights.length}, a1.parent=${a1.parent}, a1.disp=${a1.__disposedCount()}, hasA=${lru.entries.has(lbKeyA)}`
    );
    check(
        "B10 #6: evict(lbKeyA) leaves lbKeyB's light untouched",
        bAlive,
        `b1InActive=${activeLights.indexOf(b1) !== -1}, b1.parent===parentB=${b1.parent === parentB}, b1.disp=${b1.__disposedCount()}, hasB=${lru.entries.has(lbKeyB)}`
    );

    // Evict B → fully clears.
    lru.evict(lbKeyB);
    check(
        "B10 #6: evict(lbKeyB) clears the last light + activeLights empties",
        activeLights.length === 0 && b1.parent === null && b1.__disposedCount() === 1 && !lru.entries.has(lbKeyB),
        `activeLen=${activeLights.length}, b1.parent=${b1.parent}, b1.disp=${b1.__disposedCount()}`
    );
}

// =====================================================================
// Assert 4: track() stays back-compatible (omitting lights is fine, and
// a fresh entry still has the lights bucket).
// =====================================================================
{
    const scene3d = { activeLights: [] };
    const lru = new LandblockLRU({ scene3d, maxResident: 8, getCurrentLbId: () => null });
    let threw = false;
    try {
        lru.track(0x12340000); // no options at all
        lru.track(0x12340000, { geometries: [] }); // no lights key
    } catch (_) { threw = true; }
    const entry = lru.entries.get(0x12340000);
    check(
        "B10 #6: track() back-compatible — omitting lights is a no-op, lights bucket exists",
        !threw && entry && Array.isArray(entry.disposables.lights) && entry.disposables.lights.length === 0,
        `threw=${threw}, hasBucket=${!!entry && Array.isArray(entry?.disposables?.lights)}, len=${entry?.disposables?.lights?.length}`
    );
}

// =====================================================================
// Assert 5: #16 — sRGB light color decode.
// =====================================================================
check(
    "B10 #16: THREE.ColorManagement.enabled === true (sRGB decode is active)",
    THREE.ColorManagement.enabled === true,
    `enabled=${THREE.ColorManagement.enabled}`
);

{
    const mid = buildLightForSetupLight({
        partIndex: 0, x: 0, y: 0, z: 0,
        colorR: 0.5, colorG: 0.5, colorB: 0.5,
        intensity: 50, falloff: 10, coneAngle: 0,
    });
    // sRGB 0.5 decodes to ~0.2140 linear (NOT 0.5).
    const r = mid?.color?.r ?? -1;
    check(
        "B10 #16: buildLightForSetupLight(0.5,0.5,0.5) decodes sRGB→linear (color.r ≈ 0.214, NOT 0.5)",
        mid && Math.abs(r - 0.2140411) < 1e-3 && Math.abs(r - 0.5) > 0.1,
        `color.r=${r}`
    );

    const white = buildLightForSetupLight({
        partIndex: 0, x: 0, y: 0, z: 0,
        colorR: 1, colorG: 1, colorB: 1,
        intensity: 50, falloff: 10, coneAngle: 0,
    });
    check(
        "B10 #16: buildLightForSetupLight(1,1,1) stays (1,1,1) (sRGB white === linear white)",
        white && Math.abs(white.color.r - 1) < 1e-6 && Math.abs(white.color.g - 1) < 1e-6 && Math.abs(white.color.b - 1) < 1e-6,
        `color=(${white?.color?.r},${white?.color?.g},${white?.color?.b})`
    );
}

console.log("=========================");
if (failed > 0) {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
} else {
    console.log(`PASS: all ${passed} checks passed.`);
    process.exit(0);
}
