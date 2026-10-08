// Train / raise math for the character pane (gmStatManagementUI family).
//
// History: Wave 4.A (2026-05-28) shipped this file as a standalone
// "Train Skills" main-panel view. BAND-B S2/S3 (2026-06-17) folded the
// raise/train flow into the character pane's Skills tab and retired the
// view registration, but the ~450-line DOM renderer stayed behind as dead
// code. HUD overhaul 2026-10-05: the dead renderer is gone — there is ONE
// character UI (plugins/character-info.js, Attributes / Skills / Titles)
// and F11 opens it on the Skills tab (app/plugin_bar.js
// PLUGIN_HOTKEY_DISPATCH "train-skills"). This module is now the pure,
// DOM-free maths the pane uses, so it stays unit-testable in node
// (test_train_skill.mjs):
//
//   computeNextRaiseCost / decideTrainAction — wire dispatch (unchanged)
//   statRaiseCost      — retail gm{Attribute,Skill}UI::GetCostToRaise{,10}
//   estimateVitalRanks — vital rank recovery from the base max + formula
//   levelProgress      — gmStatManagementUI::UpdateExperience header meter
//   skillGroupFor      — gmSkillUI::RebuildSkillList section assignment
//
// Wire layer (ACE): RaiseSkill 0x0046 / TrainSkill 0x0047 /
// RaiseAttribute 0x0045 / RaiseVital 0x0044 — every raise sends the XP
// AMOUNT to spend; ACE (Player_Skills.cs HandleActionRaiseSkill →
// SpendSkillXp) adds it to the stat's spent XP and recomputes the rank,
// rejecting amounts above AvailableExperience or past max rank. So a +10
// raise is ONE request carrying the cost of ten ranks, exactly like
// retail gmSkillUI::Raise10Selection (acclient.c, CM_Train::Event_TrainSkill
// with GetCostToRaise10).
//
// XP tables: data/xp-tables-full.json (DAT 0x0E000018 ExperienceTable —
// levels / attributes / vitals / trainedSkills / specializedSkills, all
// CUMULATIVE xp indexed by rank). data/xp-tables.json (attributes +
// vitals only) remains the fallback.

// ─── Pure helpers ─────────────────────────────────────────────────

/**
 * AC skill `training` enum (SkillAdvancementClass / retail
 * SKILL_ADVANCEMENT_CLASS):
 *   0 = Unusable (Inactive) — class can't train
 *   1 = Untrained           — eligible to train for `trainedCost` credits
 *   2 = Trained             — raised with XP on the trained curve
 *   3 = Specialized         — raised with XP on the specialized curve
 */
export const TRAINING = Object.freeze({
  UNUSABLE: 0,
  UNTRAINED: 1,
  TRAINED: 2,
  SPECIALIZED: 3,
});

/**
 * Next-rank XP cost for a skill from its stride-6 snapshot row
 * (`[id, current, base, ranks, training, next_rank_cost]`). `snap.xp` is
 * the index-5 MARGINAL next-rank cost (next_rank_xp − spent_xp,
 * computed Rust-side) — directly usable as the +1 raise amount.
 * Returns `null` at max rank / not raisable / malformed.
 *
 * @param {{ training: number, xp: number }} snap
 * @returns {number|null}
 */
export function computeNextRaiseCost(snap) {
  if (!snap || typeof snap.xp !== "number" || snap.xp <= 0) return null;
  if (snap.training !== TRAINING.TRAINED && snap.training !== TRAINING.SPECIALIZED) {
    return null;
  }
  return snap.xp >>> 0;
}

/**
 * Pure dispatch helper — given a UI action (`raise`/`train`/`cancel`)
 * and a client facade, compute the method name + u32-coerced args.
 * Returns `{called: null, args: [], reason}` for no-ops so tests stay
 * deterministic.
 *
 * @param {{ kind: "train"|"raise"|"cancel", skillId: number,
 *           cost: number, availableXp: number, availableCredits: number }} action
 * @param {{ player?: { raiseSkill?: Function, trainSkill?: Function } }} client
 * @returns {{ called: string|null, args: any[], reason?: string }}
 */
export function decideTrainAction(action, client) {
  if (action.kind === "train") {
    if (action.cost > action.availableCredits) {
      return { called: null, args: [], reason: "insufficient-credits" };
    }
    if (typeof client?.player?.trainSkill !== "function") {
      return { called: null, args: [], reason: "no-facade" };
    }
    return { called: "trainSkill", args: [action.skillId >>> 0, action.cost >>> 0] };
  }
  if (action.kind === "raise") {
    if (action.cost > action.availableXp) {
      return { called: null, args: [], reason: "insufficient-xp" };
    }
    if (typeof client?.player?.raiseSkill !== "function") {
      return { called: null, args: [], reason: "no-facade" };
    }
    return { called: "raiseSkill", args: [action.skillId >>> 0, action.cost >>> 0] };
  }
  return { called: null, args: [], reason: "noop" };
}

/**
 * XP cost to raise a stat by `steps` ranks (1 or 10), mirroring retail
 * gmSkillUI::GetCostToRaise10 (acclient.c — `steps = min(10, max −
 * level_from_pp)`; `cost = ExperienceToSkillLevel(sac, level + steps) −
 * pp`) and the gmAttributeUI equivalents. Near the cap a +10 raise buys
 * only the ranks that are left; at the cap it returns `null`.
 *
 * `spentXp` is the XP already invested. Callers that only know the
 * marginal next-rank cost (the skill snapshot) recover it as
 * `table[ranks + 1] − marginal` (see `skillSpentXp`).
 *
 * @param {number[]|null} table   cumulative xp by rank (index = rank)
 * @param {number} ranks          current rank (level_from_pp)
 * @param {number} spentXp        xp already spent on the stat (pp)
 * @param {number} [steps=1]      ranks to buy
 * @returns {{ cost: number, ranks: number }|null}
 */
export function statRaiseCost(table, ranks, spentXp, steps = 1) {
  if (!Array.isArray(table) || table.length < 2) return null;
  const maxRank = table.length - 1;
  const r = Math.max(0, Math.floor(Number(ranks) || 0));
  if (r >= maxRank) return null;
  const want = Math.max(1, Math.floor(Number(steps) || 1));
  const buy = Math.min(want, maxRank - r);
  const target = table[r + buy];
  const spent = Math.max(0, Number(spentXp) || 0);
  const cost = target - spent;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return { cost, ranks: buy };
}

/**
 * Recover a skill's spent XP from the snapshot's marginal next-rank
 * cost: `next_rank_cost = table[ranks + 1] − spent` (src/lib.rs
 * publish_player_stats_snapshot). Falls back to `table[ranks]` (the
 * whole-rank floor) when the marginal is unknown.
 */
export function skillSpentXp(table, ranks, marginal) {
  if (!Array.isArray(table)) return 0;
  const r = Math.max(0, Math.floor(Number(ranks) || 0));
  const next = table[r + 1];
  const m = Number(marginal) || 0;
  if (typeof next === "number" && m > 0 && m <= next) return next - m;
  return typeof table[r] === "number" ? table[r] : 0;
}

/**
 * Vital rank estimate. The stats snapshot carries a vital's unbuffed
 * max (`base`) but not its rank counter, and the raise cost is indexed
 * by rank. ACE CreatureVital.Base = StartingValue + Ranks + formula
 * (player vitals start at 0); the formula is retail's SkillFormula::
 * Calculate (acclient.c: floor((x·attr1 + y·attr2) / z + 0.5)) over the
 * UNBUFFED attributes — Health = Endurance / 2, Stamina = Endurance,
 * Mana = Self (Attribute2ndTable).
 *
 * enchstats-3 (2026-10-08): the Health `base` now includes GearMaxHealth
 * (PropertyInt 379, retail CACQualities::InqAttribute2nd adds it to the RAW
 * max), so pass it as `gearMaxHealth` and it is taken back out before the
 * rank estimate. Enlightenment is still not visible client-side, so a
 * Health estimate can be a few ranks high for those characters; the server
 * still validates.
 *
 * @param {number} vitalId   1 Health, 3 Stamina, 5 Mana
 * @param {number} vitalBase unbuffed max
 * @param {Record<number, number>} attrBase  attribute id → unbuffed value
 * @param {number} [gearMaxHealth=0] PropertyInt GearMaxHealth (Health only)
 * @returns {number}
 */
export function estimateVitalRanks(vitalId, vitalBase, attrBase, gearMaxHealth = 0) {
  const base = Number(vitalBase) || 0;
  const end = Number(attrBase?.[2]) || 0;
  const self = Number(attrBase?.[6]) || 0;
  let formula = 0;
  if (vitalId === 1) formula = Math.floor(end / 2 + 0.5) + Math.max(0, Number(gearMaxHealth) || 0);
  else if (vitalId === 3) formula = end;
  else if (vitalId === 5) formula = self;
  return Math.max(0, base - formula);
}

/**
 * Retail SkillInfoRegion / Attribute2ndInfoRegion::GetVitaeModifier
 * (acclient.c:285192 / :285287): with a vitae penalty in effect
 * (`vitae < 1`), `(u64)(raw × vitae + 0.5) − raw` (≤ 0), else 0. The
 * character sheet tints a value against `current − vitaeModifier` so the
 * vitae loss alone never paints a skill or vital red — enchstats-2/3
 * (2026-10-08), now that the client folds vitae into `current` / max the
 * way retail and ACE do.
 *
 * @param {number} raw   the unbuffed (raw) value — the sheet's `base`
 * @param {number} vitae the vitae multiplier (1 = none)
 * @returns {number}
 */
export function vitaeModifier(raw, vitae) {
  const r = Number(raw) || 0;
  const v = Number(vitae);
  if (!Number.isFinite(v) || v >= 1 || v < 0) return 0;
  return Math.floor(r * v + 0.5) - r;
}

/**
 * Header XP meter — retail gmStatManagementUI::UpdateExperience:
 * `toNext = ExperienceToLevel(level + 1) − totalXp`, meter fill =
 * `(totalXp − ExperienceToLevel(level)) / (next − cur)`.
 *
 * @param {number[]|null} levels  cumulative xp by character level
 * @param {number} level
 * @param {number} totalXp
 * @returns {{ toNext: number, fraction: number, isMax: boolean }|null}
 */
export function levelProgress(levels, level, totalXp) {
  if (!Array.isArray(levels) || levels.length < 2) return null;
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  const total = Math.max(0, Number(totalXp) || 0);
  if (lv + 1 >= levels.length) return { toNext: 0, fraction: 1, isMax: true };
  const cur = levels[lv] ?? 0;
  const next = levels[lv + 1];
  const span = next - cur;
  const toNext = Math.max(0, next - total);
  const fraction = span > 0 ? Math.max(0, Math.min(1, (total - cur) / span)) : 0;
  return { toNext, fraction, isMax: false };
}

/**
 * Retail gmSkillUI::RebuildSkillList grouping: SAC 3 → Specialized,
 * SAC 2 → Trained, SAC 1 with SkillBase min_level ≤ 1 → Untrained,
 * everything else (SAC 0, or a skill gated behind a level) → Unusable.
 *
 * @param {number} training  SkillAdvancementClass (0..3)
 * @param {number} [minLevel=1] SkillTable `minLevel`
 * @returns {"specialized"|"trained"|"untrained"|"unusable"}
 */
export function skillGroupFor(training, minLevel = 1) {
  if (training === TRAINING.SPECIALIZED) return "specialized";
  if (training === TRAINING.TRAINED) return "trained";
  if (training === TRAINING.UNTRAINED && (Number(minLevel) || 1) <= 1) return "untrained";
  return "unusable";
}

// ─── Manifest (also dropped at train-skills.manifest.json) ────────
export const manifest = {
  id: "train-skills",
  name: "Train Skills",
  icon: "📜",
  iconHidden: true,
  version: "0.1.0",
  description: "Skill train/raise maths + F11 → character pane Skills tab.",
};

// ─── View shim ────────────────────────────────────────────────────
// Not registered by default (app/plugin_bar.js routes F11 straight to
// `showView("character", { tab: "skills" })`). Kept so any caller that
// still toggles the old "train-skills" view id (target-bar's Skills
// button) lands on the one character UI if the id is ever registered:
// mounting redirects to the character pane's Skills tab on the next
// microtask (main-panel finishes the current mount first).
export const view = {
  name: "Skills",
  nameFor: () => "Skills",
  mount: () => {
    const go = () => {
      try {
        if (typeof window !== "undefined" && typeof window.__openCharacterTab === "function") {
          window.__openCharacterTab("skills");
        } else {
          window?.__mainPanel?.showView?.("character", { tab: "skills" });
        }
      } catch (_) { /* panel not mounted */ }
    };
    if (typeof queueMicrotask === "function") queueMicrotask(go); else setTimeout(go, 0);
    return null;
  },
};
