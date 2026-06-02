// Workstream B (2026-05-11) — standalone ESM test for the
// client-side prediction layer added to `scene3d/camera.js`. Drives a
// CameraSwitcher with:
//   - a mock `sessionHandle.getLocalPlayerPose()` returning a steady
//     heading
//   - a synthetic `__lastEntityWorldPos` map fed at 30 Hz to simulate
//     ACE's authoritative pose emit
// and verifies the 4 bullets from the spec (Workstream B verification):
//   1. Predicted pose advances smoothly when W is held (no per-frame
//      step discontinuity).
//   2. Predicted pose stays within ±2 m of authoritative pose under
//      steady-state walking.
//   3. Teleport (>5 m delta) snaps the predicted pose cleanly.
//   4. Releasing WASD stops the predicted advance within one rAF.
//
// This test exercises the load-bearing prediction path WITHOUT live
// ACE because Workstream D (3D-mode WASD reaching the integrator)
// is still pending. Synthetic `__lastEntityWorldPos` updates are
// pushed from the test harness to mimic what loop.js's dispatchOne
// will do post-D + the wasm 30 Hz emit landed in A. This is the
// approach (b) from the prompt's Verification section — temporary
// test-only harness, not shipped code.
//
// Run with: cd apps/holtburger-web/ && node test_workstream_b_prediction.mjs
// (Skips with code 0 if three is not locatable, matching the other
// tests' policy.)

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

// ---- locate `three` + addons ----------------------------------------
function locateThreeDir() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        const buildPath = process.env.THREE_PATH;
        const idx = buildPath.indexOf("/build/three.module.js");
        if (idx !== -1) return buildPath.slice(0, idx);
    }
    try {
        const idx = require.resolve("three");
        const i = idx.indexOf("/build/three.module.js");
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
const { OrbitControls } = await import(
    joinPath(threeDir, "examples/jsm/controls/OrbitControls.js")
);
const { PointerLockControls } = await import(
    joinPath(threeDir, "examples/jsm/controls/PointerLockControls.js")
);

console.log("Workstream B — prediction layer standalone ESM test");
console.log("=========================");

// ---- Load camera.js via the same closure-injection trick the
// existing test uses --------------------------------------------------
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src
        .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
        .replace(
            /^\s*import\s+\{\s*OrbitControls\s*\}\s+from\s+["']three\/addons\/controls\/OrbitControls\.js["'];?\s*$/m,
            ""
        )
        .replace(
            /^\s*import\s+\{\s*PointerLockControls\s*\}\s+from\s+["']three\/addons\/controls\/PointerLockControls\.js["'];?\s*$/m,
            ""
        )
        .replace(
            /^\s*import\s+\{\s*acToThree\s*\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m,
            "const acToThree = (ax, ay, az) => [ax, az, -ay];"
        );
    return src;
}

function stripExports(src) {
    return src
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const camSrc = loadModule("scene3d/camera.js");
const composite =
    "// === camera.js ===\n" + stripExports(camSrc) + "\n" +
    "; return { CameraSwitcher, CAMERA_MODES, createOrthoCamera };";

const factory = new Function(
    "THREE",
    "OrbitControls",
    "PointerLockControls",
    "performance",
    "window",
    "document",
    composite
);

// ---- Mock window/document with __lastEntityWorldPos surface ---------
// The prediction layer reads `window.__lastEntityWorldPos`,
// `window.getLocalPlayerGuid`, `window.liveScene3d`, and
// `window.__movementConstants`. Wire all four.
const TEST_GUID = 0x50000007;
const lastMap = new Map();
const fakeWindow = {
    // GAP 2 (2026-06-02): these bullets validate the LEGACY Workstream-B
    // independent-advance predictor (flat RUN_SPEED * dt). That path is
    // now off by default — pure-smoothing-toward-integrator is the
    // default that collapses the dual-predictor sawtooth. Opt this test
    // back into the legacy path explicitly; the pure-smoothing path has
    // its own coverage in test_pure_smooth_prediction.mjs.
    __predPureSmooth: false,
    __lastEntityWorldPos: lastMap,
    getLocalPlayerGuid: () => TEST_GUID,
    liveScene3d: null, // set after switcher constructs
    __movementConstants: {
        FALLBACK_RUN_RATE_SCALAR: 4.5,
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

const factoryEnv = factory(
    THREE,
    OrbitControls,
    PointerLockControls,
    globalThis.performance ?? { now: () => Date.now() },
    fakeWindow,
    fakeDoc
);
const { CameraSwitcher, createOrthoCamera } = factoryEnv;

// ---- Mock sessionHandle: returns a heading=0 (north-facing) pose ----
let mockPoseHeading = 0.0;
const mockSession = {
    setMovementInput(_f, _s, _t, _r) { /* noop */ },
    getLocalPlayerPose() {
        return {
            x: 100, y: 200, z: 80, // landblock-local; unused by advance
            heading: mockPoseHeading,
            landblockId: 0xa9b40000,
        };
    },
};

// ---- Mock canvas, perspective + ortho ------------------------------
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

// ---- Player-position resolver: returns the SAME thing the camera
// would normally see via cameraSwitcher.getPredictedPlayerWorldPos.
// For this test we just use the static start pose. ------------------
const PLAYER_POS_START = { x: 32544, y: 34656, z: 80 }; // Holtburg centre
const getPlayerWorldPos = () => PLAYER_POS_START;

// ---- Construct switcher --------------------------------------------
const switcher = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: fakeCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos,
});

// Now expose `liveScene3d` so entities.js's getLocalPlayerWorldPos
// could find the switcher (this test doesn't drive entities.js but
// we still expose it for completeness — also, this validates the
// flow that the spec wires).
fakeWindow.liveScene3d = { cameraSwitcher: switcher };

// ---- Seed __lastEntityWorldPos with an initial server pose ----------
function pushServerPose(x, y, z) {
    lastMap.set(TEST_GUID, {
        x, y, z,
        ts: performance.now(),
    });
}

pushServerPose(PLAYER_POS_START.x, PLAYER_POS_START.y, PLAYER_POS_START.z);

// First tick — should seed predicted pose to server pose (no lerp).
switcher.tick(0.016);
check(
    "Bullet seed: first tick seeds predictedPlayerPos from server pose",
    switcher.predictedPlayerPos !== null
    && Math.abs(switcher.predictedPlayerPos.x - PLAYER_POS_START.x) < 0.001
    && Math.abs(switcher.predictedPlayerPos.y - PLAYER_POS_START.y) < 0.001,
    `predicted=${JSON.stringify(switcher.predictedPlayerPos)}`
);

// ---- Bullet 1: predicted advances smoothly under W-hold -------------
// Drive 120 rAF ticks (~2 s @ 60 FPS) with W held. After each tick,
// the predicted x/y should change by approximately
// `RUN_SPEED * dt = 4.5 * 0.016 ≈ 0.072 m` (heading=0 → +Y motion).
// Verify monotonic Y advancement + per-frame delta bounded.
switcher.keys.w = true;
mockPoseHeading = 0.0; // facing +Y north
const positions = [];
positions.push({ t: 0, x: switcher.predictedPlayerPos.x, y: switcher.predictedPlayerPos.y });
const dt = 0.016; // 60 FPS

// Don't push server poses during this loop — verify pure prediction.
// (Will validate reconcile separately below.)
for (let i = 0; i < 120; i += 1) {
    switcher.tick(dt);
    positions.push({
        t: (i + 1) * dt * 1000,
        x: switcher.predictedPlayerPos.x,
        y: switcher.predictedPlayerPos.y,
    });
}

let maxStepY = 0;
let nonMonotonic = 0;
let prevY = positions[0].y;
for (let i = 1; i < positions.length; i += 1) {
    const dy = positions[i].y - prevY;
    if (dy < -0.001) nonMonotonic += 1;
    maxStepY = Math.max(maxStepY, Math.abs(dy));
    prevY = positions[i].y;
}
const totalAdvance = positions[positions.length - 1].y - positions[0].y;
// Expected = 4.5 m/s × 120 × 0.016 = 8.64 m
const expectedAdvance = 4.5 * 120 * dt;
check(
    "Bullet 1: predicted Y advances smoothly under W-hold (60 FPS)",
    nonMonotonic === 0
    && Math.abs(totalAdvance - expectedAdvance) < 0.01
    && maxStepY < 0.1, // each step ~0.072 m, allow some headroom
    `totalAdvance=${totalAdvance.toFixed(3)} m (expected ~${expectedAdvance.toFixed(3)}), `
    + `maxStepY=${maxStepY.toFixed(4)} m, nonMonotonic=${nonMonotonic}`
);

// ---- Bullet 2: predicted vs auth pose agree within ±2 m -------------
// Now run 10 s of W-hold with SYNTHETIC 30 Hz server pose pushes that
// match the predicted trajectory. Predicted should never drift more
// than ±2 m from server pose.
// The synthetic harness drives wall-clock via a monotonic counter so
// the server-emit cadence stays at 30 Hz regardless of how fast Node
// processes the for-loop. loop.js's real path stamps each pose with
// performance.now(), which in the browser advances naturally between
// rAF callbacks (16 ms each at 60 FPS). Here we synthesise the same
// advance by passing an explicit `ts` to a pose-pusher helper and
// having the prediction layer use that ts via the .ts field. The
// reconcile path keys off `ts > lastReconcileTs`, so passing strictly
// increasing `ts` values from the test is equivalent to time
// advancing in a real browser session.
function pushServerPoseAtTs(x, y, z, ts) {
    lastMap.set(TEST_GUID, { x, y, z, ts });
}

switcher.keys.w = true;
switcher.predictedPlayerPos = null; // reset
switcher._predLastTickMs = null;
lastMap.clear();
let simT = 1000.0; // synthetic wall-clock (ms), arbitrary start
pushServerPoseAtTs(PLAYER_POS_START.x, PLAYER_POS_START.y, PLAYER_POS_START.z, simT);
switcher.tick(0.016);

const SIM_S = 10.0;
const FRAMES = Math.floor(SIM_S / dt);
const SERVER_HZ = 30.0;
const SERVER_PERIOD_MS = 1000.0 / SERVER_HZ;
let nextServerEmit = simT;
let serverY = PLAYER_POS_START.y;
let maxDelta = 0;
let serverEmits = 0;
const RUN_SPEED = 4.5;

for (let i = 0; i < FRAMES; i += 1) {
    simT += dt * 1000.0;
    // Tick the server at 30 Hz on the synthetic clock — advance its
    // pose by (running) speed each tick, then push.
    while (simT >= nextServerEmit) {
        serverY += RUN_SPEED * (SERVER_PERIOD_MS / 1000.0);
        pushServerPoseAtTs(
            PLAYER_POS_START.x, serverY, PLAYER_POS_START.z,
            nextServerEmit
        );
        nextServerEmit += SERVER_PERIOD_MS;
        serverEmits += 1;
    }
    switcher.tick(dt);
    const pred = switcher.predictedPlayerPos;
    const delta = Math.abs(pred.y - serverY);
    maxDelta = Math.max(maxDelta, delta);
}

check(
    "Bullet 2: predicted vs auth pose stay within ±2 m over 10s W-hold",
    maxDelta < 2.0,
    `maxDelta=${maxDelta.toFixed(3)} m over ${SIM_S}s (server emits=${serverEmits})`
);

// ---- Bullet 3: teleport (>5 m) snaps predicted cleanly ------------
switcher.keys.w = false; // stop walking first
switcher.tick(dt);
// Snapshot predicted just before teleport.
const preTeleportY = switcher.predictedPlayerPos.y;
// Push a server pose 100 m away (using a strictly-greater synthetic ts
// so reconcile fires regardless of how fast Node ran the previous
// statements).
simT += 100.0;
pushServerPoseAtTs(PLAYER_POS_START.x, preTeleportY + 100.0, PLAYER_POS_START.z, simT);
switcher.tick(dt);
const postTeleport = switcher.predictedPlayerPos.y;
check(
    "Bullet 3: 100 m teleport snaps predicted pose cleanly (no lerp)",
    Math.abs(postTeleport - (preTeleportY + 100.0)) < 0.001
    && switcher._lerpRemainingMs === 0.0,
    `pred Δ=${(postTeleport - preTeleportY).toFixed(3)} m (expected 100.000), `
    + `lerpRemaining=${switcher._lerpRemainingMs}`
);

// ---- Bullet 4: releasing WASD stops advancing within 1 rAF ----------
// Run a few ticks under W-hold with NO new server poses, so any
// in-flight lerp drains and we measure pure prediction advance vs
// release. Then drop W and assert the next tick advances < 1 mm.
switcher.keys.w = true;
// Drain any latent lerp first (a few ticks should fully resolve
// 150 ms of duration at dt=16 ms each).
for (let i = 0; i < 12; i += 1) {
    switcher.tick(dt);
}
const beforeRelease = switcher.predictedPlayerPos.y;
switcher.tick(dt); // one tick under W-hold (no new server pose)
const advancedDuringHold = switcher.predictedPlayerPos.y - beforeRelease;
// Release W and tick once more.
switcher.keys.w = false;
const beforeRelTick = switcher.predictedPlayerPos.y;
switcher.tick(dt); // one tick after release (no new server pose, no lerp)
const afterReleaseTick = switcher.predictedPlayerPos.y;
const advancedAfterRelease = Math.abs(afterReleaseTick - beforeRelTick);
check(
    "Bullet 4: predicted pose stops advancing within 1 rAF tick after W release",
    advancedAfterRelease < 0.001 && advancedDuringHold > 0.01,
    `advancedDuringHold=${advancedDuringHold.toFixed(4)} m, `
    + `advancedAfterRelease=${advancedAfterRelease.toFixed(4)} m`
);

// ---- Bullet getPredictedPlayerWorldPos surface --------------------
const exported = switcher.getPredictedPlayerWorldPos();
check(
    "API: getPredictedPlayerWorldPos returns {x, y, z}",
    exported !== null
    && typeof exported.x === "number"
    && typeof exported.y === "number"
    && typeof exported.z === "number",
    `exported=${JSON.stringify(exported)}`
);

// ---- Bullet heading vector — verify east (π/2) → +X motion ------
switcher.predictedPlayerPos = null;
lastMap.clear();
pushServerPose(PLAYER_POS_START.x, PLAYER_POS_START.y, PLAYER_POS_START.z);
switcher.tick(0.016); // seed
mockPoseHeading = Math.PI / 2; // facing +X east
switcher.keys.w = true;
const xBefore = switcher.predictedPlayerPos.x;
const yBefore = switcher.predictedPlayerPos.y;
for (let i = 0; i < 60; i += 1) switcher.tick(dt);
const xAfter = switcher.predictedPlayerPos.x;
const yAfter = switcher.predictedPlayerPos.y;
check(
    "Heading: heading=π/2 (east) → predicted advances +X, not +Y",
    (xAfter - xBefore) > 4.0 && Math.abs(yAfter - yBefore) < 0.5,
    `Δx=${(xAfter - xBefore).toFixed(3)} m, Δy=${(yAfter - yBefore).toFixed(3)} m`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Workstream B prediction checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
