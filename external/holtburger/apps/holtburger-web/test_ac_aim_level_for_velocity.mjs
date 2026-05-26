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
const {
    AIM_MOTIONS,
    getAimLevelForVelocity,
    solveBallisticArcZAngle,
    getAimLevelForBallisticArc,
} = await import(helperUrl);

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

// =============================================================
// Wave 7 / Phase 19 — gravity-arc resolver tests
// =============================================================
//
// `solveBallisticArcZAngle` returns sin(theta_low), which is what
// `GetAimLevel` calls `normalize(velocity).Z`. Then bucketing into
// `AIM_MOTIONS` via `getAimLevelForBallisticArc` runs the same branch
// tree as the direct-line predictor.

console.log("");
console.log("--- Wave 7 / Phase 19 — gravity-arc resolver ---");

check(
    "solveBallisticArcZAngle is a function",
    typeof solveBallisticArcZAngle === "function",
);
check(
    "getAimLevelForBallisticArc is a function",
    typeof getAimLevelForBallisticArc === "function",
);

// W7.1 — At-feet target (target directly below origin → straight down).
// horizDist == 0, dz < 0 → solver returns -1 → -1 * 90 = -90 →
// branch tree fall-through to AimLow90.
{
    const motion = getAimLevelForBallisticArc({
        origin: { x: 0, y: 0, z: 5 },
        target: { x: 0, y: 0, z: 0 },
        projectileSpeed: 20.0,
    });
    check(
        "at-feet target (target directly below origin) → AimLow90",
        (motion >>> 0) === (AIM_MOTIONS.AimLow90 >>> 0),
        `expected=${hex(AIM_MOTIONS.AimLow90)} got=${hex(motion)}`,
    );
}

// W7.2 — Same-height target 1m horizontal away, v=20 m/s.
// Δz=0, Δx=1, v²=400, disc = v⁴ - g·(g·1 + 2·0·v²) = 160000 - 9.81·9.81
//   ≈ 159904 → √disc ≈ 399.88 → tan(θ_low) = (400 - 399.88) / (9.81·1)
//   ≈ 0.0125 → θ_low ≈ 0.0125 rad ≈ 0.715° → sin(θ) * 90 ≈ 1.12 →
// strictly between [-7.5, 7.5) → AimLevel. Very near-level shot.
{
    const motion = getAimLevelForBallisticArc({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 1, y: 0, z: 0 },
        projectileSpeed: 20.0,
    });
    check(
        "near level same-height target (1m horiz, v=20) → AimLevel",
        (motion >>> 0) === (AIM_MOTIONS.AimLevel >>> 0),
        `expected=${hex(AIM_MOTIONS.AimLevel)} got=${hex(motion)}`,
    );
}

// W7.3 — Mid-range level shot: 10m horizontal, v=30 m/s, Δz=0.
// v² = 900, v⁴ = 810000, g·Δx² = 981, 2·Δz·v² = 0
// disc = 810000 - 9.81·981 = 810000 - 9623.61 ≈ 800376.4
// √disc ≈ 894.638 → tan(θ_low) = (900 - 894.638) / (9.81·10)
//   ≈ 5.362 / 98.1 ≈ 0.05466 → θ_low ≈ 3.13° → sin(θ)*90 ≈ 4.92°
// Hmm — that buckets to AimLevel still (< 7.5). The plan said
// "AimHighN (some upward arc)" — at v=30 / 10m the required arc is
// actually small. Let me check the solver returns >0 (upward, not
// down) — the bucket might be AimLevel but the z-angle is non-zero.
// Adjusted to test the *sign* and that it's >0 (upward) — the bucket
// flip happens at longer ranges, not 10m.
{
    const z = solveBallisticArcZAngle({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 10, y: 0, z: 0 },
        projectileSpeed: 30.0,
    });
    check(
        "mid-range level shot (10m horiz, v=30) → positive z (upward arc)",
        z !== null && z > 0 && z < 0.2,
        `z=${z}`,
    );
}

// W7.4 — Long level shot: 30m horizontal, v=30 m/s, Δz=0.
// v² = 900, v⁴ = 810000, g·Δx² = 9·g·100 = 9810·9 = wait
// Δx² = 900, g·Δx² = 9.81·900 = 8829, 2·0·900 = 0
// disc = 810000 - 9.81·8829 = 810000 - 86612.49 ≈ 723387.5
// √disc ≈ 850.52 → tan(θ_low) = (900 - 850.52)/(9.81·30) ≈ 49.48 / 294.3
//   ≈ 0.1681 → θ_low ≈ 9.55° → sin·90 ≈ 14.92° → bucket AimHigh15
//   (≥7.5 and <22.5). Acceptance bar said "at least AimHigh15".
{
    const motion = getAimLevelForBallisticArc({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 30, y: 0, z: 0 },
        projectileSpeed: 30.0,
    });
    // Acceptance: motion is one of AimHigh15..AimHigh90 (any upward arc
    // bucket). The expected hand-calc lands AimHigh15.
    const upwardArcMotions = new Set([
        AIM_MOTIONS.AimHigh15, AIM_MOTIONS.AimHigh30, AIM_MOTIONS.AimHigh45,
        AIM_MOTIONS.AimHigh60, AIM_MOTIONS.AimHigh75, AIM_MOTIONS.AimHigh90,
    ].map(v => v >>> 0));
    check(
        "long level shot (30m horiz, v=30) → AimHigh* (upward arc bucket, ≥AimHigh15)",
        upwardArcMotions.has(motion >>> 0),
        `expected one of AimHigh15..AimHigh90, got=${hex(motion)}`,
    );
    // Also pin the exact bucket so we catch regressions in the formula.
    check(
        "long level shot (30m horiz, v=30) → AimHigh15 (specific bucket)",
        (motion >>> 0) === (AIM_MOTIONS.AimHigh15 >>> 0),
        `expected=${hex(AIM_MOTIONS.AimHigh15)} got=${hex(motion)}`,
    );
}

// W7.5 — Out-of-range target: 1000m level shot at v=10 m/s.
// v² = 100, v⁴ = 10000, g·Δx² = 9.81·1e6 = 9.81e6.
// disc = 10000 - 9.81 * 9.81e6 ≈ -9.6e7 → negative → out of range.
// solveBallisticArcZAngle returns null; getAimLevelForBallisticArc
// falls back to direct-line on (target - origin). Direct line of a
// level shot is `(1000, 0, 0)`, zAngle = 0 → AimLevel.
{
    const z = solveBallisticArcZAngle({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 1000, y: 0, z: 0 },
        projectileSpeed: 10.0,
    });
    check(
        "out-of-range solver → null (target beyond ballistic range)",
        z === null,
        `expected null, got=${z}`,
    );
    const motion = getAimLevelForBallisticArc({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 1000, y: 0, z: 0 },
        projectileSpeed: 10.0,
    });
    // Direct-line fallback on a level shot → AimLevel.
    check(
        "out-of-range bucket → direct-line fallback returns AimLevel for level shot",
        (motion >>> 0) === (AIM_MOTIONS.AimLevel >>> 0),
        `expected=${hex(AIM_MOTIONS.AimLevel)} got=${hex(motion)}`,
    );
}

// W7.6 — Edge cases: zero distance + zero speed.
{
    // Identically co-located target → solver returns null → direct-line
    // fallback on zero vector → AimLevel.
    const motionColocated = getAimLevelForBallisticArc({
        origin: { x: 5, y: 5, z: 5 },
        target: { x: 5, y: 5, z: 5 },
        projectileSpeed: 20.0,
    });
    check(
        "co-located origin/target → fallback to AimLevel",
        (motionColocated >>> 0) === (AIM_MOTIONS.AimLevel >>> 0),
        `expected=${hex(AIM_MOTIONS.AimLevel)} got=${hex(motionColocated)}`,
    );
    // Zero projectile speed → solver returns null → direct-line fallback.
    const zeroSpeedZ = solveBallisticArcZAngle({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 10, y: 0, z: 0 },
        projectileSpeed: 0,
    });
    check(
        "zero projectile speed → solver returns null",
        zeroSpeedZ === null,
        `expected null, got=${zeroSpeedZ}`,
    );
    const zeroSpeedMotion = getAimLevelForBallisticArc({
        origin: { x: 0, y: 0, z: 0 },
        target: { x: 10, y: 0, z: 0 },
        projectileSpeed: 0,
    });
    check(
        "zero projectile speed → fallback returns AimLevel for level shot",
        (zeroSpeedMotion >>> 0) === (AIM_MOTIONS.AimLevel >>> 0),
        `expected=${hex(AIM_MOTIONS.AimLevel)} got=${hex(zeroSpeedMotion)}`,
    );
}

// --- Summary ---
console.log("");
console.log(`Cases: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log("All Phase 7 + Phase 19 aim-level tests PASS.");
}
