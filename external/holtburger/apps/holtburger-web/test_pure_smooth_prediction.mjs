// GAP 2 (2026-06-02) — standalone ESM test for the pure-smoothing
// prediction path added to `scene3d/camera.js` (`_smoothToIntegrator`).
//
// Pure-smoothing collapses the dual-predictor sawtooth (Dimension 5 of
// newprompts/physics-deep-dive-2026-06-01/verified-comparison-report.md):
// instead of independently advancing rendered X/Y at a flat RUN_SPEED
// (the legacy Workstream-B path, validated separately in
// test_workstream_b_prediction.mjs), the JS layer eases the rendered
// pose toward the authoritative Rust integrator pose
// (`getLocalPlayerPose()` converted landblock-local → world) every frame.
//
// This test drives a CameraSwitcher with a MOVING mock integrator pose
// and asserts:
//   1. First tick seeds predicted pose from the integrator world pose.
//   2. Under a steadily-advancing integrator, predicted X/Y CONVERGE on
//      the integrator (small bounded lag) and NEVER overrun it — the
//      structural fix for the forward-bias sawtooth.
//   3. A landblock-ID change hard-snaps the predicted pose (teleport).
//   4. The `window.__predPureSmooth === false` lever falls back to the
//      legacy independent-advance path.
//
// Run with: node apps/holtburger-web/test_pure_smooth_prediction.mjs
// (Skips with code 0 if three is not locatable, matching sibling tests.)

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

function locateThreeDir() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        const buildPath = process.env.THREE_PATH;
        const idx = buildPath.indexOf("/build/three.module.js");
        if (idx !== -1) return buildPath.slice(0, idx);
    }
    // App's own declared dependency first (2026-10-05) — require.resolve
    // yields build/three.cjs here, and the npx fallback ships no examples/jsm.
    const appThree = joinPath(__dirname, "node_modules", "three");
    if (existsSync(joinPath(appThree, "build/three.module.js"))) return appThree;
    try {
        const idx = require.resolve("three");
        const i = idx.search(/\/build\/three\.(module\.js|cjs)$/);
        if (i !== -1) return idx.slice(0, i);
    } catch (_) {}
    const candidates = [
        "/tmp/three-test/node_modules/three",
        joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

const threeDir = locateThreeDir();
if (!threeDir) {
    console.log("SKIP: cannot locate three.module.js — set THREE_PATH.");
    process.exit(0);
}
console.log(`three loaded from: ${threeDir}`);

const THREE = await import(joinPath(threeDir, "build/three.module.js"));
console.log("GAP 2 — pure-smoothing prediction path standalone ESM test");
console.log("=========================");

// 2026-10-05 — camera.js is IMPORTED as a real ES module (it grew imports
// the old hand-rolled splice never learned; the suite died on load). The
// window/document shims are installed as globals before the import.
// ---- Mock window/document. Pure-smoothing reads only
// `window.getLocalPlayerGuid` (indirectly), `window.__predPureSmooth`
// (the A/B lever), and the integrator pose via the session handle. -----
const TEST_GUID = 0x50000007;
const lastMap = new Map();
const fakeWindow = {
    // default (undefined) == pure-smoothing on; set explicitly for clarity.
    __predPureSmooth: undefined,
    __lastEntityWorldPos: lastMap,
    getLocalPlayerGuid: () => TEST_GUID,
    liveScene3d: null,
    __movementConstants: {
        // 2026-07-27: renamed from `FALLBACK_RUN_RATE_SCALAR` — the 4.5 is the
        // base RUN forward speed in m/s, not the dimensionless run-rate scalar
        // (which Rust seeds to 1.0). Same effective 4.5 m/s: the mock session
        // has no `player_run_rate()`, so camera.js uses the 1.0 scalar seed.
        BASE_RUN_FORWARD_SPEED: 4.5,
        WALK_FORWARD_SPEED: 1.0,
        RUN_HELD_TURN_SPEED_RAD_PER_SEC: 1.5,
        NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC: 1.0,
        SPRITE_HEADING_OFFSET: Math.PI / 2,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
};
const fakeDoc = {
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
};

globalThis.window = fakeWindow;
globalThis.document = fakeDoc;
const factoryEnv = await import("./scene3d/camera.js");
const { CameraSwitcher, createOrthoCamera } = factoryEnv;

// ---- Mock integrator: a MOVING landblock-local pose. The integrator
// advances `localY` each tick (simulating the authoritative Rust
// integrator stepping forward). Pure-smoothing converts (localX, localY,
// landblockId) → world coords identically to loop.js. -----------------
// LB id high bytes (0xa9, 0xb4) are the landblock X/Y the camera decodes
// into world coords (lbX*192 + localX); the test drives via lbId directly.
const LB_ID = 0xa9b40000;
let localX = 100.0;
let localY = 50.0;
let lbId = LB_ID;
const mockSession = {
    setMovementInput() { /* noop */ },
    getLocalPlayerPose() {
        return {
            x: localX, y: localY, z: 80,
            heading: 0.0,
            landblockId: lbId,
        };
    },
};
const worldX = () => ((lbId >>> 24) & 0xff) * 192.0 + localX;
const worldY = () => ((lbId >>> 16) & 0xff) * 192.0 + localY;

const fakeCanvas = {
    addEventListener: () => {},
    removeEventListener: () => {},
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    style: {},
    ownerDocument: {
        addEventListener: () => {},
        removeEventListener: () => {},
        body: {
            addEventListener: () => {},
            removeEventListener: () => {},
            style: {},
            requestPointerLock: () => {},
        },
        pointerLockElement: null,
        exitPointerLock: () => {},
    },
    requestPointerLock: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getRootNode() { return this.ownerDocument; },
    getBoundingClientRect: () => ({
        left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
    }),
};

const persp = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
const ortho = createOrthoCamera(fakeCanvas);
const getPlayerWorldPos = () => ({ x: worldX(), y: worldY(), z: 80 });

const switcher = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: fakeCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos,
});
fakeWindow.liveScene3d = { cameraSwitcher: switcher };

const dt = 1 / 60;

// ---- Bullet 1: first tick seeds predicted from integrator world pose --
switcher.tick(dt);
check(
    "Bullet 1: first tick seeds predictedPlayerPos from integrator world pose",
    switcher.predictedPlayerPos !== null
    && Math.abs(switcher.predictedPlayerPos.x - worldX()) < 0.001
    && Math.abs(switcher.predictedPlayerPos.y - worldY()) < 0.001,
    `predicted=${JSON.stringify(switcher.predictedPlayerPos)}, `
    + `world=(${worldX()}, ${worldY()})`
);

// ---- Bullet 2: under a steadily-advancing integrator, predicted Y
// converges on integrator Y with a small bounded lag and NEVER overruns
// it. The legacy bug overran (predicted ahead of authoritative); the
// pure-smoothing ease can only lag-and-converge — the structural fix. --
const RUN_MS = 4.0; // integrator advances 4 m/s forward (real run rate-ish)
let maxOverrun = -Infinity; // predicted - integrator; must stay <= ~0
let everConverged = false;
for (let i = 0; i < 600; i += 1) { // ~10 s
    localY += RUN_MS * dt; // integrator steps forward
    switcher.tick(dt);
    const lag = worldY() - switcher.predictedPlayerPos.y; // integrator - predicted
    const overrun = -lag; // predicted - integrator
    if (overrun > maxOverrun) maxOverrun = overrun;
    if (Math.abs(lag) < 0.2) everConverged = true;
}
// Steady-state lag of an exp ease toward a v·t ramp is ~v·tau =
// 4.0 * 0.150 = ~0.6 m. So predicted trails by a small fixed amount and
// never gets ahead (overrun must be ~0 or negative — tiny float epsilon
// allowed).
check(
    "Bullet 2: predicted never overruns the integrator (no forward-bias sawtooth)",
    maxOverrun < 0.01,
    `maxOverrun=${maxOverrun.toFixed(4)} m (must be < 0.01)`
);
const finalLag = worldY() - switcher.predictedPlayerPos.y;
check(
    "Bullet 2b: predicted tracks the integrator at a small bounded lag",
    everConverged === false ? finalLag > 0 && finalLag < 1.5 : finalLag < 1.5,
    `finalLag=${finalLag.toFixed(4)} m (steady-state ~v*tau ≈ 0.6 m)`
);

// ---- Bullet 3: landblock crossing hard-snaps. Bump the LB id and the
// local coords; the world delta jumps ~192 m and must snap, not ease. --
const beforeSnapX = switcher.predictedPlayerPos.x;
lbId = 0xa9b50000; // +1 in the LB-Y byte → +192 m in world Y
localY = 10.0;
switcher.tick(dt);
const snapped =
    Math.abs(switcher.predictedPlayerPos.x - worldX()) < 0.001
    && Math.abs(switcher.predictedPlayerPos.y - worldY()) < 0.001;
check(
    "Bullet 3: landblock-ID change hard-snaps predicted pose (teleport feel)",
    snapped,
    `predicted=(${switcher.predictedPlayerPos.x.toFixed(2)}, `
    + `${switcher.predictedPlayerPos.y.toFixed(2)}), `
    + `world=(${worldX().toFixed(2)}, ${worldY().toFixed(2)}), `
    + `beforeSnapX=${beforeSnapX.toFixed(2)}`
);

// ---- Bullet 4: the RETIRED legacy independent-advance predictor, called
// DIRECTLY. As of 2026-06-29 it is no longer reachable via tick()
// (camera.js tick() always mirrors the integrator); the methods are
// retained, so we exercise them directly here. With NO new server pose in
// __lastEntityWorldPos and W held, the legacy path advances at RUN_SPEED*dt
// while pure-smoothing would ease toward the (static) integrator pose. Seed
// a server pose so the legacy reconcile has an anchor, hold W, assert it
// advances. -------------
const legacyPredictTick = (d) => {
    switcher._reconcilePrediction();
    switcher._advancePrediction(d);
    switcher._applyPredictionLerp(d);
};
switcher.predictedPlayerPos = null;
switcher._predPrevLandblockId = null;
lastMap.set(TEST_GUID, { x: worldX(), y: worldY(), z: 80, ts: performance.now() });
legacyPredictTick(dt); // legacy seed
switcher.keys.w = true;
switcher.keys.shift = false; // run
const yBeforeLegacy = switcher.predictedPlayerPos.y;
legacyPredictTick(dt); // skipped — first advance tick has no dt baseline
legacyPredictTick(dt); // legacy advance: RUN_SPEED * dt along heading=0 (+Y)
const legacyAdvance = switcher.predictedPlayerPos.y - yBeforeLegacy;
check(
    "Bullet 4: retired legacy predictor (called directly) independent-advances",
    legacyAdvance > 0.05, // ~4.5 * 1/60 ≈ 0.075 m per advancing tick
    `legacyAdvance=${legacyAdvance.toFixed(4)} m (expected ~0.075)`
);

console.log("=========================");
if (failed === 0) {
    console.log(`ALL PASS (${passed} checks)`);
    process.exit(0);
} else {
    console.log(`FAILED: ${failed} check(s), ${passed} passed`);
    process.exit(1);
}
