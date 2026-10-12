// rynth/vt/combat/index.js — barrel of the VTank Monsters/Items runtime
// (PLAN W1-7 CMB, §3.9). No side effects: data JSON loads lazily
// (loadCombatSpells / loadCreatureSpecies) and nothing here touches window or
// document. The expression engine, host, options and signals are injected by
// the composition root (INT-2); this package imports no other vt package (C2).

export {
  MONSTER_COLUMNS,
  MONSTER_VARIABLES,
  MONSTER_ELEMENTS,
  DEFAULT_ENTRY,
  DEFAULT_TEXT,
  normalizeEntry,
  fromRynthAiRule,
  fromLegacyPriorities,
  MonsterList,
} from "./monster_list.js";
export { makeMonsterVars } from "./monster_vars.js";
export {
  ELEMENTS,
  normalizeElement,
  loadCombatSpells,
  isLoaded,
  familyNames,
  familyLadder,
  bestCastable,
  familyOf,
  durationOf,
  nameOf,
  rungOf,
} from "./spell_tables.js";
export { DebuffLedger } from "./debuff_ledger.js";
export { AttackPlanner } from "./attack_planner.js";
export {
  ITEM_KINDS,
  ITEM_BUFF_FAMILIES,
  ITEM_BUFF_DEFAULTS,
  itemBuffFamilies,
  classifyItem,
  elementFromDamageType,
  ItemsModel,
} from "./items.js";
export {
  CREATURES_STORAGE_KEY,
  CreatureProfiles,
  loadCreatureSpecies,
  isSpeciesLoaded,
  creatureTypeName,
} from "./creature_profiles.js";
