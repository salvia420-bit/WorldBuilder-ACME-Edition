// rynth/vt/support/index.js — barrel for the W1-9 SUP package (PLAN §3.11):
// consumables, supplies (kits/food/potions, dispel, grenades), mana stones,
// autostack/autocram/peas, pets, fellowship recruiting, doors, buff items,
// idle rebuff and peace mode.
//
// Kernel wiring (INT-1/INT-2, §3.13): registration order
//   [Supplies, Helpers, Ammo, JumpNow, Pets, ReadScrolls, Salvage, Doors, Navigate, BuffItems, IdleRebuff]
// aux.idleHooks gets idle.peaceHook; the reflexes (inventory, manaStones,
// fellow) run on the VT post-tick under the §3.3 gate, the helpers' (its
// fellow-vitals hold) on every post-tick, held or not. Every slot/hook/reflex
// is inert at the schema defaults with empty lists (Z2) — the helper too,
// outside a fellowship (DoHelp is ON by default since 2026-10-19).
//
// createSupport() is a convenience for the composition root: it builds every
// module over one shared ConsumablesModel. Nothing here has top-level side
// effects (C1).

import { ConsumablesModel } from "./consumables.js";
import { createSupplies } from "./supplies.js";
import { createHelpers } from "./helpers.js";
import { createAmmo } from "./ammo.js";
import { createScrolls } from "./scrolls.js";
import { createSalvage } from "./salvage.js";
import { createManaStones } from "./mana_stones.js";
import { createInventoryMgr } from "./inventory_mgr.js";
import { createPets } from "./pets.js";
import { createFellow } from "./fellow.js";
import { createDoors } from "./doors.js";
import { createBuffItems } from "./buff_items.js";
import { createIdle } from "./idle.js";

export {
  CONSUMABLE_TYPES,
  OWNERS,
  classifyConsumable,
  normalizeConsumable,
  ConsumablesModel,
  loadSupportData,
  loadSupportJson,
  supportData,
} from "./consumables.js";
export { createSupplies, estimateKitChance, skillChance, VITAL_CONSUMABLE_TYPES, SUPPLIES_TUNING } from "./supplies.js";
export { createHelpers, pickTier, HELPER_LADDERS, HELPER_TUNING } from "./helpers.js";
export { createAmmo, pickLooseAmmo, craftPlan, craftProduct, AMMO_TUNING } from "./ammo.js";
export { createScrolls, parseReadLine, SCROLL_TUNING } from "./scrolls.js";
export {
  createSalvage,
  planCombine,
  parseSalvageBands,
  salvageBandIndex,
  combineBandsOf,
  bagWorkmanship,
  isSalvageMaterial,
  UST_WCID,
  SALVAGE_TUNING,
} from "./salvage.js";
export { createManaStones, checkStoneUse, MANA_TUNING } from "./mana_stones.js";
export { createInventoryMgr, planStack, planCram, maxStackOf, INVENTORY_TUNING } from "./inventory_mgr.js";
export { createPets, PET_TUNING } from "./pets.js";
export { createFellow, XP_TELL_RE, COME_CLOSER_TEXT, FELLOW_TUNING } from "./fellow.js";
export { createDoors, DOOR_TUNING } from "./doors.js";
export { createBuffItems, BUFF_ITEM_TUNING } from "./buff_items.js";
export { createIdle, IDLE_TUNING } from "./idle.js";

/**
 * Build the whole support suite.
 * deps = { host, bot, options, subscribe, items, now, log,
 *          consumables?  — an existing ConsumablesModel (else one is built),
 *          buff?, combat? — () => loop getters (default bot.buff / bot.combat),
 *          monsterPetDmg? — (guid) => Element | "PAuto",
 *          doorsRank?, navWants? — the nav slot's rank function and "nav wants the tick" predicate,
 *          helpersState? — page-session memory for the helper (a Healer's Heart swap still owing the weapons),
 *          lootProfile? — () => the bound .utl profile or null (Salvage's combine bands) }
 * → { consumables, supplies, helpers, ammo, manaStones, inventory, pets, fellow, doors, buffItems, idle,
 *     scrolls, salvage, status(), dispose() }
 */
export function createSupport(deps = {}) {
  const ownConsumables = !deps.consumables;
  const consumables =
    deps.consumables || new ConsumablesModel({ options: deps.options ?? null, host: deps.host ?? null, log: deps.log, now: deps.now });
  const common = { ...deps, consumables };
  const supplies = createSupplies(common);
  const helpers = createHelpers({ ...common, state: deps.helpersState });
  const ammo = createAmmo(common);
  const scrolls = createScrolls(common);
  const salvage = createSalvage(common);
  const manaStones = createManaStones(common);
  const inventory = createInventoryMgr(common);
  const pets = createPets(common);
  const fellow = createFellow(common);
  const doors = createDoors({
    ...common,
    rank: typeof deps.doorsRank === "function" ? deps.doorsRank : () => "beforeIdle",
    navWants: typeof deps.navWants === "function" ? deps.navWants : () => false,
  });
  const buffItems = createBuffItems(common);
  const idle = createIdle(common);
  const parts = { supplies, helpers, ammo, manaStones, inventory, pets, fellow, doors, buffItems, idle, scrolls, salvage };
  return {
    consumables,
    ...parts,
    status() {
      const out = {};
      for (const [k, v] of Object.entries(parts)) {
        try {
          out[k] = v.status();
        } catch (_) {
          out[k] = null;
        }
      }
      return out;
    },
    dispose() {
      for (const v of Object.values(parts)) {
        try {
          v.dispose?.();
        } catch (_) {
          /* best effort */
        }
      }
      if (ownConsumables) {
        try {
          consumables.dispose?.();
        } catch (_) {
          /* best effort */
        }
      }
    },
  };
}

export default createSupport;
