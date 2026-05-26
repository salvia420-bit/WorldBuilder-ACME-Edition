// Wave 7 / Phase 21 — `ui/ac_attack_type_for_weapon.js` unit tests.
//
// Focuses on the unarmed power-level branch added in Phase 21:
//   `Player_Melee.cs:462` —
//     AttackType = PowerLevel > KickThreshold && !IsDualWieldAttack
//         ? AttackType.Kick (0x08) : AttackType.Punch (0x01)
//   with `KickThreshold = 0.75f` at `Player_Melee.cs:432`.
//
// Also re-verifies Wave 6's 4-case precedence regression (spear → Thrust,
// sword → Thrust|Slash, fallback → Slash, null → Punch) still passes for
// existing one-arg callers.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_ac_attack_type_for_weapon.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperUrl =
    "file://" + resolvePath(__dirname, "ui/ac_attack_type_for_weapon.js");
const { ATTACK_TYPE, inferAttackTypeForWeapon } = await import(helperUrl);

let failed = 0;
let passed = 0;
function hex(u) { return "0x" + ((u >>> 0).toString(16).padStart(4, "0")); }
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1; else passed += 1;
}
function checkType(name, weapon, opts, expected) {
    const got = inferAttackTypeForWeapon(weapon, opts);
    const ok = (got >>> 0) === (expected >>> 0);
    check(
        name,
        ok,
        `weapon=${weapon === null ? "null" : "..."} ` +
        `opts=${opts ? JSON.stringify(opts) : "<none>"} ` +
        `expected=${hex(expected)} got=${hex(got)}`,
    );
}

console.log("===========================================================");
console.log("Wave 7 / Phase 21 — ac_attack_type_for_weapon unit tests");
console.log("===========================================================");

// =========================================================================
// Phase 21 — unarmed power-level branch (the new logic)
// =========================================================================

// 1. Low power unarmed → Punch (well below 0.75 threshold).
checkType("unarmed @ powerLevel=0.10 → Punch", null, { powerLevel: 0.10 }, ATTACK_TYPE.Punch);

// 2. Medium power unarmed → Punch (still below 0.75 — covers the wiki's
//    "Medium PB = Punch" maneuver-table row).
checkType("unarmed @ powerLevel=0.50 → Punch", null, { powerLevel: 0.50 }, ATTACK_TYPE.Punch);

// 3. High power unarmed → Kick (above 0.75 — the wiki's "Full PB = Kick").
checkType("unarmed @ powerLevel=0.90 → Kick", null, { powerLevel: 0.90 }, ATTACK_TYPE.Kick);

// 4. Boundary: ACE uses STRICT `PowerLevel > KickThreshold` (not >=),
//    so 0.75 exactly must still return Punch.
checkType(
    "unarmed @ powerLevel=0.75 EXACTLY → Punch (strict > 0.75 in Player_Melee.cs:462)",
    null,
    { powerLevel: 0.75 },
    ATTACK_TYPE.Punch,
);

// 5. Just above the boundary: 0.7500001 → Kick (any positive delta over
//    the threshold flips).
checkType(
    "unarmed @ powerLevel=0.7500001 → Kick (just above threshold)",
    null,
    { powerLevel: 0.7500001 },
    ATTACK_TYPE.Kick,
);

// 6. Max power → Kick.
checkType("unarmed @ powerLevel=1.0 → Kick", null, { powerLevel: 1.0 }, ATTACK_TYPE.Kick);

// 7. Dual-wield clause: even at max power, dual-wield unarmed never kicks
//    (the offhand fist takes the slot). Mirrors `!IsDualWieldAttack` in
//    `Player_Melee.cs:462`.
checkType(
    "unarmed @ powerLevel=1.0 + isDualWield → Punch (dual-wield gates out Kick)",
    null,
    { powerLevel: 1.0, isDualWield: true },
    ATTACK_TYPE.Punch,
);

// =========================================================================
// Backward-compat — opts is optional (must not break Wave 6 one-arg callers)
// =========================================================================

// 8. Wave 6 regression: `inferAttackTypeForWeapon(null)` with no second
//    arg must still return Punch (matches the plan line 948 acceptance:
//    "inferAttackTypeForWeapon(null) → 0x01 (unarmed: Punch).").
checkType("unarmed, no opts (one-arg legacy) → Punch", null, undefined, ATTACK_TYPE.Punch);

// 9. Defensive: powerLevel = NaN → treated as 0 → Punch.
checkType(
    "unarmed @ powerLevel=NaN → Punch (defensive default)",
    null,
    { powerLevel: NaN },
    ATTACK_TYPE.Punch,
);

// 10. Defensive: empty opts object → Punch (no power → default 0).
checkType(
    "unarmed @ opts={} → Punch (no power → default 0 → Punch)",
    null,
    {},
    ATTACK_TYPE.Punch,
);

// =========================================================================
// Wave 6 precedence regression check (4 documented cases must still pass)
// =========================================================================

// 11. Spear (wire W_AttackType = Thrust) → Thrust (verbatim).
checkType(
    "Wave 6: spear with W_AttackType=Thrust → Thrust",
    { attackType: ATTACK_TYPE.Thrust, equipMask: 0x02000000 /* TWO_HANDED */ },
    undefined,
    ATTACK_TYPE.Thrust,
);

// 12. Sword (wire W_AttackType = Thrust|Slash multi-bit) → returned verbatim,
//     CMT picker handles the IsThrustSlash branch downstream.
checkType(
    "Wave 6: sword with W_AttackType=Thrust|Slash → Thrust|Slash (multi-bit)",
    { attackType: ATTACK_TYPE.Thrust | ATTACK_TYPE.Slash, equipMask: 0x00100000 /* MELEE */ },
    undefined,
    ATTACK_TYPE.Thrust | ATTACK_TYPE.Slash,
);

// 13. Fallback (wire attackType = 0, mask = MELEE_WEAPON) → Slash heuristic.
checkType(
    "Wave 6: melee fallback (no wire attackType, MELEE mask) → Slash",
    { attackType: 0, equipMask: 0x00100000 /* MELEE */ },
    undefined,
    ATTACK_TYPE.Slash,
);

// 14. Caster → Undef (magic path bypasses CMT).
checkType(
    "Wave 6: caster mask → Undef",
    { attackType: 0, equipMask: 0x01000000 /* CASTER */ },
    undefined,
    ATTACK_TYPE.Undef,
);

// =========================================================================
// Sanity: weapon-equipped callers IGNORE opts (only unarmed branch consults)
// =========================================================================

// 15. Confirm: passing powerLevel with an equipped weapon doesn't change
//     the wire-W_AttackType-driven answer. Wave 7 only touched the
//     unarmed branch; weapon branches are unchanged.
checkType(
    "Wave 6 unchanged: spear + powerLevel=0.9 still returns Thrust",
    { attackType: ATTACK_TYPE.Thrust, equipMask: 0x02000000 },
    { powerLevel: 0.9 },
    ATTACK_TYPE.Thrust,
);

// 16. ATTACK_TYPE.Kick is 0x08 (and not 0x10 or 0x80) — sanity check
//     that the enum hasn't shifted.
check(
    "ATTACK_TYPE.Kick === 0x08",
    ATTACK_TYPE.Kick === 0x08,
    `got ${hex(ATTACK_TYPE.Kick)}`,
);

console.log("===========================================================");
console.log(`Result: ${passed} pass, ${failed} fail`);
console.log("===========================================================");
process.exit(failed === 0 ? 0 : 1);
