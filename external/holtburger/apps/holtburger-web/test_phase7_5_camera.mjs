// Phase 7.5 — standalone ESM test for `scene3d/camera.js`. Loads
// three.js + the OrbitControls / PointerLockControls addons by
// rewriting `import * as THREE from "three"` + `import ... from
// "three/addons/..."` into closure-captured references (same trick
// the 7.4a/7.4b tests use). Drives a CameraSwitcher with a mock
// `sessionHandle.setMovementInput` recorder + verifies the WASD intent
// (`lastMoveIntent`) per camera mode. 2026-10-05: follow-mode WASD is
// PLAYER-LOCAL since Cohere-D Phase 1 (the camera-relative yaw rotation
// this file originally pinned was removed on purpose), and the camera
// dispatcher stays silent under the default-ON `?cmdInterp`.
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
    // The app's own declared dependency FIRST (2026-10-05): `require.resolve`
    // yields build/three.cjs on this layout, so the old `/build/three.module.js`
    // match never hit and the scan fell through to a stale npx cache whose
    // three ships no examples/jsm — an unconditional SKIP that asserted nothing.
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
        )
        .replace(
            // F#0 added `import { acToThree } from "./adapter.js"`. Inline
            // the implementation here so the test stays self-contained.
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

// 2026-10-05 — camera.js is now IMPORTED as a real ES module instead of
// text-spliced into new Function(). It grew imports (input.js run-modifier,
// ui/input-funnel.js, camera_retail_math, rust_pose) that the hand-rolled
// stripper below never learned, and the spliced body died with "Cannot use
// import statement outside a module" — hidden for months behind an
// OrbitControls-not-found SKIP. Node resolves `three` and
// `three/addons/...` from the app's own node_modules (same three.module.js
// instance as THREE above), so the genuine module graph runs. The window /
// document shims are installed as globals BEFORE the import so any
// module-top-level flag read sees them.
const fakeDoc = {
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
};
const fakeWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.window = fakeWindow;
globalThis.document = fakeDoc;
const factoryEnv = await import("./scene3d/camera.js");
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
// 2026-10-05 rewrite. Two deliberate app changes made the original
// assertions stale:
//   1. Cohere-D Phase 1 (2026-05-12, camera.js computeMovementFromKeys):
//      follow-mode WASD is PLAYER-LOCAL — the camera yaw no longer rotates
//      the intent vector (and auto-turn-to-align was removed). The old
//      "yaw=π/2 W → strafe=+1" camera-relative convention is gone.
//   2. `?cmdInterp` is DEFAULT-ON (camera.js CMD_INTERP_ON, `!== "off"`):
//      raw key edges reach wasm via handleKeyAction, so the camera
//      dispatcher must NOT also call setMovementInput (row-14 double-drive).
//      The resolved intent is still published every tick as
//      `switcher.lastMoveIntent`, which is what these checks now read.
function driveTick(keys, yaw, dt = 0.016) {
    Object.assign(switcher.keys, keys);
    switcher.followYaw = yaw;
    calls.length = 0;
    switcher.tick(dt);
    return switcher.lastMoveIntent;
}
function resetSig() {
    switcher.lastInputSig = "STALE";
}
const K = (o) => ({ w: false, a: false, s: false, d: false, q: false, e: false, shift: false, ...o });
const isMv = (mv, f, s, t) => !!mv && mv.forward === f && mv.strafe === s && (t === undefined || mv.turn === t);

let mv = driveTick(K({ w: true }), 0);
check("Phase 7.5: W + followYaw=0 → intent forward=+1, strafe=0", isMv(mv, 1, 0, 0), JSON.stringify(mv));
check(
    "Phase 7.5: cmdInterp default-ON → camera dispatcher sends NO setMovementInput (no double-drive)",
    calls.length === 0,
    `calls=${JSON.stringify(calls)}`
);
const yaw0Call = mv;

resetSig();
mv = driveTick(K({ w: true }), Math.PI / 2);
check(
    "Phase 7.5: follow is player-local — W + followYaw=π/2 still → forward=+1, strafe=0 (camera yaw does not redirect WASD)",
    isMv(mv, 1, 0, 0),
    JSON.stringify(mv)
);
const yawPi2Call = mv;

resetSig();
mv = driveTick(K({ d: true }), 0);
check("Phase 7.5: D + followYaw=0 → forward=0, strafe=+1", isMv(mv, 0, 1), JSON.stringify(mv));

resetSig();
mv = driveTick(K({ d: true }), Math.PI / 2);
check("Phase 7.5: D + followYaw=π/2 → forward=0, strafe=+1 (player-local)", isMv(mv, 0, 1), JSON.stringify(mv));

resetSig();
mv = driveTick(K({ w: true, d: true }), 0);
check("Phase 7.5: W+D diagonal → forward=+1, strafe=+1 (no normalization)", isMv(mv, 1, 1), JSON.stringify(mv));

resetSig();
mv = driveTick(K({ q: true }), 0);
check("Phase 7.5: Q → turn=-1 (left)", !!mv && mv.turn === -1, JSON.stringify(mv));

resetSig();
mv = driveTick(K({ w: true }), 0);
check("Phase 7.5: W (no Shift) → run=true (run-by-default; ToggleRun option defaults TRUE)", !!mv && mv.run === true, JSON.stringify(mv));
resetSig();
mv = driveTick(K({ w: true, shift: true }), 0);
check("Phase 7.5: W + Shift → run=false (walk modifier)", !!mv && mv.run === false, JSON.stringify(mv));

// ---- Mode switch to 'orbit' suppresses movement ----------------------
switcher.switchMode("orbit");
check(
    "Phase 7.5: switchMode('orbit') flips mode + activeCamera",
    switcher.mode === "orbit" && switcher.activeCamera === persp,
    `mode=${switcher.mode}, activeCamera === persp? ${switcher.activeCamera === persp}`
);
const orbitMv = switcher.computeMovementFromKeys();
check(
    "Phase 7.5: orbit mode suppresses computeMovementFromKeys (returns null)",
    orbitMv === null,
    `orbitMv=${JSON.stringify(orbitMv)}`
);
resetSig();
mv = driveTick(K({ w: true }), 0);
check(
    "Phase 7.5: tick in orbit mode publishes a null intent and fires no setMovementInput",
    mv === null && calls.length === 0,
    `mv=${JSON.stringify(mv)} calls.length=${calls.length}`
);

// ---- Mode switch to 'topDown' -----------------------------------------
switcher.switchMode("topDown");
check(
    "Phase 7.5: switchMode('topDown') flips mode + activeCamera",
    switcher.mode === "topDown" && switcher.activeCamera === ortho,
    `mode=${switcher.mode}, activeCamera === ortho? ${switcher.activeCamera === ortho}`
);
resetSig();
mv = driveTick(K({ w: true }), Math.PI / 2);
check("Phase 7.5: topDown is world-fixed — W → forward=+1 regardless of followYaw", isMv(mv, 1, 0), JSON.stringify(mv));
resetSig();
mv = driveTick(K({ d: true }), Math.PI / 2);
check("Phase 7.5: topDown is world-fixed — D → strafe=+1 regardless of followYaw", isMv(mv, 0, 1), JSON.stringify(mv));

// ---- Mode cycles through all 3 (CAMERA_MODES order, `C` key) ------------
switcher.switchMode("follow");
const cycle = [];
for (let i = 0; i < 6; i += 1) {
    cycle.push(switcher.mode);
    const idx = CAMERA_MODES.indexOf(switcher.mode);
    switcher.switchMode(CAMERA_MODES[(idx + 1) % CAMERA_MODES.length]);
}
check(
    "Phase 7.5: mode cycles follow → topDown → orbit → follow (CAMERA_MODES ordering)",
    cycle.join(",") === "follow,topDown,orbit,follow,topDown,orbit",
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

// ---- C1 listener-split assertions (#1) + getActive (#4) -------------
// These FAIL on pre-C1 code (no `_globalListeners`, the constructor's
// switchMode('follow') strips the global blur/keydown/keyup/wheel/C
// handlers, and there is no getActive()). They prove the C1 split.
//
// Construct a SECOND switcher with instrumented window/document/canvas
// shims so we can record every removeEventListener call made during the
// constructor (which runs switchMode('follow') at the end). The global
// input listeners must NOT appear in that removed[] list.
const removedDuringCtor = [];
const recordingDoc = {
    addEventListener: () => {},
    removeEventListener: (type) => { removedDuringCtor.push(["document", type]); },
    activeElement: null,
};
const recordingWindow = {
    addEventListener: () => {},
    removeEventListener: (type) => { removedDuringCtor.push(["window", type]); },
};
const recordingCanvas = {
    addEventListener: () => {},
    removeEventListener: (type) => { removedDuringCtor.push(["canvas", type]); },
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
// The module is a real ES import now (cached), and camera.js resolves
// `window` / `document` as globals at CALL time, so swapping the globals
// is what binds the constructor's listener installers to the recorders.
globalThis.window = recordingWindow;
globalThis.document = recordingDoc;
const recFactoryEnv = factoryEnv;
const recPersp = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
const recOrtho = recFactoryEnv.createOrthoCamera(recordingCanvas);
const switcher2 = new recFactoryEnv.CameraSwitcher({
    scene3d: {},
    perspectiveCamera: recPersp,
    orthoCamera: recOrtho,
    domElement: recordingCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos,
});

// (A) the 5 global input listeners (blur/keydown/keyup/wheel/C) landed
// in _globalListeners — at least 4 (window 'blur' is skipped if window
// is undefined, but our shim provides it, so expect all 5).
// P-unification (2026-07-28): under the default-ON `?inputFunnelV2` the
// keydown/keyup keystate mirror + the C mode toggle are RAW funnel
// subscribers (`_funnelUnbinds`), not document listeners, so
// `_globalListeners` keeps only blur + wheel. The C1 invariant is that the
// page-global input handlers (wherever they live) are ALL installed and
// survive switchMode — count both homes.
const gl = switcher2._globalListeners;
const fu = switcher2._funnelUnbinds || [];
check(
    "C1 (#1): page-global input handlers installed — _globalListeners (blur/wheel) + funnel binds (keydown/keyup/C) >= 4",
    Array.isArray(gl) && gl.length + fu.length >= 4 &&
        gl.some(([t]) => t === "blur") && gl.some(([t]) => t === "wheel"),
    `_globalListeners=${gl ? gl.map(([t]) => t).join("/") : "MISSING"} funnelBinds=${fu.length}`
);

// (B) the constructor's switchMode('follow') must NOT have removed any
// of the global input listeners.
const removedGlobalTypes = removedDuringCtor
    .filter(([, type]) => ["blur", "keydown", "keyup", "wheel"].includes(type));
check(
    "C1 (#1): constructor switchMode did NOT remove any global input listener",
    removedGlobalTypes.length === 0,
    `removed=${JSON.stringify(removedGlobalTypes)}`
);

// (C) toggling modes twice does not change the global listener count
// (switchMode tears down only the per-mode _listeners).
const globalLenBefore = switcher2._globalListeners.length;
switcher2.switchMode("orbit");
switcher2.switchMode("topDown");
check(
    "C1 (#1): _globalListeners.length + funnel binds unchanged after two switchMode toggles",
    switcher2._globalListeners.length === globalLenBefore &&
        (switcher2._funnelUnbinds || []).length === fu.length,
    `before=${globalLenBefore}+${fu.length} after=${switcher2._globalListeners.length}+${(switcher2._funnelUnbinds || []).length}`
);

// (D) getActive() returns the live activeCamera (ortho in topDown,
// persp in follow/orbit), NOT this.persp.
switcher2.switchMode("topDown");
const getActiveIsFn = typeof switcher2.getActive === "function";
check(
    "C1 (#4): getActive is a function",
    getActiveIsFn,
    `typeof getActive=${typeof switcher2.getActive}`
);
check(
    "C1 (#4): getActive()===ortho in topDown",
    getActiveIsFn && switcher2.getActive() === recOrtho,
    `getActive()===ortho? ${getActiveIsFn && switcher2.getActive() === recOrtho}`
);
switcher2.switchMode("follow");
check(
    "C1 (#4): getActive()===persp in follow",
    getActiveIsFn && switcher2.getActive() === recPersp,
    `getActive()===persp? ${getActiveIsFn && switcher2.getActive() === recPersp}`
);
switcher2.switchMode("orbit");
check(
    "C1 (#4): getActive()===persp in orbit",
    getActiveIsFn && switcher2.getActive() === recPersp,
    `getActive()===persp? ${getActiveIsFn && switcher2.getActive() === recPersp}`
);
switcher2.dispose();

// ---- Summary --------------------------------------------------------
console.log("=========================");
console.log("Convention (Cohere-D Phase 1): follow-mode WASD is player-local; camera yaw never redirects it.");
console.log(`yaw=0 / yaw=π/2 W intents: ${JSON.stringify(yaw0Call)} / ${JSON.stringify(yawPi2Call)}`);
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Phase 7.5 camera-math checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
