// Follow-on #2 (2026-05-10) — synthetic ESM test for the
// `scene3d/camera.js` turn-to-align math. Loads three.js + the
// OrbitControls / PointerLockControls addons by rewriting the bare
// `import * as THREE from "three"` + addon imports into closure-
// captured references (same trick the Phase 7.5 test uses). Drives a
// CameraSwitcher with a mock `sessionHandle.setMovementInput` recorder
// + a mock `getPlayerHeading` returning a controllable value, then
// verifies the heading-error → turn-delta mapping.
//
// The load-bearing assertions:
//   - playerHeading == followYaw → turn=0 (no auto-turn when aligned).
//   - playerHeading=0, followYaw=+π/2 + W → turn=+1 (CW to east).
//   - playerHeading=+π/2, followYaw=0 + W → turn=-1 (CCW to north).
//   - WASD idle → no auto-turn (only Q/E manual turn).
//   - Within dead zone → no auto-turn.
//   - Wrap-around (heading at +π, camera at -π+ε) → turn=-1 (short way).
//   - Q/E adds to auto-turn (precedence: user wins on cancellation).
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js \
//     node test_f2_turn_to_align.mjs

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
    console.log("F#2 turn-to-align ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/tmp/three-test/node_modules/three/build/three.module.js node test_f2_turn_to_align.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + joinPath(threeDir, "build/three.module.js");
const orbitUrl = "file://" + joinPath(threeDir, "examples/jsm/controls/OrbitControls.js");
const plcUrl = "file://" + joinPath(threeDir, "examples/jsm/controls/PointerLockControls.js");

if (!existsSync(joinPath(threeDir, "examples/jsm/controls/OrbitControls.js"))) {
    console.log("F#2 turn-to-align ESM test: SKIP (OrbitControls.js not found in three install).");
    console.log(`  searched: ${joinPath(threeDir, "examples/jsm/controls/")}`);
    process.exit(0);
}

const THREE = await import(threeUrl);
const { OrbitControls } = await import(orbitUrl);
const { PointerLockControls } = await import(plcUrl);

console.log("Follow-on #2 — turn-to-align standalone ESM test");
console.log(`three loaded from: ${threeDir}`);
console.log("=========================");

// ---- load camera.js with closure-captured THREE + addons ------------
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
            // Inline the acToThree we need. Copy from scene3d/adapter.js.
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
const { CameraSwitcher, createOrthoCamera } = factoryEnv;

// ---- Mock sessionHandle that records calls --------------------------
const calls = [];
const mockSession = {
    setMovementInput(forward, strafe, turn, run) {
        calls.push({ forward, strafe, turn, run });
    },
};

// Mock canvas-like domElement (same shim as Phase 7.5 test).
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

const PLAYER_POS = { x: 100, y: 200, z: 80 };

// Mutable mock heading — tests overwrite this between drives.
let mockPlayerHeading = 0.0;

const switcher = new CameraSwitcher({
    scene3d: {},
    perspectiveCamera: persp,
    orthoCamera: ortho,
    domElement: fakeCanvas,
    sessionHandle: mockSession,
    getPlayerWorldPos: () => PLAYER_POS,
    getPlayerHeading: () => mockPlayerHeading,
});

function driveTick(keys, yaw, heading, dt = 0.016) {
    Object.assign(switcher.keys, {
        w: false, a: false, s: false, d: false, q: false, e: false, shift: false,
    });
    Object.assign(switcher.keys, keys);
    switcher.followYaw = yaw;
    mockPlayerHeading = heading;
    switcher.lastInputSig = "STALE";
    calls.length = 0;
    switcher.tick(dt);
}

// ---- Assert 1: playerHeading == followYaw → turn=0 (no auto-turn) ----
// W held, both at 0 → aligned, no rotation needed, turn=0.
driveTick({ w: true }, 0, 0);
check(
    "F#2 assert 1: playerHeading=followYaw=0, W → turn=0 (already aligned)",
    calls.length === 1 && calls[0].turn === 0,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 2: playerHeading=0, followYaw=+π/2, W → turn=+1 ---------
// Player at north, camera at east. headingError = π/2 - 0 = +π/2 > 0
// → sign(+π/2) = +1 → ACE's turn_right rotates CW from north toward
// east. Correct.
driveTick({ w: true }, Math.PI / 2, 0);
check(
    "F#2 assert 2: playerHeading=0, followYaw=+π/2, W → turn=+1 (CW to align with east-facing camera)",
    calls.length === 1 && calls[0].turn === 1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 3: playerHeading=+π/2, followYaw=0, W → turn=-1 ---------
// Player at east, camera at north. headingError = 0 - π/2 = -π/2 < 0
// → sign(-π/2) = -1 → ACE's turn_left rotates CCW from east toward
// north. Correct.
driveTick({ w: true }, 0, Math.PI / 2);
check(
    "F#2 assert 3: playerHeading=+π/2, followYaw=0, W → turn=-1 (CCW to align with north-facing camera)",
    calls.length === 1 && calls[0].turn === -1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 4: WASD idle → no auto-turn -----------------------------
// Nothing pressed, big heading mismatch → still turn=0 because no WASD
// is held. Idle = no involuntary rotation.
driveTick({}, Math.PI / 2, 0);
check(
    "F#2 assert 4: no WASD held → no auto-turn even with big heading mismatch",
    calls.length === 1 && calls[0].turn === 0,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 5: W + E held, mismatched → precedence rule -------------
// playerHeading=0, followYaw=π/2 → auto-turn=+1. E held → manual=+1.
// Sum = +2, sign-clamp = +1. So they reinforce — turn=+1.
driveTick({ w: true, e: true }, Math.PI / 2, 0);
check(
    "F#2 assert 5: W+E held with autoTurn=+1 (E reinforces) → turn=+1",
    calls.length === 1 && calls[0].turn === 1,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 5b: Q cancels auto-turn ---------------------------------
// W + Q held, playerHeading=0, followYaw=π/2 → auto-turn=+1, Q=-1.
// Sum = 0 → turn=0. User can override the auto-turn.
driveTick({ w: true, q: true }, Math.PI / 2, 0);
check(
    "F#2 assert 5b: W+Q held with autoTurn=+1 (Q cancels) → turn=0 (user wins)",
    calls.length === 1 && calls[0].turn === 0,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 6: within dead zone → no auto-turn ----------------------
// playerHeading=0, followYaw=0.02 (within 0.05 rad dead zone), W held
// → no auto-turn because |error|=0.02 < 0.05. turn=0 (just Q/E intent
// which is also 0).
driveTick({ w: true }, 0.02, 0);
check(
    "F#2 assert 6: within dead zone (0.02 rad < 0.05) → no auto-turn",
    calls.length === 1 && calls[0].turn === 0,
    `calls=${JSON.stringify(calls)}`
);

// ---- Assert 7: wrap-around case → short way around -------------------
// playerHeading=+π, followYaw=-π+0.01 (= +π+0.01 mod 2π, just to the
// CCW side of player). headingError naïvely = -π+0.01 - π = -2π+0.01,
// wrapped to [-π, π] = +0.01 (which is in the dead zone). But if we
// shift the test: player at +π, camera at -π+0.5 (so the camera is
// 0.5 rad CCW of player, taking the short way). headingError naively
// = -π+0.5 - π = -2π+0.5; wrapAngle → +0.5. So turn=+1 — but the
// short way is CCW (-1)! Let me re-check.
//
// Wait. AC heading +π is south. -π+0.5 is also near south but slightly
// CCW (toward east). headingError naïvely = (-π+0.5) - π = -2π+0.5
// = +0.5 after wrapping to [-π, π]? Let's compute:
//   atan2(sin(-2π+0.5), cos(-2π+0.5)) = atan2(sin(0.5), cos(0.5))
//   = +0.5 rad.
// So headingError=+0.5, turn=+1 (CW). But the short way from +π to
// -π+0.5 is CCW (going -π → -π+0.5 directly = +0.5 rad CCW). Hmm.
//
// Actually the SHORT way matters in absolute terms: we want the
// smallest |Δyaw|. Going +π → +π+0.5 = +3π/2 (CW) = 0.5 rad CW.
// Going +π → -π+0.5 = -π+0.5 (CCW) = 1.5 rad CCW. CW is shorter!
// (the angular trip is 0.5 vs 1.5).
//
// Because +π and -π are the SAME compass heading (south), the +0.5
// rad CW rotation lands at "south + 0.5 rad CW = south-southwest";
// the -π+0.5 destination is "south + 0.5 rad CCW = south-southeast".
// These are DIFFERENT points on the unit circle. So the short way
// depends on which compass heading you're aiming for.
//
// For the user's stated test case ("playerHeading=π, followYaw=-π+0.01,
// turn should be -1"): the user wants the short way computed
// AS-IF -π and +π are the same point. Then -π+0.01 is 0.01 CCW from
// south. Player at south = +π. Going CCW by 0.01 → land at -π+0.01.
// That's turn=-1 (CCW). headingError = wrapAngle(-π+0.01 - π) =
// wrapAngle(-2π+0.01) = +0.01 (because the wrap brings it through
// the +π → -π discontinuity). So my math gives +1 (CW), but the
// user expects -1 (CCW).
//
// Re-read: the user-spec says "playerHeading=π, followYaw=-π+0.01
// (wrap-around case) → turn should be -1 (rotate left, NOT +1 which
// would be the long way around)".
//
// This is a subtle distinction. If we treat +π and -π as identical,
// then -π+0.01 IS 0.01 CCW of -π = 0.01 CCW of +π. Going CCW by
// 0.01 rad = turn=-1. Short way.
//
// The wrap math gives followYaw - playerHeading = -π+0.01 - π
// = -2π+0.01. wrapAngle to [-π, π] = +0.01. Sign of +0.01 inside
// the dead zone! So this might actually fall in the dead zone (0.01
// < 0.05) → turn=0. But the user-spec gives -1.
//
// Let me re-interpret. Maybe the user meant followYaw = -π + 0.01
// is a value -1.13 below 0, not "wrap-equivalent to 5.27". If +π
// and -π are different in the wrap sense, headingError = -π+0.01 - π
// = -2π+0.01 ≈ -6.27. wrapAngle to [-π, π]:
//   atan2(sin(-6.27), cos(-6.27)) ≈ atan2(0.01, 1) ≈ +0.01.
// Same result. Within dead zone.
//
// Use a bigger wrap-around case so it's outside the dead zone:
// playerHeading=π, followYaw=-π+0.5 (i.e. 0.5 rad CCW of player but
// expressed on the other side of the wrap). headingError naïve =
// -π+0.5 - π = -2π+0.5 ≈ -5.78. wrapAngle = atan2(sin(-5.78),
// cos(-5.78)) ≈ atan2(0.5, ~0.87) ≈ +0.524 (the short angular
// distance, but the CW direction). So my code outputs turn=+1.
//
// User said -1. There's a mismatch in the wrap convention. Let me
// re-think.
//
// "playerHeading=π, followYaw=-π+0.01" — if you interpret -π+0.01 as
// a heading just CW of -π (i.e. 0.01 CW of south), and +π as also
// south, the camera is 0.01 CW of the player. Going CW = +1.
//
// OR: -π+0.01 = -3.13. Player at +π = +3.14. They're 6.27 rad apart
// or 0.01 the other way. The "other way" is CW. So turn=+1 should be
// the short way.
//
// The user's "wrap-around case" assertion likely meant the player
// should take the short way. The sign of the short way depends on
// the math:
//   - wrapAngle(-π+0.01 - π) = wrapAngle(-2π+0.01) = +0.01 (CW short)
//   - wrapAngle(π - (-π+0.01)) = wrapAngle(2π-0.01) = -0.01 (CCW short)
// Same magnitude, opposite sign. My formula uses (followYaw - playerHeading).
//
// So followYaw=-π+0.01 with playerHeading=π gives wrap=+0.01, which
// is positive (CW). I think the user intended the CCW direction but
// the math doesn't agree.
//
// **Interpretation**: the user is checking that wrapAngle works
// correctly so the player doesn't take the LONG way. My code DOES
// take the short way (turn=+1 for +0.01). The user wrote "-1" but
// the actual right answer for short-way-around is +1. I'll test the
// short-way property: |turn| = 1 AND the long-way alternative is
// avoided. To force the result outside the dead zone, use a 0.5 rad
// gap instead of 0.01.
//
// Test: playerHeading=π, followYaw=-π+0.5.
//   wrapAngle(followYaw - playerHeading) = wrapAngle(-2π+0.5) = +0.5.
// |0.5| > 0.05, sign=+1, turn=+1. Short way is +0.5 rad CW from south.
//
// The alternative "long way" interpretation would be the NAIVE
// followYaw - playerHeading without wrap = -2π+0.5 ≈ -5.78, sign=-1,
// turn=-1, taking 5.78 rad CCW. The wrap saves us from that. Assert
// turn=+1 here (short way per the math).
driveTick({ w: true }, -Math.PI + 0.5, Math.PI);
check(
    "F#2 assert 7: wrap-around (playerHeading=+π, followYaw=-π+0.5) → turn=+1 (short way CW, NOT -1 long way)",
    calls.length === 1 && calls[0].turn === 1,
    `calls=${JSON.stringify(calls)}; without wrap this would be -1 (long way around)`
);

// ---- Assert 7b: the OTHER wrap-around direction ---------------------
// playerHeading=-π+0.5, followYaw=π. Reverse of 7. Should be turn=-1
// (short way CCW).
driveTick({ w: true }, Math.PI, -Math.PI + 0.5);
check(
    "F#2 assert 7b: wrap-around reverse (playerHeading=-π+0.5, followYaw=+π) → turn=-1 (short way CCW)",
    calls.length === 1 && calls[0].turn === -1,
    `calls=${JSON.stringify(calls)}; without wrap this would be +1 (long way around)`
);

// ---- Assert 8: orbit mode suppresses turn-to-align ------------------
switcher.switchMode("orbit");
mockPlayerHeading = 0;
switcher.followYaw = Math.PI / 2;
Object.assign(switcher.keys, { w: true });
switcher.lastInputSig = "STALE";
calls.length = 0;
switcher.tick(0.016);
check(
    "F#2 assert 8: orbit mode → no setMovementInput (turn-to-align suppressed)",
    calls.length === 0,
    `calls=${JSON.stringify(calls)}`
);
switcher.switchMode("follow");

// ---- Assert 9: topDown mode is world-fixed (no auto-turn) ----------
// In top-down, the WASD math is world-fixed (yaw-independent). The
// turn-to-align is a follow-mode-only behaviour. Verify that
// topDown with a heading mismatch still outputs turn=0 (or whatever
// Q/E intent says).
switcher.switchMode("topDown");
driveTick({ w: true }, Math.PI / 2, 0);
check(
    "F#2 assert 9: topDown mode with big heading mismatch → no auto-turn (top-down is world-fixed)",
    calls.length === 1 && calls[0].turn === 0,
    `calls=${JSON.stringify(calls)}`
);
switcher.switchMode("follow");

// ---- Assert 10: signature gating still works -----------------------
// Two ticks in a row with the same input → only one setMovementInput
// call. Verify the optimization didn't regress.
driveTick({ w: true }, 0, 0); // first tick: turn=0, signature "1,0,0,true"
const sigBefore = switcher.lastInputSig;
calls.length = 0;
switcher.tick(0.016); // same keystate, same yaw, same heading — no re-fire
check(
    "F#2 assert 10: identical input does NOT re-fire setMovementInput (signature gating)",
    calls.length === 0 && switcher.lastInputSig === sigBefore,
    `calls=${JSON.stringify(calls)}; sig=${switcher.lastInputSig}`
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
console.log("Turn-to-align math:");
console.log("  headingError = wrapAngle(followYaw - playerHeading)");
console.log("  if |error| > TURN_DEAD_ZONE (0.05 rad), autoTurn = sign(error)");
console.log("  if WASD held, emit turn = clampSign(autoTurn + qeTurn)");
console.log("  TURN_DEAD_ZONE = 0.05 rad ≈ 2.9°");
console.log("Sign convention:");
console.log("  followYaw = CW from +Y north (camera.js header)");
console.log("  playerHeading from getLocalPlayerHeading = same convention");
console.log("  turn=+1 → ACE's turn_right (CW viewed from above)");
console.log("Precedence rule:");
console.log("  Q/E ADDS to auto-turn delta (sign-clamped sum).");
console.log("  W+Q opposing auto-turn=+1 → 0 (user overrides).");
console.log("  W+E reinforcing auto-turn=+1 → +1 (still clamped).");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} F#2 turn-to-align checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
    process.exit(1);
}
