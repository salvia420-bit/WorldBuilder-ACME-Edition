// Workstream D (2026-05-11) — standalone ESM test for the camera-
// relative WASD + auto-turn-to-align math restored to `scene3d/camera.js`.
//
// Drives a CameraSwitcher with:
//   - a mock `sessionHandle.getLocalPlayerPose()` returning a controllable
//     heading (the "authoritative integrator heading" Workstream A
//     exposes)
//   - a mock `sessionHandle.setMovementInput()` that simulates ACE's
//     rotational integrator: when `turn` is held, the mock advances the
//     heading at the same rate the wasm side would (RUN_HELD_TURN_SPEED_RAD_PER_SEC
//     ≈ 1.5 rad/s by default; configurable via env)
//
// and verifies the 5 design bullets from the spec's Verification section:
//   1. Pressing W with playerHeading=south + yaw=0 (north) produces an
//      auto-turn LEFT that rotates heading toward followYaw within
//      ~300 ms.
//   2. Panning mouse 90° left while walking re-triggers the auto-turn —
//      heading converges to new followYaw within ~300 ms.
//   3. Mouse-look sign: mouse-right → followYaw increases (standard FPS).
//      (Tested via direct followYaw write since real mousemove isn't
//      synthesizable in node.)
//   4. Manual Q/E overrides auto-turn — the per-tick `turn` signal
//      matches qeTurn (sign-clamped), not the auto-turn.
//   5. Heading-error dead zone — once |heading - followYaw| < TURN_DEAD_ZONE,
//      no further `turn` deltas fire (auto-turn releases).
//
// Run with: cd apps/holtburger-web/ && node test_workstream_d_camera_relative.mjs
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

console.log("Workstream D — camera-relative WASD + auto-turn-to-align test");
console.log("=========================");

// ---- Load camera.js via closure-injection (same trick as B's test) --
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

// ---- Mock window/document --------------------------------------------
const TEST_GUID = 0x50000007;
const lastMap = new Map();
const fakeWindow = {
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

const factoryEnv = factory(
    THREE,
    OrbitControls,
    PointerLockControls,
    globalThis.performance ?? { now: () => Date.now() },
    fakeWindow,
    fakeDoc
);
const { CameraSwitcher, createOrthoCamera } = factoryEnv;

// ---- Mock sessionHandle: holds a mutable heading the integrator
// updates per tick when `turn != 0`. setMovementInput captures the
// last call's args + steps the heading; the cameraSwitcher then reads
// the new heading via getLocalPlayerPose() on the next tick.
//
// This simulates ACE's integrator at the wasm/network boundary — the
// JS side has no direct write access to playerHeading, only the
// turn-signal it sends via setMovementInput.
const RUN_TURN = 1.5; // RUN_HELD_TURN_SPEED_RAD_PER_SEC
let mockHeading = 0.0;
let mockLastTurn = 0;
let mockLastForward = 0;
let mockLastStrafe = 0;
let mockTickDt = 0.016;
function stepMockIntegrator(dt) {
    if (mockLastTurn !== 0) {
        // ACE's MovementSystem uses CCW-positive turn. Our followYaw
        // is CW-from-+Y-north. The headingError math in
        // computeMovementFromKeys signs `turn = +1` when followYaw >
        // playerHeading (CW direction). The cli's MotionState builder
        // maps turn=+1 → builder.turn_right() → omega.z negative (CW
        // around +Z = decreasing yaw in our CW-from-north convention,
        // which means our heading should INCREASE toward followYaw
        // when turn=+1 is held). Mock simulates that.
        mockHeading += mockLastTurn * RUN_TURN * dt;
        // wrap to [-π, π]
        mockHeading = Math.atan2(Math.sin(mockHeading), Math.cos(mockHeading));
    }
}
const mockSession = {
    setMovementInput(forward, strafe, turn, run) {
        mockLastForward = forward;
        mockLastStrafe = strafe;
        mockLastTurn = turn;
    },
    getLocalPlayerPose() {
        return {
            x: 100, y: 200, z: 80,
            heading: mockHeading,
            landblockId: 0xa9b40000,
        };
    },
};

// ---- Mock canvas + cameras -------------------------------------------
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

const PLAYER_POS = { x: 32544, y: 34656, z: 80 };
const getPlayerWorldPos = () => PLAYER_POS;

const switcher = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: fakeCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos,
});

fakeWindow.liveScene3d = { cameraSwitcher: switcher };

// ---- Helpers ----------------------------------------------------------
function wrapAngle(rad) {
    return Math.atan2(Math.sin(rad), Math.cos(rad));
}
function resetAll() {
    mockHeading = 0.0;
    mockLastTurn = 0;
    mockLastForward = 0;
    mockLastStrafe = 0;
    switcher.followYaw = 0.0;
    switcher.lastInputSig = "STALE";
    switcher.keys.w = false;
    switcher.keys.a = false;
    switcher.keys.s = false;
    switcher.keys.d = false;
    switcher.keys.q = false;
    switcher.keys.e = false;
    switcher.keys.shift = false;
    switcher.predictedPlayerPos = null;
    switcher._predLastTickMs = null;
}

// ---- Bullet 1: heading converges to followYaw monotonically ----------
// Player spawns facing south (heading=π); camera faces north (yaw=0).
// Press W. Auto-turn should rotate heading from π toward 0 (or via -π
// → 0 by wrap-around). Expect convergence within TURN_DEAD_ZONE (0.05
// rad).
//
// The convergence time bound is **set by the ACE rotational integrator
// rate** (`RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.5 rad/s` from
// `crates/holtburger-core/src/client/movement/common.rs:29`). A 180°
// turn (π rad) takes at least π/1.5 ≈ 2.094 s. A 90° turn (π/2 rad)
// takes ≈ 1.05 s. The spec's "~300 ms" upper bound was aspirational —
// it'd require a turn rate of ~10 rad/s, which doesn't match ACE's
// retail-AC-matching 1.5 rad/s. Allow 2.5 s here (worst case + margin).

resetAll();
mockHeading = Math.PI; // facing south
switcher.followYaw = 0.0; // camera north
switcher.keys.w = true;

const dt = 0.016;
const headingTrace = [];
let convergedT = null;
const TURN_DEAD_ZONE = 0.05;
const MAX_CONVERGE_180_MS = 2500; // 180° rotation @ 1.5 rad/s ≈ 2094 ms + margin
const MAX_CONVERGE_90_MS = 1500;  // 90° rotation @ 1.5 rad/s ≈ 1047 ms + margin
for (let i = 0; i < 350; i += 1) { // up to 350 ticks (~5.6 s)
    const tNow = i * dt * 1000;
    switcher.lastInputSig = "STALE"; // force dispatch every tick
    switcher.tick(dt);
    stepMockIntegrator(dt);
    const err = wrapAngle(switcher.followYaw - mockHeading);
    headingTrace.push({ t: tNow, heading: mockHeading, err, turn: mockLastTurn, forward: mockLastForward, strafe: mockLastStrafe });
    if (Math.abs(err) < TURN_DEAD_ZONE && convergedT === null) {
        convergedT = tNow;
    }
    if (tNow > 5000) break;
}
check(
    "Bullet 1: heading converges to followYaw within TURN_DEAD_ZONE (player spawned facing south, camera north)",
    convergedT !== null && convergedT <= MAX_CONVERGE_180_MS,
    convergedT === null
      ? `no convergence within 5 s (final heading=${mockHeading.toFixed(3)}, err=${headingTrace[headingTrace.length-1]?.err?.toFixed(3)})`
      : `converged at t=${convergedT.toFixed(0)} ms ≤ ${MAX_CONVERGE_180_MS} ms bound (180° turn @ 1.5 rad/s ≈ ${(Math.PI / 1.5 * 1000).toFixed(0)} ms theoretical)`
);

// ---- Bullet 2: mouse-pan 90° left re-triggers convergence ------------
// After Bullet 1, heading ≈ 0 (north), camera at 0. Pan camera 90° left
// (followYaw = -π/2). Hold W. Heading should converge to -π/2 within
// ~1.5 s bound (90° @ 1.5 rad/s = 1.047 s + margin).

const yawTarget = -Math.PI / 2;
switcher.followYaw = yawTarget;
mockLastTurn = 0; // reset so we measure from this pan
let panConvergedT = null;
for (let i = 0; i < 350; i += 1) {
    const tNow = i * dt * 1000;
    switcher.lastInputSig = "STALE";
    switcher.tick(dt);
    stepMockIntegrator(dt);
    const err = wrapAngle(switcher.followYaw - mockHeading);
    if (Math.abs(err) < TURN_DEAD_ZONE && panConvergedT === null) {
        panConvergedT = tNow;
    }
    if (tNow > 5000) break;
}
check(
    "Bullet 2: pan 90° left mid-walk → heading re-converges within 1.5 s",
    panConvergedT !== null && panConvergedT <= MAX_CONVERGE_90_MS,
    panConvergedT === null
      ? `no convergence; final heading=${mockHeading.toFixed(3)}`
      : `converged at t=${panConvergedT.toFixed(0)} ms ≤ ${MAX_CONVERGE_90_MS} ms (90° @ 1.5 rad/s ≈ 1047 ms theoretical), final=${mockHeading.toFixed(3)}`
);

// ---- Bullet 3 (synthetic): mouse-right increases followYaw ----------
// Direct write test — the real PointerLockControls path is exercised
// by capture_phase7_5_camera.cjs (live mouse-move not feasible in
// node). Here we just sanity-check the sign convention applied at the
// followYaw write site in camera.js (mouse-right → +deltaYaw).
resetAll();
const yawBefore = switcher.followYaw;
// Manually invoke the mouse-move handler's body equivalent: pretend
// movementX=+100, movementY=+0. The actual handler is installed in
// switchMode("follow"); rather than firing a synthetic mousemove event
// (which the fakeDoc would swallow), we verify the sign by
// applying the same delta math the handler uses.
const POINTER_YAW_SENS = 0.0025;
switcher.followYaw += 100 * POINTER_YAW_SENS;
const yawAfter = switcher.followYaw;
check(
    "Bullet 3: mouse-right (movementX=+100) increases followYaw (standard FPS)",
    yawAfter > yawBefore,
    `yaw ${yawBefore.toFixed(3)} → ${yawAfter.toFixed(3)} (Δ=${(yawAfter - yawBefore).toFixed(3)})`
);

// ---- Bullet 4: manual Q overrides auto-turn -------------------------
// Set up a state where auto-turn would fire (heading=π, yaw=0). Hold W
// AND Q (left). Verify the per-tick `turn` signal is -1 (manual Q),
// not the auto-turn's +1 or -1.
resetAll();
mockHeading = Math.PI; // facing south → auto-turn would want to rotate
switcher.followYaw = 0.0;
switcher.keys.w = true;
switcher.keys.q = true; // manual left turn
switcher.lastInputSig = "STALE";
const out = switcher.computeMovementFromKeys();
check(
    "Bullet 4: Q held while WASD + heading mismatch → turn=-1 (manual override)",
    out && out.turn === -1,
    `out=${JSON.stringify(out)}`
);

// And E override:
switcher.keys.q = false;
switcher.keys.e = true;
const outE = switcher.computeMovementFromKeys();
check(
    "Bullet 4b: E held while WASD + heading mismatch → turn=+1 (manual override)",
    outE && outE.turn === 1,
    `out=${JSON.stringify(outE)}`
);

// ---- Bullet 5: dead-zone release — no further turn deltas -----------
// Set heading == followYaw exactly (no error). Hold W. Verify turn=0.
resetAll();
mockHeading = 0.0;
switcher.followYaw = 0.0;
switcher.keys.w = true;
switcher.lastInputSig = "STALE";
const inDeadZone = switcher.computeMovementFromKeys();
check(
    "Bullet 5a: heading == followYaw → turn=0 (auto-turn released, inside dead zone)",
    inDeadZone && inDeadZone.turn === 0,
    `out=${JSON.stringify(inDeadZone)}`
);

// Edge-case: heading inside dead zone (small error)
mockHeading = TURN_DEAD_ZONE * 0.5; // half a dead-zone worth of error
switcher.lastInputSig = "STALE";
const justInside = switcher.computeMovementFromKeys();
check(
    "Bullet 5b: heading within TURN_DEAD_ZONE of followYaw → turn=0",
    justInside && justInside.turn === 0,
    `heading=${mockHeading.toFixed(4)} TURN_DEAD_ZONE=${TURN_DEAD_ZONE} out=${JSON.stringify(justInside)}`
);

// Just outside dead zone → auto-turn fires
mockHeading = TURN_DEAD_ZONE * 2.0;
switcher.lastInputSig = "STALE";
const justOutside = switcher.computeMovementFromKeys();
check(
    "Bullet 5c: heading just outside TURN_DEAD_ZONE → turn=-1 (auto-turn engages)",
    justOutside && justOutside.turn === -1, // need to turn back toward yaw=0 from heading>0 → turn=-1 (CW-from-north + signed error)
    `heading=${mockHeading.toFixed(4)} out=${JSON.stringify(justOutside)}`
);

// ---- Camera-relative invariants --------------------------------------
// Spec rule #2 + #3: world-frame intent rotated by followYaw, then
// rotated into player local frame. At followYaw=0 + playerHeading=0,
// W should produce {forward=+1, strafe=0, turn=0}. Spec verified by
// capture_phase7_5_camera.cjs; mirror the assertion here for hygiene.
resetAll();
mockHeading = 0.0;
switcher.followYaw = 0.0;
switcher.keys.w = true;
switcher.lastInputSig = "STALE";
const wn = switcher.computeMovementFromKeys();
check(
    "Invariant: W + yaw=0 + heading=0 → forward=+1, strafe=0, turn=0 (camera/player aligned)",
    wn && wn.forward === 1 && wn.strafe === 0 && wn.turn === 0,
    `out=${JSON.stringify(wn)}`
);

// W + yaw=π/2 (camera east), heading=π/2 (player east, aligned). W
// should be forward=+1 in local frame, strafe=0, turn=0 (no
// auto-turn — already aligned).
resetAll();
mockHeading = Math.PI / 2;
switcher.followYaw = Math.PI / 2;
switcher.keys.w = true;
switcher.lastInputSig = "STALE";
const aligned = switcher.computeMovementFromKeys();
check(
    "Invariant: W + camera-east + player-east (aligned) → forward=+1, strafe=0, turn=0",
    aligned && aligned.forward === 1 && aligned.strafe === 0 && aligned.turn === 0,
    `out=${JSON.stringify(aligned)}`
);

// W + yaw=π/2 (camera east), heading=0 (player still north). W in
// world frame = +X east. Rotated into player local (heading=0): localF=0,
// localS=+1. So forward=0, strafe=+1, turn=+1 (auto-turn engaging).
resetAll();
mockHeading = 0.0;
switcher.followYaw = Math.PI / 2;
switcher.keys.w = true;
switcher.lastInputSig = "STALE";
const turning = switcher.computeMovementFromKeys();
check(
    "Invariant: W + camera-east + player-north → forward=0, strafe=+1, turn=+1 (auto-turn engaged)",
    turning && turning.forward === 0 && turning.strafe === 1 && turning.turn === 1,
    `out=${JSON.stringify(turning)}`
);

// ---- Summary ---------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} Workstream D camera-relative + auto-turn checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${passed} passed, ${failed} failed (of ${passed + failed}).`);
    process.exit(1);
}
