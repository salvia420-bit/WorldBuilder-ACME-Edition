// ui/ac_spell_formula.js — Retail Asheron's Call personalized spell formulas,
// Foci (scarab + prismatic taper) formulas, WCID mapping, and PropertyBool 68
// (SpellComponentsRequired) verification.
//
// References:
//   - ACE.Server/Entity/SpellFormula.cs (Scarab, FociFormula, GetPlayerFormula)
//   - ACE.DatLoader/FileTypes/SpellTable.cs (ComputeHash, RandomizeVersion1/2/3)
//   - Retail acclient.c:297666 (compute_hash), :449055 (InqTargetType), :488093 (RandomizeVersion2), :488138 (RandomizeVersion3)
//   - DualDidMapper 0x27000002 (SpellComponents: SCID -> WCID)

export const LOWEST_TAPER_ID = 63; // Red Taper

export const SCARAB_IDS = Object.freeze(new Set([
  1,   // Lead
  2,   // Iron
  3,   // Copper
  4,   // Silver
  5,   // Gold
  6,   // Pyreal
  110, // Diamond
  112, // Platinum
  192, // Dark
  193, // Mana
]));

export const CHORIZITE_ID = 111;
export const PRISMATIC_TAPER_ID = 188;
export const PRISMATIC_TAPER_WCID = 20631;

export const FOCI_BY_SCHOOL = Object.freeze({
  1: 15271, // War Magic Focus
  2: 15270, // Life Magic Focus
  3: 15269, // Item Enchantment Focus
  4: 15268, // Creature Enchantment Focus
  5: 43173, // Void Magic Focus
});

/**
 * Retail spellbase_string_hash (PStringBase<char>::compute_hash).
 * Bit-identical to ACE SpellTable.ComputeHash and holtburger-core spellbase_string_hash.
 *
 * @param {string} str
 * @returns {number} 32-bit unsigned integer hash
 */
export function spellbaseStringHash(str) {
  if (typeof str !== "string") return 0;
  let result = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) & 0xFF;
    result = (c + (result * 16)) >>> 0;
    const high = (result & 0xF0000000) >>> 0;
    if (high !== 0) {
      result = ((result ^ (high >>> 24)) & 0x0FFFFFFF) >>> 0;
    }
  }
  return result >>> 0;
}

/**
 * Returns number of Prismatic Tapers required for a Foci formula based on power.
 * From retail CSpellBase::InqScarabOnlyFormula / ACE SpellFormula.GetFociFormula.
 *
 * @param {number} power - Spell power (or rough level 1..8)
 * @returns {number} 1..4
 */
export function getPrismaticTaperCount(power) {
  const p = Math.max(1, power | 0);
  switch (p) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
    case 4:
    case 7:
      return 3;
    case 5:
    case 6:
    case 8:
    case 9:
    case 10:
      return 4;
    default:
      if (p <= 1) return 1;
      if (p === 2) return 2;
      if (p <= 4) return 3;
      return 4;
  }
}

/**
 * Generates the Foci (scarab-only + prismatic taper) formula.
 * Retains all scarabs (and chorizite 111) from the base formula, plus N Prismatic Tapers (188).
 *
 * @param {number[]} baseComponents
 * @param {number} power
 * @returns {number[]}
 */
export function getFociFormula(baseComponents, power = 1) {
  const scarabs = [];
  for (const comp of (baseComponents || [])) {
    const id = comp | 0;
    if (SCARAB_IDS.has(id) || id === CHORIZITE_ID) {
      scarabs.push(id);
    }
  }
  const taperCount = getPrismaticTaperCount(power);
  for (let i = 0; i < taperCount; i++) {
    scarabs.push(PRISMATIC_TAPER_ID);
  }
  return scarabs;
}

/**
 * RandomizeVersion1 (retail spell formula personalization version 1).
 */
export function randomizeVersion1(baseComponents, accountName) {
  const comps = [...(baseComponents || [])];
  if (comps.length === 0) return comps;

  let hasTaper1 = false;
  let hasTaper2 = false;
  let hasTaper3 = false;

  const key = spellbaseStringHash(accountName);
  const seed = (key % 0x13D573) >>> 0;

  const scarab = comps[0] | 0;
  let herb_index = 1;
  if (comps.length > 5) {
    herb_index = 2;
    hasTaper1 = true;
  }
  const herb = (comps[herb_index] | 0);

  let powder_index = herb_index + 1;
  if (comps.length > 6) {
    powder_index++;
    hasTaper2 = true;
  }
  const powder = (comps[powder_index] | 0);

  const potion_index = powder_index + 1;
  const potion = (comps[potion_index] | 0);

  let talisman_index = potion_index + 1;
  if (comps.length > 7) {
    talisman_index++;
    hasTaper3 = true;
  }
  const talisman = (comps[talisman_index] | 0);

  if (hasTaper1) {
    comps[1] = (((powder + 2 * herb + potion + talisman + scarab) % 0xC) >>> 0) + LOWEST_TAPER_ID;
  }

  if (hasTaper2) {
    const denom = (scarab + (powder + potion)) >>> 0;
    const factor = denom !== 0 ? Math.floor(seed / denom) : 0;
    comps[3] = ((((scarab + herb + talisman + 2 * (powder + potion)) * factor) % 0xC) >>> 0) + LOWEST_TAPER_ID;
  }

  if (hasTaper3) {
    const denom = (talisman + scarab) >>> 0;
    const factor = denom !== 0 ? Math.floor(seed / denom) : 0;
    comps[6] = ((((powder + 2 * talisman + potion + herb + scarab) * factor) % 0xC) >>> 0) + LOWEST_TAPER_ID;
  }

  return comps;
}

/**
 * RandomizeVersion2 (retail spell formula personalization version 2).
 */
export function randomizeVersion2(baseComponents, accountName) {
  const comps = [...(baseComponents || [])];
  if (comps.length < 8) return comps;

  const key = spellbaseStringHash(accountName);
  const seed = (key % 0x13D573) >>> 0;

  const p1 = comps[0] | 0;
  const c = comps[4] | 0;
  const x = comps[5] | 0;
  const a = comps[7] | 0;

  comps[3] = (((a + 2 * comps[0] + 2 * c * x + comps[0] + comps[2] + comps[1]) % 0xC) >>> 0) + LOWEST_TAPER_ID;
  const denom = ((comps[1] | 0) * a + 2 * c) >>> 0;
  const factor = denom !== 0 ? Math.floor(seed / denom) : 0;
  comps[6] = ((((a + 2 * p1 * comps[2] + 2 * x + p1 * comps[2] + c) * factor) % 0xC) >>> 0) + LOWEST_TAPER_ID;

  return comps;
}

/**
 * RandomizeVersion3 (retail spell formula personalization version 3).
 */
export function randomizeVersion3(baseComponents, accountName) {
  const comps = [...(baseComponents || [])];
  if (comps.length < 7) return comps;

  const key = spellbaseStringHash(accountName);
  const seed1 = (key % 0x13D573) >>> 0;
  const seed2 = (key % 0x4AEFD) >>> 0;
  const seed3 = (key % 0x96A7F) >>> 0;
  const seed4 = (key % 0x100A03) >>> 0;
  const seed5 = (key % 0xEB2EF) >>> 0;
  const seed6 = (key % 0x121E7D) >>> 0;

  const compHash0 = ((seed1 + (comps[0] | 0)) % 0xC) >>> 0;
  const compHash1 = ((seed2 + (comps[1] | 0)) % 0xC) >>> 0;
  const compHash2 = ((seed3 + (comps[2] | 0)) % 0xC) >>> 0;
  const compHash4 = ((seed4 + (comps[4] | 0)) % 0xC) >>> 0;
  const compHash5 = ((seed5 + (comps[5] | 0)) % 0xC) >>> 0;

  let compHash7 = 0;
  if (comps.length < 8) {
    compHash7 = ((seed6 + 0) % 0xC) >>> 0;
  } else {
    compHash7 = ((seed6 + (comps[7] | 0)) % 0xC) >>> 0;
  }

  comps[3] = (((compHash0 + compHash1 + compHash2 + compHash4 + compHash5 + compHash2 * compHash5 + compHash0 * compHash1 + compHash7 * (compHash4 + 1)) % 0xC) >>> 0) + LOWEST_TAPER_ID;
  comps[6] = (((compHash0 + compHash1 + compHash2 + compHash4 + ((key % 0x65039) % 0xC) + compHash7 * (compHash4 * (compHash0 * compHash1 * compHash2 * compHash5 + 7) + 1) + compHash5 + 4 * compHash0 * compHash1 + compHash0 * compHash1 + 11 * compHash2 * compHash5) % 0xC) >>> 0) + LOWEST_TAPER_ID;

  return comps;
}

/**
 * Returns the effective formula for a spell:
 *   1. If player has Foci for the spell's school -> Foci formula (scarabs + Prismatic Tapers)
 *   2. Otherwise -> Personalized formula based on account name and formulaVersion (1, 2, or 3)
 *
 * @param {object} opts
 * @param {object} opts.spell - Spell record with { components, formulaVersion, school, power, level }
 * @param {string} [opts.accountName] - Account name (defaults to empty string)
 * @param {Set<number>|number[]} [opts.inventoryWcids] - Set of owned item WCIDs (to detect carried Foci)
 * @param {boolean} [opts.hasFoci] - Explicit foci override
 * @returns {number[]} Array of component IDs
 */
export function getEffectiveSpellFormula({ spell, accountName = "", inventoryWcids = null, hasFoci = null }) {
  if (!spell || !Array.isArray(spell.components) || spell.components.length === 0) {
    return [];
  }

  const school = spell.school | 0;
  const power = (spell.power || spell.level || 1) | 0;

  let userHasFoci = false;
  if (typeof hasFoci === "boolean") {
    userHasFoci = hasFoci;
  } else if (inventoryWcids) {
    const focusWcid = FOCI_BY_SCHOOL[school];
    if (focusWcid) {
      if (inventoryWcids instanceof Set) {
        userHasFoci = inventoryWcids.has(focusWcid);
      } else if (Array.isArray(inventoryWcids)) {
        userHasFoci = inventoryWcids.includes(focusWcid);
      }
    }
  }

  if (userHasFoci) {
    return getFociFormula(spell.components, power);
  }

  const ver = spell.formulaVersion | 0;
  const acct = typeof accountName === "string" ? accountName : "";

  switch (ver) {
    case 1:
      return randomizeVersion1(spell.components, acct);
    case 2:
      return randomizeVersion2(spell.components, acct);
    case 3:
      return randomizeVersion3(spell.components, acct);
    default:
      return [...spell.components];
  }
}

/**
 * Determines whether components are required to cast spells on the current character.
 * Retail/ACE PropertyBool 68 (SpellComponentsRequired) defaults to true;
 * if explicitly set to false, spells do not consume or require components.
 *
 * @param {object|null} handle - Session handle
 * @param {number} [playerGuid]
 * @returns {boolean}
 */
export function areSpellComponentsRequired(handle, playerGuid = 0) {
  if (!handle) return false;
  try {
    const guid = (playerGuid >>> 0) || (typeof handle.playerGuid === "function" ? handle.playerGuid() >>> 0 : 0);
    if (typeof handle.playerPropertyBool === "function") {
      const val = handle.playerPropertyBool(guid, 68);
      if (typeof val === "boolean") return val;
    }
    if (typeof handle.objectBoolProperty === "function" && guid) {
      const val = handle.objectBoolProperty(guid, 68);
      if (typeof val === "boolean") return val;
    }
    if (typeof handle.getObjectAppraisal === "function" && guid) {
      const json = handle.getObjectAppraisal(guid);
      if (typeof json === "string" && json.length > 0) {
        const parsed = JSON.parse(json);
        const bools = parsed?.properties?.bools;
        if (bools) {
          if (bools[68] === false || bools["SpellComponentsRequired"] === false || bools.SpellComponentsRequired === false) {
            return false;
          }
        }
      }
    }
  } catch (_) {}
  return true;
}

/**
 * Reads the account name from global session, DOM, or storage.
 * @returns {string}
 */
export function getAccountName() {
  if (typeof window === "undefined") return "";
  if (window.__sessionAccount) return String(window.__sessionAccount);
  try {
    const formVal = document?.querySelector?.('#login-form [name="account"]')?.value;
    if (formVal) return String(formVal);
  } catch (_) {}
  try {
    const stored = localStorage.getItem("hb.lastAccount") || localStorage.getItem("holtburger.account");
    if (stored) return String(stored);
  } catch (_) {}
  return "";
}
