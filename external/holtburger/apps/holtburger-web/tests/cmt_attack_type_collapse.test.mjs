// cmt_attack_type_collapse.test.mjs — DEC-16 (PARITY-C, 2026-08-13).
//
// The CombatManeuverTable is keyed on SINGLE-BIT AttackType values. All
// 102 rows of retail CMT 0x30000000 were dumped and every one is single
// bit (`crates/holtburger-dat/examples/dump_cmt_attack_types.rs`):
//   0x0001x11 0x0002x12 0x0004x21 0x0008x3 0x0010x7 0x0020x9 0x0040x9
//   0x0080x6  0x0100x6  0x0200..0x4000 x3 each
//   SwordCombat rows for attack_type 0x06 (Thrust|Slash): 0
// and ACE's lookup is an exact dictionary match
// (`ACE.DatLoader/FileTypes/CombatManeuverTable.cs:75`).
//
// So the wire `W_AttackType`, which is multi-bit on most real weapons,
// must be collapsed first. ACE does that in
// `ACE.Server/WorldObjects/WorldObject_Weapon.cs:1050-1161
// GetAttackType(stance, powerLevel, offhand)` with
// `ThrustThreshold = 0.33f` (line 1033), called from
// `Player_Melee.cs:456`. These cases transcribe that function.
//
// Run: node tests/cmt_attack_type_collapse.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import {
  ATTACK_TYPE,
  THRUST_THRESHOLD,
  resolveAttackTypeForStance,
  isThrustSlashAttackType,
} from "../ui/ac_attack_type_for_weapon.js";

const SWORD = 0x8000003e;
const SWORD_SHIELD = 0x80000040;
const DUAL_WIELD = 0x80000046;
const TWO_HANDED = 0x80000044;
const HAND = 0x8000003c;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

test("ThrustThreshold matches WorldObject_Weapon.cs:1033", () => {
  assert.equal(THRUST_THRESHOLD, 0.33);
});

test("real weapon masks collapse to a single bit in every melee stance", () => {
  // The W_AttackType masks that actually occur on retail weapons:
  // Thrust|Slash (swords), DoubleSlash|DoubleThrust (daggers),
  // TripleSlash|TripleThrust, and the plain single bits.
  // Multi-strike masks only occur on one-handed stances; the two-handed
  // and unarmed stances only ever see Thrust|Slash / single bits.
  const cases = [
    [SWORD, [0x06, 0xa0, 0x140, 0x02, 0x04]],
    [SWORD_SHIELD, [0x06, 0xa0, 0x140, 0x02, 0x04]],
    [DUAL_WIELD, [0x06, 0xa0, 0x140, 0x02, 0x04]],
    [TWO_HANDED, [0x06, 0x02, 0x04]],
    [HAND, [0x01, 0x08]],
  ];
  for (const [stance, masks] of cases) {
    for (const m of masks) {
      for (const p of [0, 0.2, 0.33, 0.5, 0.7, 1.0]) {
        const out = resolveAttackTypeForStance(m, stance, p);
        const bits = out.toString(2).split("").filter((c) => c === "1").length;
        assert.ok(bits <= 1,
          `stance=0x${stance.toString(16)} mask=0x${m.toString(16)} p=${p} -> 0x${out.toString(16)} (${bits} bits)`);
      }
    }
  }
});

test("ACE-faithful: an unhandled mask in an unhandled stance stays multi-bit", () => {
  // Slash|DoubleSlash (0x24) in SwordShieldCombat hits none of ACE's
  // branches (no TripleThrust, no DoubleThrust, no Thrust bit) and the
  // universal Thrust|Slash collapse does not apply either — so ACE
  // itself would hand a multi-bit key to GetMotion and miss. We match
  // that rather than inventing a client-only reduction: the client must
  // never predict a swing the server would not have chosen.
  assert.equal(resolveAttackTypeForStance(0x24, SWORD_SHIELD, 0.0), 0x24);
});

test("universal Thrust|Slash collapse (WorldObject_Weapon.cs:1154-1160)", () => {
  const sword = ATTACK_TYPE.Thrust | ATTACK_TYPE.Slash; // 0x06 — most swords
  assert.equal(resolveAttackTypeForStance(sword, TWO_HANDED, 1.0), ATTACK_TYPE.Slash);
  assert.equal(resolveAttackTypeForStance(sword, TWO_HANDED, 0.33), ATTACK_TYPE.Slash);
  assert.equal(resolveAttackTypeForStance(sword, TWO_HANDED, 0.32), ATTACK_TYPE.Thrust);
  assert.equal(resolveAttackTypeForStance(sword, TWO_HANDED, 0.0), ATTACK_TYPE.Thrust);
});

test("SwordCombat forces slash on a multi-strike weapon (lines 1131-1152)", () => {
  // DoubleSlash|DoubleThrust dagger, no Thrust bit -> DoubleSlash at any power
  const dagger = ATTACK_TYPE.DoubleSlash | ATTACK_TYPE.DoubleThrust; // 0xA0
  assert.equal(resolveAttackTypeForStance(dagger, SWORD, 1.0), ATTACK_TYPE.DoubleSlash);
  assert.equal(resolveAttackTypeForStance(dagger, SWORD, 0.0), ATTACK_TYPE.DoubleSlash);
  // rapier: Thrust|DoubleSlash -> DoubleSlash high, Thrust low
  const rapier = ATTACK_TYPE.Thrust | ATTACK_TYPE.DoubleSlash;
  assert.equal(resolveAttackTypeForStance(rapier, SWORD, 0.9), ATTACK_TYPE.DoubleSlash);
  assert.equal(resolveAttackTypeForStance(rapier, SWORD, 0.1), ATTACK_TYPE.Thrust);
  // bugged stiletto: DoubleThrust only -> Thrust (line 1150)
  assert.equal(resolveAttackTypeForStance(ATTACK_TYPE.DoubleThrust, SWORD, 1.0), ATTACK_TYPE.Thrust);
});

test("SwordShieldCombat forces thrust on a multi-strike weapon (lines 1108-1129)", () => {
  const dagger = ATTACK_TYPE.DoubleSlash | ATTACK_TYPE.DoubleThrust;
  assert.equal(resolveAttackTypeForStance(dagger, SWORD_SHIELD, 1.0), ATTACK_TYPE.DoubleThrust);
  const rapier = ATTACK_TYPE.Thrust | ATTACK_TYPE.DoubleThrust;
  assert.equal(resolveAttackTypeForStance(rapier, SWORD_SHIELD, 0.9), ATTACK_TYPE.DoubleThrust);
  assert.equal(resolveAttackTypeForStance(rapier, SWORD_SHIELD, 0.1), ATTACK_TYPE.Thrust);
  // tachi: Thrust|DoubleSlash -> Thrust (line 1128)
  const tachi = ATTACK_TYPE.Thrust | ATTACK_TYPE.DoubleSlash;
  assert.equal(resolveAttackTypeForStance(tachi, SWORD_SHIELD, 1.0), ATTACK_TYPE.Thrust);
});

test("DualWieldCombat power split (lines 1063-1106)", () => {
  const triple = ATTACK_TYPE.TripleThrust | ATTACK_TYPE.TripleSlash;
  assert.equal(resolveAttackTypeForStance(triple, DUAL_WIELD, 0.5), ATTACK_TYPE.TripleSlash);
  assert.equal(resolveAttackTypeForStance(triple, DUAL_WIELD, 0.1), ATTACK_TYPE.TripleThrust);
  const dbl = ATTACK_TYPE.DoubleThrust | ATTACK_TYPE.DoubleSlash;
  assert.equal(resolveAttackTypeForStance(dbl, DUAL_WIELD, 0.5), ATTACK_TYPE.DoubleSlash);
  assert.equal(resolveAttackTypeForStance(dbl, DUAL_WIELD, 0.1), ATTACK_TYPE.DoubleThrust);
});

test("Offhand bits are stripped from a main-hand attack (lines 1057-1061)", () => {
  const bad = ATTACK_TYPE.Slash | ATTACK_TYPE.OffhandSlash;
  assert.equal(resolveAttackTypeForStance(bad, SWORD, 1.0), ATTACK_TYPE.Slash);
});

test("already-single-bit masks pass through unchanged", () => {
  for (const t of [ATTACK_TYPE.Punch, ATTACK_TYPE.Kick, ATTACK_TYPE.Slash, ATTACK_TYPE.Thrust]) {
    assert.equal(resolveAttackTypeForStance(t, HAND, 0.5), t);
  }
});

test("Undef in, Undef out", () => {
  assert.equal(resolveAttackTypeForStance(0, SWORD, 1.0), ATTACK_TYPE.Undef);
});

test("IsThrustSlash mirrors WorldObject_Weapon.cs:1039-1048", () => {
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.Thrust | ATTACK_TYPE.Slash), true);
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.DoubleSlash | ATTACK_TYPE.DoubleThrust), true);
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.TripleSlash | ATTACK_TYPE.TripleThrust), true);
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.DoubleSlash), true); // stiletto
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.Slash), false);
  assert.equal(isThrustSlashAttackType(ATTACK_TYPE.Punch), false);
});

if (process.exitCode) console.error(`\n${passed} passed, failures above`);
else console.log(`cmt_attack_type_collapse: ${passed}/${passed} passed`);
