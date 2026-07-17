// tools/advancement.js — the playtester's character-advancement hands: spend
// earned XP on skills/attributes/vitals and train new skills with skill
// credits, over the RynthWebHost advancement plane (webhost.js:
// TryGetPlayerStats/TryGetSkillCredits + RaiseAttribute/RaiseVital/RaiseSkill/
// TrainSkill, which marshal SessionHandle.raiseAttribute/raiseVital/raiseSkill/
// trainSkill — GameAction 0x0044-0x0047, verified end-to-end vs ACE).
//
// Same additive registration shape as tools/economy.js: advancementActions()/
// registerAdvancement hand the integrator actions.js-shaped defs; extensions.js
// wires them default-on.
//
// Survival invariant: every apply degrades to { ok:false, error } — a host
// without the advancement capabilities (older wasm) can never throw into the
// director loop. The wasm calls are fire-and-forget and ACE rejects invalid
// spends SILENTLY (server Warn-log only), so we validate hard up front against
// the live stats snapshot and journal intent + "confirm next check-in";
// the next observation's advancement line is the confirm-by-diff.

const JOURNAL_CLIP = 800;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function journalNote(ctx, text) {
  try {
    ctx.journal?.add?.("note", clip(String(text), JOURNAL_CLIP));
  } catch {} // journal loss must not fail the action (journal.js contract)
}

// ── name → id maps (ACE Skill/PropertyAttribute/PropertyAttribute2nd) ──
// Attributes: raiseAttribute(attribute_id, ...) — d.ts:5050.
const ATTRS = { strength: 1, endurance: 2, quickness: 3, coordination: 4, focus: 5, self: 6 };
// Vitals: raiseVital(vital_id, ...) — MaxHealth=1, MaxStamina=3, MaxMana=5 (d.ts:5067).
const VITALS = { health: 1, stamina: 3, mana: 5 };
// Skills: raiseSkill/trainSkill(skill_id, ...) — ACE Skill enum (0-indexed).
const SKILLS = {
  melee_defense: 6, missile_defense: 7, arcane_lore: 14, magic_defense: 15,
  mana_conversion: 16, item_tinkering: 18, assess_person: 19, deception: 20,
  healing: 21, jump: 22, lockpick: 23, run: 24, assess_creature: 27,
  weapon_tinkering: 28, armor_tinkering: 29, magic_item_tinkering: 30,
  creature_enchantment: 31, item_enchantment: 32, life_magic: 33, war_magic: 34,
  leadership: 35, loyalty: 36, fletching: 37, alchemy: 38, cooking: 39,
  salvaging: 40, two_handed_combat: 41, void_magic: 43, heavy_weapons: 44,
  light_weapons: 45, finesse_weapons: 46, shield: 48, dual_wield: 49,
  recklessness: 50, sneak_attack: 51, dirty_fighting: 52, summoning: 54,
};
// SkillTable.TrainedCost (portal.dat SkillTable 0x0E000004) — trainSkill()
// requires EXACTLY this many credits or ACE rejects it (Player_Skills.cs:129).
const TRAINED_COST = {
  6: 10, 7: 6, 14: 4, 15: 0, 16: 6, 18: 2, 19: 2, 20: 4, 21: 6, 22: 0, 23: 6,
  24: 0, 27: 4, 28: 4, 29: 4, 30: 4, 31: 8, 32: 8, 33: 12, 34: 16, 35: 4,
  36: 0, 37: 4, 38: 6, 39: 4, 40: 0, 41: 8, 43: 16, 44: 6, 45: 4, 46: 4,
  48: 2, 49: 2, 50: 4, 51: 4, 52: 2, 54: 8,
};
const TRAINING = { 0: "unusable", 1: "untrained", 2: "trained", 3: "specialized" };

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
const skillNames = () => Object.keys(SKILLS).join(", ");

function makeApply(def, run) {
  return async function apply(bot, a, ctx = {}) {
    const fail = (error) => {
      try {
        ctx.log && ctx.log(`[ai] action ${def.type}: ${error}`);
      } catch {}
      return { type: def.type, ok: false, error: String(error) };
    };
    try {
      const v = def.validate(a);
      if (!v.ok) return fail(v.error);
      return await run(bot, a, ctx, fail);
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };
}

const baseValidate = (type) => (a) => {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
  if (a.type !== type) return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
  return { ok: true };
};

// Positive-integer xp validator shared by the three raise_* actions.
function validateXp(a) {
  if (!Number.isInteger(a.xp) || a.xp <= 0) return { ok: false, error: "xp must be a positive integer (amount of unspent XP to spend)" };
  return { ok: true };
}

// Reads the live stats snapshot via the host. -> normalized object | null.
function readStats(h) {
  if (typeof h?.TryGetPlayerStats !== "function") return null;
  try {
    return h.TryGetPlayerStats();
  } catch {
    return null;
  }
}

/** "raise_attribute" — spend unspent XP to raise an attribute (e.g. endurance). */
export function raiseAttributeAction() {
  const def = {
    type: "raise_attribute",
    params: { attribute: `one of: ${Object.keys(ATTRS).join(", ")}`, xp: "unspent XP to spend (raises as many ranks as it buys, capped at max)" },
    desc: "spend your unspent XP to permanently raise an attribute — raise endurance for more Health, self for more Mana. Check the advancement line for your unspent XP.",
    validate(a) {
      const b = baseValidate("raise_attribute")(a);
      if (!b.ok) return b;
      if (!(norm(a.attribute) in ATTRS)) return { ok: false, error: `unknown attribute "${a.attribute}"; one of: ${Object.keys(ATTRS).join(", ")}` };
      return validateXp(a);
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.RaiseAttribute !== "function") return fail("unavailable");
    const id = ATTRS[norm(a.attribute)];
    const st = readStats(h);
    if (st && Number.isFinite(st.unspentXp) && a.xp > st.unspentXp) return fail(`only ${st.unspentXp} unspent XP available (you asked to spend ${a.xp})`);
    const before = st?.attributes?.[id]?.current;
    if (!h.RaiseAttribute(id, a.xp)) return fail("raise request failed to send");
    journalNote(ctx, `raise_attribute ${norm(a.attribute)} +${a.xp}xp (was ${before ?? "?"}) — confirm on next check-in's advancement line`);
    return { type: def.type, ok: true, result: { attribute: norm(a.attribute), xpSpent: a.xp, before } };
  });
  return def;
}

/** "raise_vital" — spend unspent XP to raise max Health/Stamina/Mana directly. */
export function raiseVitalAction() {
  const def = {
    type: "raise_vital",
    params: { vital: `one of: ${Object.keys(VITALS).join(", ")}`, xp: "unspent XP to spend" },
    desc: "spend unspent XP to raise a max vital directly (health/stamina/mana). Raising endurance also raises Health and is usually more efficient early.",
    validate(a) {
      const b = baseValidate("raise_vital")(a);
      if (!b.ok) return b;
      if (!(norm(a.vital) in VITALS)) return { ok: false, error: `unknown vital "${a.vital}"; one of: ${Object.keys(VITALS).join(", ")}` };
      return validateXp(a);
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.RaiseVital !== "function") return fail("unavailable");
    const id = VITALS[norm(a.vital)];
    const st = readStats(h);
    if (st && Number.isFinite(st.unspentXp) && a.xp > st.unspentXp) return fail(`only ${st.unspentXp} unspent XP available (you asked to spend ${a.xp})`);
    const before = st?.vitals?.[id]?.max;
    if (!h.RaiseVital(id, a.xp)) return fail("raise request failed to send");
    journalNote(ctx, `raise_vital ${norm(a.vital)} +${a.xp}xp (max was ${before ?? "?"}) — confirm next check-in`);
    return { type: def.type, ok: true, result: { vital: norm(a.vital), xpSpent: a.xp, before } };
  });
  return def;
}

/** "raise_skill" — spend unspent XP to raise a TRAINED skill's rank. */
export function raiseSkillAction() {
  const def = {
    type: "raise_skill",
    params: { skill: "a skill you have Trained or Specialized (see advancement line)", xp: "unspent XP to spend" },
    desc: "spend unspent XP to raise a skill you already have Trained/Specialized (untrained skills cannot be raised — train_skill first).",
    validate(a) {
      const b = baseValidate("raise_skill")(a);
      if (!b.ok) return b;
      if (!(norm(a.skill) in SKILLS)) return { ok: false, error: `unknown skill "${a.skill}"; known: ${skillNames()}` };
      return validateXp(a);
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.RaiseSkill !== "function") return fail("unavailable");
    const id = SKILLS[norm(a.skill)];
    const st = readStats(h);
    const sk = st?.skills?.[id];
    if (sk && sk.training < 2) return fail(`${norm(a.skill)} is ${TRAINING[sk.training] ?? "untrained"} — must be Trained first (train_skill)`);
    if (st && Number.isFinite(st.unspentXp) && a.xp > st.unspentXp) return fail(`only ${st.unspentXp} unspent XP available (you asked to spend ${a.xp})`);
    const before = sk?.current;
    if (!h.RaiseSkill(id, a.xp)) return fail("raise request failed to send");
    journalNote(ctx, `raise_skill ${norm(a.skill)} +${a.xp}xp (was ${before ?? "?"}) — confirm next check-in`);
    return { type: def.type, ok: true, result: { skill: norm(a.skill), xpSpent: a.xp, before } };
  });
  return def;
}

/** "train_skill" — spend skill credits to train a new (untrained) skill. */
export function trainSkillAction() {
  const def = {
    type: "train_skill",
    params: { skill: `an untrained skill to train, e.g. ${["item_enchantment", "creature_enchantment", "mana_conversion", "war_magic"].join(", ")}` },
    desc: "spend skill credits to Train a new skill (Untrained -> Trained), unlocking it for casting/use and for raise_skill. Costs the skill's fixed credit price; check your skill credits on the advancement line.",
    validate(a) {
      const b = baseValidate("train_skill")(a);
      if (!b.ok) return b;
      if (!(norm(a.skill) in SKILLS)) return { ok: false, error: `unknown skill "${a.skill}"; known: ${skillNames()}` };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.TrainSkill !== "function") return fail("unavailable");
    const id = SKILLS[norm(a.skill)];
    const cost = TRAINED_COST[id];
    if (cost == null) return fail(`no trained-cost known for ${norm(a.skill)}`);
    const st = readStats(h);
    const sk = st?.skills?.[id];
    if (sk && sk.training >= 2) return fail(`${norm(a.skill)} is already ${TRAINING[sk.training]}`);
    const credits = typeof h.TryGetSkillCredits === "function" ? h.TryGetSkillCredits() : null;
    if (credits != null && credits < cost) return fail(`${norm(a.skill)} costs ${cost} skill credits, you have ${credits} (earn more by leveling)`);
    if (!h.TrainSkill(id, cost)) return fail("train request failed to send");
    journalNote(ctx, `train_skill ${norm(a.skill)} (-${cost} credits, had ${credits ?? "?"}) — confirm next check-in; then you can raise_skill it`);
    return { type: def.type, ok: true, result: { skill: norm(a.skill), creditsCost: cost, creditsBefore: credits } };
  });
  return def;
}

/** All advancement defs. */
export function advancementActions() {
  return [raiseAttributeAction(), raiseVitalAction(), raiseSkillAction(), trainSkillAction()];
}

/**
 * Integrator seam, registerEconomy-shaped: mutates a PASSED-IN copy of the
 * ACTIONS map. Returns the defs. Throws loudly on programmer error.
 */
export function registerAdvancement(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerAdvancement: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = advancementActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}

// Shared maps exported for observe_ext.js (advancement observation line) and tests.
export const ADVANCEMENT_MAPS = { ATTRS, VITALS, SKILLS, TRAINED_COST, TRAINING };
