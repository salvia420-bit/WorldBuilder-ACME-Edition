// EnchantmentTypeFlags — canonical wire-format bitfield from
// `holtburger_common::properties::combat` (crates/holtburger-common/
// src/properties/combat.rs:99-122). Centralised here so the HUD
// plugins that classify enchantments (buffs-hud, status-indicators,
// future tooling) share one authoritative definition and can't drift.
//
// Each bit reflects retail's EnchantmentTypeFlags spec and ACE's
// `Enchantment.StatModType` echo:
//
//   ATTRIBUTE      — stat key is an Attribute id (Str / End / …)
//   SECOND_ATT     — stat key is a Vital id (Health / Stamina / Mana)
//   INT            — stat key is a PropertyInt
//   FLOAT          — stat key is a PropertyFloat
//   SKILL          — stat key is a Skill id
//   SINGLE_STAT    — modifier touches one stat (vs MULTIPLE_STAT)
//   MULTIPLE_STAT  — modifier touches a stat family
//   MULTIPLICATIVE — value is a multiplier (1.05 = +5%)
//   ADDITIVE       — value is a flat delta (+10 strength)
//   VITAE          — vitae penalty (special-case enchantment)
//   COOLDOWN       — cooldown / shared-cooldown marker
//   BENEFICIAL     — set by spell.IsBeneficial server-side
//                   (used for buff / debuff colouring)

export const ETF = Object.freeze({
  ATTRIBUTE:      0x0000001,
  SECOND_ATT:     0x0000002,
  INT:            0x0000004,
  FLOAT:          0x0000008,
  SKILL:          0x0000010,
  SINGLE_STAT:    0x0001000,
  MULTIPLE_STAT:  0x0002000,
  MULTIPLICATIVE: 0x0004000,
  ADDITIVE:       0x0008000,
  VITAE:          0x0800000,
  COOLDOWN:       0x1000000,
  BENEFICIAL:     0x2000000,
});
