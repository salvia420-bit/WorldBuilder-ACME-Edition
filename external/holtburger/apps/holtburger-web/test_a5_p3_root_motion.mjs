// A5-P3 (2026-06-12, W3+ S13) — standalone ESM test for the
// `?rootMotionObject=1` JS consumer:
//
//   1. `hasRootMotion` significance-predicate truth table.
//   2. AnimationCache snapshot: fake animData with/without `rootMotionNet`
//      → entry carries Float32Array(7) / null (fail-soft for older wasm).
//   3. `_applyRootMotionToAnchor` apply unit: object-local translation
//      `d = R_root·(s·T)` + quat post-multiply; freshness gate (skip when
//      a KIND_POSITION landed mid-clip); airborne gate (translation
//      skipped, rotation applied); dead-reckon target co-move.
//   4. `_armRootMotionOnFinish`: spam re-arm applies exactly once per
//      completed play; interrupted (no `finished`) applies nothing.
//   5. Local-player guid is excluded by the `_tryPlayLink` arm gate
//      (`_isLocalPlayerGuid` leg verified directly).
//
// Run with:  cd apps/holtburger-web/ && node test_a5_p3_root_motion.mjs
// Same three-locating + module-splicing pattern as
// `test_phase7_4b_entity_pipeline.mjs` (bypasses bare-specifier `three`).
// SKIPs (exit 0) when `three` can't be located.

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
    const candidates = [];
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
    console.log("A5-P3 root-motion ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_a5_p3_root_motion.mjs`");
    process.exit(0);
}

const threeMod = await import("file://" + threePath);
// three may resolve to the CJS build (`three.cjs`) — named exports land
// on the namespace via cjs-module-lexer, but fall back to .default.
const THREE = threeMod.Object3D ? threeMod : (threeMod.default ?? threeMod);

console.log("A5-P3 — root-motion metadata consumer standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- splice modules (pattern of test_phase7_4b) ----------------------
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    if (!existsSync(full)) {
        throw new Error(`module not found: ${full}`);
    }
    let src = readFileSync(full, "utf8");
    src = src
        .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
        // Strip relative `import { … } from "./X.js"` / "../ui/X.js" lines —
        // we splice the modules we need by hand instead.
        .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\.?\/[^"']+["'];?\s*$/gm, "")
        // Strip bare relative side-effect imports `import "./X.js";` (e.g. the VFX
        // component barrel that self-registers components). The eval sandbox does
        // not need the side effect; spliced deps are shimmed by hand below.
        .replace(/^\s*import\s+["']\.\.?\/[^"']+["'];?\s*$/gm, "");
    return src;
}

function stripExports(src) {
    return src
        .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const composite =
    // Shims for imported symbols entities.js calls at module top level
    // (setup_rig.js's flag reader) — the splice deliberately omits that
    // module; flags read false in the Node harness anyway (no window).
    "function readRigModuleFlag() { return false; }\n" +
    "// === adapter.js ===\n" + stripExports(loadModule("scene3d/adapter.js")) + "\n" +
    "// === animation.js ===\n" + stripExports(loadModule("scene3d/animation.js")) + "\n" +
    "// === entities.js ===\n" + stripExports(loadModule("scene3d/entities.js")) + "\n" +
    "; return { EntityManager, AnimationCache, hasRootMotion, acQuatToThree };";

const factory = new Function("THREE", "performance", "window", composite);

// Fake window: per-guid KIND_POSITION stamp map + local-player guid hook.
const GUID = 0x71001234 >>> 0;
const LOCAL_GUID = 0x50000001 >>> 0;
const fakeWindow = {
    __lastEntityWorldPos: new Map(),
    getLocalPlayerGuid: () => LOCAL_GUID,
};
const { EntityManager, AnimationCache, hasRootMotion, acQuatToThree } = factory(
    THREE,
    globalThis.performance ?? { now: () => Date.now() },
    fakeWindow,
);

const close = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

// ---- 1. hasRootMotion truth table -------------------------------------
console.log("[1] hasRootMotion predicate");
check("null → false", hasRootMotion(null) === false);
check("undefined → false", hasRootMotion(undefined) === false);
check("empty vec → false", hasRootMotion(new Float32Array(0)) === false);
check("wrong length (3) → false", hasRootMotion([1, 2, 3]) === false);
check("identity 7-vec → false", hasRootMotion([0, 0, 0, 1, 0, 0, 0]) === false);
check(
    "tiny-eps translation → false",
    hasRootMotion([5e-5, 0, 0, 1, 0, 0, 0]) === false,
);
check(
    "translation-only → true",
    hasRootMotion([0.1, 0, 0, 1, 0, 0, 0]) === true,
);
{
    // rotation-only: angle 0.02 rad (> 1e-3) about Z.
    const h = 0.01;
    check(
        "rotation-only → true",
        hasRootMotion([0, 0, 0, Math.cos(h), 0, 0, Math.sin(h)]) === true,
    );
}

// ---- 2. cache snapshot -------------------------------------------------
console.log("[2] AnimationCache rootMotionNet snapshot");
{
    const cache = new AnimationCache();
    const mkFetch = (net) => async () => ({
        partCount: 0,
        numFrames: 0,
        framerate: 0,
        resolvedStance: 0,
        duration: 0,
        ...(net !== undefined ? { rootMotionNet: net } : {}),
    });
    const withNet = await cache.get(0x02000001, 0x09000001, 0x11, 0, mkFetch([1, 2, 3, 1, 0, 0, 0]));
    check(
        "7-vec → Float32Array(7) snapshot",
        withNet.rootMotionNet instanceof Float32Array &&
            withNet.rootMotionNet.length === 7 &&
            close(withNet.rootMotionNet[0], 1) &&
            close(withNet.rootMotionNet[2], 3),
    );
    const withoutNet = await cache.get(0x02000002, 0x09000001, 0x11, 0, mkFetch(undefined));
    check("getter absent (old wasm) → null", withoutNet.rootMotionNet === null);
    const emptyNet = await cache.get(0x02000003, 0x09000001, 0x11, 0, mkFetch(new Float32Array(0)));
    check("empty vec (no cycle) → null", emptyNet.rootMotionNet === null);
}

// ---- 3 + 4. apply unit + arm/finished ----------------------------------
console.log("[3] _applyRootMotionToAnchor");

function makeMixer() {
    const listeners = new Set();
    return {
        addEventListener(type, fn) { if (type === "finished") listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); },
        dispatchFinished(action) {
            for (const fn of [...listeners]) fn({ action });
        },
        listenerCount: () => listeners.size,
    };
}

function makeInst(guid) {
    const root = new THREE.Object3D();
    return {
        guid,
        root,
        mixer: makeMixer(),
        _isAirborne: false,
        airborneTilt: null,
        _serverTargetPos: new THREE.Vector3(0, 0, 0),
        _serverTargetQuat: new THREE.Quaternion(),
    };
}

function makeCtx(inst) {
    return {
        _rootMotionObjectOn: true,
        entityMap: new Map([[inst.guid >>> 0, inst]]),
        _isLocalPlayerGuid: EntityManager.prototype._isLocalPlayerGuid,
        _armRootMotionOnFinish: EntityManager.prototype._armRootMotionOnFinish,
        _applyRootMotionToAnchor: EntityManager.prototype._applyRootMotionToAnchor,
    };
}

const yawZ = (rad) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad);

{
    // Object-local compose: root pre-rotated yaw90(Z), scale 2; net T=(1,0,0)
    // → d = R_root·(s·T) = yaw90·(2,0,0) = (0,2,0). Net quat = yaw90 (AC
    // w-first [w,x,y,z] = [cos45, 0, 0, sin45]) post-multiplies.
    const inst = makeInst(GUID);
    inst.root.quaternion.copy(yawZ(Math.PI / 2));
    inst.root.scale.setScalar(2);
    const ctx = makeCtx(inst);
    fakeWindow.__lastEntityWorldPos.set(GUID, { x: 0, y: 0, z: 0, ts: 42 });
    const h = Math.PI / 4;
    const net = [1, 0, 0, Math.cos(h), 0, 0, Math.sin(h)];
    ctx._applyRootMotionToAnchor(inst, net, 42);
    check(
        "translation d = R_root·(s·T)",
        close(inst.root.position.x, 0) && close(inst.root.position.y, 2) && close(inst.root.position.z, 0),
        `got (${inst.root.position.x.toFixed(4)}, ${inst.root.position.y.toFixed(4)}, ${inst.root.position.z.toFixed(4)})`,
    );
    check(
        "dead-reckon target co-moved",
        close(inst._serverTargetPos.y, 2),
    );
    const expectedQ = yawZ(Math.PI / 2).multiply(acQuatToThree(net[3], net[4], net[5], net[6]));
    check(
        "rotation post-multiplied object-local",
        close(Math.abs(inst.root.quaternion.dot(expectedQ)), 1, 1e-5),
    );
    check(
        "heading target co-rotated",
        close(Math.abs(inst._serverTargetQuat.dot(acQuatToThree(net[3], net[4], net[5], net[6]))), 1, 1e-5),
    );
    check("diag ledger written", inst._appliedRootMotion?.count === 1);
}

{
    // Freshness gate: server KIND_POSITION landed mid-clip (ts changed).
    const inst = makeInst(GUID);
    const ctx = makeCtx(inst);
    fakeWindow.__lastEntityWorldPos.set(GUID, { x: 0, y: 0, z: 0, ts: 99 });
    ctx._applyRootMotionToAnchor(inst, [1, 0, 0, 1, 0, 0, 0], 42);
    check(
        "freshness gate skips entirely (translation AND rotation)",
        close(inst.root.position.length(), 0) && close(inst.root.quaternion.w, 1),
    );
}

{
    // Airborne gate: translation skipped, rotation still applied
    // (retail zeroes only m_fOrigin — acclient.c:320020-320026).
    const inst = makeInst(GUID);
    inst._isAirborne = true;
    const ctx = makeCtx(inst);
    fakeWindow.__lastEntityWorldPos.set(GUID, { x: 0, y: 0, z: 0, ts: 7 });
    const h = Math.PI / 4;
    ctx._applyRootMotionToAnchor(inst, [1, 0, 0, Math.cos(h), 0, 0, Math.sin(h)], 7);
    check("airborne skips translation", close(inst.root.position.length(), 0));
    check(
        "airborne still applies rotation",
        close(Math.abs(inst.root.quaternion.dot(yawZ(Math.PI / 2))), 1, 1e-5),
    );
}

{
    // Disposed entity / flag-off bails.
    const inst = makeInst(GUID);
    const ctx = makeCtx(inst);
    ctx.entityMap.delete(GUID);
    fakeWindow.__lastEntityWorldPos.set(GUID, { ts: 7 });
    ctx._applyRootMotionToAnchor(inst, [1, 0, 0, 1, 0, 0, 0], 7);
    check("disposed entity bails", close(inst.root.position.length(), 0));
    const inst2 = makeInst(GUID);
    const ctx2 = makeCtx(inst2);
    ctx2._rootMotionObjectOn = false;
    ctx2._applyRootMotionToAnchor(inst2, [1, 0, 0, 1, 0, 0, 0], 7);
    check("flag off bails", close(inst2.root.position.length(), 0));
}

console.log("[4] _armRootMotionOnFinish (spam re-arm, interrupt)");
{
    const inst = makeInst(GUID);
    const ctx = makeCtx(inst);
    fakeWindow.__lastEntityWorldPos.set(GUID, { x: 0, y: 0, z: 0, ts: 5 });
    const action = { name: "fake-overlay" };
    const net = [1, 0, 0, 1, 0, 0, 0];
    // Spam re-arm: three plays before one completion.
    ctx._armRootMotionOnFinish(inst, action, net);
    ctx._armRootMotionOnFinish(inst, action, net);
    ctx._armRootMotionOnFinish(inst, action, net);
    check("re-arm does not stack listeners", inst.mixer.listenerCount() === 1);
    inst.mixer.dispatchFinished(action);
    check(
        "one completed play applies exactly once",
        close(inst.root.position.x, 1) && close(inst.root.position.y, 0),
        `got x=${inst.root.position.x}`,
    );
    check("listener removed after finish", inst.mixer.listenerCount() === 0);
    check("pending cleared", inst._pendingRootMotion === null);
    // Other-action finished events don't trigger the apply.
    ctx._armRootMotionOnFinish(inst, action, net);
    inst.mixer.dispatchFinished({ name: "different" });
    check(
        "other action's finished ignored (interrupt = no apply)",
        close(inst.root.position.x, 1) && inst.mixer.listenerCount() === 1,
    );
    // Re-arm REFRESHES poseTs: stamp moved, re-arm picks it up → applies.
    fakeWindow.__lastEntityWorldPos.set(GUID, { x: 0, y: 0, z: 0, ts: 6 });
    ctx._armRootMotionOnFinish(inst, action, net); // refresh path
    inst.mixer.dispatchFinished(action);
    check(
        "re-arm refreshes captured poseTs",
        close(inst.root.position.x, 2),
        `got x=${inst.root.position.x}`,
    );
}

console.log("[5] local-player exclusion (arm-gate leg)");
{
    // The _tryPlayLink arm gate is
    //   flag && hasRootMotion(net) && !this._isLocalPlayerGuid(guid)
    // — verify the _isLocalPlayerGuid leg against the fake window's
    // getLocalPlayerGuid so the local rig is never armed.
    const isLocal = EntityManager.prototype._isLocalPlayerGuid;
    check("local guid detected", isLocal.call({}, LOCAL_GUID) === true);
    check("remote guid passes", isLocal.call({}, GUID) === false);
}

console.log("=========================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
