use std::collections::HashMap;

use holtburger_dat::file_type::spell_table::{
    SpellBase as DatSpellBase, SpellExtras as DatSpellExtras, SpellSet as DatSpellSet,
    SpellSetTiers as DatSpellSetTiers, SpellTable as DatSpellTable,
};

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    serde::Serialize,
    serde::Deserialize,
    strum_macros::Display,
    strum_macros::FromRepr,
)]
pub enum MagicSchool {
    #[strum(serialize = "None")]
    None = 0,
    #[strum(serialize = "War Magic")]
    WarMagic = 1,
    #[strum(serialize = "Life Magic")]
    LifeMagic = 2,
    #[strum(serialize = "Item Enchantment")]
    ItemEnchantment = 3,
    #[strum(serialize = "Creature Enchantment")]
    CreatureEnchantment = 4,
    #[strum(serialize = "Void Magic")]
    VoidMagic = 5,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct SpellCatalog {
    pub spells: HashMap<u32, SpellInfo>,
    pub spell_sets: HashMap<u32, SpellSetInfo>,
}

impl SpellCatalog {
    pub fn get(&self, spell_id: u32) -> Option<&SpellInfo> {
        // High bit (0x80000000) is used to mark enchantments in a spell book
        let masked_id = spell_id & 0x7FFFFFFF;
        self.spells.get(&masked_id)
    }

    pub fn resolve_name(&self, spell_id: u32) -> Option<&str> {
        self.get(spell_id).map(|spell| spell.name.as_str())
    }
}

impl From<DatSpellTable> for SpellCatalog {
    fn from(value: DatSpellTable) -> Self {
        Self {
            spells: value
                .spells
                .into_iter()
                .map(|(id, spell)| (id, spell.into()))
                .collect(),
            spell_sets: value
                .spell_sets
                .into_iter()
                .map(|(id, set)| (id, set.into()))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpellInfo {
    pub name: String,
    pub description: String,
    pub school: MagicSchool,
    pub icon_id: u32,
    pub category: u32,
    pub bitfield: u32,
    pub base_mana: u32,
    pub base_range_constant: f32,
    pub base_range_mod: f32,
    pub power: u32,
    pub spell_economy_mod: f32,
    pub formula_version: u32,
    pub component_loss: f32,
    pub meta_spell_type: u32,
    pub meta_spell_id: u32,
    pub extras: SpellExtrasInfo,
    /// Encrypted 8-slot wire-format component array. **Do NOT use this**
    /// for UI display — it carries the obfuscated values straight from
    /// the DAT. See [`Self::decrypted_components`] for the actual
    /// SpellComponentTable IDs (1..198).
    pub components: [u32; 8],
    /// Plaintext SpellComponentTable IDs decrypted from `components`
    /// using the spell's name+description hash. **Wave F.1 (2026-05-27):**
    /// JS spellbook + spell-research-panel consume this for the cast
    /// formula icons + spell-words rendering. Length is 4..=6 for most
    /// spells; trailing-zero slots are dropped.
    pub decrypted_components: Vec<u32>,
    pub caster_effect: u32,
    pub target_effect: u32,
    pub fizzle_effect: u32,
    pub recovery_interval: f64,
    pub recovery_amount: f32,
    pub display_order: u32,
    pub non_component_target_type: u32,
    pub mana_mod: u32,
}

impl SpellInfo {
    const SELF_TARGETED_FLAG: u32 = 0x8;

    pub fn is_self_targeted(&self) -> bool {
        self.bitfield & Self::SELF_TARGETED_FLAG != 0
    }

    pub fn is_untargeted(&self) -> bool {
        self.non_component_target_type == 0
    }

    /// Returns the **ACE-canonical** spell level (1-8) per
    /// `ACE.Server.Entity.SpellFormula.Level`
    /// (`external/ACE/Source/ACE.Server/Entity/SpellFormula.cs:177-191`).
    /// First-component scarab lookup; 0 for empty / non-scarab.
    ///
    /// Wave J4.A (2026-05-27) port; replaces the Wave F.1 max-tier
    /// heuristic which mis-tagged tier-I spells as tier 7 by treating
    /// herbs (Hyssop=7, Mandrake=8) as scarabs. See
    /// [`holtburger_dat::file_type::spell_table::SpellBase::rough_level`]
    /// for the full provenance + algorithm description.
    pub fn rough_level(&self) -> u32 {
        match self.decrypted_components.first().copied() {
            Some(1) => 1,           // Lead
            Some(2) => 2,           // Iron
            Some(3) => 3,           // Copper
            Some(4) => 4,           // Silver
            Some(5) => 5,           // Gold
            Some(6) => 6,           // Pyreal
            Some(110) => 6,         // Diamond (collides with Pyreal)
            Some(112) => 7,         // Platinum
            Some(192) => 7,         // Dark (collides with Platinum)
            Some(193) => 8,         // Mana (max tier)
            _ => 0,                 // empty or non-scarab first
        }
    }
}

impl From<DatSpellBase> for SpellInfo {
    fn from(value: DatSpellBase) -> Self {
        let components =
            std::array::from_fn(|index| value.raw_components.get(index).copied().unwrap_or(0));
        let decrypted_components = value.decrypt_components();

        Self {
            name: value.name,
            description: value.description,
            school: MagicSchool::from_repr(value.school as usize).unwrap_or(MagicSchool::None),
            icon_id: value.icon_id,
            category: value.category,
            bitfield: value.bitfield,
            base_mana: value.base_mana,
            base_range_constant: value.base_range_constant,
            base_range_mod: value.base_range_mod,
            power: value.power,
            spell_economy_mod: value.spell_economy_mod,
            formula_version: value.formula_version,
            component_loss: value.component_loss,
            meta_spell_type: value.meta_spell_type,
            meta_spell_id: value.meta_spell_id,
            extras: value.extras.into(),
            components,
            decrypted_components,
            caster_effect: value.caster_effect,
            target_effect: value.target_effect,
            fizzle_effect: value.fizzle_effect,
            recovery_interval: value.recovery_interval,
            recovery_amount: value.recovery_amount,
            display_order: value.display_order,
            non_component_target_type: value.non_component_target_type,
            mana_mod: value.mana_mod,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum SpellExtrasInfo {
    Enchantment {
        duration: f64,
        degrade_modifier: f32,
        degrade_limit: f32,
    },
    PortalSummon {
        portal_lifetime: f64,
    },
    None,
}

impl From<DatSpellExtras> for SpellExtrasInfo {
    fn from(value: DatSpellExtras) -> Self {
        match value {
            DatSpellExtras::Enchantment {
                duration,
                degrade_modifier,
                degrade_limit,
            } => Self::Enchantment {
                duration,
                degrade_modifier,
                degrade_limit,
            },
            DatSpellExtras::PortalSummon { portal_lifetime } => {
                Self::PortalSummon { portal_lifetime }
            }
            DatSpellExtras::None => Self::None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct SpellSetInfo {
    pub tiers: HashMap<u32, SpellSetTierInfo>,
}

impl From<DatSpellSet> for SpellSetInfo {
    fn from(value: DatSpellSet) -> Self {
        Self {
            tiers: value
                .tiers
                .into_iter()
                .map(|(id, tier)| (id, tier.into()))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpellSetTierInfo {
    pub spell_count: i32,
    pub spells: Vec<u32>,
}

impl From<DatSpellSetTiers> for SpellSetTierInfo {
    fn from(value: DatSpellSetTiers) -> Self {
        Self {
            spell_count: value.spell_count,
            spells: value.spells,
        }
    }
}
