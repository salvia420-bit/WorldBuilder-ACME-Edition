// Item appraisal text — the ItemExamineUI::SetAppraiseInfo (acclient.c:235257)
// sections behind the examine panel's Weapon / Armor / Magic blocks, as pure
// line builders (no DOM, no wasm). examine-text-5 (2026-10-13).
//
// Each builder takes the snapshot `getObjectAppraisal(guid)` returns
// (property bags keyed by the Rust enum name, `weaponProfile`, the
// *Highlight / *Color masks, `identifySuccess` / `identifyFlags`) and returns
// retail's lines in retail order:
//   { key, text, label?, value?, tone, group? }
// `text` is retail's whole line. `label` + `value` split it for a kit kv row
// (the value drops the closing period, like the panel's other rows); a line
// without `label` is a sentence the panel prints as prose. `tone` is
// highlightState's "buffed" / "debuffed" / null for the enchantment bit
// AppraisalProfile::InqIntEnchantmentMod / ::InqFloatEnchantmentMod
// (acclient.c:477439 / :477475) map the stat to:
//   armor  0x1 ArmorLevel (int 0x1C)
//   weapon 0x1 WeaponOffense (float 0x3E), 0x2 WeaponDefense (0x1D),
//          0x4 WeaponTime (int 0x31), 0x8 Damage (int 0x2C),
//          0x10 DamageVariance (float 0x16), 0x20 DamageMod (float 0x3F)
//   resist 0x1000 ManaConversionMod (0x90), 0x2000 ElementalDamageMod (0x98)
// The highlight masks are honoured only when the IdentifyResponse flagged
// them (or carried no flags at all), like examine-target.js's flagBit.
//
// Re-derived from acclient.c; WebAC packages/renderer/src/ui/examine/
// ItemAppraisalText.ts (AGPL-3.0) was a cross-check only.
//
// examine-text-6 (2026-10-13), phase 1: Appraisal_ShowSet,
// Appraisal_ShowRatings, Appraisal_ShowSpecialProperties and
// Appraisal_ShowItemLevelInfo (equipmentSetLines / ratingLines /
// specialPropertyLines / itemLevelLines below).

import {
  ATTRIBUTE_NAMES, VITAL_NAMES,
  attunedText, bondedText, creatureTypeName, formatThousands,
  damageTypeLabel, heritageName, highlightState, skillName, weaponSpeedText,
} from "./examine_format.js";

// ── Property bags (Rust enum name first, wire id as a fallback) ─────────

function bagValue(bag, name, id) {
  if (!bag) return undefined;
  const v = bag[name] ?? bag[String(id)];
  return v == null || v === "" ? undefined : v;
}
function bagInt(bag, name, id) {
  const v = bagValue(bag, name, id);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}
function bagFloat(bag, name, id) {
  const v = bagValue(bag, name, id);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function bagBool(bag, name, id) {
  const v = bagValue(bag, name, id);
  return v === true || v === 1 || v === "true";
}

// IdentifyResponseFlags (holtburger-protocol object/events.rs).
const IDENTIFY_FLAG_WEAPON_PROFILE = 0x0020;
const IDENTIFY_FLAG_HOOK_PROFILE = 0x0040;
const IDENTIFY_FLAG_ARMOR_ENCH = 0x0200;
const IDENTIFY_FLAG_RESIST_ENCH = 0x0400;
const IDENTIFY_FLAG_WEAPON_ENCH = 0x0800;

function appraisalView(snapshot) {
  const s = snapshot || {};
  const p = s.properties || {};
  const flags = (Number(s.identifyFlags) >>> 0) || 0;
  const has = (mask) => flags === 0 || (flags & mask) !== 0;
  const toneFn = (h, c, mask) => (has(mask) ? (bit) => highlightState(h, c, bit) : () => null);
  return {
    success: s.identifySuccess !== false,
    ints: p.ints || {},
    floats: p.floats || {},
    bools: p.bools || {},
    strings: p.strings || {},
    int64s: p.int64s || {},
    dids: p.dids || {},
    wp: has(IDENTIFY_FLAG_WEAPON_PROFILE) ? (s.weaponProfile || null) : null,
    hook: has(IDENTIFY_FLAG_HOOK_PROFILE) ? (s.hookProfile || null) : null,
    armorTone: toneFn(s.armorHighlight, s.armorColor, IDENTIFY_FLAG_ARMOR_ENCH),
    weaponTone: toneFn(s.weaponHighlight, s.weaponColor, IDENTIFY_FLAG_WEAPON_ENCH),
    resistTone: toneFn(s.resistHighlight, s.resistColor, IDENTIFY_FLAG_RESIST_ENCH),
  };
}

// ── Number formatting ─────────────────────────────────────────────────

/** ModifierToString (acclient.c:226480): "%c%d%%" — '-' when rMod < 1,
 *  else '+', then (unsigned __int64)(|1 − rMod| × 100 + 0.5). */
export function modifierToString(rMod) {
  const m = Number(rMod);
  if (!Number.isFinite(m)) return null;
  return `${m < 1 ? "-" : "+"}${Math.trunc(Math.abs(1 - m) * 100 + 0.5)}%`;
}

/** SmallModifierToString (acclient.c:226492): "%c%.1lf%%" of |1 − rMod| × 100. */
export function smallModifierToString(rMod) {
  const m = Number(rMod);
  if (!Number.isFinite(m)) return null;
  return `${m < 1 ? "-" : "+"}${(Math.abs(1 - m) * 100).toFixed(1)}%`;
}

/** C's "%.<p>g": `p` significant digits, trailing zeros dropped, exponent
 *  form when the rounded exponent is < −4 or ≥ p. */
export function formatG(x, precision) {
  const v = Number(x);
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const [mant, e] = v.toExponential(precision - 1).split("e");
  const exp = Number(e);
  const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (exp < -4 || exp >= precision) {
    return `${trim(mant)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return trim(v.toFixed(precision - 1 - exp));
}

// ── Appraisal_ShowWeaponAndArmorData (acclient.c:231171) ───────────────

/** AppraisalSystem::SkillToString (acclient.c:479655) — the appraisal's own
 *  skill words (retired / renamed skills included; Shield 0x30 has none, so
 *  a shield prints no "Skill:" line). */
export const APPRAISAL_SKILL_NAMES = Object.freeze({
  1: "Axe", 2: "Bow", 3: "Crossbow", 4: "Dagger", 5: "Mace",
  6: "Melee Defense", 7: "Missile Defense", 8: "Sling", 9: "Spear", 10: "Staff",
  11: "Sword", 12: "Thrown Weapon", 13: "Unarmed Combat", 14: "Arcane Lore",
  15: "Magic Defense", 16: "Mana Conversion", 17: "Spellcraft", 18: "Item Tinkering",
  19: "Person Appraisal", 20: "Deception", 21: "Healing", 22: "Jump", 23: "Lockpick",
  24: "Run", 25: "Awareness", 26: "Armor Repair", 27: "Creature Appraisal",
  28: "Weapon Tinkering", 29: "Armor Tinkering", 30: "Magic Item Tinkering",
  31: "Creature Enchantment", 32: "Item Enchantment", 33: "Life Magic", 34: "War Magic",
  35: "Leadership", 36: "Loyalty", 37: "Fletching", 38: "Alchemy", 39: "Cooking",
  40: "Salvaging", 41: "Two Handed Combat", 42: "Gearcraft", 43: "Void Magic",
  44: "Heavy Weapons", 45: "Light Weapons", 46: "Finesse Weapons", 47: "Missile Weapons",
  49: "Dual Wield", 50: "Recklessness", 51: "Sneak Attack", 52: "Dirty Fighting",
  53: "Challenge", 54: "Summoning",
});

/** The "Skill: " line's suffix for PropertyInt WeaponType (0x161). */
export const WEAPON_TYPE_SUFFIX = Object.freeze({
  1: " (Unarmed Weapon)", 2: " (Sword)", 3: " (Axe)", 4: " (Mace)", 5: " (Spear)",
  6: " (Dagger)", 7: " (Staff)", 8: " (Bow)", 9: " (Crossbow)", 10: " (Thrown)",
});

/** MISSILE_RANGE_CAP (acclient.c:40036). */
const MISSILE_RANGE_CAP = 85.0;

/**
 * The "Range: %d yds." number: pow(maxVelocity, 2) × 0.1020408163265306 ×
 * 1.094 capped at MISSILE_RANGE_CAP, then rounded down to a multiple of 5
 * from 10 yards up, or ceil'd below 10.
 */
export function missileRangeYards(maxVelocity) {
  const v = Number(maxVelocity);
  if (!Number.isFinite(v)) return null;
  let range = Math.pow(v, 2) * 0.1020408163265306 * 1.094;
  if (range > MISSILE_RANGE_CAP) range = MISSILE_RANGE_CAP;
  if (range >= 10) {
    const r = Math.trunc(range);
    return r - (r % 5);
  }
  return Math.ceil(range);
}

/**
 * AppraisalSystem::ClothingPriorityToString (acclient.c:479868): "Covers "
 * plus the body parts of the CoverageMask (PropertyInt ClothingPriority, the
 * CreateObject `priority`), joined with ", ". Underwear and outerwear bits
 * share a word. null when no part matches (retail returns 0 and prints
 * nothing).
 */
const COVERAGE_PARTS = Object.freeze([
  [0x4000, "Head"],
  [0x0008 | 0x0400, "Chest"],
  [0x0010 | 0x0800, "Abdomen"],
  [0x0020 | 0x1000, "Upper Arms"],
  [0x0040 | 0x2000, "Lower Arms"],
  [0x8000, "Hands"],
  [0x0002 | 0x0100, "Upper Legs"],
  [0x0004 | 0x0200, "Lower Legs"],
  [0x10000, "Feet"],
]);
export function clothingPriorityText(priority) {
  const p = (Number(priority) >>> 0) || 0;
  const parts = COVERAGE_PARTS.filter(([bits]) => (p & bits) !== 0).map(([, n]) => n);
  return parts.length ? `Covers ${parts.join(", ")}` : null;
}

const AMMO_USES = Object.freeze({
  1: "Uses arrows as ammunition.",
  2: "Uses quarrels as ammunition.",
  4: "Uses atlatl darts as ammunition.",
});
const AMMO_USED_BY = Object.freeze({
  1: "Used as ammunition by bows.",
  2: "Used as ammunition by crossbows.",
  4: "Used as ammunition by atlatls.",
});

// EquipMask bits ShowWeaponAndArmorData tests on `lm` (the ValidLocations).
const LM_WIELDED = 0x3F00000;     // melee | shield | missile | ammo | held | two-handed
const LM_MELEE = 0x100000;
const LM_SHIELD = 0x200000;
const LM_MISSILE = 0x400000;
const LM_AMMO = 0x800000;
const LM_SPEED = 0x2500000;       // melee | missile | two-handed
const LM_ARMOR_CLOTHING = 0x8007FFF;

/**
 * SetAppraiseInfo's `lm` (acclient.c:235301): the CreateObject
 * `valid_locations` (PropertyInt ValidLocations, hydrated into the bag),
 * or a hook's item's (GetHookedItemValidLocations) when it is numeric.
 * Holtburger fallback: an object with a weapon profile but NO
 * ValidLocations in its bag reads as a melee weapon, so its weapon lines
 * still show (a known 0 prints nothing, as in retail).
 */
function validLocations(view) {
  const hooked = view.hook?.valid_locations;
  if (typeof hooked === "number" && hooked !== 0) return hooked >>> 0;
  const lm = bagInt(view.ints, "ValidLocations", 9);
  if (lm !== undefined) return lm >>> 0;
  return view.wp ? LM_MELEE : 0;
}

function ammoTypeOf(view) {
  const hooked = view.hook?.ammo_type;
  if (typeof hooked === "number" && hooked !== 0) return hooked >>> 0;
  return (bagInt(view.ints, "AmmoType", 50) ?? 0) >>> 0;
}

function kv(key, label, value, tone = null, group = undefined, text = undefined) {
  return { key, text: text ?? `${label}: ${value}.`, label, value, tone: tone ?? null, group };
}

/**
 * ItemExamineUI::Appraisal_ShowWeaponAndArmorData (acclient.c:231171), in
 * retail order:
 *   - shields (lm & 0x200000): "Base Shield Level: %d" (armor bit 0x1) and
 *     "Effective Shield Level : %d (with Shield skill)" — the viewer's
 *     buffed Shield skill, halved below specialized, capped at the level —
 *     or "Shield Level: Unknown";
 *   - the weapon profile: "Skill: <SkillToString><WeaponType suffix>",
 *     "Damage: <min> - <max>, <types>" (a launcher with ammo reads
 *     "Damage Bonus: " without the types), "Elemental Damage Bonus: %d,
 *     %s.", "Damage Modifier: %s." (ammo launchers only), "Speed: …" and
 *     "Range: %d yds." (melee / missile / two-handed only), "Bonus to Attack
 *     Skill: %s%d%%." (not for ammo launchers, :231563);
 *   - "Uses arrows as ammunition." / "Used as ammunition by bows." lines;
 *   - a non-wieldable armor / clothing item: "Covers …".
 * `opts.shieldSkill` is `{current, training}` (training 3 = specialized) or
 * a function returning it, read only for a shield; absent = 0, like
 * retail's zeroed InqSkill out-params.
 * @returns {Array<{key, text, label?, value?, tone, group: "weapon"|"armor"}>}
 */
export function weaponAndArmorLines(snapshot, opts = {}) {
  const view = appraisalView(snapshot);
  const { ints, wp } = view;
  const lines = [];
  const lm = validLocations(view);
  const ammoType = ammoTypeOf(view);

  if ((lm & LM_WIELDED) === 0) {
    if ((lm & LM_ARMOR_CLOTHING) !== 0) {
      const covers = clothingPriorityText(bagInt(ints, "ClothingPriority", 4));
      if (covers) lines.push({ key: "covers", text: covers, tone: null, group: "armor" });
    }
    return lines;
  }

  if ((lm & LM_SHIELD) !== 0) {
    const sl = bagInt(ints, "ArmorLevel", 28);
    if (sl === undefined) {
      lines.push(kv("shieldLevel", "Shield Level", "Unknown", null, "armor", "Shield Level: Unknown"));
    } else {
      lines.push(kv("baseShieldLevel", "Base Shield Level", String(sl), view.armorTone(0x1), "armor",
        `Base Shield Level: ${sl}`));
      const sk = typeof opts.shieldSkill === "function" ? opts.shieldSkill() : opts.shieldSkill;
      let eff = Math.trunc(Number(sk?.current) || 0);
      if (!((Number(sk?.training) || 0) >= 3)) eff = Math.trunc(eff / 2);
      if (eff > sl) eff = sl;
      lines.push(kv("effectiveShieldLevel", "Effective Shield Level", `${eff} (with Shield skill)`, null, "armor",
        `Effective Shield Level : ${eff} (with Shield skill)`));
    }
  }

  const missile = (lm & LM_MISSILE) !== 0;
  if (wp) {
    // `raised` in retail: a missile launcher that takes ammunition.
    const launcher = missile && ammoType !== 0;
    const skill = APPRAISAL_SKILL_NAMES[Number(wp.weapon_skill) >>> 0];
    if (skill) {
      const sub = bagInt(ints, "WeaponType", 353);
      const value = skill + (sub !== undefined ? (WEAPON_TYPE_SUFFIX[sub] ?? "") : "");
      lines.push(kv("skill", "Skill", value, null, "weapon", `Skill: ${value}`));
    }

    const damageLabel = launcher ? "Damage Bonus" : "Damage";
    const dmg = Number(wp.damage) | 0; // u32 on the wire; retail's int −1 = unknown
    if (dmg <= -1) {
      lines.push(kv("damage", damageLabel, "Unknown", null, "weapon", `${damageLabel}: Unknown`));
    } else {
      let suffix = "";
      if (!launcher) {
        const dt = Number(wp.damage_type) >>> 0;
        suffix = dt ? `, ${damageTypeLabel(dt) ?? ""}` : ", unknown type";
      }
      const min = (1 - Number(wp.damage_variance)) * dmg;
      const value = (dmg - min > 0.00019999999)
        ? `${formatG(min, min >= 10 ? 4 : 3)} - ${dmg}${suffix}`
        : `${dmg}${suffix}`;
      lines.push(kv("damage", damageLabel, value, view.weaponTone(0x8) || view.weaponTone(0x10), "weapon",
        `${damageLabel}: ${value}`));
    }

    const edb = bagInt(ints, "ElementalDamageBonus", 204) ?? 0;
    if (edb > 0) {
      const types = damageTypeLabel(Number(wp.damage_type) >>> 0) ?? "";
      lines.push(kv("elementalDamageBonus", "Elemental Damage Bonus", `${edb}, ${types}`, null, "weapon"));
    }

    if (launcher) {
      if (view.success) {
        const mod = modifierToString(wp.damage_mod);
        if (mod) lines.push(kv("damageModifier", "Damage Modifier", mod, view.weaponTone(0x20), "weapon"));
      } else {
        lines.push(kv("damageModifier", "Damage Modifier", "Unknown", null, "weapon", "Damage Modifier: Unknown"));
      }
    }

    if ((lm & LM_SPEED) !== 0) {
      const time = Number(wp.weapon_time) | 0;
      if (time <= -1) {
        lines.push(kv("speed", "Speed", "Unknown", null, "weapon", "Speed:  Unknown"));
        if (missile) lines.push(kv("range", "Range", "Unknown", null, "weapon", "Range:  Unknown"));
      } else {
        const speed = weaponSpeedText(time);
        lines.push(kv("speed", "Speed", speed, view.weaponTone(0x4), "weapon", `Speed: ${speed}`));
        if (missile) {
          const yds = missileRangeYards(wp.max_velocity);
          if (yds != null) {
            const est = Number(wp.max_velocity_estimated) ? " (based on STRENGTH 100)" : "";
            const value = `${yds} yds.${est}`;
            lines.push(kv("range", "Range", value, null, "weapon", `Range: ${value}`));
          }
        }
      }
    }

    const offense = Number(wp.weapon_offense);
    if (Number.isFinite(offense) && offense !== 1 && !launcher) {
      const value = modifierToString(offense);
      lines.push(kv("attackSkill", "Bonus to Attack Skill", value, view.weaponTone(0x1), "weapon"));
    }
  }

  const ammoLine = missile ? AMMO_USES[ammoType] : ((lm & LM_AMMO) !== 0 ? AMMO_USED_BY[ammoType] : undefined);
  if (ammoLine) lines.push({ key: "ammo", text: ammoLine, tone: null, group: "weapon" });
  return lines;
}

// ── Appraisal_ShowDefenseModData (acclient.c:231730) ──────────────────

/**
 * "Bonus to Melee Defense: %s." (float WeaponDefense 0x1D, weapon bit 0x2),
 * "Bonus to Missile Defense: %s." (0x95) and "Bonus to Magic Defense: %s."
 * (0x96), each SmallModifierToString and only when the float is not 1.
 */
export function defenseModLines(snapshot) {
  const view = appraisalView(snapshot);
  const lines = [];
  const add = (key, label, name, id, tone) => {
    const m = bagFloat(view.floats, name, id);
    if (m === undefined || m === 1) return;
    lines.push(kv(key, label, smallModifierToString(m), tone));
  };
  add("meleeDefense", "Bonus to Melee Defense", "WeaponDefense", 29, view.weaponTone(0x2));
  add("missileDefense", "Bonus to Missile Defense", "WeaponMissileDefense", 149, null);
  add("magicDefense", "Bonus to Magic Defense", "WeaponMagicDefense", 150, null);
  return lines;
}

// ── Appraisal_ShowCasterData (acclient.c:231613) ──────────────────────

/** CombatSystem::ElementalModPKModifier (acclient.c:45860). */
export const ELEMENTAL_MOD_PK_MODIFIER = 0.25;

/**
 * - "Bonus to Mana Conversion: %s." — ModifierToString(ManaConversionMod
 *   (float 0x90) + 1), resist bit 0x1000;
 * - with ElementalDamageMod (float 0x98) and DamageType (int 0x2D):
 *   "Damage bonus for %s spells:", " vs. Monsters: %s." and " vs. Players:
 *   %s." (CombatSystem::GetElementalModPKModifier, :500132:
 *   (mod − 1) × 0.25 + 1), all three in resist bit 0x2000's tint.
 * The header line has no label (prose); the two vs. lines are kv rows.
 */
export function casterLines(snapshot) {
  const view = appraisalView(snapshot);
  const lines = [];
  const mc = bagFloat(view.floats, "ManaConversionMod", 144);
  if (mc !== undefined) {
    lines.push(kv("manaConversion", "Bonus to Mana Conversion", modifierToString(mc + 1), view.resistTone(0x1000)));
  }
  const edm = bagFloat(view.floats, "ElementalDamageMod", 152);
  const dt = bagInt(view.ints, "DamageType", 45);
  if (edm !== undefined && dt !== undefined) {
    const tone = view.resistTone(0x2000);
    const pvp = (edm - 1) * ELEMENTAL_MOD_PK_MODIFIER + 1;
    const types = damageTypeLabel(dt >>> 0) ?? "";
    lines.push({ key: "elementalSpells", text: `Damage bonus for ${types} spells:`, tone });
    const vsMonsters = smallModifierToString(edm);
    const vsPlayers = smallModifierToString(pvp);
    lines.push(kv("vsMonsters", "vs. Monsters", vsMonsters, tone, undefined, ` vs. Monsters: ${vsMonsters}.`));
    lines.push(kv("vsPlayers", "vs. Players", vsPlayers, tone, undefined, ` vs. Players: ${vsPlayers}.`));
  }
  return lines;
}

// ── Appraisal_ShowActivationRequirements (acclient.c:232724) ──────────

/**
 * Successful appraisals only. One "Activation requires " line joining, with
 * ", ": "Arcane Lore: %d" (ItemDifficulty 0x6D > 0), "Allegiance Rank: %d"
 * (ItemAllegianceRankLimit 0x6E ≥ 1), the heritage name (HeritageGroup 0xBC),
 * "<skill>: %d" (ItemSkillLevelLimit 0x73 > 0 with AppraisalItemSkill 0xB0),
 * "<attribute>: %d" (ItemAttributeLevelLimit 0x102 > 0 with
 * ItemAttributeLimit 0x101) and "<vital>: %d" (ItemAttribute2ndLevelLimit
 * 0x104 > 0 with ItemAttribute2ndLimit 0x103). Then, for
 * AppraisalHasAllowedActivator (bool 0x5E), "This item can only be activated
 * by <CraftsmanName | the original owner>.". Both are prose.
 */
export function activationRequirementLines(snapshot) {
  const view = appraisalView(snapshot);
  if (!view.success) return [];
  const { ints, bools, strings } = view;
  const parts = [];
  const diff = bagInt(ints, "ItemDifficulty", 109);
  if (diff !== undefined && diff > 0) parts.push(`Arcane Lore: ${diff}`);
  const rank = bagInt(ints, "ItemAllegianceRankLimit", 110);
  if (rank !== undefined && rank >= 1) parts.push(`Allegiance Rank: ${rank}`);
  const heritage = bagInt(ints, "HeritageGroup", 188);
  if (heritage) {
    const h = heritageName(heritage);
    if (h) parts.push(h);
  }
  const skillLimit = bagInt(ints, "ItemSkillLevelLimit", 115);
  const skill = bagInt(ints, "AppraisalItemSkill", 176);
  if (skillLimit !== undefined && skillLimit > 0 && skill !== undefined) {
    const n = skill > 0 ? skillName(skill) : null;
    if (n) parts.push(`${n}: ${skillLimit}`);
  }
  const attrLimit = bagInt(ints, "ItemAttributeLevelLimit", 258);
  const attr = bagInt(ints, "ItemAttributeLimit", 257);
  if (attrLimit !== undefined && attrLimit > 0 && attr !== undefined) {
    const n = ATTRIBUTE_NAMES[attr];
    if (n) parts.push(`${n}: ${attrLimit}`);
  }
  const vitalLimit = bagInt(ints, "ItemAttribute2ndLevelLimit", 260);
  const vital = bagInt(ints, "ItemAttribute2ndLimit", 259);
  if (vitalLimit !== undefined && vitalLimit > 0 && vital !== undefined) {
    const n = VITAL_NAMES[vital];
    if (n) parts.push(`${n}: ${vitalLimit}`);
  }
  const lines = [];
  if (parts.length) lines.push({ key: "activation", text: `Activation requires ${parts.join(", ")}`, tone: null });
  if (bagBool(bools, "AppraisalHasAllowedActivator", 94)) {
    const owner = bagValue(strings, "CraftsmanName", 25);
    lines.push({
      key: "allowedActivator",
      text: `This item can only be activated by ${owner !== undefined ? String(owner) : "the original owner"}.`,
      tone: null,
    });
  }
  return lines;
}

// ── Appraisal_ShowSet (acclient.c:229498) ─────────────────────────────

/** The InqInt(0x109 EquipmentSetId) switch. 1-3, 34 and 42-48 have no
 *  name, so retail prints nothing for them; the retired Weave ids
 *  53/67/74/75/79 read "Light Weapons" and 54/57/77 "Missile Weapons". */
export const EQUIPMENT_SET_NAMES = Object.freeze({
  4: "Carraida's Benediction", 5: "Noble Relic", 6: "Ancient Relic", 7: "Alduressa Relic",
  8: "Shou-jen", 9: "Empyrean Rings", 10: "Arm, Mind, Heart", 11: "Coat of Perfect Light",
  12: "Leggings of Perfect Light", 13: "Soldier's", 14: "Adept's", 15: "Archer's", 16: "Defender's",
  17: "Tinker's", 18: "Crafter's", 19: "Hearty", 20: "Dexterous", 21: "Wise", 22: "Swift",
  23: "Hardened", 24: "Reinforced", 25: "Interlocking", 26: "Flame Proof", 27: "Acid Proof",
  28: "Cold Proof", 29: "Lightning Proof", 30: "Dedication", 31: "Gladiatorial Clothing",
  32: "Ceremonial Clothing", 33: "Protective Clothing", 35: "Sigil of Defense",
  36: "Sigil of Destruction", 37: "Sigil of Fury", 38: "Sigil of Growth", 39: "Sigil of Vigor",
  40: "Heroic Protector", 41: "Heroic Destroyer", 49: "Weave of Alchemy",
  50: "Weave of Arcane Lore", 51: "Weave of Armor Tinkering", 52: "Weave of Assess Person",
  53: "Weave of Light Weapons", 54: "Weave of Missile Weapons", 55: "Weave of Cooking",
  56: "Weave of Creature Enchantment", 57: "Weave of Missile Weapons",
  58: "Weave of Finesse Weapons", 59: "Weave of Deception", 60: "Weave of Fletching",
  61: "Weave of Healing", 62: "Weave of Item Enchantment", 63: "Weave of Item Tinkering",
  64: "Weave of Leadership", 65: "Weave of Life Magic", 66: "Weave of Loyalty",
  67: "Weave of Light Weapons", 68: "Weave of Magic Defense", 69: "Weave of Magic Item Tinkering",
  70: "Weave of Mana Conversion", 71: "Weave of Melee Defense", 72: "Weave of Missile Defense",
  73: "Weave of Salvaging", 74: "Weave of Light Weapons", 75: "Weave of Light Weapons",
  76: "Weave of Heavy Weapons", 77: "Weave of Missile Weapons", 78: "Weave of Two Handed Combat",
  79: "Weave of Light Weapons", 80: "Weave of Void Magic", 81: "Weave of War Magic",
  82: "Weave of Weapon Tinkering", 83: "Weave of Assess Creature", 84: "Weave of Dirty Fighting",
  85: "Weave of Dual Wield", 86: "Weave of Recklessness", 87: "Weave of Shield",
  88: "Weave of Sneak Attack", 89: "Shou-jen Shozoku", 90: "Weave of Summoning",
  91: "Shrouded Soul", 92: "Darkened Mind", 93: "Clouded Spirit",
  94: "Minor Stinging Shrouded Soul", 95: "Minor Sparking Shrouded Soul",
  96: "Minor Smoldering Shrouded Soul", 97: "Minor Shivering Shrouded Soul",
  98: "Minor Stinging Darkened Mind", 99: "Minor Sparking Darkened Mind",
  100: "Minor Smoldering Darkened Mind", 101: "Minor Shivering Darkened Mind",
  102: "Minor Stinging Clouded Spirit", 103: "Minor Sparking Clouded Spirit",
  104: "Minor Smoldering Clouded Spirit", 105: "Minor Shivering Clouded Spirit",
  106: "Major Stinging Shrouded Soul", 107: "Major Sparking Shrouded Soul",
  108: "Major Smoldering Shrouded Soul", 109: "Major Shivering Shrouded Soul",
  110: "Major Stinging Darkened Mind", 111: "Major Sparking Darkened Mind",
  112: "Major Smoldering Darkened Mind", 113: "Major Shivering Darkened Mind",
  114: "Major Stinging Clouded Spirit", 115: "Major Sparking Clouded Spirit",
  116: "Major Smoldering Clouded Spirit", 117: "Major Shivering Clouded Spirit",
  118: "Blackfire Stinging Shrouded Soul", 119: "Blackfire Sparking Shrouded Soul",
  120: "Blackfire Smoldering Shrouded Soul", 121: "Blackfire Shivering Shrouded Soul",
  122: "Blackfire Stinging Darkened Mind", 123: "Blackfire Sparking Darkened Mind",
  124: "Blackfire Smoldering Darkened Mind", 125: "Blackfire Shivering Darkened Mind",
  126: "Blackfire Stinging Clouded Spirit", 127: "Blackfire Sparking Clouded Spirit",
  128: "Blackfire Smoldering Clouded Spirit", 129: "Blackfire Shivering Clouded Spirit",
  130: "Shimmering Shadows",
});

/** "Set: <name>" (no period) for a named EquipmentSetId. A kv row. */
export function equipmentSetLines(snapshot) {
  const view = appraisalView(snapshot);
  const id = bagInt(view.ints, "EquipmentSetId", 265);
  const name = id !== undefined && id > 0 ? EQUIPMENT_SET_NAMES[id] : undefined;
  if (!name) return [];
  return [kv("set", "Set", name, null, undefined, `Set: ${name}`)];
}

// ── Appraisal_ShowRatings (acclient.c:229906) ─────────────────────────

/** The gear rating ints in retail's print order (Crit Dam 0x176 comes
 *  before Crit Resist 0x175, Nether 0x179 before Life 0x17A). */
const RATING_PARTS = Object.freeze([
  ["GearDamage", 370, "Dam"],
  ["GearDamageResist", 371, "Dam Resist"],
  ["GearCrit", 372, "Crit"],
  ["GearCritDamage", 374, "Crit Dam"],
  ["GearCritResist", 373, "Crit Resist"],
  ["GearCritDamageResist", 375, "Crit Dam Resist"],
  ["GearHealingBoost", 376, "Heal Boost"],
  ["GearNetherResist", 377, "Nether Resist"],
  ["GearLifeResist", 378, "Life Resist"],
]);

/**
 * "Ratings: Dam %d, Dam Resist %d, …." — every rating int > 0, joined
 * with ", " — then "This item adds %d Vitality." for GearMaxHealth (int
 * 0x17B) > 0. The Ratings line is a kv row (value without the period),
 * the Vitality line prose.
 */
export function ratingLines(snapshot) {
  const view = appraisalView(snapshot);
  const parts = [];
  for (const [name, id, label] of RATING_PARTS) {
    const v = bagInt(view.ints, name, id) ?? 0;
    if (v > 0) parts.push(`${label} ${v}`);
  }
  const lines = [];
  if (parts.length) lines.push(kv("ratings", "Ratings", parts.join(", ")));
  const vitality = bagInt(view.ints, "GearMaxHealth", 379) ?? 0;
  if (vitality > 0) lines.push({ key: "vitality", text: `This item adds ${vitality} Vitality.`, tone: null });
  return lines;
}

// ── Appraisal_ShowSpecialProperties (acclient.c:230639) ───────────────

/**
 * ClientUISystem::DeltaTimeToString (acclient.c:403033): whole seconds
 * (truncated to an unsigned int) as "%dmo %dd %dh %dm %ds" — 30-day
 * months, each unit only when non-zero, seconds always — with the
 * trailing space cut. 90 → "1m 30s", 3600 → "1h 0s".
 */
export function deltaTimeToString(seconds) {
  const t = Math.max(0, Math.trunc(Number(seconds) || 0)) >>> 0;
  const mo = Math.trunc(t / 2592000);
  let rem = t % 2592000;
  const d = Math.trunc(rem / 86400);
  rem %= 86400;
  const h = Math.trunc(rem / 3600);
  rem %= 3600;
  const m = Math.trunc(rem / 60);
  let out = "";
  if (mo) out += `${mo}mo `;
  if (d) out += `${d}d `;
  if (h) out += `${h}h `;
  if (m) out += `${m}m `;
  return `${out}${rem % 60}s`;
}

/** The imbue bits — the OR of ImbuedEffect (int 0xB3) and ImbuedEffect2..5
 *  (0x12F..0x132) — in retail's print order: Nether 0x4000 sits between
 *  Acid and Cold, and 0x80000000 reads "Phantasmal". */
export const IMBUED_EFFECT_NAMES = Object.freeze([
  [0x1, "Critical Strike"], [0x2, "Crippling Blow"], [0x4, "Armor Rending"],
  [0x8, "Slash Rending"], [0x10, "Pierce Rending"], [0x20, "Bludgeon Rending"],
  [0x40, "Acid Rending"], [0x4000, "Nether Rending"], [0x80, "Cold Rending"],
  [0x100, "Lightning Rending"], [0x200, "Fire Rending"], [0x400, "+1 Melee Defense"],
  [0x800, "+1 Missile Defense"], [0x1000, "+1 Magic Defense"], [0x80000000, "Phantasmal"],
]);
const IMBUE_INTS = Object.freeze([
  ["ImbuedEffect", 179], ["ImbuedEffect2", 303], ["ImbuedEffect3", 304],
  ["ImbuedEffect4", 305], ["ImbuedEffect5", 306],
]);

/** AttackType (int 0x2F) bits that read "Multi-Strike": the double and
 *  triple slashes and thrusts, main and off hand. */
const ATTACK_TYPE_MULTI_STRIKE = 0x79E0;
/** ResistMagic (int 0x24) at or above this reads "Unenchantable". */
const RESIST_MAGIC_UNENCHANTABLE = 9999;
/** SlayerCreatureType 31 (Human) reads "Bael'Zharon's Hate". */
const CREATURE_TYPE_HUMAN = 31;

/**
 * ItemExamineUI::Appraisal_ShowSpecialProperties, in retail order:
 *   - "You can only carry %s of these items." (Unique, int 0x117, with
 *     InsertCommas);
 *   - "Cooldown When Used: <DeltaTimeToString>" (CooldownDuration, float
 *     0xA7) and, for a SharedCooldown (int 0x118) that is cooling down,
 *     "Cooldown Remaining: …". `opts.cooldownRemaining(sharedCooldownId)`
 *     returns the seconds left (CEnchantmentRegistry::OnCooldown on
 *     id + 0x8000); without it the line is skipped;
 *   - "Cleave: %d enemies in front arc." (Cleaving, int 0x124, > 1);
 *   - "Properties: " + the AppendHelper ", " list: "<creature> slayer" or
 *     "Bael'Zharon's Hate" (SlayerCreatureType 0xA6), "Multi-Strike"
 *     (AttackType & 0x79E0), the imbue names, "Magic Absorbing"
 *     (AbsorbMagicDamage 0x9F), "Unenchantable" (ResistMagic ≥ 9999), the
 *     Attuned and Bonded words, "Retained" (bool 0x5B), "Crushing Blow"
 *     (CriticalMultiplier 0x88), "Biting Strike" (CriticalFrequency 0x93),
 *     "Armor Cleaving" (IgnoreArmor 0x9B), "Resistance Cleaving: <type>"
 *     (ResistanceModifier 0x9D with ResistanceModifierType 0x107), "Cast
 *     on Strike" (ProcSpell DID 0x37), "Ivoryable" (bool 0x63) and
 *     "Dyeable" (bool 0x64). The float and DID entries need only be
 *     present, like retail's Inq* calls. No closing period;
 *   - "This item cannot be further imbued." (any imbue bit);
 *   - "This item is tethered to the left side." (AutowieldLeft, bool 0x82).
 * `opts.attuned` / `opts.bonded` take the AttunedStatusToString /
 * BondedStatusToString words when the caller already has them
 * (examine-target.js); otherwise they come from the bag.
 * @returns {Array<{key, text, label?, value?, tone}>}
 */
export function specialPropertyLines(snapshot, opts = {}) {
  const o = opts || {};
  const view = appraisalView(snapshot);
  const { ints, floats, bools, dids } = view;
  const lines = [];

  const unique = bagInt(ints, "Unique", 279);
  if (unique !== undefined) {
    lines.push({ key: "unique", text: `You can only carry ${formatThousands(unique)} of these items.`, tone: null });
  }

  const cooldown = bagFloat(floats, "CooldownDuration", 167);
  if (cooldown !== undefined) {
    const value = deltaTimeToString(cooldown);
    lines.push(kv("cooldown", "Cooldown When Used", value, null, undefined, `Cooldown When Used: ${value}`));
    const shared = bagInt(ints, "SharedCooldown", 280);
    if (shared !== undefined && typeof o.cooldownRemaining === "function") {
      const left = Number(o.cooldownRemaining(shared >>> 0));
      if (Number.isFinite(left) && left > 0) {
        const rem = deltaTimeToString(left);
        lines.push(kv("cooldownRemaining", "Cooldown Remaining", rem, null, undefined, `Cooldown Remaining: ${rem}`));
      }
    }
  }

  const cleave = bagInt(ints, "Cleaving", 292);
  if (cleave !== undefined && cleave > 1) lines.push(kv("cleave", "Cleave", `${cleave} enemies in front arc`));

  const parts = [];
  const slayer = bagInt(ints, "SlayerCreatureType", 166);
  if (slayer !== undefined) {
    const name = creatureTypeName(slayer);
    if (name) parts.push(slayer === CREATURE_TYPE_HUMAN ? "Bael'Zharon's Hate" : `${name} slayer`);
  }
  const attackType = bagInt(ints, "AttackType", 47);
  if (attackType !== undefined && (attackType & ATTACK_TYPE_MULTI_STRIKE) !== 0) parts.push("Multi-Strike");
  let imbue = 0;
  for (const [name, id] of IMBUE_INTS) {
    const v = bagInt(ints, name, id);
    if (v !== undefined) imbue = (imbue | v) >>> 0;
  }
  for (const [bit, name] of IMBUED_EFFECT_NAMES) if ((imbue & bit) !== 0) parts.push(name);
  if (bagFloat(floats, "AbsorbMagicDamage", 159) !== undefined) parts.push("Magic Absorbing");
  const resistMagic = bagInt(ints, "ResistMagic", 36);
  if (resistMagic !== undefined && resistMagic >= RESIST_MAGIC_UNENCHANTABLE) parts.push("Unenchantable");
  const attuned = "attuned" in o ? o.attuned : attunedText(bagInt(ints, "Attuned", 114));
  if (attuned) parts.push(attuned);
  const bonded = "bonded" in o ? o.bonded : bondedText(bagInt(ints, "Bonded", 33));
  if (bonded) parts.push(bonded);
  if (bagBool(bools, "Retained", 91)) parts.push("Retained");
  if (bagFloat(floats, "CriticalMultiplier", 136) !== undefined) parts.push("Crushing Blow");
  if (bagFloat(floats, "CriticalFrequency", 147) !== undefined) parts.push("Biting Strike");
  if (bagFloat(floats, "IgnoreArmor", 155) !== undefined) parts.push("Armor Cleaving");
  const resMod = bagFloat(floats, "ResistanceModifier", 157);
  const resType = bagInt(ints, "ResistanceModifierType", 263);
  if (resMod !== undefined && resType !== undefined) {
    parts.push(`Resistance Cleaving: ${damageTypeLabel(resType >>> 0) ?? ""}`);
  }
  if (bagValue(dids, "ProcSpell", 55) !== undefined) parts.push("Cast on Strike");
  if (bagBool(bools, "Ivoryable", 99)) parts.push("Ivoryable");
  if (bagBool(bools, "Dyable", 100)) parts.push("Dyeable");
  if (parts.length) lines.push({ key: "properties", text: `Properties: ${parts.join(", ")}`, tone: null });

  if (imbue !== 0) lines.push({ key: "imbued", text: "This item cannot be further imbued.", tone: null });
  if (bagBool(bools, "AutowieldLeft", 130)) {
    lines.push({ key: "autowieldLeft", text: "This item is tethered to the left side.", tone: null });
  }
  return lines;
}

// ── Appraisal_ShowItemLevelInfo (acclient.c:233065) ───────────────────

/**
 * ExperienceSystem::ItemTotalXPToLevel (acclient.c:499244): ItemXpStyle 1
 * is floor(xp / base); 2 costs base, 2·base, 4·base, … per level; 3 costs
 * base, 2·base, 3·base, …; any other style is level 0. Capped at
 * maxLevel. Number math: exact below 2^53, far above retail item XP.
 */
export function itemTotalXpToLevel(xp, baseXp, maxLevel, style) {
  const gained = Number(xp) || 0;
  const base = Number(baseXp) || 0;
  const max = Math.trunc(Number(maxLevel) || 0);
  const s = Number(style);
  let level = 0;
  if (base > 0) {
    if (s === 1) {
      level = Math.floor(gained / base);
    } else if (s === 2 || s === 3) {
      let cost = base;
      let left = gained;
      // Retail runs to the end; past maxLevel the cap decides anyway.
      while (left >= cost && level <= max) {
        level++;
        left -= cost;
        cost = s === 2 ? cost * 2 : cost + base;
      }
    }
  }
  return level <= max ? level : max;
}

/**
 * ExperienceSystem::ItemLevelToTotalXP (acclient.c:499191): the total XP
 * an item needs for `level` (0 below level 1, clamped to maxLevel; 0 for
 * an unknown style).
 */
export function itemLevelToTotalXp(level, baseXp, maxLevel, style) {
  let l = Math.trunc(Number(level) || 0);
  if (l < 1) return 0;
  const max = Math.trunc(Number(maxLevel) || 0);
  if (l > max) l = max;
  const base = Number(baseXp) || 0;
  const s = Number(style);
  if (s === 1) return l * base;
  if (s !== 2 && s !== 3) return 0;
  let step = base;
  let total = base;
  for (let i = 1; i < l; i++) {
    step = s === 2 ? step * 2 : step + base;
    total += step;
  }
  return total;
}

/** CloakWeaveProc (int 0x160) 2: the cloak's damage-reduction proc. */
const CLOAK_PROC_DAMAGE_REDUCTION = 2;

/**
 * "Item Level: %d / %d" and "Item XP: %s / %s" (ExperienceSystem::
 * XPToString's thousands commas; the second number is the total XP for
 * the next level, capped at the max) when ItemBaseXp (int64 5),
 * ItemMaxLevel (int 0x13F) and ItemXpStyle (int 0x140) are all > 0; then,
 * for CloakWeaveProc 2, "This cloak has a chance to reduce an incoming
 * attack by 200 damage.". The level lines are kv rows, the cloak line
 * prose.
 */
export function itemLevelLines(snapshot) {
  const view = appraisalView(snapshot);
  const { ints, int64s } = view;
  const lines = [];
  const base = bagInt(int64s, "ItemBaseXp", 5);
  const max = bagInt(ints, "ItemMaxLevel", 319);
  const style = bagInt(ints, "ItemXpStyle", 320);
  if (base > 0 && max > 0 && style > 0) {
    const xp = bagInt(int64s, "ItemTotalXp", 4) ?? 0;
    const level = itemTotalXpToLevel(xp, base, max, style);
    const next = itemLevelToTotalXp(Math.min(level + 1, max), base, max, style);
    const lv = `${level} / ${max}`;
    lines.push(kv("itemLevel", "Item Level", lv, null, undefined, `Item Level: ${lv}`));
    const xpText = `${formatThousands(xp)} / ${formatThousands(next)}`;
    lines.push(kv("itemXp", "Item XP", xpText, null, undefined, `Item XP: ${xpText}`));
  }
  if (bagInt(ints, "CloakWeaveProc", 352) === CLOAK_PROC_DAMAGE_REDUCTION) {
    lines.push({
      key: "cloakProc",
      text: "This cloak has a chance to reduce an incoming attack by 200 damage.",
      tone: null,
    });
  }
  return lines;
}
