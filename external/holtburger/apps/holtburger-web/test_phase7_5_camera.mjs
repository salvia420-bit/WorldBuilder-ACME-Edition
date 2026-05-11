// Phase 7.5 — standalone ESM test for `scene3d/camera.js`. Loads
// three.js + the OrbitControls / PointerLockControls addons by
// rewriting `import * as THREE from "three"` + `import ... from
// "three/addons/..."` into closure-captured references (same trick
// the 7.4a/7.4b tests use). Drives a CameraSwitcher with a mock
// `sessionHandle.setMovementInput` recorder + verifies the
// camera-relative WASD math at yaw=0 and yaw=π/2.
//
// The load-bearing assertion: at yaw=π/2, pressing W (intent
// forward) should NOT produce setMovementInput(forward=+1, strafe=0)
// — it should produce setMovementInput(forward=0, strafe=+1)
// because the camera is now facing east, and pressing forward means
// "move east", which is `strafe=+1` in the world-fixed (camera-
// rotated) convention.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_phase7_5_camera.mjs
//
// If three or the controls addons can't be located, the test prints
// SKIP and exits 0 (the smoke regex check is the mandatory floor).

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
        // THREE_PATH points at build/three.module.js — derive the
        // package root.
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
        if (existsSync(joinPath(c, "build/three.module.js"))) return c;
    }
    return null;
}

const threeDir = locateThreeDir();
if (!threeDir) {
    console.log("Phase 7.5 camera ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_phase7_5_camera.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + joinPath(threeDir, "build/three.module.js");
const orbitUrl = "file://" + joinPath(threeDir, "examples/jsm/controls/OrbitControls.js");
const plcUrl = "file://" + joinPath(threeDir, "examples/jsm/controls/PointerLockControls.js");

if (!existsSync(joinPath(threeDir, "examples/jsm/controls/OrbitControls.js"))) {
    console.log("Phase 7.5 camera ESM test: SKIP (OrbitControls.js not found in three install).");
    console.log(`  searched: ${joinPath(threeDir, "examples/jsm/controls/")}`);
    process.exit(0);
}

const THREE = await import(threeUrl);
const { OrbitControls } = await import(orbitUrl);
const { PointerLockControls } = await import(plcUrl);

console.log("Phase 7.5 — camera switcher standalone ESM test");
console.log(`three loaded from: ${threeDir}`);
console.log("=========================");

// ---- load camera.js with closure-captured THREE + addons ------------
// scene3d/camera.js imports `* as THREE from "three"` plus the two
// addons. We rewrite those imports out and inject the captures via a
// function closure — same pattern as test_phase7_4b_entity_pipeline.mjs.
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

// Provide minimal performance + window + document shims. Node has
// performance.now() natively. window/document need just enough
// surface for the listener installers — `addEventListener` /
// `removeEventListener` no-ops + `activeElement: null`.
const noopListener = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
const fakeDoc = {
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
};
const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
};
const factoryEnv = factory(
    THREE,
    OrbitControls,
    PointerLockControls,
    globalThis.performance ?? { now: () => Date.now() },
    fakeWindow,
    fakeDoc
);
const { CameraSwitcher, CAMERA_MODES, createOrthoCamera } = factoryEnv;

// ---- Mock sessionHandle that records calls --------------------------
const calls = [];
const mockSession = {
    setMovementInput(forward, strafe, turn, run) {
        calls.push({ forward, strafe, turn, run });
    },
};

// Mock canvas-like domElement. PointerLockControls + OrbitControls
// both call `.ownerDocument.removeEventListener` in their constructors
// — without ownerDocument, they throw. Wire a fake ownerDocument that
// silences the throw so we can exercise the mode switch without
// dragging in a full DOM polyfill.
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

// Mock perspective camera + ortho.
const persp = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
const ortho = createOrthoCamera(fakeCanvas);

// Player position resolver returns a fixed Holtburg-ish coord.
const PLAYER_POS = { x: 100, y: 200, z: 80 };
const getPlayerWorldPos = () => PLAYER_POS;

// Construct the switcher.
const switcher = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: fakeCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos,
});

// ---- Assert 1: initial mode is follow -------------------------------
check(
    "Phase 7.5: initial mode is 'follow'",
    switcher.mode === "follow",
    `mode=${switcher.mode}`
);

// ---- Assert 2: activeCamera is perspective in follow mode -----------
check(
    "Phase 7.5: activeCamera is perspective in follow mode",
    switcher.activeCamera === persp,
    `activeCamera === persp? ${switcher.activeCamera === persp}`
);

// ---- Helper to drive a tick with a specific keystate + yaw ----------
function driveTick(keys, yaw, dt = 0.016) {
    Object.assign(switcher.keys, keys);
    switcher.followYaw = yaw;
    calls.length = 0;
    switcher.tick(dt);
}

// ---- Assert 3: W with followYaw=0 → setMovementInput(+1, 0, 0, run) -
// At yaw=0, camera faces +Y (north). Pressing W should move the
// player north, which in world-fixed coords is forward=+1, strafe=0.
driveTick({ w: true, a: false, s: false, d: false, q: false, e: false, shift: false }, 0);
check(
    "Phase 7.5: W + followYaw=0 → setMovementInput(forward=+1, strafe=0, ...)",
    calls.length === 1 && calls[0].forward === 1 && calls[0].strafe === 0,
    `calls=${JSON.stringify(calls)}`
);
const yaw0Call = calls[0];

// ---- Reset signature so subsequent calls fire -----------------------
function resetSig() {
    switcher.lastInputSig = "STALE";
}

// ---- Assert 4: W with followYaw=π/2 → setMovementInput(0, +1, ...) --
// At yaw=π/2, camera faces +X (east). Pressing W should move the
// player east, which in world-fixed coords is forward=0, strafe=+1.
resetSig();
driveTick({ w: true, a: false, s: false, d: false, q: false, e: false, shift: false }, Math.PI / 2);
check(
    "Phase 7.5: W + followYaw=π/2 → setMovementInput(forward=0, strafe=+1, ...) (camera-east = world-east strafe)",
    calls.length === 1 && calls[0].forward === 0 && calls[0].strafe === 1,
    `calls=${JSON.stringify(calls)}`
);
const yawPi2Call = calls[0];

// ---- Assert 5: D with followYaw=0 → setMovementInput(0, +1, ...) ----
// At yaw=0, pressing D (strafe right in camera frame) = world-east.
resetSig();
driveTick({ w: false, a: false, s: false, d: true, q: false, e: false, shift: false }, 0);
check(
    "Phase 7.5: D + followYaw=0 → setMovementInput(forward=0, strafe=+1, ...)",
    calls.length === 1 && calls[0].forward === 0 && calls[0].strafe === 1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 6: D with followYaw=π/2 → setMovementInput(-1, 0, ...) --
// At yaw=π/2 (camera faces east), pressing D (strafe right in camera
// frame) = world-south. World-south = forward=-1, strafe=0.
resetSig();
driveTick({ w: false, a: false, s: false, d: true, q: false, e: false, shift: false }, Math.PI / 2);
check(
    "Phase 7.5: D + followYaw=π/2 → setMovementInput(forward=-1, strafe=0, ...) (camera-right = world-south)",
    calls.length === 1 && calls[0].forward === -1 && calls[0].strafe === 0,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 7: W+D diagonal at yaw=0 → forward=+1, strafe=+1 --------
resetSig();
driveTick({ w: true, a: false, s: false, d: true, q: false, e: false, shift: false }, 0);
check(
    "Phase 7.5: W+D diagonal + yaw=0 → forward=+1, strafe=+1 (no normalization)",
    calls.length === 1 && calls[0].forward === 1 && calls[0].strafe === 1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 8: Q (turn left) → turn=-1 ------------------------------
resetSig();
driveTick({ w: false, a: false, s: false, d: false, q: true, e: false, shift: false }, 0);
check(
    "Phase 7.5: Q → turn=-1 (left)",
    calls.length === 1 && calls[0].turn === -1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 9: Shift → run=false ------------------------------------
resetSig();
driveTick({ w: true, a: false, s: false, d: false, q: false, e: false, shift: true }, 0);
check(
    "Phase 7.5: W + Shift → run=false (walk modifier)",
    calls.length === 1 && calls[0].run === false,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 10: Mode switch to 'orbit' suppresses movement ---------
switcher.switchMode("orbit");
check(
    "Phase 7.5: switchMode('orbit') flips mode + activeCamera",
    switcher.mode === "orbit" && switcher.activeCamera === persp,
    `mode=${switcher.mode}, activeCamera === persp? ${switcher.activeCamera === persp}`
);
// Verify computeMovementFromKeys returns null in orbit (movement
// suppressed — no setMovementInput call).
const orbitMv = switcher.computeMovementFromKeys();
check(
    "Phase 7.5: orbit mode suppresses computeMovementFromKeys (returns null)",
    orbitMv === null,
    `orbitMv=${JSON.stringify(orbitMv)}`
);
// Tick the switcher with W pressed in orbit mode — should NOT fire
// setMovementInput.
resetSig();
driveTick({ w: true, a: false, s: false, d: false, q: false, e: false, shift: false }, 0);
check(
    "Phase 7.5: tick in orbit mode does NOT fire setMovementInput on WASD",
    calls.length === 0,
    `calls.length=${calls.length}`
);

// ---- Assert 11: Mode switch to 'topDown' --------------------------
switcher.switchMode("topDown");
check(
    "Phase 7.5: switchMode('topDown') flips mode + activeCamera",
    switcher.mode === "topDown" && switcher.activeCamera === ortho,
    `mode=${switcher.mode}, activeCamera === ortho? ${switcher.activeCamera === ortho}`
);

// In topDown mode, WASD is world-fixed regardless of followYaw. Press
// W → forward=+1, regardless of yaw.
resetSig();
driveTick({ w: true, a: false, s: false, d: false, q: false, e: false, shift: false }, Math.PI / 2);
check(
    "Phase 7.5: topDown mode is world-fixed — W → forward=+1 regardless of followYaw",
    calls.length === 1 && calls[0].forward === 1 && calls[0].strafe === 0,
    `calls=${JSON.stringify(calls)}`
);
resetSig();
driveTick({ w: false, a: false, s: false, d: true, q: false, e: false, shift: false }, Math.PI / 2);
check(
    "Phase 7.5: topDown mode is world-fixed — D → strafe=+1 regardless of followYaw",
    calls.length === 1 && calls[0].forward === 0 && calls[0].strafe === 1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 12: Mode cycles through all 3 ---------------------------
switcher.switchMode("follow");
const cycle = [];
for (let i = 0; i < 6; i += 1) {
    cycle.push(switcher.mode);
    const idx = CAMERA_MODES.indexOf(switcher.mode);
    const nextMode = CAMERA_MODES[(idx + 1) % CAMERA_MODES.length];
    switcher.switchMode(nextMode);
}
check(
    "Phase 7.5: mode cycles follow → orbit → topDown → follow (CAMERA_MODES ordering)",
    cycle.join(",") === "follow,orbit,topDown,follow,orbit,topDown",
    `cycle=${cycle.join(",")}`
);

// ---- Assert 13: dispose() cleans up controllers --------------------
switcher.switchMode("follow");
switcher.dispose();
check(
    "Phase 7.5: dispose() drops controls reference",
    switcher.controls === null,
    `controls=${switcher.controls}`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
console.log("Resolution of the load-bearing sign convention:");
console.log("  yaw=0   W → forward=+1, strafe=0  (player moves +Y north — camera faces north)");
console.log("  yaw=π/2 W → forward=0,  strafe=+1 (player moves +X east  — camera faces east)");
console.log("  yaw=0   D → forward=0,  strafe=+1 (player moves +X east  — strafe-right in camera-frame)");
console.log("  yaw=π/2 D → forward=-1, strafe=0  (player moves -Y south — strafe-right of east-facing = south)");
console.log("Convention: setMovementInput.forward = clampSign(worldDy) where +Y = north;");
console.log("            setMovementInput.strafe  = clampSign(worldDx) where +X = east.");
console.log(`recorded calls: ${calls.length} most recent; recorded yaw=0/yaw=π/2 W: ${JSON.stringify(yaw0Call)} / ${JSON.stringify(yawPi2Call)}`);
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 7.5 camera-math checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
