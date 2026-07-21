#!/usr/bin/env node
// rynth_suit_solver_test.cjs — unit test for rynth/suit/suit_solver.js
// (WP-13, Tier-0 armor coverage gaps). Verifies the ported EquipMask /
// IsBodyArmor / GetTotalBitsSet bit-ops, the nine-slot gap computation over
// synthetic inventory snapshots, and — critically — that the solver NEVER
// touches an appraisal surface (RequestId / item profile / value stream).
//
// Run: node rynth_suit_solver_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0,
  fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}
function eqSet(a, b) {
  const A = new Set(a),
    B = new Set(b);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

// EquipMask bits used to build synthetic worn/pack rows.
const M = {
  HEAD_WEAR: 0x00000001,
  CHEST_WEAR: 0x00000002,
  HAND_WEAR: 0x00000020,
  FOOT_WEAR: 0x00000100,
  CHEST_ARMOR: 0x00000200,
  ABDOMEN_ARMOR: 0x00000400,
  UPPER_ARM_ARMOR: 0x00000800,
  LOWER_ARM_ARMOR: 0x00001000,
  UPPER_LEG_ARMOR: 0x00002000,
  LOWER_LEG_ARMOR: 0x00004000,
  NECK_WEAR: 0x00008000,
  FINGER_WEAR_LEFT: 0x00040000,
  MELEE_WEAPON: 0x00100000,
  SHIELD: 0x00200000,
};
// A worn row: equipMask == validLocations == the occupied slot(s).
function worn(mask, extra) {
  return { guid: 1, name: "x", equipMask: mask >>> 0, validLocations: mask >>> 0, ...(extra || {}) };
}
// A pack row: not worn (equipMask 0) but could go somewhere.
function pack(valid) {
  return { guid: 2, name: "y", equipMask: 0, validLocations: valid >>> 0 };
}
const ALL9 = ["head", "chest", "abdomen", "upper_arms", "lower_arms", "hands", "upper_legs", "lower_legs", "feet"];

// A host mock whose appraisal surfaces THROW if called — proves the solver
// never appraises. `TryGetPlayerInventory` is the only allowed read.
function makeAppraisalTrap(rows) {
  const touched = [];
  const trap = (n) => () => {
    touched.push(n);
    throw new Error(`appraisal surface ${n} must not be called by suit_solver`);
  };
  return {
    touched,
    TryGetPlayerInventory: () => rows,
    RequestId: trap("RequestId"),
    HasAppraisalData: trap("HasAppraisalData"),
    TryGetItemProfile: trap("TryGetItemProfile"),
    AppraiseItem: trap("AppraiseItem"),
    TryGetObjectIntProperty: trap("TryGetObjectIntProperty"),
  };
}

(async () => {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "rynth/suit/suit_solver.js")).href
  );
  const { coverageGaps, getTotalBitsSet, IS_BODY_ARMOR, ARMOR_SLOTS, EQUIP_MASK } = mod;

  // --- ported consts -------------------------------------------------------
  check("IS_BODY_ARMOR == 0x00007F21", IS_BODY_ARMOR === 0x00007f21, `got ${IS_BODY_ARMOR.toString(16)}`);
  check(
    "IS_BODY_ARMOR is the OR of the 9 ARMOR_SLOTS",
    ARMOR_SLOTS.reduce((m, s) => m | s.mask, 0) >>> 0 === IS_BODY_ARMOR
  );
  check("ARMOR_SLOTS has exactly 9 slots", ARMOR_SLOTS.length === 9);
  check("getTotalBitsSet(0x7F21) == 9", getTotalBitsSet(0x7f21) === 9);
  check("getTotalBitsSet(0) == 0", getTotalBitsSet(0) === 0);
  check("getTotalBitsSet(0xFFFFFFFF) == 32", getTotalBitsSet(0xffffffff) === 32);
  check("EQUIP_MASK.CHEST_ARMOR == 0x200", EQUIP_MASK.CHEST_ARMOR === 0x200);

  // --- empty snapshot: unknown, not "naked" -------------------------------
  {
    const r = coverageGaps([]);
    check("empty: all 9 slots reported as gaps", eqSet(r.gaps, ALL9) && r.gapCount === 9);
    check("empty: coveredCount 0, wornArmorCount 0", r.coveredCount === 0 && r.wornArmorCount === 0);
    check("empty: streamed=false (unknown, not naked)", r.streamed === false);
  }

  // --- fully armored: no gaps ---------------------------------------------
  {
    const rows = [
      worn(M.HEAD_WEAR),
      worn(M.HAND_WEAR),
      worn(M.FOOT_WEAR),
      worn(M.CHEST_ARMOR),
      worn(M.ABDOMEN_ARMOR),
      worn(M.UPPER_ARM_ARMOR),
      worn(M.LOWER_ARM_ARMOR),
      worn(M.UPPER_LEG_ARMOR),
      worn(M.LOWER_LEG_ARMOR),
    ];
    const r = coverageGaps(rows);
    check("full suit: zero gaps", r.gapCount === 0 && r.gaps.length === 0);
    check("full suit: 9 covered", r.coveredCount === 9 && eqSet(r.covered, ALL9));
    check("full suit: coveredMask == IS_BODY_ARMOR", r.coveredMask === IS_BODY_ARMOR);
    check("full suit: streamed=true", r.streamed === true);
  }

  // --- partial: only helm + breastplate -----------------------------------
  {
    const r = coverageGaps([worn(M.HEAD_WEAR), worn(M.CHEST_ARMOR)]);
    check(
      "partial: gaps are the 7 uncovered slots",
      eqSet(r.gaps, ["abdomen", "upper_arms", "lower_arms", "hands", "upper_legs", "lower_legs", "feet"])
    );
    check("partial: covered == head+chest", eqSet(r.covered, ["head", "chest"]) && r.wornArmorCount === 2);
  }

  // --- multi-slot item (hauberk covers chest+abdomen+arms) ----------------
  {
    const hauberk = M.CHEST_ARMOR | M.ABDOMEN_ARMOR | M.UPPER_ARM_ARMOR | M.LOWER_ARM_ARMOR;
    const r = coverageGaps([worn(hauberk), worn(M.HEAD_WEAR)]);
    check(
      "hauberk: one item fills 4 slots, gaps = hands/legs/feet",
      eqSet(r.gaps, ["hands", "upper_legs", "lower_legs", "feet"])
    );
    check("hauberk: wornArmorCount counts items not slots (2)", r.wornArmorCount === 2 && r.coveredCount === 5);
  }

  // --- validLocations recovers coverage when equipMask under-reports ------
  {
    // equipMask has only the chest bit, but validLocations spans chest+abdomen.
    const row = { guid: 3, name: "z", equipMask: M.CHEST_ARMOR, validLocations: M.CHEST_ARMOR | M.ABDOMEN_ARMOR };
    const r = coverageGaps([row]);
    check("validLocations union: abdomen counted from a chest-equipped item", r.covered.includes("abdomen"));
  }

  // --- pack items never reduce gaps ---------------------------------------
  {
    const r = coverageGaps([pack(M.CHEST_ARMOR), pack(M.HEAD_WEAR)]);
    check("pack armor is ignored (still all 9 gaps)", eqSet(r.gaps, ALL9) && r.wornArmorCount === 0);
  }

  // --- worn non-armor (weapon/shield/ring/necklace/cloth-chest) ignored ---
  {
    const rows = [
      worn(M.MELEE_WEAPON),
      worn(M.SHIELD),
      worn(M.FINGER_WEAR_LEFT),
      worn(M.NECK_WEAR),
      worn(M.CHEST_WEAR), // clothing chest — NOT a body-armor bit
    ];
    const r = coverageGaps(rows);
    check("non-armor worn items cover nothing", eqSet(r.gaps, ALL9) && r.coveredCount === 0);
  }

  // --- snapshot shapes: {inventory:[...]} and host -------------------------
  {
    const r = coverageGaps({ inventory: [worn(M.HEAD_WEAR)] });
    check("snapshot.inventory shape works", eqSet(r.covered, ["head"]));
  }
  {
    const host = makeAppraisalTrap([worn(M.CHEST_ARMOR), worn(M.HEAD_WEAR)]);
    const r = coverageGaps(host);
    check("host shape (TryGetPlayerInventory) works", eqSet(r.covered, ["head", "chest"]));
    check("NO appraisal call — trap surfaces untouched", host.touched.length === 0, host.touched.join(","));
  }

  // --- survival: never throws on garbage / degrades to no-op --------------
  {
    let threw = false;
    let out = [];
    try {
      out = [
        coverageGaps(undefined),
        coverageGaps(null),
        coverageGaps(42),
        coverageGaps("nope"),
        coverageGaps({ inventory: "notarray" }),
        coverageGaps([null, 7, {}, { equipMask: "bad", validLocations: null }]),
        coverageGaps({ TryGetPlayerInventory: () => { throw new Error("boom"); } }),
      ];
    } catch (_) {
      threw = true;
    }
    check("never throws on garbage input", threw === false);
    check(
      "garbage degrades to no-op (unknown gaps, streamed=false)",
      out.slice(0, 5).every((r) => r.gapCount === 9 && r.streamed === false)
    );
    check(
      "throwing host degrades to no-op",
      out[6] && out[6].gapCount === 9 && out[6].streamed === false
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
