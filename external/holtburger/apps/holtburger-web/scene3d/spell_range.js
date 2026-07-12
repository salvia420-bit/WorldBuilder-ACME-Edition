// WS05 (2026-07-12) — pure port of retail SpellExamineUI::DetermineSpellRange
// (acclient.c:228504-228581), the client's cast-range DISPLAY formula.
//
// NOTE: retail used this only for the spell-examine tooltip; it never gated a
// cast on range client-side (the server is authoritative and toasts an
// out-of-range reject). The holtburger use of it — a pre-cast out-of-range
// WARNING toast — is a client ENHANCEMENT retail did not have, not retail
// parity. The FORMULA below is retail; its pre-cast application is new.
//
// range = baseRangeMod * skillLevel + baseRangeConstant, capped at 75.0
// (RADAR_OUTDOOR_RADIUS). `skillLevel` is the RAW `init_level + points_raised`
// for the spell's magic skill (retail CACQualities::InqSkillLevel,
// acclient.c:443063) — NOT the buffed/attribute-formula skill. ACE's
// VerifySpellRange (Player_Magic.cs:492-497) overrides its magicSkill to the
// same init+ranks for player self-casts, so this preview matches the server's
// reject boundary. Import-free / node-testable.

export const RADAR_OUTDOOR_RADIUS = 75.0;

// The 5 magic skills queried by DetermineSpellRange's skill-less branch, by
// SkillType u32: CreatureEnchantment 31, ItemEnchantment 32, LifeMagic 33,
// WarMagic 34, VoidMagic 43 (0x2B — NOT ArcaneLore 0x0E; the retail else-branch
// is a MAX over these five, not an "Arcane Lore clamp").
const MAGIC_SKILLS = [31, 32, 33, 34, 43];

// CSpellBase::InqSkillForSpell school->skill map (acclient.c:448600-448626).
// Matches getSpellRecord's school numbering (lib.rs: 1=War, 2=Life,
// 3=ItemEnch, 4=CreatureEnch, 5=Void). School 0 / anything else -> 0, which
// routes the caller to the max-of-5 branch.
export function inqSkillForSchool(school) {
  switch (school >>> 0) {
    case 1: return 34; // War   -> WarMagic
    case 2: return 33; // Life  -> LifeMagic
    case 3: return 32; // ItemEnch -> ItemEnchantment
    case 4: return 31; // CreatureEnch -> CreatureEnchantment
    case 5: return 43; // Void  -> VoidMagic
    default: return 0;
  }
}

// Resolve the skillLevel fed to the range formula. `getRaw(skillId)` returns
// the raw init+ranks for a skill (0 if absent), mirroring InqSkillLevel: a
// skill-bearing spell uses its ONE school skill; a skill-less spell (school 0)
// uses max over the five magic skills (acclient.c:228558-228573).
export function pickSkillLevel(school, getRaw) {
  const id = inqSkillForSchool(school);
  if (id !== 0) return getRaw(id) >>> 0;
  return MAGIC_SKILLS.reduce((m, s) => Math.max(m, getRaw(s) >>> 0), 0);
}

// range = mod*skill + const, capped at RADAR_OUTDOOR_RADIUS (75).
export function determineSpellRange(baseRangeMod, baseRangeConstant, skillLevel) {
  const r = baseRangeMod * skillLevel + baseRangeConstant;
  return r > RADAR_OUTDOOR_RADIUS ? RADAR_OUTDOOR_RADIUS : r;
}
