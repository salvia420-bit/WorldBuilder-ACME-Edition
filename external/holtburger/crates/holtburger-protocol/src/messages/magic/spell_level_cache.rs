//! Wave J4.A (2026-05-27): `SpellLevelCache` port from ACE.Server.
//!
//! Ports `ACE.Server.Factories.Entity.SpellLevelCache` + the
//! `ACE.Server.Entity.SpellFormula.Level` algorithm so the wasm spell
//! record can report the ACE-canonical spell level (1-8) instead of
//! the buggy Wave F.1 "highest scarab tier" heuristic, which mis-classified
//! tier-I spells like "Strength Other I" as level 7 because they contain
//! `Hyssop` (component id 7) — a herb, not a scarab. The JS spellbook's
//! `makeHybridCatalog` Proxy worked around this with a JSON name-suffix
//! override; this module fixes the wasm side so that workaround can be
//! dropped.
//!
//! # Algorithm
//!
//! Per `external/ACE/Source/ACE.Server/Entity/SpellFormula.cs:177-191`:
//!
//! ```csharp
//! public uint Level
//! {
//!     get
//!     {
//!         if (Components == null || Components.Count == 0)
//!             return 0;
//!
//!         var firstComp = Components[0];
//!         if (!IsScarab(firstComp))
//!             return 0;
//!
//!         return ScarabLevel[(Scarab)firstComp];
//!     }
//! }
//! ```
//!
//! And `SpellLevelCache.cs` (ACE.Server/Factories/Entity/SpellLevelCache.cs,
//! head `a8ff29f`):
//!
//! ```csharp
//! public static int GetSpellLevel(int spellId)
//! {
//!     if (!spellLevels.TryGetValue(spellId, out var spellLevel))
//!     {
//!         var spell = new Spell(spellId);
//!         spellLevel = spellLevels[spellId] = (int)spell.Formula.Level;
//!     }
//!     return spellLevel;
//! }
//! ```
//!
//! So `SpellLevelCache` is just a memoization wrapper over
//! `Spell.Formula.Level`. The actual semantics:
//!
//! 1. The **first** component (Components[0]), not the max or any scan,
//!    decides the level.
//! 2. If the first component is not a scarab, return 0.
//! 3. The scarab → level mapping is the static `ScarabLevel` dict:
//!    Lead=1, Iron=2, Copper=3, Silver=4, Gold=5, Pyreal=6, Diamond=6,
//!    Platinum=7, Dark=7, Mana=8.
//!
//! Note that:
//!
//! * **Diamond=6 collides with Pyreal=6** by design — both produce
//!   "level 6" spells with a different fizzle/power profile. The cap
//!   stays at 8 (Mana scarab).
//! * The **non-scarab** mapping (Diamond=110, Platinum=112, Dark=192,
//!   Mana=193) lives at component IDs that are NOT 1..8. Wave F.1's
//!   `(110..=116)` and `(192..=198)` ranges were a guess that worked
//!   accidentally for Diamond/Platinum/Dark/Mana but would mis-classify
//!   other items in the 110-116 / 192-198 range (currently none in
//!   retail, but the contract is the explicit lookup).
//! * **Power** (separate from Level) follows a similar mapping where
//!   Diamond=7, Platinum=8, Dark=9, Mana=10 — used by foci-formula
//!   prismatic-taper count, exported below for completeness.
//!
//! # Why no `HashMap`-per-spell-id cache
//!
//! ACE caches by `spell_id` because computing `Spell.Formula.Level`
//! requires walking through `new Spell(spellId)` → DAT lookup →
//! component decryption. We've already done that work at parse time:
//! `SpellBase::decrypt_components()` returns the in-order component
//! list. So our port is one indirection cheaper than ACE's — no need
//! for a separate cache layer.
//!
//! # Cross-references
//!
//! * `external/ACE/Source/ACE.Server/Factories/Entity/SpellLevelCache.cs`
//!   (cache wrapper; head `a8ff29f`).
//! * `external/ACE/Source/ACE.Server/Entity/SpellFormula.cs:14-77,177-191`
//!   (`Scarab` enum, `ScarabLevel`, `ScarabPower`, `IsScarab`, `Level`).
//! * `external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/UIHooks.cs:208-250`
//!   (client-side port of the same algorithm — confirms the choice).
//! * `acclient.c` offset `0x005981D0`
//!   `CSpellBase::InqSpellLevelByRoughHeuristic` — retail's first-scarab
//!   lookup that both ACE and Chorizite mirror.

/// Scarab component IDs from `SpellComponentTable` (0x0E00000F).
///
/// Wraps `ACE.Server.Entity.Scarab` (`SpellFormula.cs:15-27`,
/// vendored HEAD `a8ff29f`). The lower six (Lead-Pyreal) sit at IDs
/// 1-6 because they are the first six entries in the canonical
/// component table; the upper four (Diamond/Platinum/Dark/Mana) were
/// added later at sparse IDs 110/112/192/193.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u32)]
pub enum Scarab {
    Lead = 1,
    Iron = 2,
    Copper = 3,
    Silver = 4,
    Gold = 5,
    Pyreal = 6,
    Diamond = 110,
    Platinum = 112,
    Dark = 192,
    Mana = 193,
}

impl Scarab {
    /// Returns the scarab-tier level (1-8) per
    /// `SpellFormula.ScarabLevel`. Note Diamond shares level 6 with
    /// Pyreal; Dark shares level 7 with Platinum.
    pub const fn level(self) -> u32 {
        match self {
            Scarab::Lead => 1,
            Scarab::Iron => 2,
            Scarab::Copper => 3,
            Scarab::Silver => 4,
            Scarab::Gold => 5,
            Scarab::Pyreal => 6,
            Scarab::Diamond => 6,
            Scarab::Platinum => 7,
            Scarab::Dark => 7,
            Scarab::Mana => 8,
        }
    }

    /// Returns the scarab power (1-10) per `SpellFormula.ScarabPower`.
    /// Used by the foci-formula prismatic-taper count, not by the
    /// spellbook tier filter. Exposed for parity with ACE.
    pub const fn power(self) -> u32 {
        match self {
            Scarab::Lead => 1,
            Scarab::Iron => 2,
            Scarab::Copper => 3,
            Scarab::Silver => 4,
            Scarab::Gold => 5,
            Scarab::Pyreal => 6,
            Scarab::Diamond => 7,
            Scarab::Platinum => 8,
            Scarab::Dark => 9,
            Scarab::Mana => 10,
        }
    }

    /// Tries to construct a `Scarab` from a raw component ID. Returns
    /// `None` for non-scarab components (herbs, talismans, etc.).
    pub const fn from_component_id(component_id: u32) -> Option<Scarab> {
        match component_id {
            1 => Some(Scarab::Lead),
            2 => Some(Scarab::Iron),
            3 => Some(Scarab::Copper),
            4 => Some(Scarab::Silver),
            5 => Some(Scarab::Gold),
            6 => Some(Scarab::Pyreal),
            110 => Some(Scarab::Diamond),
            112 => Some(Scarab::Platinum),
            192 => Some(Scarab::Dark),
            193 => Some(Scarab::Mana),
            _ => None,
        }
    }
}

/// Returns `true` iff `component_id` is one of the ten scarab
/// components recognized by ACE's `Spell.Formula.Level`.
///
/// Mirrors `SpellFormula.IsScarab` (`SpellFormula.cs:111-114`).
#[inline]
pub const fn is_scarab(component_id: u32) -> bool {
    Scarab::from_component_id(component_id).is_some()
}

/// Returns the level for a scarab component id, or `None` for
/// non-scarabs.
///
/// Pure lookup — no caching, no allocation. Mirrors
/// `SpellFormula.ScarabLevel[(Scarab)componentId]`.
#[inline]
pub fn scarab_level(component_id: u32) -> Option<u32> {
    Scarab::from_component_id(component_id).map(Scarab::level)
}

/// Returns the power for a scarab component id, or `None` for
/// non-scarabs. Mirrors `SpellFormula.ScarabPower[(Scarab)componentId]`.
#[inline]
pub fn scarab_power(component_id: u32) -> Option<u32> {
    Scarab::from_component_id(component_id).map(Scarab::power)
}

/// Returns the **ACE-canonical** spell level (1-8) for a spell, given
/// its decrypted component list in canonical order.
///
/// Returns 0 when the component list is empty or its first entry is
/// not a scarab. Mirrors `SpellFormula.Level` exactly.
///
/// ```
/// use holtburger_protocol::messages::magic::spell_level_cache::get_spell_level;
///
/// // "Strength Other I" — Lead scarab first → level 1.
/// assert_eq!(get_spell_level(&[1, 7, 33, 44, 49]), 1);
/// // "Summon Primary Portal I" — Silver scarab first → level 4
/// // (despite containing Pyreal too, ACE only looks at Components[0]).
/// assert_eq!(get_spell_level(&[4, 69, 24, 66, 32, 42, 60]), 4);
/// // Diamond-tier spell — Diamond scarab → level 6.
/// assert_eq!(get_spell_level(&[110, 27, 40, 56]), 6);
/// // Mana scarab → level 8 (highest tier).
/// assert_eq!(get_spell_level(&[193, 27, 40, 56]), 8);
/// // Non-scarab first component (Hyssop herb) → 0.
/// assert_eq!(get_spell_level(&[7, 1, 33, 44, 49]), 0);
/// // Empty → 0.
/// assert_eq!(get_spell_level(&[]), 0);
/// ```
#[inline]
pub fn get_spell_level(components: &[u32]) -> u32 {
    match components.first() {
        Some(&first) => scarab_level(first).unwrap_or(0),
        None => 0,
    }
}

/// Returns the ACE-canonical spell power (1-10) for a spell, given
/// its decrypted component list. Mirrors `SpellFormula.Power`. Used by
/// the foci-formula prismatic-taper count.
#[inline]
pub fn get_spell_power(components: &[u32]) -> u32 {
    match components.first() {
        Some(&first) => scarab_power(first).unwrap_or(0),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_ten_scarabs_round_trip() {
        // Lower six (sequential IDs 1-6).
        assert_eq!(Scarab::from_component_id(1), Some(Scarab::Lead));
        assert_eq!(Scarab::from_component_id(2), Some(Scarab::Iron));
        assert_eq!(Scarab::from_component_id(3), Some(Scarab::Copper));
        assert_eq!(Scarab::from_component_id(4), Some(Scarab::Silver));
        assert_eq!(Scarab::from_component_id(5), Some(Scarab::Gold));
        assert_eq!(Scarab::from_component_id(6), Some(Scarab::Pyreal));
        // Upper four (sparse IDs).
        assert_eq!(Scarab::from_component_id(110), Some(Scarab::Diamond));
        assert_eq!(Scarab::from_component_id(112), Some(Scarab::Platinum));
        assert_eq!(Scarab::from_component_id(192), Some(Scarab::Dark));
        assert_eq!(Scarab::from_component_id(193), Some(Scarab::Mana));
    }

    #[test]
    fn non_scarab_ids_return_none() {
        // ID 7 = Hyssop (herb) — Wave F.1's buggy heuristic mistook
        // this for a scarab.
        assert_eq!(Scarab::from_component_id(7), None);
        // ID 8 = Mandrake (herb).
        assert_eq!(Scarab::from_component_id(8), None);
        // Mid-range herbs/powders.
        assert_eq!(Scarab::from_component_id(33), None);
        // Talismans.
        assert_eq!(Scarab::from_component_id(49), None);
        // ID 0 and high IDs.
        assert_eq!(Scarab::from_component_id(0), None);
        assert_eq!(Scarab::from_component_id(111), None); // Iron Pea? No — sparse.
        assert_eq!(Scarab::from_component_id(194), None);
        assert_eq!(Scarab::from_component_id(999), None);
    }

    #[test]
    fn scarab_level_table_matches_ace() {
        // From ACE.Server/Entity/SpellFormula.cs:40-52.
        assert_eq!(Scarab::Lead.level(), 1);
        assert_eq!(Scarab::Iron.level(), 2);
        assert_eq!(Scarab::Copper.level(), 3);
        assert_eq!(Scarab::Silver.level(), 4);
        assert_eq!(Scarab::Gold.level(), 5);
        assert_eq!(Scarab::Pyreal.level(), 6);
        assert_eq!(Scarab::Diamond.level(), 6); // collides with Pyreal!
        assert_eq!(Scarab::Platinum.level(), 7);
        assert_eq!(Scarab::Dark.level(), 7); // collides with Platinum!
        assert_eq!(Scarab::Mana.level(), 8);
    }

    #[test]
    fn scarab_power_table_matches_ace() {
        // From ACE.Server/Entity/SpellFormula.cs:57-69.
        // Diverges from level table for Diamond+ (7/8/9/10).
        assert_eq!(Scarab::Lead.power(), 1);
        assert_eq!(Scarab::Iron.power(), 2);
        assert_eq!(Scarab::Copper.power(), 3);
        assert_eq!(Scarab::Silver.power(), 4);
        assert_eq!(Scarab::Gold.power(), 5);
        assert_eq!(Scarab::Pyreal.power(), 6);
        assert_eq!(Scarab::Diamond.power(), 7); // diverges from level
        assert_eq!(Scarab::Platinum.power(), 8);
        assert_eq!(Scarab::Dark.power(), 9);
        assert_eq!(Scarab::Mana.power(), 10);
    }

    #[test]
    fn is_scarab_matches_ace_definition() {
        // Scarab IDs from the canonical 10.
        assert!(is_scarab(1));
        assert!(is_scarab(6));
        assert!(is_scarab(110));
        assert!(is_scarab(193));
        // Wave F.1's bug: comp 7 (Hyssop) is NOT a scarab.
        assert!(!is_scarab(7));
        assert!(!is_scarab(8));
        // Sparse non-scarabs in the 110-116 / 192-198 range that
        // Wave F.1's range-based heuristic incorrectly mapped.
        assert!(!is_scarab(111));
        assert!(!is_scarab(113));
        assert!(!is_scarab(194));
    }

    #[test]
    fn get_spell_level_strength_other_i_canonical() {
        // Spell id 1 "Strength Other I" — decrypted components
        // [1=Lead, 7=Hyssop, 33=Powdered Moonstone, 44=Realgar,
        //  49=Poplar Talisman]. ACE: Components[0]=Lead → 1.
        // Wave F.1 buggy: max(1,7,0,0,0)=7 because it treated comp
        // 7 (Hyssop) as scarab.
        assert_eq!(get_spell_level(&[1, 7, 33, 44, 49]), 1);
    }

    #[test]
    fn get_spell_level_first_scarab_only() {
        // ACE's `Level` cares ONLY about Components[0]. A spell with
        // [4=Silver, ..., 6=Pyreal in the middle] is level 4 (Silver),
        // not level 6 (Pyreal). This is the key behavior change vs
        // Wave F.1's max() heuristic.
        assert_eq!(get_spell_level(&[4, 6, 33, 44, 49]), 4);
        // Now reverse the order — first comp is Pyreal → level 6.
        assert_eq!(get_spell_level(&[6, 4, 33, 44, 49]), 6);
    }

    #[test]
    fn get_spell_level_empty_or_non_scarab_first() {
        // Empty list → 0 (per ACE early-return).
        assert_eq!(get_spell_level(&[]), 0);
        // First comp is Hyssop (herb) → 0 (per ACE `!IsScarab` branch).
        assert_eq!(get_spell_level(&[7, 1, 33, 44, 49]), 0);
        // First comp is a high non-scarab ID → 0.
        assert_eq!(get_spell_level(&[50, 1, 33, 44, 49]), 0);
    }

    #[test]
    fn get_spell_level_all_ten_scarabs_first() {
        // Each scarab in the first slot produces its mapped level.
        assert_eq!(get_spell_level(&[1]), 1); // Lead
        assert_eq!(get_spell_level(&[2]), 2); // Iron
        assert_eq!(get_spell_level(&[3]), 3); // Copper
        assert_eq!(get_spell_level(&[4]), 4); // Silver
        assert_eq!(get_spell_level(&[5]), 5); // Gold
        assert_eq!(get_spell_level(&[6]), 6); // Pyreal
        assert_eq!(get_spell_level(&[110]), 6); // Diamond
        assert_eq!(get_spell_level(&[112]), 7); // Platinum
        assert_eq!(get_spell_level(&[192]), 7); // Dark
        assert_eq!(get_spell_level(&[193]), 8); // Mana
    }

    #[test]
    fn get_spell_power_matches_ace_semantics() {
        // Diamond-power=7 (diverges from level=6).
        assert_eq!(get_spell_power(&[110, 27, 40, 56]), 7);
        // Mana-power=10 (diverges from level=8).
        assert_eq!(get_spell_power(&[193, 27, 40, 56]), 10);
        // Lower six are identical to level.
        assert_eq!(get_spell_power(&[1]), 1);
        assert_eq!(get_spell_power(&[6]), 6);
        // Empty / non-scarab → 0.
        assert_eq!(get_spell_power(&[]), 0);
        assert_eq!(get_spell_power(&[7, 1]), 0);
    }

    #[test]
    fn scarab_level_passes_through_scarab_power() {
        // The two pure functions agree about which IDs are scarabs.
        for id in 0..255u32 {
            assert_eq!(scarab_level(id).is_some(), is_scarab(id));
            assert_eq!(scarab_power(id).is_some(), is_scarab(id));
        }
    }
}
