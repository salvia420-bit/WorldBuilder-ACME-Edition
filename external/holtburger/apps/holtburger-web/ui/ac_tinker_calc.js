// ui/ac_tinker_calc.js — Retail Asheron's Call tinkering odds and difficulty calculation.
//
// References:
//   - ACE.Server/Managers/RecipeManager.cs (TinkeringDifficulty, GetMaterialMod, RecipeManager.CalculateTinkerChance)
//   - ACE.Server/WorldObjects/SkillCheck.cs (GetSkillChance)
//   - Endy's Tinkering Calculator retail reverse-engineering

/**
 * Multiplier applied to base difficulty for each attempt 1..10 (0-indexed 0..9).
 * Derived from Endy's Tinkering Calculator / ACE RecipeManager.TinkeringDifficulty.
 */
export const TINKERING_DIFFICULTY = Object.freeze([
  1.0, // 1st attempt
  1.1, // 2nd attempt
  1.3, // 3rd attempt
  1.6, // 4th attempt
  2.0, // 5th attempt
  2.5, // 6th attempt
  3.0, // 7th attempt
  3.5, // 8th attempt
  4.0, // 9th attempt
  4.5, // 10th attempt
]);

export const MAX_TINKERS = 10;

/**
 * Returns the material modifier for a salvage material type (numeric ID or string name).
 * From ACE.Server/Managers/RecipeManager.cs:255 GetMaterialMod.
 *
 * @param {number|string} material
 * @returns {number}
 */
export function getMaterialMod(material) {
  if (typeof material === "string") {
    const s = material.toLowerCase().replace(/[\s_-]/g, "");
    if (s === "gold" || s === "oak") return 10.0;
    if (
      s === "alabaster" || s === "armoredillohide" || s === "brass" ||
      s === "bronze" || s === "ceramic" || s === "granite" ||
      s === "linen" || s === "marble" || s === "moonstone" ||
      s === "opal" || s === "pine" || s === "reedsharkhide" ||
      s === "velvet" || s === "wool"
    ) return 11.0;
    if (
      s === "ebony" || s === "greengarnet" || s === "iron" ||
      s === "mahogany" || s === "porcelain" || s === "satin" ||
      s === "steel" || s === "teak"
    ) return 12.0;
    if (
      s === "bloodstone" || s === "carnelian" || s === "citrine" ||
      s === "hematite" || s === "lavenderjade" || s === "malachite" ||
      s === "redjade" || s === "rosequartz"
    ) return 25.0;
    return 20.0;
  }

  const m = Number(material) | 0;
  switch (m) {
    case 14: // Gold
    case 29: // Oak
      return 10.0;

    case 1:  // Alabaster
    case 2:  // ArmoredilloHide
    case 3:  // Brass
    case 4:  // Bronze
    case 5:  // Ceramic
    case 15: // Granite
    case 25: // Linen
    case 28: // Marble
    case 59: // Moonstone
    case 60: // Opal
    case 30: // Pine
    case 34: // ReedSharkHide
    case 39: // Velvet
    case 42: // Wool
      return 11.0;

    case 9:  // Ebony
    case 65: // GreenGarnet
    case 20: // Iron
    case 27: // Mahogany
    case 31: // Porcelain
    case 35: // Satin
    case 37: // Steel
    case 38: // Teak
      return 12.0;

    case 54: // Bloodstone
    case 55: // Carnelian
    case 56: // Citrine
    case 57: // Hematite
    case 58: // LavenderJade
    case 11: // Malachite
    case 61: // RedJade
    case 62: // RoseQuartz
      return 25.0;

    default:
      return 20.0;
  }
}

/**
 * Calculates tinkering attempt difficulty.
 *
 * @param {object} params
 * @param {number|string} params.materialType
 * @param {number} [params.itemWorkmanship=1.0]
 * @param {number} [params.toolWorkmanship=1.0]
 * @param {number} [params.tinkeredCount=0] - Number of times already tinkered (0..9)
 * @returns {number} Integer difficulty
 */
export function calculateTinkerDifficulty({
  materialType,
  itemWorkmanship = 1.0,
  toolWorkmanship = 1.0,
  tinkeredCount = 0,
}) {
  const attemptIdx = Math.max(0, Math.min(9, tinkeredCount | 0));
  const attemptMod = TINKERING_DIFFICULTY[attemptIdx];
  const salvageMod = getMaterialMod(materialType);
  const workmanshipMod = (toolWorkmanship >= itemWorkmanship) ? 2.0 : 1.0;

  const diff = Math.floor(
    ((salvageMod * 5.0) + (itemWorkmanship * salvageMod * 2.0) - ((toolWorkmanship * workmanshipMod * salvageMod) / 5.0)) * attemptMod
  );
  return Math.max(0, diff);
}

/**
 * Retail sigmoid skill-check chance function.
 * ACE SkillCheck.GetSkillChance: chance = 1.0 - (1.0 / (1.0 + exp(factor * (skill - difficulty)))).
 *
 * @param {number} skill
 * @param {number} difficulty
 * @param {number} [factor=0.03]
 * @returns {number} Float 0.0 .. 1.0
 */
export function getSkillChance(skill, difficulty, factor = 0.03) {
  const s = Number(skill) || 0;
  const d = Number(difficulty) || 0;
  const chance = 1.0 - (1.0 / (1.0 + Math.exp(factor * (s - d))));
  return Math.min(1.0, Math.max(0.0, chance));
}

/**
 * Calculates complete tinkering odds preview.
 *
 * @param {object} params
 * @param {number} params.skill - Player's tinkering skill rating
 * @param {number|string} params.materialType - Salvage material type
 * @param {number} [params.itemWorkmanship=1.0]
 * @param {number} [params.toolWorkmanship=1.0]
 * @param {number} [params.tinkeredCount=0]
 * @param {boolean} [params.isImbue=false]
 * @param {boolean} [params.isFoolproof=false]
 * @param {number} [params.augBonus=0]
 * @returns {{ difficulty: number, successChance: number, successPercent: number, tinkeredCount: number, maxTinkers: number, canTinker: boolean }}
 */
export function calculateTinkerOdds({
  skill,
  materialType,
  itemWorkmanship = 1.0,
  toolWorkmanship = 1.0,
  tinkeredCount = 0,
  isImbue = false,
  isFoolproof = false,
  augBonus = 0,
}) {
  const count = Math.max(0, tinkeredCount | 0);
  if (count >= MAX_TINKERS) {
    return {
      difficulty: 0,
      successChance: 0.0,
      successPercent: 0,
      tinkeredCount: count,
      maxTinkers: MAX_TINKERS,
      canTinker: false,
    };
  }

  const difficulty = calculateTinkerDifficulty({
    materialType,
    itemWorkmanship,
    toolWorkmanship,
    tinkeredCount: count,
  });

  let chance = getSkillChance(skill, difficulty);

  if (isImbue) {
    chance = chance / 3.0;
    if (augBonus > 0) {
      chance += augBonus * 0.05;
    }
  }

  if (isFoolproof) {
    chance = 1.0;
  }

  chance = Math.min(1.0, Math.max(0.0, chance));
  const successPercent = Math.round(chance * 100);

  return {
    difficulty,
    successChance: chance,
    successPercent,
    tinkeredCount: count,
    maxTinkers: MAX_TINKERS,
    canTinker: true,
  };
}

/**
 * Reads the number of times an item has been tinkered (PropertyInt 44 NumTimesTinkered).
 *
 * @param {number} guid
 * @param {object} [handle]
 * @returns {number} 0..10
 */
export function readTinkeredCount(guid, handle = null) {
  const g = (guid >>> 0) || 0;
  if (!g) return 0;
  const h = handle || ((typeof window !== "undefined") ? (window.__sessionHandle ?? null) : null);
  if (!h) return 0;
  try {
    if (typeof h.getObjectAppraisal === "function") {
      const json = h.getObjectAppraisal(g);
      if (typeof json === "string" && json.length > 0) {
        const parsed = JSON.parse(json);
        const count = parsed?.properties?.ints?.[44] ??
                      parsed?.properties?.ints?.NumTimesTinkered ??
                      parsed?.numTimesTinkered ?? 0;
        return Math.max(0, Math.min(MAX_TINKERS, count | 0));
      }
    }
  } catch (_) {}
  return 0;
}

/**
 * Reads an item's workmanship (PropertyFloat 40 Workmanship or PropertyInt 106).
 *
 * @param {number} guid
 * @param {object} [handle]
 * @returns {number}
 */
export function readWorkmanship(guid, handle = null) {
  const g = (guid >>> 0) || 0;
  if (!g) return 1.0;
  const h = handle || ((typeof window !== "undefined") ? (window.__sessionHandle ?? null) : null);
  if (!h) return 1.0;
  try {
    if (typeof h.getObjectAppraisal === "function") {
      const json = h.getObjectAppraisal(g);
      if (typeof json === "string" && json.length > 0) {
        const parsed = JSON.parse(json);
        const w = parsed?.properties?.floats?.[40] ??
                  parsed?.properties?.floats?.Workmanship ??
                  parsed?.properties?.ints?.[106] ??
                  parsed?.workmanship ?? 1.0;
        const val = Number(w);
        return Number.isFinite(val) && val > 0 ? val : 1.0;
      }
    }
  } catch (_) {}
  return 1.0;
}

/**
 * Reads an item's material type (PropertyInt 131 Material).
 *
 * @param {number} guid
 * @param {object} [handle]
 * @returns {number}
 */
export function readMaterialType(guid, handle = null) {
  const g = (guid >>> 0) || 0;
  if (!g) return 0;
  const h = handle || ((typeof window !== "undefined") ? (window.__sessionHandle ?? null) : null);
  if (!h) return 0;
  try {
    if (typeof h.getObjectAppraisal === "function") {
      const json = h.getObjectAppraisal(g);
      if (typeof json === "string" && json.length > 0) {
        const parsed = JSON.parse(json);
        const m = parsed?.properties?.ints?.[131] ??
                  parsed?.properties?.ints?.Material ??
                  parsed?.material ?? 0;
        return Number(m) | 0;
      }
    }
  } catch (_) {}
  return 0;
}

/**
 * Resolves the relevant tinkering skill for a given material.
 *
 * @param {number|string} material
 * @param {object} [handle]
 * @returns {number}
 */
export function getRelevantTinkerSkill(material, handle = null) {
  const h = handle || ((typeof window !== "undefined") ? (window.__sessionHandle ?? null) : null);
  let skillVal = 300;
  if (!h) return skillVal;
  try {
    if (typeof h.getSkill === "function") {
      const val = h.getSkill(18) || h.getSkill(28) || h.getSkill(29) || h.getSkill(30);
      if (val) return val;
    }
    if (typeof h.playerSkills === "function") {
      const skills = h.playerSkills();
      if (Array.isArray(skills)) {
        const found = skills.find((s) => s.skillId === 18 || s.skillId === 28 || s.skillId === 29 || s.skillId === 30);
        if (found?.effectiveSkill) return found.effectiveSkill;
      }
    }
  } catch (_) {}
  return skillVal;
}
