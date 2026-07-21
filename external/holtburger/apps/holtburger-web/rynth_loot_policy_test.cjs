#!/usr/bin/env node
// rynth_loot_policy_test.cjs — unit test for rynth/loot_policy.js, the pure
// VTank-semantics first-match loot evaluator + TierCalculator port.
//
// Coverage: greedy/minValue=0 value-floor parity with RynthLootLoop's shipped
// behavior (keep iff Value(19) >= minValue); the TierCalculator wield/
// workmanship ladder; first-match ordering; unmatched => leave; degrade-to-
// value when the item is un-appraised (empty bag); the survival invariant
// (unknown / throwing condition never escapes and fails its rule).
//
// Run: node rynth_loot_policy_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// STypeInt ids used in fixtures (Chorizite.Common/Enums/PropertyInt.cs).
const P_VALUE = 19, P_ARMOR = 28, P_WORKMANSHIP = 105, P_MATERIAL = 131;
const P_WIELD_REQ = 158, P_WIELD_SKILL = 159, P_WIELD_DIFF = 160, P_TINKERED = 171;
const P_MAX_DAMAGE = 54;

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth/loot_policy.js")).href);
  const { evaluate, tier, preset, greedy, selective, survival, NODES } = mod;

  // ── 1. value-floor parity: greedy reproduces the shipped loop verdict ──────
  // RynthLootLoop: value = Value(19) ?? 0; keep iff value >= minValue else leave.
  const shipped = (value, min) => (value >= min ? "keep" : "leave");
  for (const min of [0, 1, 100, 5000]) {
    let allMatch = true;
    for (const value of [0, 1, 99, 100, 101, 5000, 100000]) {
      const bag = { int: { [P_VALUE]: value } };
      const got = evaluate(bag, greedy({ minValue: min })).verdict;
      if (got !== shipped(value, min)) { allMatch = false; break; }
    }
    check(`greedy(min=${min}) matches shipped value-floor for all sample values`, allMatch);
  }
  eq("greedy default is minValue 0 -> keep any value", evaluate({ int: { [P_VALUE]: 0 } }, greedy()).verdict, "keep");
  eq("greedy string preset resolves via evaluate", evaluate({ int: { [P_VALUE]: 5 } }, "greedy").verdict, "keep");

  // ── 2. TierCalculator ladder (Mag-LootParser/TierCalculator.cs) ────────────
  eq("no workmanship -> tier 0", tier({ int: {} }), 0);
  eq("tinkered -> tier -1", tier({ int: { [P_WORKMANSHIP]: 5, [P_TINKERED]: 1 } }), -1);
  eq("active enchantment -> tier -1", tier({ int: { [P_WORKMANSHIP]: 5 }, activeSpellCount: 2 }), -1);
  eq("workmanship 1..5 -> tier 1", tier({ int: { [P_WORKMANSHIP]: 3 } }), 1);
  eq("workmanship 8 -> tier 4", tier({ int: { [P_WORKMANSHIP]: 8 } }), 4);
  eq("workmanship 10 -> tier 6", tier({ int: { [P_WORKMANSHIP]: 10 } }), 6);
  // Melee raw-skill wield: heavy weapons, diff 350 -> tier 5 (beats wk 1).
  eq("melee raw-skill diff 350 -> tier 5",
    tier({ int: { [P_WORKMANSHIP]: 1, [P_WIELD_REQ]: 2, [P_WIELD_SKILL]: 0x2C, [P_WIELD_DIFF]: 350 } }), 5);
  // Missile raw-skill, diff 385 -> tier 8.
  eq("missile raw-skill diff 385 -> tier 8",
    tier({ int: { [P_WORKMANSHIP]: 1, [P_WIELD_REQ]: 2, [P_WIELD_SKILL]: 0x2F, [P_WIELD_DIFF]: 385 } }), 8);
  // Magic raw-skill (war), diff 290 -> tier 4.
  eq("magic raw-skill diff 290 -> tier 4",
    tier({ int: { [P_WORKMANSHIP]: 1, [P_WIELD_REQ]: 2, [P_WIELD_SKILL]: 0x22, [P_WIELD_DIFF]: 290 } }), 4);
  // Wield-by-level, diff 180 -> tier 8.
  eq("wield-by-level diff 180 -> tier 8",
    tier({ int: { [P_WORKMANSHIP]: 1, [P_WIELD_REQ]: 7, [P_WIELD_DIFF]: 180 } }), 8);
  // Skill-type gate: a melee diff on a MISSILE-skill item does not fire the melee ladder.
  eq("skill-type gates the ladder (missile item, melee diff) -> only workmanship",
    tier({ int: { [P_WORKMANSHIP]: 1, [P_WIELD_REQ]: 2, [P_WIELD_SKILL]: 0x2F, [P_WIELD_DIFF]: 350 } }), 1);
  // Optional pre-resolved spell ladder.
  eq("spellTiers buff VIII -> tier 7",
    tier({ int: { [P_WORKMANSHIP]: 1 }, spellTiers: [{ buff: 8 }] }), 7);
  eq("spellTiers legendary cantrip -> tier 8",
    tier({ int: { [P_WORKMANSHIP]: 1 }, spellTiers: [{ cantrip: 3 }] }), 8);
  // tierGE node routed through evaluate.
  eq("tierGE(4) matches a workmanship-8 item",
    evaluate({ int: { [P_WORKMANSHIP]: 8 } }, [{ action: "keep", all: [{ type: "tierGE", min: 4 }] }]).verdict, "keep");
  eq("tierGE(5) leaves a workmanship-8 item (tier 4)",
    evaluate({ int: { [P_WORKMANSHIP]: 8 } }, [{ action: "keep", all: [{ type: "tierGE", min: 5 }] }]).verdict, "leave");

  // ── 3. first-match ordering ────────────────────────────────────────────────
  const ordered = [
    { name: "salvage-mid", action: "salvage", all: [{ type: "valueGE", min: 100 }] },
    { name: "keep-any", action: "keep", all: [{ type: "valueGE", min: 0 }] },
  ];
  {
    const r = evaluate({ int: { [P_VALUE]: 500 } }, ordered);
    eq("first matching rule wins (value 500 -> salvage)", r.verdict, "salvage");
    eq("first-match reports rule index 0", r.ruleIndex, 0);
  }
  {
    const r = evaluate({ int: { [P_VALUE]: 50 } }, ordered);
    eq("second rule when first fails (value 50 -> keep)", r.verdict, "keep");
    eq("second-match reports rule index 1", r.ruleIndex, 1);
  }
  // AND within a rule: both conditions must hold.
  {
    const rule = [{ action: "keep", all: [{ type: "valueGE", min: 100 }, { type: "armorLevelGE", min: 200 }] }];
    eq("AND rule: value ok but armor low -> leave",
      evaluate({ int: { [P_VALUE]: 500, [P_ARMOR]: 10 } }, rule).verdict, "leave");
    eq("AND rule: both ok -> keep",
      evaluate({ int: { [P_VALUE]: 500, [P_ARMOR]: 300 } }, rule).verdict, "keep");
  }
  // Empty conditions -> unconditional match (VTankLootEvaluator.cs:143).
  eq("empty-condition rule matches unconditionally", evaluate({}, [{ action: "sell", all: [] }]).verdict, "sell");

  // ── 4. unmatched -> leave ──────────────────────────────────────────────────
  {
    const r = evaluate({ int: { [P_VALUE]: 5 } }, [{ action: "keep", all: [{ type: "valueGE", min: 1000000 }] }]);
    eq("unmatched profile -> leave", r.verdict, "leave");
    check("unmatched reports matched=false and ruleIndex -1", r.matched === false && r.ruleIndex === -1);
  }
  eq("empty profile -> leave", evaluate({ int: { [P_VALUE]: 999 } }, []).verdict, "leave");
  // Explicit 'leave' action still reports matched.
  {
    const r = evaluate({ int: { [P_VALUE]: 5 } }, [{ action: "leave", all: [{ type: "valueGE", min: 0 }] }]);
    check("explicit leave action: verdict leave but matched=true", r.verdict === "leave" && r.matched === true);
  }

  // ── 5. degrade-to-value when appraisal absent (empty bag) ──────────────────
  eq("un-appraised bag + greedy(0) -> keep", evaluate({}, greedy()).verdict, "keep");
  eq("un-appraised bag + greedy(100) -> leave (value reads 0)", evaluate({}, greedy({ minValue: 100 })).verdict, "leave");
  eq("un-appraised bag: tier reads 0", tier({}), 0);
  eq("un-appraised bag: armorLevelGE reads 0 -> leave",
    evaluate({}, [{ action: "keep", all: [{ type: "armorLevelGE", min: 1 }] }]).verdict, "leave");
  // Convenience top-level `value` is honored when the int map lacks key 19.
  eq("top-level value convenience honored", evaluate({ value: 500 }, greedy({ minValue: 100 })).verdict, "keep");

  // ── other numeric node types ───────────────────────────────────────────────
  eq("objClass match", evaluate({ objClass: 5 }, [{ action: "keep", all: [{ type: "objClass", objClass: 5 }] }]).verdict, "keep");
  eq("objClass mismatch", evaluate({ objClass: 4 }, [{ action: "keep", all: [{ type: "objClass", objClass: 5 }] }]).verdict, "leave");
  eq("intGE", evaluate({ int: { 300: 40 } }, [{ action: "keep", all: [{ type: "intGE", key: 300, value: 40 }] }]).verdict, "keep");
  eq("intLE", evaluate({ int: { 300: 40 } }, [{ action: "keep", all: [{ type: "intLE", key: 300, value: 40 }] }]).verdict, "keep");
  eq("intE", evaluate({ int: { 300: 40 } }, [{ action: "keep", all: [{ type: "intE", key: 300, value: 41 }] }]).verdict, "leave");
  eq("intFlag set", evaluate({ int: { 300: 0b1010 } }, [{ action: "keep", all: [{ type: "intFlag", key: 300, flag: 0b0010 }] }]).verdict, "keep");
  eq("intFlag clear", evaluate({ int: { 300: 0b1010 } }, [{ action: "keep", all: [{ type: "intFlag", key: 300, flag: 0b0001 }] }]).verdict, "leave");
  // medianDamageGE (LootScoring.cs:453-461): maxD=0 => false; maxD=100 var .2 => 90.
  eq("medianDamageGE maxDamage 0 -> false",
    evaluate({ int: { [P_MAX_DAMAGE]: 0 } }, [{ action: "keep", all: [{ type: "medianDamageGE", min: 1 }] }]).verdict, "leave");
  eq("medianDamageGE 100/var .2 -> median 90 >= 90",
    evaluate({ int: { [P_MAX_DAMAGE]: 100 }, double: { 22: 0.2 } }, [{ action: "keep", all: [{ type: "medianDamageGE", min: 90 }] }]).verdict, "keep");
  eq("totalRatingsGE sums the rating keys",
    evaluate({ int: { 370: 5, 371: 6, 379: 4 } }, [{ action: "keep", all: [{ type: "totalRatingsGE", min: 15 }] }]).verdict, "keep");
  eq("totalRatingsGE below floor -> leave",
    evaluate({ int: { 370: 5 } }, [{ action: "keep", all: [{ type: "totalRatingsGE", min: 15 }] }]).verdict, "leave");
  eq("spellCountGE via count", evaluate({ spellCount: 3 }, [{ action: "keep", all: [{ type: "spellCountGE", min: 3 }] }]).verdict, "keep");
  eq("spellCountGE via spells array", evaluate({ spells: [1, 2] }, [{ action: "keep", all: [{ type: "spellCountGE", min: 2 }] }]).verdict, "keep");
  eq("materialIn hit", evaluate({ int: { [P_MATERIAL]: 42 } }, [{ action: "keep", all: [{ type: "materialIn", materials: [10, 42] }] }]).verdict, "keep");
  eq("materialIn miss", evaluate({ int: { [P_MATERIAL]: 7 } }, [{ action: "keep", all: [{ type: "materialIn", materials: [10, 42] }] }]).verdict, "leave");

  // ── survival invariant: unknown / throwing conditions never escape ─────────
  {
    let threw = false;
    let r;
    try { r = evaluate({ int: { [P_VALUE]: 500 } }, [{ action: "keep", all: [{ type: "no-such-node" }] }]); }
    catch { threw = true; }
    check("unknown node type does not throw and fails its rule", !threw && r && r.verdict === "leave");
  }
  {
    // A condition whose evaluator throws must be caught and fail the rule, then
    // the scan continues to the next rule.
    NODES.__boom = () => { throw new Error("boom"); };
    let threw = false, r;
    try {
      r = evaluate({ int: { [P_VALUE]: 500 } }, [
        { name: "explodes", action: "keep", all: [{ type: "__boom" }] },
        { name: "fallback", action: "salvage", all: [{ type: "valueGE", min: 0 }] },
      ]);
    } catch { threw = true; }
    delete NODES.__boom;
    check("throwing condition caught; scan falls through to next rule",
      !threw && r && r.verdict === "salvage" && r.ruleIndex === 1);
  }

  // ── presets are well-formed and parameterized ──────────────────────────────
  check("selective preset returns rules array", Array.isArray(selective().rules) && selective().rules.length > 0);
  check("survival preset returns rules array", Array.isArray(survival().rules) && survival().rules.length > 0);
  eq("selective keeps a high-tier item", evaluate({ int: { [P_WORKMANSHIP]: 8 } }, selective()).verdict, "keep");
  eq("survival leaves a low-value trash item", evaluate({ int: { [P_VALUE]: 10 } }, survival()).verdict, "leave");
  {
    let threw = false;
    try { preset("bogus"); } catch { threw = true; }
    check("unknown preset name throws (builder-time, not in the loop)", threw);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
