// WS05 (S3b, 2026-07-12) — the pure cast-range formula (DAT-grounded).
//
// Proves scene3d/spell_range.js is a faithful port of retail
// SpellExamineUI::DetermineSpellRange (acclient.c:228504-228581):
//   (1) inqSkillForSchool matches CSpellBase::InqSkillForSpell
//       (acclient.c:448600): 1->War 34, 2->Life 33, 3->ItemEnch 32,
//       4->CreatureEnch 31, 5->Void 43, else->0. Load-bearing correction:
//       school 5 -> 43 (VoidMagic 0x2B), NOT ArcaneLore (0x0E/14).
//   (2) determineSpellRange = mod*skill + const, capped at 75
//       (RADAR_OUTDOOR_RADIUS, acclient.c:40037), DAT-grounded on Flame
//       Bolt I (30/0.7) + Strength Other I (5/1) + Strength Self I (0/0).
//   (3) pickSkillLevel: a skill-bearing spell uses its ONE school skill; a
//       skill-less spell (school 0) uses MAX over the 5 magic skills — a
//       max, not a clamp (acclient.c:228558-228573).
//
// Run: node tests/test_ws05_spell_range.mjs   (from apps/holtburger-web/)

import {
  inqSkillForSchool,
  pickSkillLevel,
  determineSpellRange,
  resolveRangeRingSpec,
  RADAR_OUTDOOR_RADIUS,
} from "../scene3d/spell_range.js";

let fail = 0;
const bad = (msg) => { fail++; console.log("  ✗ " + msg); };
const ok = (msg) => console.log("  ✓ " + msg);
const eq = (got, exp, label) => {
  if (got === exp) ok(`${label} = ${got}`);
  else bad(`${label}: got ${got}, expected ${exp}`);
};

// (1) school -> skill (acclient.c:448600 InqSkillForSpell)
eq(inqSkillForSchool(1), 34, "inqSkillForSchool(War=1)");
eq(inqSkillForSchool(2), 33, "inqSkillForSchool(Life=2)");
eq(inqSkillForSchool(3), 32, "inqSkillForSchool(ItemEnch=3)");
eq(inqSkillForSchool(4), 31, "inqSkillForSchool(CreatureEnch=4)");
eq(inqSkillForSchool(5), 43, "inqSkillForSchool(Void=5) -> VoidMagic 0x2B (NOT ArcaneLore 0x0E)");
eq(inqSkillForSchool(0), 0, "inqSkillForSchool(None=0) -> max-of-5 branch");
eq(inqSkillForSchool(99), 0, "inqSkillForSchool(unknown) -> 0");

// (2) determineSpellRange = mod*skill + const, cap 75.
eq(RADAR_OUTDOOR_RADIUS, 75.0, "RADAR_OUTDOOR_RADIUS");
// Flame Bolt I (DAT oracle: baseRangeConstant 30, baseRangeMod 0.7).
eq(determineSpellRange(0.7, 30, 50), 65, "Flame Bolt I @War 50 (0.7*50+30)");
eq(determineSpellRange(0.7, 30, 20), 44, "Flame Bolt I @War 20 (0.7*20+30)");
eq(determineSpellRange(0.7, 30, 100), 75, "Flame Bolt I @War 100 -> capped");
eq(determineSpellRange(0.7, 30, 65), 75, "Flame Bolt I @War 65 (75.5 -> cap 75)");
eq(determineSpellRange(0.7, 30, 64), 74.8, "Flame Bolt I @War 64 (just under cap)");
// Strength Other I (DAT oracle: const 5, mod 1).
eq(determineSpellRange(1, 5, 40), 45, "Strength Other I @CreatureEnch 40 (1*40+5)");
// Strength Self I (DAT oracle: 0/0) -> range 0 (self spells need no range).
eq(determineSpellRange(0, 0, 300), 0, "Strength Self I (0/0) -> 0");
// Exact cap boundary: mod*skill+const == 75 is NOT over the cap.
eq(determineSpellRange(1, 0, 75), 75, "range exactly 75 -> 75 (not clamped away)");

// (3) skill selection: skill-bearing spell uses its ONE skill; school 0 =
//     MAX over the 5 magic skills (a max, not a clamp).
const raw = { 31: 10, 32: 20, 33: 30, 34: 40, 43: 250 };
const getRaw = (s) => raw[s] || 0;
eq(pickSkillLevel(1, getRaw), 40, "pickSkillLevel(War) -> War skill only (40)");
eq(pickSkillLevel(5, getRaw), 250, "pickSkillLevel(Void) -> Void skill only (250)");
eq(pickSkillLevel(0, getRaw), 250, "pickSkillLevel(None) -> MAX of 5 (Void 250)");
// Absent skill reads 0 (InqSkillLevel: absent -> retval untouched).
eq(pickSkillLevel(1, () => 0), 0, "pickSkillLevel(War) with untrained skill -> 0");
// max-of-5 ignores non-magic ids; only the five are consulted.
eq(pickSkillLevel(0, (s) => (s === 14 ? 999 : (raw[s] || 0))), 250,
  "pickSkillLevel(None) ignores ArcaneLore 0x0E/14, still max-of-5");

// End-to-end: War 50 Flame Bolt I in-range vs out-of-range boundary.
{
  const range = determineSpellRange(0.7, 30, pickSkillLevel(1, () => 50));
  eq(range, 65, "e2e Flame Bolt I @War 50 reach");
  eq(64 <= range, true, "e2e 64m target is in range (<=65)");
  eq(70 <= range, false, "e2e 70m target is out of range (>65)");
}

// =====================================================================
// WS05b (2026-07-12) — resolveRangeRingSpec: the cast-range RING decision
// core. Pins the regression the 1070 eye-test caught: the ring never drew
// because the tick resolved the local player from entityMap.get(localGuid),
// but the wasm eager-WorldState path suppresses the local player's KIND_SPAWN
// so it has NO rig in entityMap on the default boot. The fix sources the
// player position from getLocalPlayerWorldPos() instead — so the ring spec
// MUST be non-null when a targeted spell is armed and getLocalPlayerWorldPos
// returns a pose, EVEN WITH the local player absent from entityMap.
// =====================================================================
const truthy = (got, label) => (got ? ok(label) : bad(`${label}: got ${JSON.stringify(got)}`));
const nullish = (got, label) => (got == null ? ok(label) : bad(`${label}: expected null, got ${JSON.stringify(got)}`));

const warInfo = { range: 65, school: 1 };   // War, in-range
const voidInfo = { range: 60, school: 5 };   // Void
const feet = { x: 12345.5, y: 678.25, z: 82.0 };

// (a) THE REGRESSION — armed war spell + a valid getLocalPlayerWorldPos pose
//     (from the last-server fallback, NOT entityMap) => ring spec renders.
{
  const spec = resolveRangeRingSpec(27, warInfo, feet);
  truthy(spec, "resolveRangeRingSpec: armed war spell + world pose (no entityMap rig) -> ring spec");
  eq(spec?.spellId, 27, "  spec.spellId");
  eq(spec?.range, 65, "  spec.range (school reach)");
  eq(spec?.school, 1, "  spec.school (War -> blue)");
  eq(spec?.x, 12345.5, "  spec.x tracks the player world pose");
  eq(spec?.y, 678.25, "  spec.y tracks the player world pose");
  eq(spec?.z, 82.0, "  spec.z tracks the player world pose");
}

// (b) Void spell -> purple school carried through.
eq(resolveRangeRingSpec(5349, voidInfo, feet)?.school, 5, "resolveRangeRingSpec: void spell -> school 5 (purple)");

// (c) No spell armed (0 / negative / non-number) -> no ring.
nullish(resolveRangeRingSpec(0, warInfo, feet), "resolveRangeRingSpec: armedSpellId 0 -> null");
nullish(resolveRangeRingSpec(-1, warInfo, feet), "resolveRangeRingSpec: negative armedSpellId -> null");
nullish(resolveRangeRingSpec(null, warInfo, feet), "resolveRangeRingSpec: null armedSpellId -> null");

// (d) Self / untargeted / zero-range spell (rangeInfo null or range<=0) -> no
//     ring. This is the selfbuff_no_ring case (spell 2331): _armedSpellRange
//     returns null for self-targeted, so the spec is null.
nullish(resolveRangeRingSpec(2331, null, feet), "resolveRangeRingSpec: self-buff (rangeInfo null) -> null");
nullish(resolveRangeRingSpec(2331, { range: 0, school: 2 }, feet), "resolveRangeRingSpec: range 0 -> null");

// (e) No known player pose yet (getLocalPlayerWorldPos returned null / garbage)
//     -> no ring (don't draw at the origin).
nullish(resolveRangeRingSpec(27, warInfo, null), "resolveRangeRingSpec: no player pose -> null");
nullish(resolveRangeRingSpec(27, warInfo, { x: NaN, y: 0, z: 0 }), "resolveRangeRingSpec: NaN pose -> null");

console.log(fail ? `FAIL — ${fail} failure(s)` : "PASS — 0 failure(s)");
process.exit(fail ? 1 : 0);
