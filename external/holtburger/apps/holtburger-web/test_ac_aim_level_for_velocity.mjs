// Wave 3 / Phase 7 — `ui/ac_aim_level_for_velocity.js` unit tests.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_aim_level_for_velocity.mjs
//
// The helper has zero runtime deps (pure JS — Math.sqrt + branch tree)
// so we import the ESM file directly via file:// URL. Exit code is
// non-zero if any case fails.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl =
    "file://" + resolvePath(__dirname, "ui/ac_aim_level_for_velocity.js");
const { AIM_MOTIONS, getAimLevelForVelocity } = await import(helperUrl);

let failed = 0;
let passed = 0;
function hex(u) { return "0x" + ((u >>> 0).toString(16).padStart(8, "0")); }
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1; else passed += 1;
}
function checkMotion(name, vec, expected) {
    const got = getAimLevelForVelocity(vec);
    const ok = (got >>> 0) === (expected >>> 0);
    check(
        name,
        ok,
        `vec=(${vec?.x ?? "?"}, ${vec?.y ?? "?"}, ${vec?.z ?? "?"}) ` +
        `expected=${hex(expected)} got=${hex(got)}`,
    );
}

console.log("===========================================================");
console.log("Wave 3 / Phase 7 — ac_aim_level_for_velocity unit tests");
console.log("===========================================================");

// Module exports
check(
    "AIM_MOTIONS exports all 13 named u32s",
    typeof AIM_MOTIONS === "object"
    && AIM_MOTIONS.AimLevel === 0x4000001E
    && AIM_MOTIONS.AimHigh15 === 0x4000001F
    && AIM_MOTIONS.AimHigh30 === 0x40000020
    && AIM_MOTIONS.AimHigh45 === 0x40000021
    && AIM_MOTIONS.AimHigh60 === 0x40000022
    && AIM_MOTIONS.AimHigh75 === 0x40000023
    && AIM_MOTIONS.AimHigh90 === 0x40000024
    && AIM_MOTIONS.AimLow15  === 0x40000025
    && AIM_MOTIONS.AimLow30  === 0x40000026
    && AIM_MOTIONS.AimLow45  === 0x40000027
    && AIM_MOTIONS.AimLow60  === 0x40000028
    && AIM_MOTIONS.AimLow75  === 0x40000029
    && AIM_MOTIONS.AimLow90  === 0x4000002A,
);
check(
    "AIM_MOTIONS is frozen (no accidental mutation)",
    Object.isFrozen(AIM_MOTIONS),
);
check(
    "getAimLevelForVelocity is a function",
    typeof getAimLevelForVelocity === "function",
);

// --- The 5 acceptance cases from the plan doc ---

// 1. Purely horizontal east-pointing velocity → zAngle = 0 → AimLevel.
checkMotion(
    "horizontal east (x=1) → AimLevel",
    { x: 1, y: 0, z: 0 },
    AIM_MOTIONS.AimLevel,
);

// 2. Straight up → zAngle = 90 → AimHigh90.
checkMotion(
    "straight up (z=1) → AimHigh90",
    { x: 0, y: 0, z: 1 },
    AIM_MOTIONS.AimHigh90,
);

// 3. Straight down → zAngle = -90 → AimLow90.
checkMotion(
    "straight down (z=-1) → AimLow90",
    { x: 0, y: 0, z: -1 },
    AIM_MOTIONS.AimLow90,
);

// 4. 45° up in XZ plane → zAngle = (1/sqrt(2))*90 = 63.6° → bucket ≥ 52.5 → AimHigh60.
//    Hand-calc: normalize(1, 0, 1).z = 0.7071067...; * 90 = 63.6396...; first
//    bucket whose `zAngle >=` threshold it clears is 52.5 (AimHigh60).
checkMotion(
    "45° up xz-plane (x=1, z=1) → AimHigh60",
    { x: 1, y: 0, z: 1 },
    AIM_MOTIONS.AimHigh60,
);

// 5. Zero-vector guard → AimLevel.
checkMotion(
    "zero vector (0,0,0) → AimLevel",
    { x: 0, y: 0, z: 0 },
    AIM_MOTIONS.AimLevel,
);

// --- Extra bucket-boundary tests so the branch tree is fully exercised ---

// 6. Mostly horizontal with a tiny upward tilt → zAngle ~5° → still AimLevel.
//    normalize(10, 0, 1).z = 0.0995; * 90 = 8.95; bucket >= 7.5 → AimHigh15.
checkMotion(
    "barely-up tilt (x=10, z=1, zAngle ~8.95°) → AimHigh15",
    { x: 10, y: 0, z: 1 },
    AIM_MOTIONS.AimHigh15,
);

// 7. 30° down → -30° → bucket > -37.5 → AimLow30.
//    Hand-calc: normalize(cos30, 0, -sin30) = (0.866, 0, -0.5); * 90 = -45?
//    Actually: cos(30°) = 0.866, sin(30°) = 0.5. So vec=(0.866, 0, -0.5).
//    zAngle = -0.5 * 90 = -45 → bucket > -52.5 → AimLow45.
checkMotion(
    "30° down (cos30, 0, -sin30) → AimLow45 (zAngle -45)",
    { x: Math.cos(Math.PI / 6), y: 0, z: -Math.sin(Math.PI / 6) },
    AIM_MOTIONS.AimLow45,
);

// 8. Direct ACE branch-boundary: zAngle exactly at 82.5 → AimHigh90 (>=).
//    To hit zAngle exactly 82.5, need vz/len = 82.5/90 = 0.9166...
//    Pick (vx, vz) such that vz/sqrt(vx^2+vz^2) = 0.9166... → vx = vz * tan(acos(0.9166)).
//    Simpler: solve cos(theta)=0.4 (since sin=0.9166), use vx=tan, vz=??? Let's just
//    compute numerically: vec=(sqrt(1-0.9166^2), 0, 0.9166) so |vec|=1 and z=0.9166.
//    z*90 = 82.5 exactly → bucket >= 82.5 → AimHigh90.
checkMotion(
    "boundary zAngle == 82.5 exactly → AimHigh90 (>=)",
    { x: Math.sqrt(1 - (82.5 / 90) ** 2), y: 0, z: 82.5 / 90 },
    AIM_MOTIONS.AimHigh90,
);

// 9. Just below the same boundary: zAngle = 82.4 → AimHigh75 (next bucket).
checkMotion(
    "just under 82.5 (zAngle=82.4) → AimHigh75",
    { x: Math.sqrt(1 - (82.4 / 90) ** 2), y: 0, z: 82.4 / 90 },
    AIM_MOTIONS.AimHigh75,
);

// 10. Low-side strict-inequality test: zAngle = -7.5 exactly.
//     ACE has `else if (zAngle > -7.5)` → -7.5 is NOT > -7.5 → falls through to
//     `else if (zAngle > -22.5)` → -7.5 IS > -22.5 → AimLow15.
checkMotion(
    "boundary zAngle == -7.5 exactly → AimLow15 (strict >)",
    { x: Math.sqrt(1 - (7.5 / 90) ** 2), y: 0, z: -7.5 / 90 },
    AIM_MOTIONS.AimLow15,
);

// --- Defensive input handling ---

check(
    "null vector → AimLevel",
    getAimLevelForVelocity(null) === AIM_MOTIONS.AimLevel,
);
check(
    "undefined vector → AimLevel",
    getAimLevelForVelocity(undefined) === AIM_MOTIONS.AimLevel,
);
check(
    "NaN component → AimLevel (treated as zero/invalid)",
    getAimLevelForVelocity({ x: NaN, y: 0, z: 1 }) === AIM_MOTIONS.AimLevel,
);

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log("All Phase 7 aim-level tests PASS.");
}
